/**
 * creditLineCache — authoritative credit-line cache with targeted invalidation
 * (issue #919: refresh stale credit-line data after mutations).
 *
 * Why this exists: the app previously mutated `MOCK_CREDIT_LINES` copies in
 * local component state, so after a freeze/unfreeze there was no notion of
 * "the backend's canonical data" and no way to reconcile with it. This module
 * gives the UI a small framework-free store that:
 *
 *  1. Tracks pending operations — every optimistic mutation returns a token
 *     whose effects can be rolled back exactly once if the write fails.
 *  2. Supports targeted invalidation — `invalidate(ids)` marks specific lines
 *     stale without touching unrelated cached entries.
 *  3. Refreshes authoritatively — `refreshAffected(ids)` re-reads canonical
 *     data through an injected fetcher. A monotonically increasing generation
 *     guard discards out-of-order / delayed responses so a stale snapshot can
 *     never overwrite newer state.
 *  4. Exposes indexing delay — consumers read whether a refresh is in flight
 *     and how long the last authoritative round-trip took.
 *
 * Snapshots are referentially stable between emissions so the store can feed
 * `useSyncExternalStore` directly.
 */

import type { CreditLine } from "../types/creditLine";
import { MOCK_CREDIT_LINES } from "../data/mockData";
import {
  fetchAuthoritativeLines,
  type AuthoritativeSnapshot,
} from "../services/creditLineAdminService";

/** Reads canonical post-index data for the given line ids. */
export type FetchAuthoritativeLines = (
  lineIds: string[],
) => Promise<AuthoritativeSnapshot>;

/** Handle for undoing one optimistic mutation. Opaque to callers. */
export interface OptimisticMutationToken {
  readonly opId: string;
  readonly lineId: string;
}

/** Rollback outcome reasons for observability in tests/logs. */
export type RollbackRejectionReason =
  | "unknown_operation"
  | "already_settled"
  | "superseded_by_authoritative"
  | "superseded_by_newer_mutation";

export type RollbackResult =
  | { applied: true }
  | { applied: false; reason: RollbackRejectionReason };

/** UI-facing refresh indicator state. */
export interface RefreshIndicator {
  /** True while an authoritative refresh is in flight. */
  isRefreshing: boolean;
  /**
   * Wall-clock ms between the last successful refresh request and its
   * authoritative response landing. `null` until the first refresh settles.
   */
  lastIndexingDelayMs: number | null;
}

interface OptimisticOp {
  opId: string;
  lineId: string;
  /** Deep clone of the line immediately before this mutation applied. */
  baseline: CreditLine;
  /** Cache data-generation at apply time; used to detect supersession. */
  appliedAtGeneration: number;
  settled: boolean;
}

interface CacheEntry {
  line: CreditLine;
  /** Epoch ms of when this entry last synced with authoritative data. */
  cachedAt: number;
}

export interface CreditLineCacheOptions {
  fetcher?: FetchAuthoritativeLines;
  seed?: CreditLine[];
  /** Injectable clock for deterministic indexing-delay measurements. */
  now?: () => number;
}

const cloneLine = (line: CreditLine): CreditLine =>
  JSON.parse(JSON.stringify(line)) as CreditLine;

export class CreditLineCache {
  private readonly listeners = new Set<() => void>();
  private readonly entries = new Map<string, CacheEntry>();
  private order: string[] = [];
  private readonly ops = new Map<string, OptimisticOp>();
  private readonly staleIds = new Set<string>();
  private readonly pendingRefreshIds = new Set<string>();

  private readonly fetcher: FetchAuthoritativeLines;
  private readonly nowFn: () => number;

  private opCounter = 0;
  /** Bumped whenever authoritative data replaces optimistic data. */
  private dataGeneration = 0;
  /** Monotonic guard for in-flight refreshes; only the latest may land. */
  private refreshGeneration = 0;
  private isRefreshing = false;
  private lastIndexingDelayMs: number | null = null;

  private linesSnapshot: CreditLine[] | null = null;
  private indicatorSnapshot: RefreshIndicator | null = null;

  constructor(options: CreditLineCacheOptions = {}) {
    this.fetcher = options.fetcher ?? fetchAuthoritativeLines;
    this.nowFn = options.now ?? Date.now;
    this.seedInternal(options.seed ?? MOCK_CREDIT_LINES);
  }

  // ── Subscription surface (useSyncExternalStore) ────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getLines = (): CreditLine[] => {
    if (!this.linesSnapshot) {
      this.linesSnapshot = this.order.map((id) => this.entries.get(id)!.line);
    }
    return this.linesSnapshot;
  };

  getRefreshIndicator = (): RefreshIndicator => {
    if (!this.indicatorSnapshot) {
      this.indicatorSnapshot = {
        isRefreshing: this.isRefreshing,
        lastIndexingDelayMs: this.lastIndexingDelayMs,
      };
    }
    return this.indicatorSnapshot;
  };

  getLine(lineId: string): CreditLine | undefined {
    return this.entries.get(lineId)?.line;
  }

  getStaleLineIds(): string[] {
    return [...this.staleIds];
  }

  // ── Targeted invalidation ──────────────────────────────────────────────────

  /**
   * Mark specific lines stale. Cached values keep rendering until an
   * authoritative refresh replaces them; unrelated lines are untouched.
   */
  invalidate = (lineIds: string[]): void => {
    let changed = false;
    for (const id of lineIds) {
      if (this.entries.has(id) && !this.staleIds.has(id)) {
        this.staleIds.add(id);
        changed = true;
      }
    }
    if (changed) {
      this.emit();
    }
  };

  // ── Optimistic mutations ───────────────────────────────────────────────────

  /**
   * Apply an optimistic mutation to one line. Returns a token usable for a
   * single rollback if the backing write later fails.
   */
  applyOptimistic(
    lineId: string,
    mutate: (current: CreditLine) => CreditLine,
  ): OptimisticMutationToken {
    const entry = this.entries.get(lineId);
    if (!entry) {
      throw new Error(`applyOptimistic: unknown credit line ${lineId}`);
    }

    this.opCounter += 1;
    const opId = `clm-${this.opCounter}`;
    const baseline = cloneLine(entry.line);

    // Only the most recent mutation on a line may roll back; record the
    // previous latest so it becomes permanently settled.
    for (const existing of this.ops.values()) {
      if (existing.lineId === lineId && !existing.settled) {
        existing.settled = true;
      }
    }

    entry.line = mutate(entry.line);
    entry.cachedAt = this.nowFn();
    this.ops.set(opId, {
      opId,
      lineId,
      baseline,
      appliedAtGeneration: this.dataGeneration,
      settled: false,
    });

    this.emit();
    return { opId, lineId };
  }

  /**
   * Undo one optimistic mutation, exactly once. Restores the pre-mutation
   * baseline unless newer state (an authoritative refresh or a later
   * mutation on the same line) has superseded it.
   */
  rollbackOptimistic(token: OptimisticMutationToken): RollbackResult {
    const op = this.ops.get(token.opId);
    if (!op || op.lineId !== token.lineId) {
      return { applied: false, reason: "unknown_operation" };
    }

    // Supersession outranks the generic settled flag: when authoritative
    // data replaced optimistic state, the precise reason is more useful
    // than a bare already_settled.
    if (op.appliedAtGeneration !== this.dataGeneration) {
      op.settled = true;
      return { applied: false, reason: "superseded_by_authoritative" };
    }
    if (op.settled) {
      return { applied: false, reason: "already_settled" };
    }

    const entry = this.entries.get(op.lineId);
    if (!entry) {
      op.settled = true;
      return { applied: false, reason: "unknown_operation" };
    }

    op.settled = true;
    entry.line = cloneLine(op.baseline);
    entry.cachedAt = this.nowFn();
    this.emit();
    return { applied: true };
  }

  // ── Authoritative refresh ──────────────────────────────────────────────────

  /**
   * Re-read canonical data for the given ids. Only the latest issued refresh
   * may apply its result; earlier ones are discarded when they eventually
   * settle (delayed / out-of-order responses). Only requested ids are
   * replaced — unrelated cached entries retain both value and identity.
   */
  refreshAffected = (lineIds: string[]): void => {
    const requested = lineIds.filter((id) => this.entries.has(id));
    if (requested.length === 0) {
      return;
    }

    this.refreshGeneration += 1;
    const generation = this.refreshGeneration;
    const requestedAt = this.nowFn();

    for (const id of requested) {
      this.pendingRefreshIds.add(id);
    }
    this.isRefreshing = true;
    this.emit();

    void this.fetcher(requested).then(
      (snapshot) => {
        if (generation !== this.refreshGeneration) {
          return; // Out-of-order response — discard entirely.
        }
        this.applyAuthoritative(snapshot, requested, requestedAt);
      },
      () => {
        if (generation !== this.refreshGeneration) {
          return;
        }
        for (const id of requested) {
          this.pendingRefreshIds.delete(id);
        }
        if (this.pendingRefreshIds.size === 0) {
          this.isRefreshing = false;
        }
        // Keep stale marks so a retry can be issued; cached values stand.
        this.emit();
      },
    );
  };

  private applyAuthoritative(
    snapshot: AuthoritativeSnapshot,
    requestedIds: string[],
    requestedAt: number,
  ): void {
    const fetchedById = new Map(snapshot.lines.map((l) => [l.id, l]));
    for (const id of requestedIds) {
      const fetched = fetchedById.get(id);
      const entry = this.entries.get(id);
      if (fetched && entry) {
        entry.line = fetched;
        entry.cachedAt = this.nowFn();
      }
      this.pendingRefreshIds.delete(id);
      this.staleIds.delete(id);
    }

    this.dataGeneration += 1;
    // Any still-pending optimistic op is now older than server truth.
    for (const op of this.ops.values()) {
      if (!op.settled && requestedIds.includes(op.lineId)) {
        op.settled = true;
      }
    }

    if (this.pendingRefreshIds.size === 0) {
      this.isRefreshing = false;
    }
    this.lastIndexingDelayMs = Math.max(0, this.nowFn() - requestedAt);

    this.emit();
  }

  // ── Reset ──────────────────────────────────────────────────────────────────

  /** Restore the cache to its seeded state and clear all bookkeeping. */
  reset(seed?: CreditLine[]): void {
    this.seedInternal(seed ?? this.currentSeed());
    this.ops.clear();
    this.staleIds.clear();
    this.pendingRefreshIds.clear();
    this.isRefreshing = false;
    this.lastIndexingDelayMs = null;
    this.dataGeneration += 1;
    this.refreshGeneration += 1;
    this.emit();
  }

  private initialSeed: CreditLine[] = MOCK_CREDIT_LINES;

  private currentSeed(): CreditLine[] {
    return this.initialSeed;
  }

  private seedInternal(lines: CreditLine[]): void {
    this.initialSeed = lines;
    this.entries.clear();
    this.order = [];
    for (const line of lines) {
      this.entries.set(line.id, { line, cachedAt: this.nowFn() });
      this.order.push(line.id);
    }
  }

  private emit(): void {
    this.linesSnapshot = null;
    this.indicatorSnapshot = null;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/**
 * Application-wide singleton wired to the simulated backend service.
 * Tests construct their own instances with injected fetchers/clocks instead.
 */
export const creditLineCache = new CreditLineCache({
  fetcher: fetchAuthoritativeLines,
});
