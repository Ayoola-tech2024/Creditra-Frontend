# PREFLIGHT — #918 & #921 recon (read-only, done 2026-08-25 before assignment)

Purpose: pre-map code paths so implementation starts within hours of drips-wave[bot]
assignment. No code written yet per third-campaign rules.

## Issue #918 [High] — Safe wallet transaction lifecycle

### Existing infrastructure (reuse, don't rebuild)
- `src/types/wallet.ts` — `WalletType` = freighter | albedo | xbull | rabet;
  `ConnectionStatus` = disconnected|connecting|reconnecting|connected|error;
  `WalletError` = { type: not_found|connection_failed|wrong_network|user_rejected; message }.
- `src/utils/wallet.ts` — connect/disconnect/switchNetwork/isWalletInstalled via
  raw extension globals (NO stellar-sdk dep); namespaced localStorage
  (`creditra-wallet-info|recent|remember`), MRU list, remember opt-in.
- `src/context/WalletContext.tsx` — full connection lifecycle: auto-reconnect
  w/ RECONNECT_TIMEOUT_MS=8s banner, session timeout 30min + 60s warning,
  `stayConnected()` liveness ping, Horizon REST balance polling
  (`horizon[-testnet].stellar.org/accounts/{pk}`) on dropdown open every 30s.
- `src/utils/amountValidation.ts` — client-side repay guard rails
  (min/max/reserve) already exist and return structured feedback.
- `src/pages/RepayPage.tsx:172` `handleConfirm` — currently MOCK ONLY (no
  network/wallet call). This is the primary integration point.
- **No signing/submitting/XDR/Horizon-tx code exists anywhere** — greenfield.

### Planned shape (matches our claim comment)
- New `src/services/walletTransactionService.ts`: build → sign → submit →
  poll Horizon `/transactions/{hash}` for confirmation.
- New hook `useTransactionLifecycle` (or extend WalletContext): state machine
  idle→signing→submitting→confirming→confirmed|rejected|failed|timeout.
  - Rejection ≠ network-failure ≠ timeout (three distinct terminal states).
  - Idempotency: request-seq token like creditLineCache (#919 pattern) so a
    late response cannot overwrite newer state; retries create NEW tokens.
  - Timeout budget with clear UX; disconnect/stale-account checks pre-sign.
- Tests: retry/refresh/duplicate-submit/disconnect/rejection paths
  (mirror CreditLines.cache.test.tsx fake-timer patterns).

### Risks
- Real Freighter/Albedo APIs can't be exercised in jsdom → mock at the
  service boundary (same as creditLineAdminService backend-mirror pattern).
- Network/account mismatch handling overlaps shinzoxD's claimed #925 — keep
  scope to lifecycle states, leave deep network-guard polish to them if both
  get assigned.

## Issue #921 [Med] — Map credit API errors to actionable UI

### Current error surface (fragmented, ad hoc)
- Services throw mixed shapes: plain `Error('Failed to fetch linked accounts')`
  (linkedAccounts.ts:52) vs typed `{code,message}` objects (`AccountLinkError`,
  `WalletError`). No common taxonomy.
- Catch sites are hand-rolled per page: LinkedAccounts.tsx ×5, LoginPage,
  ForgotPasswordPage, settings/Data+Export, CollateralSubstitutionModal,
  Dashboard.tsx:164, CreditLines.tsx:400 (our rollback announcement).
- Toast infra READY: `src/hooks/useToast.ts` (success/error/warning/info via
  NotificationContext.addToast). aria-live precedent: LiveRegion in CreditLines.

### Planned shape (matches our claim comment)
- New `src/services/creditApiError.ts` (+ types): discriminated
  `CreditApiError { code, userMessage, action?, retrySafe }`.
  - `toCreditApiError(unknown): CreditApiError` normalizes plain Errors,
    AbortErrors, malformed payloads, unknown codes → safe generic message +
    correlation id.
  - Retry affordance only rendered when `retrySafe === true`.
- Wire into catch sites on credit surfaces first (CreditLines, Dashboard,
  RepayPage), then others opportunistically.
- Exhaustive per-code unit tests + one page test proving toast/LiveRegion copy
  comes from the map, not ad-hoc strings.

### Risks
- Scope creep across ALL pages — claim text scopes to *credit API* surfaces;
  note that boundary in the PR.
- Keep announcements compatible with existing CreditLines rollback message
  (arialive test asserts exact strings).

## Env notes for the PRs (disclose honestly)
- ESLint CLI broken in this env (flat-config migration message) — say so;
  gates = vitest + tsc baseline (main = 292 pre-existing errors, zero new).
- Branch naming/commit style: `feat(#<issue>): <summary>` off latest main.
