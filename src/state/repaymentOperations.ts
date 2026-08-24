import type { CreditLine, Transaction } from '@/types/creditLine';
import { MOCK_CREDIT_LINES } from '@/data/mockData';

/**
 * Lifecycle of a single optimistic repayment operation.
 *
 * `pending`  — submitted optimistically, awaiting authoritative settlement.
 * `confirmed` — the backend accepted the repayment; authoritative values applied.
 * `rolled_back` — the backend rejected/failed the operation; its effect was
 *                 removed from local state EXACTLY ONCE.
 *
 * `confirmed` and `rolled_back` are terminal. Every transition into them is
 * guarded, which is what guarantees the "exactly once" rollback property:
 * calling `failRepayment` twice can never double-refund the displayed balance.
 */
export type RepaymentOpStatus = 'pending' | 'confirmed' | 'rolled_back';

export interface RepaymentOperation {
  /**
   * Monotonic operation identifier (`repay-1`, `repay-2`, …). Every user
   * attempt — including retries of a previously failed repayment — gets a
   * fresh opId so repeated attempts remain distinct operations.
   */
  opId: string;
  lineId: string;
  /** Amount the user asked to repay. Always positive and finite. */
  amount: number;
  status: RepaymentOpStatus;
  createdAt: string;
  settledAt?: string;
}

/**
 * Authoritative post-settlement payload. Mirrors what a real indexer/API
 * would return; the store applies these values verbatim on confirmation
 * (server-canonical reconciliation) instead of trusting local arithmetic.
 */
export interface RepaymentAuthoritativeResult {
  utilizedAfter: number;
  updatedAt: string;
  transaction?: Transaction;
}

/** Result of attempting to settle an operation. */
export interface SettleOutcome {
  applied: boolean;
  reason?: 'already_settled' | 'superseded' | 'unknown_operation';
}

interface InternalOperation extends RepaymentOperation {
  /** Deep clone of the line captured when the operation began. */
  baseline: CreditLine;
  /** Monotonic sequence number used to order operations on the same line. */
  seq: number;
}

export const OPTIMISTIC_PENDING_TX_PREFIX = 'TXN-PENDING';

function cloneLine(line: CreditLine): CreditLine {
  return {
    ...line,
    transactions: [...line.transactions],
    statusHistory: [...line.statusHistory],
    aprHistory: line.aprHistory ? [...line.aprHistory] : undefined,
  };
}

/**
 * repaymentStore — framework-free observable store for optimistic repayments.
 *
 * Responsibilities (issue #922 scope):
 *  1. Operation identity — every attempt gets a unique monotonic opId.
 *  2. Optimistic application — balances update immediately on submission.
 *  3. Authoritative reconciliation — confirmations overwrite with server data.
 *  4. Exactly-once rollback — failures restore the prior balance under a
 *     terminal-state-machine guard; late/duplicate settlement calls are no-ops.
 *  5. Late-response safety — a stale confirmation arriving after a newer
 *     operation began on the same line never overwrites the newer state.
 */
class RepaymentStore {
  private lines: CreditLine[] = [];
  private ops = new Map<string, InternalOperation>();
  private opCounter = 0;
  private seqCounter = 0;

  private listeners = new Set<() => void>();
  private linesSnapshot: CreditLine[] = [];
  private opsSnapshot: RepaymentOperation[] = [];

  constructor(seed?: CreditLine[]) {
    this.reset(seed);
  }

  /** Re-seed the store (app bootstrap or tests). Deep-clones input. */
  reset(seed: CreditLine[] = []): void {
    this.lines = seed.map(cloneLine);
    this.ops = new Map();
    this.opCounter = 0;
    this.seqCounter = 0;
    this.rebuildSnapshots();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Referentially-stable lines snapshot for useSyncExternalStore. */
  getLines = (): CreditLine[] => this.linesSnapshot;

  /** Referentially-stable read-only view of all operations (creation order). */
  getOperations = (): RepaymentOperation[] => this.opsSnapshot;

  getOperation(opId: string): RepaymentOperation | undefined {
    return this.ops.get(opId);
  }

  getLine(lineId: string): CreditLine | undefined {
    return this.lines.find((cl) => cl.id === lineId);
  }

  /**
   * Begin an optimistic repayment: registers a distinct pending operation,
   * snapshots the line baseline, and immediately applies the optimistic
   * balance reduction plus a Pending transaction marker.
   */
  beginRepayment(lineId: string, amount: number): RepaymentOperation {
    const line = this.getLine(lineId);
    if (!line) {
      throw new Error(`beginRepayment: unknown credit line "${lineId}"`);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new RangeError(`beginRepayment: invalid amount ${amount}`);
    }

    this.opCounter += 1;
    this.seqCounter += 1;
    const opId = `repay-${this.opCounter}`;
    const now = new Date().toISOString();

    const op: InternalOperation = {
      opId,
      lineId,
      amount,
      status: 'pending',
      createdAt: now,
      baseline: cloneLine(line),
      seq: this.seqCounter,
    };
    this.ops.set(opId, op);

    const pendingTx: Transaction = {
      id: `${OPTIMISTIC_PENDING_TX_PREFIX}-${opId}`,
      type: 'Repay',
      amount,
      date: now,
      note: 'Optimistic repayment — awaiting confirmation',
      status: 'Pending',
    };

    this.lines = this.lines.map((cl) =>
      cl.id === lineId
        ? {
            ...cl,
            utilized: cl.utilized - amount,
            updatedAt: now,
            lastActivityAt: now,
            transactions: [...cl.transactions, pendingTx],
          }
        : cl,
    );

    this.rebuildSnapshots();
    const publicOp: RepaymentOperation = {
      opId: op.opId,
      lineId: op.lineId,
      amount: op.amount,
      status: op.status,
      createdAt: op.createdAt,
    };
    return publicOp;
  }

  /**
   * Confirm an operation with authoritative server data.
   *
   * Guards:
   *  - Non-pending operations are never re-applied (`already_settled`).
   *  - If a newer operation has begun/settled on the same line, this late
   *    confirmation is recorded as settled but does NOT touch the line
   *    (`superseded`) — newer state wins.
   */
  confirmRepayment(
    opId: string,
    authoritative: RepaymentAuthoritativeResult,
  ): SettleOutcome {
    const op = this.ops.get(opId);
    if (!op) return { applied: false, reason: 'unknown_operation' };
    if (op.status !== 'pending') {
      return { applied: false, reason: 'already_settled' };
    }

    op.status = 'confirmed';
    op.settledAt = new Date().toISOString();
    this.rebuildSnapshots();

    if (this.latestSeqForLine(op.lineId) !== op.seq) {
      // A newer operation exists on this line — its state is canonical now.
      return { applied: false, reason: 'superseded' };
    }

    const settledTx: Transaction = authoritative.transaction ?? {
      id: `TXN-${opId}`,
      type: 'Repay',
      amount: op.amount,
      date: authoritative.updatedAt,
      note: 'Repayment confirmed',
      status: 'Completed',
    };

    this.lines = this.lines.map((cl) => {
      if (cl.id !== op.lineId) return cl;
      return {
        ...cl,
        utilized: authoritative.utilizedAfter,
        updatedAt: authoritative.updatedAt,
        lastActivityAt: authoritative.updatedAt,
        transactions: [
          ...cl.transactions.filter(
            (tx) => !tx.id.startsWith(`${OPTIMISTIC_PENDING_TX_PREFIX}-`),
          ),
          settledTx,
        ],
      };
    });

    this.rebuildSnapshots();
    return { applied: true };
  }

  /**
   * Roll back a failed/rejected operation — EXACTLY ONCE.
   *
   * Only pending operations can roll back; the terminal-state guard makes any
   * second call a no-op, so double-failure handling can never double-refund.
   *
   * Restore strategy:
   *  - Latest operation on its line → restore the full baseline snapshot
   *    (prior balance, prior updatedAt, prior transaction list).
   *  - Superseded by newer operations → remove only THIS operation's delta
   *    (add its amount back to the current balance) and drop its pending
   *    transaction marker, leaving newer operations untouched.
   */
  failRepayment(opId: string): SettleOutcome & { rolledBack: boolean } {
    const op = this.ops.get(opId);
    if (!op)
      return { applied: false, rolledBack: false, reason: 'unknown_operation' };
    if (op.status !== 'pending') {
      return { applied: false, rolledBack: false, reason: 'already_settled' };
    }

    op.status = 'rolled_back';
    op.settledAt = new Date().toISOString();

    if (this.latestSeqForLine(op.lineId) === op.seq) {
      this.lines = this.lines.map((cl) =>
        cl.id === op.lineId ? op.baseline : cl,
      );
    } else {
      this.lines = this.lines.map((cl) => {
        if (cl.id !== op.lineId) return cl;
        return {
          ...cl,
          utilized: cl.utilized + op.amount,
          transactions: cl.transactions.filter(
            (tx) => tx.id !== `${OPTIMISTIC_PENDING_TX_PREFIX}-${opId}`,
          ),
        };
      });
    }

    this.rebuildSnapshots();
    return { applied: false, rolledBack: true };
  }

  /** Sequence number of the most recent operation on a line (0 if none). */
  private latestSeqForLine(lineId: string): number {
    let latest = 0;
    for (const candidate of this.ops.values()) {
      if (candidate.lineId === lineId && candidate.seq > latest) {
        latest = candidate.seq;
      }
    }
    return latest;
  }

  private rebuildSnapshots(): void {
    this.linesSnapshot = this.lines.map(cloneLine);
    this.opsSnapshot = [...this.ops.values()].map(
      ({ baseline: _baseline, seq: _seq, ...publicOp }) => publicOp,
    );
    for (const listener of this.listeners) listener();
  }
}

/**
 * App singleton seeded from mock data. Pages subscribe via
 * `useSyncExternalStore(repaymentStore.subscribe, repaymentStore.getLines)`.
 * Tests construct isolated instances with `new RepaymentStore(seedLines)`.
 */
export const repaymentStore = new RepaymentStore(MOCK_CREDIT_LINES);
export { RepaymentStore };
