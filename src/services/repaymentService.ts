import type { RepaymentAuthoritativeResult } from '@/state/repaymentOperations';

/**
 * Typed rejection reasons the UI can branch on. A wallet rejection and a
 * network failure both roll back, but deserve different user messaging.
 */
export type RepaymentRejectionCode =
  | 'wallet_rejected'
  | 'network_error'
  | 'insufficient_funds'
  | 'timeout';

/** Error thrown when a repayment fails to settle. */
export class RepaymentRejectedError extends Error {
  code: RepaymentRejectionCode;

  constructor(code: RepaymentRejectionCode, message?: string) {
    super(message ?? `Repayment rejected (${code})`);
    this.name = 'RepaymentRejectedError';
    this.code = code;
  }
}

export interface RepaymentRequest {
  opId: string;
  lineId: string;
  amount: number;
  /** Balance at submission time; used to compute the authoritative result. */
  utilizedAtSubmission: number;
}

/**
 * Test-controllable settlement behaviour. Production calls submitRepayment
 * without options (realistic ~1.2s settlement); tests pass explicit
 * outcomes/delays to exercise success, rejection, refresh and out-of-order
 * response ordering deterministically.
 */
export interface SubmitOptions {
  /** Artificial network latency in ms (default 1200). */
  delayMs?: number;
  /** Force an outcome instead of the default confirmed settlement. */
  outcome?: { kind: 'confirmed' } | { kind: 'rejected'; code: RepaymentRejectionCode };
  /** Field-level overrides merged into the authoritative receipt. */
  receiptOverride?: Partial<RepaymentAuthoritativeResult>;
}

export type SettlementReceipt = RepaymentAuthoritativeResult & {
  opId: string;
};

let txCounter = 0;

/**
 * Mock repayment settlement service.
 *
 * Stands in for the future backend call: submits, waits, then resolves with
 * an AUTHORITATIVE post-settlement payload or rejects with a typed error.
 * The store consumes either path — confirm for reconciliation, failure for
 * exactly-once rollback.
 */
export function submitRepayment(
  request: RepaymentRequest,
  options: SubmitOptions = {},
): Promise<SettlementReceipt> {
  const delay = options.delayMs ?? 1200;
  const outcome = options.outcome ?? { kind: 'confirmed' as const };

  return new Promise<SettlementReceipt>((resolve, reject) => {
    window.setTimeout(() => {
      if (outcome.kind === 'rejected') {
        reject(new RepaymentRejectedError(outcome.code));
        return;
      }

      txCounter += 1;
      resolve({
        opId: request.opId,
        utilizedAfter: Math.max(
          0,
          request.utilizedAtSubmission - request.amount,
        ),
        updatedAt: new Date().toISOString(),
        transaction: {
          id: `TXN-SETTLE-${txCounter}-${request.opId}`,
          type: 'Repay',
          amount: request.amount,
          date: new Date().toISOString(),
          note: 'Repayment settled on-chain',
          status: 'Completed',
          txHash: `0x${(txCounter * 0x9e3779b9)
            .toString(16)
            .padStart(8, '0')}${request.opId.replace(/[^a-z0-9]/gi, '')}`,
        },
        ...options.receiptOverride,
      });
    }, delay);
  });
}
