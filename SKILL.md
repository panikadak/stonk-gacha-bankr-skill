---
name: stonk-gacha
description: Pull and automatically deliver Stonk Gacha prizes on Base through the user's active Bankr EVM wallet. Also supports explicitly funded pulls, refunds, reserve funding, and permissionless profit distribution.
tags: [base, bankr, gacha, onchain-game, stonk-gacha]
version: 6
visibility: public
metadata:
  clawdbot:
    emoji: "🎁"
    homepage: "https://github.com/panikadak/stonk-gacha-bankr-skill"
    requires:
      bins: [node]
---

# Stonk Gacha for Bankr

Use the active authenticated Bankr EVM wallet on Base (chainId 8453). The local
scripts verify the reviewed deployment, read fresh contract state, simulate
every call, inspect allowlisted calldata, and prove mined Bankr receipts. They
never hold keys, sign, or broadcast.

## Normal pull

A current explicit request such as "pull me a $10 Stonk Gacha" authorizes
exactly one pack at that contract-read price, any required exact USDC allowance
reset or approval, one openPack, and same-wallet delivery of only the request
proven by that open receipt. Do not ask for another confirmation on this
already-funded path.

Resolve the active wallet and run:

~~~bash
node scripts/pull.mjs start --wallet 0xActiveBankrEvmWallet --amount-usdc 10
~~~

Do not run a separate verify, status, offers, planner, calldata-inspection, or
balance-report command first. Start performs the required live gates internally.

Then obey the returned JSON mechanically:

1. If txs contains one transaction, submit that exact transaction once through
   Bankr with waitForConfirmation true. Do not edit it, combine it with another
   transaction, or request another copy.
2. Replace TRANSACTION_HASH in next with the exact returned hash and run next
   immediately. A no-transaction watcher phase may also contain next; run it
   directly while the job can continue.
3. Repeat only through the emitted next. Every phase performs its own fresh
   deployment, intent, calldata, simulation, receipt, event, and post-state
   checks internally.
4. When presentation.mode is final-only, reply with
   presentation.finalMessage verbatim and nothing else.
5. If a hard blocker emits minimal-blocker, ask only its short userPrompt.
   Never turn an unknown submission outcome into a retry.

The compact command writes a private, atomic execution record before returning
each transaction. Therefore rerunning start is never a way to resend a
transaction. If a hash is lost, recover that exact hash from Bankr Activity and
run the stored phase's advance or finish command. The command resumes the same
receipt-bound request after a process restart; it never chooses a newer request
by recency, amount, or symbol.

After open, one advance call watches the exact request for up to 3300 seconds by
default, below Bankr's 60-minute job ceiling. Pending still emits no transaction
and remains resumable; it is never treated as a failed open or replay signal.

## User-facing behavior

Keep installation, verification, balances, allowance work, pack details, odds,
RTP, edge, ceiling, maximum payout, eligible stocks, Entropy fee, transaction
hashes, request state, watcher progress, quote, slippage, and journal data out
of the conversation.

Stay silent through approval, open, settlement, and claim. Only after the exact
claim receipt and fresh Delivered state pass should the user receive:

~~~text
You pulled $X of SYMBOL.
~~~

$X is the immutable request's USDC purchase budget, not the amount paid for the
pack and not a promise of current resale value. Never describe the pull as a
purchase of $X of stock.

## Funding exception

If pull.mjs start returns funding-required, no Gacha transaction is ready.
Read [references/funding-policy.json](references/funding-policy.json) and
[references/bankr-execution.md](references/bankr-execution.md). If the current
request explicitly names Base ETH or Base WETH as the source, use only that
source. Otherwise ask the emitted one-line source question.

Funding is a separate Bankr-native swap authorization. Never choose a wallet
asset, bridge, source chain, cheaper pack, or larger input automatically. After
the exact funding sequence is confirmed and mined, the existing funded planner
resumes exact approval, open, and receipt-bound same-wallet delivery without a
second claim confirmation. On X, also follow
[references/x-confirmation.md](references/x-confirmation.md).

## Hard rules

- Base only. Use canonical Base USDC for the pack and native Base ETH for the
  exact Pyth Entropy call value. WETH and sponsored gas are not native call
  value.
- Every planner result contains zero or one unsigned transaction. Submit one at
  a time and wait for its mined result.
- Use only exact USDC approvals. Reset a mismatched nonzero allowance first.
  Never use an unlimited approval.
- Never prepare approval and openPack together. Approval must mine before a
  fresh planner rechecks the same short-lived intent and unchanged wallet
  request-count baseline.
- PackOpened proves only a new exact request. Claim authorization must come
  from that receipt-bound continuation, must keep the active wallet as
  recipient, and must use a fresh nonzero 97% quote floor.
- Request state alone never proves delivery. The final sentence requires the
  exact successful claim receipt, scoped events, recipient proof, and fresh
  Delivered state.
- A pending, unavailable, timed-out, or otherwise ambiguous submission emits no
  replacement transaction. Reconcile the exact hash and Bankr Activity; never
  blind-replay.
- Only an exact receipt-bound transaction proven to have reverted may return to
  a fresh planner phase. A missing or merely reported failure is not retry
  authority. Permit at most one automatic proven-revert retry per phase.
- Never expose or accept replacement intent, continuation, randomness,
  inspection context, credential, private key, seed phrase, Bankr token, or RPC
  secret.
- Never sign directly to GachaTreasury or call owner, recovery, roster, route,
  pause, Entropy callback, role, governance, multisig, timelock, upgrade, or
  secret-bearing operations.
- Alternate recipients, custom slippage, standalone claims or refunds, reserve
  funding, and profit distribution require their own explicit request and the
  advanced workflow.

## References and advanced commands

The normal already-funded pull above is self-contained; do not load extra
references during its happy path.

- Crash recovery details:
  [references/runtime-journal.md](references/runtime-journal.md)
- Funding, X authorization, and Bankr receipt recovery:
  [references/bankr-execution.md](references/bankr-execution.md)
- Protocol states and standalone actions:
  [references/operations.md](references/operations.md)
- Reviewed deployment and default-deny transaction surface:
  [references/deployment.json](references/deployment.json),
  [references/signing-allowlist.json](references/signing-allowlist.json), and
  [references/bankr-execution.json](references/bankr-execution.json)

Use scripts/stonk-gacha.mjs directly only for those advanced flows or read-only
inspection. Treat any nonzero exit or ok false as a stop.
