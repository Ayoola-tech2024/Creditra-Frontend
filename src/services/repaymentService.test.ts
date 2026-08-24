import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RepaymentRejectedError,
  submitRepayment,
  type SettlementReceipt,
} from './repaymentService';

afterEach(() => {
  vi.useRealTimers();
});

function baseRequest() {
  return {
    opId: 'repay-1',
    lineId: 'CL-TEST-001',
    amount: 12500,
    utilizedAtSubmission: 50000,
  };
}

describe('submitRepayment', () => {
  it('resolves after settlement with an authoritative Completed receipt', async () => {
    const receipt = await submitRepayment(baseRequest(), { delayMs: 0 });

    expect(receipt.opId).toBe('repay-1');
    expect(receipt.utilizedAfter).toBe(37500);
    expect(receipt.updatedAt).toBeTruthy();
    expect(receipt.transaction?.status).toBe('Completed');
    expect(receipt.transaction?.type).toBe('Repay');
    expect(receipt.transaction?.amount).toBe(12500);
    expect(receipt.transaction?.txHash).toMatch(/^0x/);
  });

  it('never reports a negative authoritative balance', async () => {
    const receipt: SettlementReceipt = await submitRepayment(
      { ...baseRequest(), amount: 999999 },
      { delayMs: 0 },
    );
    expect(receipt.utilizedAfter).toBe(0);
  });

  it('rejects with a typed error when forced', async () => {
    await expect(
      submitRepayment(baseRequest(), {
        delayMs: 0,
        outcome: { kind: 'rejected', code: 'wallet_rejected' },
      }),
    ).rejects.toBeInstanceOf(RepaymentRejectedError);

    await expect(
      submitRepayment(baseRequest(), {
        delayMs: 0,
        outcome: { kind: 'rejected', code: 'network_error' },
      }),
    ).rejects.toMatchObject({ code: 'network_error' });
  });

  it('honors receipt overrides so tests can simulate indexer discrepancies', async () => {
    const receipt = await submitRepayment(baseRequest(), {
      delayMs: 0,
      receiptOverride: { utilizedAfter: 37000 },
    });
    expect(receipt.utilizedAfter).toBe(37000);
    // Non-overridden fields still populated.
    expect(receipt.opId).toBe('repay-1');
  });

  it('delays resolution by the requested latency (out-of-order test support)', async () => {
    vi.useFakeTimers();

    let settled = false;
    const slow = submitRepayment(baseRequest(), { delayMs: 5_000 }).then(
      (r) => {
        settled = true;
        return r;
      },
    );
    const fast = submitRepayment({ ...baseRequest(), opId: 'repay-2' }, {
      delayMs: 100,
    });

    await vi.advanceTimersByTimeAsync(150);
    expect(settled).toBe(false); // slow one still pending — ordering preserved

    await vi.advanceTimersByTimeAsync(4_900);
    const [fastReceipt, slowReceipt] = await Promise.all([fast, slow]);
    expect(fastReceipt.opId).toBe('repay-2');
    expect(slowReceipt.opId).toBe('repay-1');
    expect(settled).toBe(true);
  });
});
