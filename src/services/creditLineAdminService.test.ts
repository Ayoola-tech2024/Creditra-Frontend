/**
 * Tests for creditLineAdminService (issue #919) — simulated backend used by
 * the creditLineCache authoritative-refresh flow.
 */

import { describe, expect, it, vi } from "vitest";
import {
  LineStatusChangeError,
  fetchAuthoritativeLines,
  resetBackendMirror,
  submitLineStatusChange,
} from "./creditLineAdminService";
import { MOCK_CREDIT_LINES } from "../data/mockData";
import type { CreditLine } from "../types/creditLine";

vi.useFakeTimers();

function makeSeed(): CreditLine[] {
  return JSON.parse(JSON.stringify(MOCK_CREDIT_LINES)) as CreditLine[];
}

/** Starts the async call, advances fake timers so it settles, then awaits. */
async function withTimers<T>(start: () => Promise<T>): Promise<T> {
  const promise = start();
  await vi.advanceTimersByTimeAsync(5_000);
  return promise;
}

describe("creditLineAdminService — submitLineStatusChange", () => {
  it("applies a confirmed freeze to the backend mirror and returns a receipt", async () => {
    resetBackendMirror(makeSeed());

    const receipt = await withTimers(() =>
      submitLineStatusChange({ lineId: "CL-2024-001", nextStatus: "Frozen" }),
    );
    expect(receipt.lineId).toBe("CL-2024-001");
    expect(receipt.status).toBe("Frozen");
    expect(typeof receipt.updatedAt).toBe("string");

    const snapshot = await withTimers(() =>
      fetchAuthoritativeLines(["CL-2024-001"], { delayMs: 0 }),
    );
    expect(snapshot.lines[0]!.status).toBe("Frozen");
  });

  it("rejects with a typed error and leaves the mirror untouched on failure", async () => {
    resetBackendMirror(makeSeed());

    const promise = submitLineStatusChange(
      { lineId: "CL-2024-001", nextStatus: "Frozen" },
      { outcome: { kind: "rejected", code: "network_error" } },
    );
    const assertion = expect(promise).rejects.toBeInstanceOf(LineStatusChangeError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;

    const snapshot = await withTimers(() =>
      fetchAuthoritativeLines(["CL-2024-001"], { delayMs: 0 }),
    );
    expect(snapshot.lines[0]!.status).not.toBe("Frozen");
  });

  it("surfaces the rejection code on the typed error", async () => {
    resetBackendMirror(makeSeed());

    const promise = submitLineStatusChange(
      { lineId: "CL-2024-001", nextStatus: "Active" },
      { outcome: { kind: "rejected", code: "timeout" } },
    );
    const assertion = expect(promise).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("rejects submissions for unknown lines", async () => {
    resetBackendMirror(makeSeed());

    const promise = submitLineStatusChange({ lineId: "CL-MISSING", nextStatus: "Frozen" });
    const assertion = expect(promise).rejects.toMatchObject({
      code: "rejected_by_backend",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });
});

describe("creditLineAdminService — fetchAuthoritativeLines", () => {
  it("returns deep clones; mutating a result never aliases backend state", async () => {
    resetBackendMirror(makeSeed());

    const snapshot = await withTimers(() =>
      fetchAuthoritativeLines(["CL-2024-001"], { delayMs: 0 }),
    );
    snapshot.lines[0]!.utilized = 1_234_567;
    snapshot.lines[0]!.name = "tampered";

    const fresh = await withTimers(() =>
      fetchAuthoritativeLines(["CL-2024-001"], { delayMs: 0 }),
    );
    expect(fresh.lines[0]!.utilized).not.toBe(1_234_567);
    expect(fresh.lines[0]!.name).not.toBe("tampered");
  });

  it("omits unknown ids instead of throwing", async () => {
    resetBackendMirror(makeSeed());

    const snapshot = await withTimers(() =>
      fetchAuthoritativeLines(["CL-2024-001", "CL-GHOST"], { delayMs: 0 }),
    );
    expect(snapshot.lines.map((l) => l.id)).toEqual(["CL-2024-001"]);
  });

  it("resetBackendMirror restores pristine state between scenarios", async () => {
    resetBackendMirror(makeSeed());
    await withTimers(() =>
      submitLineStatusChange({ lineId: "CL-2024-002", nextStatus: "Frozen" }),
    );

    resetBackendMirror(makeSeed());
    const snapshot = await withTimers(() =>
      fetchAuthoritativeLines(["CL-2024-002"], { delayMs: 0 }),
    );
    expect(snapshot.lines[0]!.status).toBe("Active");
  });
});
