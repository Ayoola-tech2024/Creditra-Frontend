/**
 * Unit tests for creditLineCache (issue #919).
 *
 * Covers: optimistic apply + exactly-once rollback, targeted invalidation,
 * generation-guarded authoritative refreshes (delayed / out-of-order safe),
 * indexing-delay exposure, and cache isolation for unrelated lines.
 */

import { describe, expect, it, vi } from "vitest";
import {
  CreditLineCache,
  type OptimisticMutationToken,
} from "./creditLineCache";
import type { CreditLine } from "../types/creditLine";
import type { AuthoritativeSnapshot } from "../services/creditLineAdminService";

function makeLine(overrides: Partial<CreditLine> = {}): CreditLine {
  return {
    id: "CL-TEST-001",
    name: "Test line",
    status: "Active",
    limit: 500000,
    utilized: 187500,
    apr: 12.5,
    riskScore: 720,
    openedAt: "2024-01-15T09:00:00.000Z",
    updatedAt: "2024-06-01T09:00:00.000Z",
    transactions: [],
    statusHistory: [],
    ...overrides,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Fetcher whose responses are settled manually, per id-set, in order. */
class ManualFetcher {
  private queue: Array<Deferred<AuthoritativeSnapshot>> = [];
  seenRequestIds: string[][] = [];

  fetch(lineIds: string[]): Promise<AuthoritativeSnapshot> {
    this.seenRequestIds.push([...lineIds]);
    const deferred = createDeferred<AuthoritativeSnapshot>();
    this.queue.push(deferred);
    return deferred.promise;
  }

  settle(index: number, snapshot: AuthoritativeSnapshot): void {
    this.queue[index].resolve(snapshot);
  }

  fail(index: number, error?: unknown): void {
    this.queue[index].reject(error ?? new Error("fetch failed"));
  }

  get pendingCount(): number {
    return this.queue.length;
  }
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("CreditLineCache — seeding and snapshots", () => {
  it("seeds from the provided lines and returns a referentially stable array", () => {
    const seed = [makeLine(), makeLine({ id: "CL-TEST-002" })];
    const cache = new CreditLineCache({ seed });

    const first = cache.getLines();
    const second = cache.getLines();

    expect(first).toBe(second);
    expect(first.map((l) => l.id)).toEqual(["CL-TEST-001", "CL-TEST-002"]);
  });

  it("notifies subscribers on mutations but not for repeated reads", () => {
    const seed = [makeLine()];
    const cache = new CreditLineCache({ seed });
    const listener = vi.fn();
    cache.subscribe(listener);

    cache.getLines();
    cache.getRefreshIndicator();
    expect(listener).not.toHaveBeenCalled();

    cache.applyOptimistic("CL-TEST-001", (l) => ({
      ...l,
      status: "Frozen",
    }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops notifying after unsubscribe", () => {
    const cache = new CreditLineCache({ seed: [makeLine()] });
    const listener = vi.fn();
    const unsubscribe = cache.subscribe(listener);

    unsubscribe();
    cache.applyOptimistic("CL-TEST-001", (l) => ({ ...l }));

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("CreditLineCache — optimistic apply + rollback", () => {
  it("applies the mutation to the target line only, preserving unrelated entries by identity", () => {
    const untouched = makeLine({ id: "CL-TEST-002" });
    const cache = new CreditLineCache({
      seed: [makeLine(), untouched],
    });

    cache.applyOptimistic("CL-TEST-001", (l) => ({
      ...l,
      status: "Frozen",
      updatedAt: "2026-08-24T10:00:00.000Z",
    }));

    const lines = cache.getLines();
    expect(lines[0]!.status).toBe("Frozen");
    expect(lines[1]).toBe(untouched);
  });

  it("rolls back to the exact pre-mutation baseline exactly once", () => {
    const cache = new CreditLineCache({ seed: [makeLine()] });
    const before = cache.getLine("CL-TEST-001")!;

    const token = cache.applyOptimistic("CL-TEST-001", (l) => ({
      ...l,
      utilized: 100,
    }));
    expect(cache.getLine("CL-TEST-001")!.utilized).toBe(100);

    const first = cache.rollbackOptimistic(token);
    expect(first).toEqual({ applied: true });

    const restored = cache.getLine("CL-TEST-001")!;
    expect(restored).toEqual(before);
    expect(cache.getLines().length).toBe(1);

    const second = cache.rollbackOptimistic(token);
    expect(second).toEqual({ applied: false, reason: "already_settled" });
  });

  it("preserves nested collections across rollback (statusHistory additions undone)", () => {
    const cache = new CreditLineCache({
      seed: [
        makeLine({
          statusHistory: [{ status: "Active", date: "2024-01-15T09:00:00.000Z" }],
        }),
      ],
    });

    const token = cache.applyOptimistic("CL-TEST-001", (l) => ({
      ...l,
      status: "Frozen",
      statusHistory: [
        ...l.statusHistory,
        { status: "Frozen", date: "2026-08-24T10:00:00.000Z", note: "Frozen by user" },
      ],
    }));
    cache.rollbackOptimistic(token);

    const line = cache.getLine("CL-TEST-001")!;
    expect(line.status).toBe("Active");
    expect(line.statusHistory).toHaveLength(1);
  });

  it("refuses rollback for unknown tokens", () => {
    const cache = new CreditLineCache({ seed: [makeLine()] });
    const result = cache.rollbackOptimistic({
      opId: "clm-9999",
      lineId: "CL-TEST-001",
    } satisfies OptimisticMutationToken);
    expect(result).toEqual({ applied: false, reason: "unknown_operation" });
  });

  it("only allows the latest mutation on a line to roll back", () => {
    const cache = new CreditLineCache({ seed: [makeLine()] });

    const first = cache.applyOptimistic("CL-TEST-001", (l) => ({
      ...l,
      status: "Frozen",
    }));
    const second = cache.applyOptimistic("CL-TEST-001", (l) => ({
      ...l,
      riskScore: 800,
    }));

    const olderResult = cache.rollbackOptimistic(first);
    expect(olderResult.applied).toBe(false);

    const latestResult = cache.rollbackOptimistic(second);
    expect(latestResult).toEqual({ applied: true });
    // Restores the baseline captured when the *second* op applied
    // (i.e. the state right after the first optimistic freeze).
    expect(cache.getLine("CL-TEST-001")!.status).toBe("Frozen");
    expect(cache.getLine("CL-TEST-001")!.riskScore).toBe(720);
  });

  it("throws when mutating an unknown line", () => {
    const cache = new CreditLineCache({ seed: [makeLine()] });
    expect(() =>
      cache.applyOptimistic("CL-DOES-NOT-EXIST", (l) => ({ ...l })),
    ).toThrow(/unknown credit line/i);
  });
});

describe("CreditLineCache — targeted invalidation + authoritative refresh", () => {
  it("marks requested lines stale without changing displayed values", () => {
    const cache = new CreditLineCache({ seed: [makeLine(), makeLine({ id: "CL-TEST-002" })] });

    cache.invalidate(["CL-TEST-001"]);

    expect(cache.getStaleLineIds()).toEqual(["CL-TEST-001"]);
    expect(cache.getLine("CL-TEST-001")!.utilized).toBe(187500);
  });

  it("refresh replaces only affected lines; unrelated lines keep value AND identity", async () => {
    const fetcher = new ManualFetcher();
    const unrelated = makeLine({ id: "CL-TEST-002", utilized: 42 });
    const cache = new CreditLineCache({ fetcher: (ids) => fetcher.fetch(ids), seed: [makeLine(), unrelated] });

    cache.refreshAffected(["CL-TEST-001"]);
    expect(cache.getRefreshIndicator().isRefreshing).toBe(true);

    fetcher.settle(0, {
      lines: [
        makeLine({ utilized: 999999 }),
        // The backend also echoes CL-TEST-002, but it was never requested.
        makeLine({ id: "CL-TEST-002", utilized: 777 }),
      ],
    });
    await flushMicrotasks();

    const lines = cache.getLines();
    expect(lines[0]!.utilized).toBe(999999);
    expect(lines[1]).toBe(unrelated);
    expect(lines[1]!.utilized).toBe(42);
    expect(cache.getRefreshIndicator().isRefreshing).toBe(false);
  });

  it("clears stale marks after a successful refresh", async () => {
    const fetcher = new ManualFetcher();
    const cache = new CreditLineCache({ fetcher: (ids) => fetcher.fetch(ids), seed: [makeLine()] });

    cache.invalidate(["CL-TEST-001"]);
    cache.refreshAffected(["CL-TEST-001"]);
    fetcher.settle(0, { lines: [makeLine({ updatedAt: "2026-08-24T11:00:00.000Z" })] });
    await flushMicrotasks();

    expect(cache.getStaleLineIds()).toEqual([]);
  });

  it("discards delayed out-of-order responses; only the latest generation lands", async () => {
    const fetcher = new ManualFetcher();
    const cache = new CreditLineCache({ fetcher: (ids) => fetcher.fetch(ids), seed: [makeLine()] });

    // Older refresh (slow) issued first.
    cache.refreshAffected(["CL-TEST-001"]);
    // Newer refresh (fast) issued second.
    cache.refreshAffected(["CL-TEST-001"]);

    fetcher.settle(1, { lines: [makeLine({ utilized: 222 })] }); // newer lands first
    await flushMicrotasks();
    expect(cache.getLine("CL-TEST-001")!.utilized).toBe(222);

    fetcher.settle(0, { lines: [makeLine({ utilized: 111 })] }); // stale response arrives late
    await flushMicrotasks();
    expect(cache.getLine("CL-TEST-001")!.utilized).toBe(222); // discarded
    expect(cache.getRefreshIndicator().isRefreshing).toBe(false);
  });

  it("measures indexing delay with the injectable clock", async () => {
    let clock = 1_000;
    const fetcher = new ManualFetcher();
    const cache = new CreditLineCache({
      fetcher: (ids) => fetcher.fetch(ids),
      seed: [makeLine()],
      now: () => clock,
    });

    expect(cache.getRefreshIndicator().lastIndexingDelayMs).toBeNull();

    cache.refreshAffected(["CL-TEST-001"]);
    clock += 375;
    fetcher.settle(0, { lines: [makeLine()] });
    await flushMicrotasks();

    expect(cache.getRefreshIndicator().lastIndexingDelayMs).toBe(375);
  });

  it("keeps cached values and stale marks when the refresh fails", async () => {
    const fetcher = new ManualFetcher();
    const original = makeLine();
    const cache = new CreditLineCache({ fetcher: (ids) => fetcher.fetch(ids), seed: [original] });

    cache.invalidate(["CL-TEST-001"]);
    cache.refreshAffected(["CL-TEST-001"]);
    fetcher.fail(0, new Error("indexer unavailable"));
    await flushMicrotasks();

    expect(cache.getRefreshIndicator().isRefreshing).toBe(false);
    expect(cache.getStaleLineIds()).toEqual(["CL-TEST-001"]);
    expect(cache.getLine("CL-TEST-001")).toBe(original);
  });

  it("ignores refresh requests for unknown ids entirely", async () => {
    const fetcher = new ManualFetcher();
    const cache = new CreditLineCache({ fetcher: (ids) => fetcher.fetch(ids), seed: [makeLine()] });

    cache.refreshAffected(["CL-GHOST"]);

    expect(fetcher.pendingCount).toBe(0);
    expect(cache.getRefreshIndicator().isRefreshing).toBe(false);
  });

  it("an authoritative landing settles pending optimistic ops on refreshed lines", async () => {
    const fetcher = new ManualFetcher();
    const cache = new CreditLineCache({ fetcher: (ids) => fetcher.fetch(ids), seed: [makeLine()] });

    const token = cache.applyOptimistic("CL-TEST-001", (l) => ({
      ...l,
      status: "Frozen",
    }));

    cache.refreshAffected(["CL-TEST-001"]);
    fetcher.settle(0, { lines: [makeLine({ status: "Suspended", utilized: 55 })] });
    await flushMicrotasks();

    // Authoritative data replaced the optimistic view; a late rollback must
    // not clobber server truth.
    const result = cache.rollbackOptimistic(token);
    expect(result).toEqual({ applied: false, reason: "superseded_by_authoritative" });
    expect(cache.getLine("CL-TEST-001")!.status).toBe("Suspended");
    expect(cache.getLine("CL-TEST-001")!.utilized).toBe(55);
  });
});

describe("CreditLineCache — indicator identity and reset", () => {
  it("returns a stable indicator object between emissions", () => {
    const cache = new CreditLineCache({ seed: [makeLine()] });
    expect(cache.getRefreshIndicator()).toBe(cache.getRefreshIndicator());
  });

  it("reset restores the seed and clears all bookkeeping", async () => {
    const fetcher = new ManualFetcher();
    const seed = [makeLine()];
    const cache = new CreditLineCache({ fetcher: (ids) => fetcher.fetch(ids), seed });

    cache.applyOptimistic("CL-TEST-001", (l) => ({ ...l, status: "Frozen" }));
    cache.invalidate(["CL-TEST-001"]);
    cache.refreshAffected(["CL-TEST-001"]);
    fetcher.settle(0, { lines: [makeLine({ utilized: 5 })] });
    await flushMicrotasks();

    cache.reset();

    expect(cache.getLines()).toEqual(seed);
    expect(cache.getStaleLineIds()).toEqual([]);
    expect(cache.getRefreshIndicator()).toEqual({
      isRefreshing: false,
      lastIndexingDelayMs: null,
    });
  });

  it("a superseded response does not clear a newer refresh's in-flight state", async () => {
    const fetcher = new ManualFetcher();
    const cache = new CreditLineCache({ fetcher: (ids) => fetcher.fetch(ids), seed: [makeLine()] });

    cache.refreshAffected(["CL-TEST-001"]); // gen 1
    cache.refreshAffected(["CL-TEST-001"]); // gen 2

    fetcher.settle(0, { lines: [makeLine({ utilized: 1 })] }); // gen 1 settles late-ish
    await flushMicrotasks();
    // gen 2 still in flight → indicator stays refreshing.
    expect(cache.getRefreshIndicator().isRefreshing).toBe(true);

    fetcher.settle(1, { lines: [makeLine({ utilized: 2 })] });
    await flushMicrotasks();
    expect(cache.getRefreshIndicator().isRefreshing).toBe(false);
    expect(cache.getLine("CL-TEST-001")!.utilized).toBe(2);
  });
});
