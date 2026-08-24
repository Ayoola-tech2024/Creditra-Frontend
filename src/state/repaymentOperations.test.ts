import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPTIMISTIC_PENDING_TX_PREFIX,
  RepaymentStore,
} from './repaymentOperations';
import type { CreditLine } from '@/types/creditLine';

function makeLine(overrides: Partial<CreditLine> = {}): CreditLine {
  return {
    id: 'CL-TEST-001',
    name: 'Test Line',
    status: 'Active',
    limit: 100000,
    utilized: 50000,
    apr: 8.5,
    riskScore: 700,
    openedAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-06-01T00:00:00Z',
    transactions: [],
    statusHistory: [{ status: 'Active', date: '2024-01-01' }],
    ...overrides,
  };
}

let store: RepaymentStore;

beforeEach(() => {
  store = new RepaymentStore([makeLine()]);
});

describe('operation identity', () => {
  it('assigns unique monotonic opIds so repeated retries remain distinct', () => {
    const first = store.beginRepayment('CL-TEST-001', 5000);
    const retry = store.beginRepayment('CL-TEST-001', 5000);

    expect(first.opId).not.toEqual(retry.opId);
    expect(first.opId).toBe('repay-1');
    expect(retry.opId).toBe('repay-2');
    expect(store.getOperations()).toHaveLength(2);
  });

  it('begins in pending status with a baseline snapshot untouched by later mutation', () => {
    const op = store.beginRepayment('CL-TEST-001', 20000);
    expect(op.status).toBe('pending');
    expect(op.lineId).toBe('CL-TEST-001');
    expect(op.amount).toBe(20000);
  });

  it('rejects unknown lines and invalid amounts', () => {
    expect(() => store.beginRepayment('CL-GHOST', 10)).toThrow(/unknown credit line/i);
    expect(() => store.beginRepayment('CL-TEST-001', 0)).toThrow(RangeError);
    expect(() => store.beginRepayment('CL-TEST-001', -5)).toThrow(RangeError);
  });
});

describe('optimistic application', () => {
  it('immediately reduces the balance and appends a Pending transaction marker', () => {
    store.beginRepayment('CL-TEST-001', 12500);

    const line = store.getLine('CL-TEST-001')!;
    expect(line.utilized).toBe(37500);
    const pending = line.transactions.find((tx) =>
      tx.id.startsWith(OPTIMISTIC_PENDING_TX_PREFIX),
    );
    expect(pending).toBeDefined();
    expect(pending?.status).toBe('Pending');
    expect(pending?.amount).toBe(12500);
  });

  it('notifies subscribers and produces referentially-stable snapshots between mutations', () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    const before = store.getLines();
    expect(listener).not.toHaveBeenCalled();

    store.beginRepayment('CL-TEST-001', 100);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getLines()).not.toBe(before);

    unsubscribe();
    store.beginRepayment('CL-TEST-001', 100);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('authoritative reconciliation', () => {
  it('applies server-canonical values on confirmation, replacing the pending marker', () => {
    const op = store.beginRepayment('CL-TEST-001', 20000);
    // Server disagrees slightly with local math (e.g. fees): trust the server.
    const outcome = store.confirmRepayment(op.opId, {
      utilizedAfter: 30500,
      updatedAt: '2024-07-02T12:00:00Z',
    });

    expect(outcome.applied).toBe(true);
    const line = store.getLine('CL-TEST-001')!;
    expect(line.utilized).toBe(30500);
    expect(line.updatedAt).toBe('2024-07-02T12:00:00Z');
    expect(
      line.transactions.some((tx) =>
        tx.id.startsWith(OPTIMISTIC_PENDING_TX_PREFIX),
      ),
    ).toBe(false);
    const completed = line.transactions[line.transactions.length - 1]!;
    expect(completed.status).toBe('Completed');
    expect(completed.type).toBe('Repay');

    const settled = store.getOperation(op.opId)!;
    expect(settled.status).toBe('confirmed');
    expect(settled.settledAt).toBeDefined();
  });

  it('never re-applies an already-settled operation (idempotent confirm)', () => {
    const op = store.beginRepayment('CL-TEST-001', 10000);
    store.confirmRepayment(op.opId, { utilizedAfter: 40000, updatedAt: 'x' });

    const second = store.confirmRepayment(op.opId, {
      utilizedAfter: 999999,
      updatedAt: 'y',
    });
    expect(second.applied).toBe(false);
    expect(second.reason).toBe('already_settled');
    expect(store.getLine('CL-TEST-001')!.utilized).toBe(40000);
  });
});

describe('exactly-once rollback', () => {
  it('restores the prior balance exactly once when a repayment is rejected', () => {
    const op = store.beginRepayment('CL-TEST-001', 15000);
    expect(store.getLine('CL-TEST-001')!.utilized).toBe(35000);

    const result = store.failRepayment(op.opId);
    expect(result.rolledBack).toBe(true);

    const restored = store.getLine('CL-TEST-001')!;
    expect(restored.utilized).toBe(50000);
    expect(restored.updatedAt).toBe('2024-06-01T00:00:00Z');
    expect(
      restored.transactions.some((tx) =>
        tx.id.startsWith(OPTIMISTIC_PENDING_TX_PREFIX),
      ),
    ).toBe(false);

    const settled = store.getOperation(op.opId)!;
    expect(settled.status).toBe('rolled_back');
  });

  it('is a no-op on repeated failure handling (terminal-state guard)', () => {
    const op = store.beginRepayment('CL-TEST-001', 15000);
    store.failRepayment(op.opId);

    const again = store.failRepayment(op.opId);
    expect(again.rolledBack).toBe(false);
    expect(again.reason).toBe('already_settled');
    // No double refund.
    expect(store.getLine('CL-TEST-001')!.utilized).toBe(50000);
  });

  it('cannot be rolled back after confirmation and vice versa', () => {
    const opA = store.beginRepayment('CL-TEST-001', 1000);
    store.confirmRepayment(opA.opId, { utilizedAfter: 49000, updatedAt: 'z' });
    expect(store.failRepayment(opA.opId).reason).toBe('already_settled');
    expect(store.getLine('CL-TEST-001')!.utilized).toBe(49000);

    const opB = store.beginRepayment('CL-TEST-001', 1000);
    store.failRepayment(opB.opId);
    expect(
      store.confirmRepayment(opB.opId, { utilizedAfter: 1, updatedAt: 'w' })
        .reason,
    ).toBe('already_settled');
  });

  it('returns unknown_operation for a nonexistent opId', () => {
    expect(store.failRepayment('repay-404').reason).toBe('unknown_operation');
    expect(store.confirmRepayment('repay-404', { utilizedAfter: 0, updatedAt: '' }).reason).toBe(
      'unknown_operation',
    );
  });
});

describe('late responses cannot overwrite newer state', () => {
  it('ignores a stale confirmation that arrives after a newer operation began', () => {
    const first = store.beginRepayment('CL-TEST-001', 5000); // seq 1
    const second = store.beginRepayment('CL-TEST-001', 3000); // seq 2
    // Newer op settles first.
    store.confirmRepayment(second.opId, {
      utilizedAfter: 42000,
      updatedAt: '2024-07-03T00:00:00Z',
    });
    // The older confirmation arrives LATE.
    const outcome = store.confirmRepayment(first.opId, {
      utilizedAfter: 45000, // would clobber the newer authoritative value
      updatedAt: '2024-07-04T00:00:00Z',
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe('superseded');
    expect(store.getOperation(first.opId)!.status).toBe('confirmed');
    // Newer state survived untouched.
    const line = store.getLine('CL-TEST-001')!;
    expect(line.utilized).toBe(42000);
    expect(line.updatedAt).toBe('2024-07-03T00:00:00Z');
  });

  it('rolls back only its own delta when failing behind a newer concurrent repayment', () => {
    const first = store.beginRepayment('CL-TEST-001', 8000); // 50k -> 42k
    store.beginRepayment('CL-TEST-001', 2000); // 42k -> 40k

    const result = store.failRepayment(first.opId);
    expect(result.rolledBack).toBe(true);
    // Only op #1's delta is removed: 40k + 8k = 48k, NOT the 50k baseline
    // (which would also undo the still-pending newer repayment).
    expect(store.getLine('CL-TEST-001')!.utilized).toBe(48000);
  });

  it('keeps concurrent repayments distinct across mixed outcomes', () => {
    const a = store.beginRepayment('CL-TEST-001', 10000); // 50k -> 40k
    const b = store.beginRepayment('CL-TEST-001', 5000); // 40k -> 35k
    const c = store.beginRepayment('CL-TEST-001', 2500); // 35k -> 32.5k

    // Middle operation rejects: only its own delta is removed.
    expect(store.failRepayment(b.opId).rolledBack).toBe(true);
    expect(store.getLine('CL-TEST-001')!.utilized).toBe(37500); // 32.5k + 5k

    // Newest operation settles authoritatively.
    expect(
      store.confirmRepayment(c.opId, {
        utilizedAfter: 30000,
        updatedAt: '2024-07-05T00:00:00Z',
      }).applied,
    ).toBe(true);

    // Oldest confirmation arrives last — recorded but never applied.
    const stale = store.confirmRepayment(a.opId, {
      utilizedAfter: 11111,
      updatedAt: '2024-07-06T00:00:00Z',
    });
    expect(stale.applied).toBe(false);
    expect(stale.reason).toBe('superseded');

    const line = store.getLine('CL-TEST-001')!;
    expect(line.utilized).toBe(30000);
    expect(store.getOperation(a.opId)!.status).toBe('confirmed');
    expect(store.getOperation(b.opId)!.status).toBe('rolled_back');
    expect(store.getOperation(c.opId)!.status).toBe('confirmed');
  });
});

describe('refresh resilience', () => {
  it('applies whatever authoritative payload arrives, including refreshed values differing from local math', () => {
    const op = store.beginRepayment('CL-TEST-001', 20000);
    store.confirmRepayment(op.opId, {
      utilizedAfter: 29999.99,
      updatedAt: '2024-08-01T09:30:00Z',
      transaction: {
        id: 'TXN-SERVER-77',
        type: 'Repay',
        amount: 20000,
        date: '2024-08-01T09:30:00Z',
        status: 'Completed',
        txHash: '0xfeedface',
      },
    });

    const line = store.getLine('CL-TEST-001')!;
    expect(line.utilized).toBe(29999.99);
    const lastTx = line.transactions[line.transactions.length - 1]!;
    expect(lastTx.id).toBe('TXN-SERVER-77');
    expect(lastTx.txHash).toBe('0xfeedface');
  });

  it('does not leak internal fields through the public operations view', () => {
    store.beginRepayment('CL-TEST-001', 100);
    const ops = store.getOperations();
    expect(ops[0]).not.toHaveProperty('baseline');
    expect(ops[0]).not.toHaveProperty('seq');
  });

  it('reset() restores pristine seeded state for isolation between tests', () => {
    store.beginRepayment('CL-TEST-001', 7000);
    store.reset([makeLine({ utilized: 12345 })]);
    expect(store.getOperations()).toHaveLength(0);
    expect(store.getLine('CL-TEST-001')!.utilized).toBe(12345);
  });
});
