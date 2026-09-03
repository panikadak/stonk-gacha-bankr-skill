# Compact pull state

The compact pull CLI owns a private crash-recovery record. It writes the next
phase atomically before returning a transaction. Bankr still signs and
broadcasts; local state cannot create transaction authority.

## Location and authority

Records live at:

~~~text
~/.stonk-gacha/pulls/8453/<lowercase-wallet>/<directIntentKey-without-0x>.json
~~~

STONK_GACHA_PULLS_ROOT may replace only the root for tests. The production
location is fixed by references/bankr-execution.json.

Each record is mode 0600 inside a mode 0700 wallet directory. Writes use a
same-directory temporary file, file fsync, atomic rename, and directory fsync.
The reader rejects symlinks, noncanonical paths or JSON, loose permissions,
unknown fields, wrong wallet, wrong chain or deployment, and stale concurrent
revisions.

The pull id equals the direct intent key. The record revalidates the complete
direct intent and, after open, the complete receipt-bound claim continuation.
Its wallet, authorization, creation time, request id, open hash, continuation,
key, and expiry are immutable. Editing the file cannot widen or renew either
authorization.

Onchain state and exact successful receipts remain truth. This file is only a
private resume and replay-prevention aid. Bankr submission and a local file
write are not one atomic operation, so this design does not claim platform
exactly-once delivery.

## State machine

Normal stages are:

~~~text
allowance-reset-submitting
  -> approval-submitting
  -> open-submitting
  -> awaiting-settlement
  -> claim-submitting
  -> delivered
~~~

The allowance reset can move directly to open if fresh state already has the
exact allowance. Any pre-open stage may skip unnecessary allowance work, but
open is never prepared alongside approval. An exact proven pre-open revert is
first persisted as preopen-reverted, then either enters one fresh planner phase
or stops safely if replanning fails. Other terminal or stop states are expired,
refunded, stopped, and needs-reconciliation.

A submitting stage means its one transaction was marked consumed before being
returned to Bankr. It is not permission to rerun start or obtain another copy.
The exact returned hash must be passed to the emitted advance or finish command.

Every update uses compare-and-swap revision checks and a fixed transition
allowlist. Wallet-scoped start discovery captures a generation of every compact
record; final creation runs under a second exclusive lease and rejects the
prepared plan if that generation changed, including when a competing pull
already reached a terminal state. Record-scoped leases prevent phase updates
from silently overwriting each other. Lock files
are fully written before atomic hard-link acquisition, stale recovery is bound
to one observed inode under a separately recoverable reaper lease, and release
removes only the holder's own inode. A valid dead-owner lock older than five
minutes is recoverable; a live owner or malformed lock remains fail-closed. An
interrupted write leaves the prior canonical file intact.

## Recovery

At start, pull.mjs checks every nonterminal record for the active wallet before
planning a new write:

- awaiting-settlement resumes only its exact receipt-bound request watcher;
- an approval stage without a hash may advance only if a fresh allowance read
  unambiguously proves the previous post-state;
- open-submitting or claim-submitting without its exact hash never emits a
  replacement transaction;
- Delivered request state without the exact claim receipt never produces a
  result;
- expired or refunded requests never produce a prize claim;
- multiple unfinished compact pulls require exact reconciliation rather than a
  recency guess.

The direct pre-open authorization remains valid for two hours so an approval
confirmed near a Bankr turn limit can still resume through a fresh allowance,
request-count, offer, price, ceiling, fee, balance, and simulation gate. The
stored authorization never bypasses those live checks.

Recover a lost hash from Bankr Activity. Use the record's emitted command:

~~~bash
node scripts/pull.mjs advance --wallet 0xActiveWallet --pull-id PULL_ID --tx 0xExactHash
node scripts/pull.mjs finish  --wallet 0xActiveWallet --pull-id PULL_ID --tx 0xExactClaimHash
~~~

Receipt inspection proves the Bankr execution envelope, exact inner logical
call, deployment identity at the receipt block, scoped events, and fresh
post-state. A pending, unavailable, wrong, or otherwise unproved hash does not
authorize a retry. Only the exact persisted logical call, bound inspection
context, Bankr envelope, mined receipt, and receipt-block deployment together
may prove a revert. That proof can return the same unexpired direct intent to a
fresh pre-open planner, or a failed claim to the same request watcher. It never
reuses the reverted calldata. Each phase permits at most one such automatic
retry; a second proven revert emits no transaction.

If the request is already Delivered after a process restart, finish can recover
from the exact successful same-wallet claim hash without the prior in-memory
claim plan. It decodes only claimPrize for the stored request, proves the Bankr
envelope, receipt-block deployment, scoped delivery events, token movement, and
fresh Delivered state before producing the result. Request state without that
hash remains insufficient.

Continuation expiry removes automatic claim authority but does not hide
onchain terminal state. The watcher still recognizes Delivered, Expired, or
Refunded and updates the compact record accordingly. A nonterminal Pending or
Ready request instead asks for a fresh user decision and emits no transaction.

## Settlement

After the proven open receipt, advance stores its exact request id, open
transaction hash, and receipt-derived claim continuation before polling.
Pending timeouts emit no transaction and retain awaiting-settlement. Ready
produces one fresh same-wallet claim with a nonzero 97% quote floor and records
claim-submitting before returning it.

The compact wrapper uses one bounded watcher call of up to 3300 seconds by
default, below Bankr's 60-minute job ceiling. A process timeout does not expire
onchain state or renew authority; a later compact invocation resumes the same
request.

## User-facing boundary

Records, phases, polls, calldata, continuations, hashes, and recovery stay
private. Only finish can produce a successful final-only presentation, after
the exact claim receipt and fresh Delivered state agree:

~~~text
You pulled $X of SYMBOL.
~~~

If the finish process loses its output after recording Delivered, rerunning the
same emitted finish command with the same pull id and claim hash re-proves the
receipt and returns the same final-only sentence. It cannot accept a different
hash or create another pull.
