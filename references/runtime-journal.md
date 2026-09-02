# Pull resume record

This is a small, private crash-recovery record for Bankr. The local CLI stays
stateless and never signs or broadcasts.

## Authority and storage

- Onchain request state is truth.
- The exact unexpired receipt-bound continuation is silent claim authority.
- The journal is only a private resume hint; editing it cannot create or widen
  authority.

The pre-open intent lasts at most 600 seconds. After `inspect-tx` proves
`PackOpened`, same-wallet claim authority lasts at most 172800 seconds. Every
claim plan still uses a fresh quote and a deadline no more than 600 seconds from
its pinned snapshot. Journal state cannot renew either authorization.

Store one record per request at exactly:

```text
/stonk-gacha/pulls/8453/<lowercase-wallet>/<requestId>.json
```

Never store it under `/.memory`, `/cli`, `/skills`, `/runs`, the installed skill
directory, a repository, or a shared aggregate file. Never expose a
continuation, inspection context, credential, or calldata in chat, public/user-
visible logs, issues, or Git; protected CLI output is the runtime handoff.
Reject a mismatched chain, wallet, request, schema, path, symlink, redirect,
duplicate, or unknown field.

Immediately after the open receipt is proven, persist the exact record emitted
by `inspect-tx`:

```json
{
  "schemaVersion": 1,
  "chainId": 8453,
  "gacha": "0x...",
  "wallet": "0xlowercase",
  "requestId": "123",
  "openTransactionHash": "0x...",
  "claimContinuation": "0x...",
  "claimContinuationKey": "0x...",
  "claimContinuationExpiresAt": "unix-seconds",
  "stage": "awaiting-settlement",
  "claimInspectionContextHex": null,
  "claimInspectionKey": null,
  "claimTransactionHash": null
}
```

Write the exact CLI object without adding or decoding fields. Before claim
submission, the planner fills `claimInspectionContextHex` and
`claimInspectionKey`; retain those opaque values only so a recovered transaction
hash can be passed to `inspect-tx`. They are receipt-proof material, not resend
authority. Do not separately persist or reconstruct a quote, `minOut`, deadline,
token price, randomness, or pending claim calldata; generate them only from a
fresh `Ready` read.

For X, keep the authenticated original-tweet/thread mapping and final-reply
dedupe marker in the runtime's existing protected conversation state, not in
this JSON record. Routing data never authorizes a transaction and must not come
from tweet text. If trusted reply routing is unavailable after a restart, never
guess another thread.

The normal stages are `awaiting-settlement`, `ready`, `claim-submitting`,
`claim-submitted`, `needs-reconciliation`, `delivered`, `expired`, `refunded`,
and `stopped`. Keep one writer per request. Before a claim submission, accept
only `awaiting-settlement` or `ready` as the prior stage; if another execution
changed it, reconcile onchain state before doing anything.

## Reconcile first

At every Stonk Gacha skill invocation, resolve the authenticated active wallet
and reconcile all its nonterminal records before planning another write:

1. Validate the record and continuation.
2. Re-prove the source `PackOpened` receipt and exact request binding.
3. Read the request from one fresh canonical Base snapshot.
4. Reconcile any known claim hash with its receipt and Bankr Activity.

Process multiple records independently; never select by recency, amount, or
symbol. Reconciliation stays silent and must not block an unrelated read.

| Fresh state | Action |
|---|---|
| `Pending`, authority valid | Keep `awaiting-settlement` and resume only its exact watcher. |
| `Ready`, authority valid | Move to `ready` and build one fresh claim plan. |
| `Ready`, authority missing, invalid, stopped, or expired | No silent write; require normal standalone-claim confirmation. |
| `Delivered` | Never resubmit; recover and inspect the exact claim receipt before reporting it. Request state alone does not prove the recipient. |
| `Expired` or `Refunded` | Stop silent delivery; refund work needs its normal decision. |
| Unknown submission outcome | Move to `needs-reconciliation`; reconcile and never replay. |

## Await the exact request

```bash
node scripts/stonk-gacha.mjs await-claim-prize \
  --wallet 0xActiveBankrEvmWallet \
  --request-id REQUEST_ID \
  --claim-continuation 0xEXACT_RECEIPT_BOUND_CONTINUATION \
  --claim-continuation-key 0xEXACT_CONTINUATION_KEY \
  --max-wait-seconds BOUNDED_WAIT \
  --poll-interval-seconds BOUNDED_INTERVAL
```

The command re-proves the source receipt, wallet, request, continuation,
deployment, and each fresh observation. It never signs or broadcasts.
`Pending` at timeout emits no transaction and leaves the record resumable.
`Ready` emits at most one fresh default same-wallet claim plan. `Delivered`
emits no transaction and requires exact claim-receipt reconciliation before a
result; `Expired` and `Refunded` emit no claim transaction.

Keep each watcher comfortably below Bankr's
[60-minute job maximum](https://docs.bankr.bot/faq/building-ai-agents/). A
process timeout is not an authorization timeout. Preserve the record and resume
it in the same process when possible or at the next skill invocation; do not
post progress.

## Claim submission

Before Bankr submission, change `awaiting-settlement` or `ready` to
`claim-submitting` and retain the exact opaque claim inspection context/key. If
the stage changed unexpectedly, do not submit. Submit the unchanged inspected
planner transaction once. Record a returned hash in `claimTransactionHash` and
change to `claim-submitted` before receipt polling.

- Successful receipt plus fresh `Delivered` state becomes `delivered`.
- A proven revert may return to `ready` for a fresh plan while the same
  continuation remains valid.
- A timeout, connection loss, missing hash, pending receipt, or other uncertain
  result becomes `needs-reconciliation`. Reconcile the request, receipt, nonce
  or UserOperation, and Bankr Activity. Never submit a second claim while the
  first outcome is unknown.

Raw `/wallet/submit` has no documented idempotency key. These checks reduce
duplicate risk but do not promise platform-level exactly-once execution.

## Stop monitoring

For `stop monitoring pull N`, resolve the active wallet and exact record, stop
its active watcher, set only that record's stage to `stopped`, and clear its
continuation, key, and expiry without adding fields. Make no onchain
transaction. The request remains manually claimable under a new current user
decision.

## User-facing boundary

Journal writes, polls, resumes, and claim preparation stay internal. Only after
`inspect-tx` proves delivery and a fresh request read is `Delivered`, reply:

```text
You pulled $X of SYMBOL.
```
