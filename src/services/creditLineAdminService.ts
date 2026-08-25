/**
 * creditLineAdminService — simulated backend for credit-line admin mutations
 * (issue #919: refresh stale credit-line data after mutations).
 *
 * The real backend indexes writes asynchronously: a confirmed status change
 * becomes readable through the authoritative read endpoint only after a short
 * indexing delay. This module models both halves so callers (and tests) can
 * exercise the full write → index → read cycle deterministically:
 *
 *  - `submitLineStatusChange` — the write path (freeze/unfreeze).
 *  - `fetchAuthoritativeLines` — the read path (post-index canonical data).
 *  - `resetBackendMirror` — reseeds the simulated backend state.
 *
 * The "backend" here is an in-memory mirror of {@link CreditLine}s. Confirmed
 * writes mutate the mirror; reads return deep clones so callers can never
 * alias backend state.
 */

import type { CreditLine, CreditLineStatus } from "../types/creditLine";
import { MOCK_CREDIT_LINES } from "../data/mockData";

/** Authoritative read payload, mirroring what the indexer would return. */
export interface AuthoritativeSnapshot {
  lines: CreditLine[];
  /** Server-side timestamp for when the index served this snapshot. */
  indexedAt?: string;
}

/** Typed failure codes for a rejected status-change submission. */
export type LineStatusChangeCode =
  | "network_error"
  | "timeout"
  | "rejected_by_backend";

/** Error thrown when `submitLineStatusChange` is rejected. */
export class LineStatusChangeError extends Error {
  readonly code: LineStatusChangeCode;

  constructor(code: LineStatusChangeCode, message?: string) {
    super(message ?? `Credit line status change failed (${code}).`);
    this.name = "LineStatusChangeError";
    this.code = code;
  }
}

/** Receipt returned after a confirmed status change. */
export interface LineStatusChangeReceipt {
  lineId: string;
  status: CreditLineStatus;
  updatedAt: string;
}

// ─── Simulated backend state ─────────────────────────────────────────────────

type BackendMirror = Map<string, CreditLine>;

function cloneLine(line: CreditLine): CreditLine {
  return JSON.parse(JSON.stringify(line)) as CreditLine;
}

function seedMirror(lines: CreditLine[]): BackendMirror {
  return new Map(lines.map((line) => [line.id, cloneLine(line)]));
}

let backendMirror: BackendMirror = seedMirror(MOCK_CREDIT_LINES);

/**
 * Reseed the simulated backend. Tests use this to isolate scenarios; the
 * production singleton never calls it.
 */
export function resetBackendMirror(seed: CreditLine[] = MOCK_CREDIT_LINES): void {
  backendMirror = seedMirror(seed);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ─── Write path ──────────────────────────────────────────────────────────────

export interface SubmitLineStatusChangeRequest {
  lineId: string;
  nextStatus: CreditLineStatus;
}

export interface SubmitLineStatusChangeOptions {
  /** Simulated round-trip latency in ms. */
  delayMs?: number;
  /** Force an outcome; defaults to a confirmed submission. */
  outcome?: { kind: "confirmed" } | { kind: "rejected"; code: LineStatusChangeCode };
}

/**
 * Submit a status change for a credit line. Resolves with a receipt once the
 * backend has accepted (and applied) the write; the read side may still lag
 * behind until indexing completes.
 */
export async function submitLineStatusChange(
  request: SubmitLineStatusChangeRequest,
  options: SubmitLineStatusChangeOptions = {},
): Promise<LineStatusChangeReceipt> {
  const delayMs = options.delayMs ?? 900;
  const outcome = options.outcome ?? { kind: "confirmed" };

  await delay(delayMs);

  if (outcome.kind === "rejected") {
    throw new LineStatusChangeError(outcome.code);
  }

  const line = backendMirror.get(request.lineId);
  if (!line) {
    throw new LineStatusChangeError(
      "rejected_by_backend",
      `Unknown credit line: ${request.lineId}`,
    );
  }

  line.status = request.nextStatus;
  line.updatedAt = new Date().toISOString();

  return { lineId: line.id, status: line.status, updatedAt: line.updatedAt };
}

// ─── Read path ───────────────────────────────────────────────────────────────

export interface FetchAuthoritativeLinesOptions {
  /** Simulated indexing + read latency in ms. */
  delayMs?: number;
}

/**
 * Read the canonical, post-index state for the requested credit-line ids.
 * Returns deep clones; mutating the result never touches backend state.
 */
export async function fetchAuthoritativeLines(
  lineIds: string[],
  options: FetchAuthoritativeLinesOptions = {},
): Promise<AuthoritativeSnapshot> {
  const delayMs = options.delayMs ?? 450;

  await delay(delayMs);

  const lines: CreditLine[] = [];
  for (const id of lineIds) {
    const line = backendMirror.get(id);
    if (line) {
      lines.push(cloneLine(line));
    }
  }

  return { lines, indexedAt: new Date().toISOString() };
}
