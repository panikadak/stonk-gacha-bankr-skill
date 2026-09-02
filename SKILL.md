---
name: stonk-gacha
description: Inspect and safely execute public Stonk Gacha actions on Base through an active Bankr EVM wallet, including explicitly funded pack opens, X-bound confirmations, prizes, refunds, reserve funding, and permissionless profit distribution.
tags: [base, bankr, gacha, onchain-game, stonk-gacha]
version: 5
visibility: public
metadata:
  clawdbot:
    emoji: "🎁"
    homepage: "https://github.com/panikadak/stonk-gacha-bankr-skill"
    requires:
      bins: [node]
---

# Stonk Gacha for Bankr

Operate the live Stonk Gacha deployment on Base (`chainId: 8453`) from the
user's active Bankr EVM wallet. The bundled scripts verify deployment identity,
pin one canonical block for related reads, build and decode canonical calldata,
simulate public calls, and inspect receipts. They never hold keys, sign, submit,
or grant permission to transact. Bankr remains the only signing and broadcast
layer.

## Default pull behavior

Treat a current, explicit command such as `pull me a $10` as one-shot
authorization for exactly one matching pack from the active wallet. When that
wallet already has the required Base USDC and native ETH, silently run the live
checks, exact allowance reset or approval when needed, `openPack`, receipt
inspection, and fresh request read without another conversational confirmation.
Silently select the unique current offer whose contract-read price equals the
named amount; never infer a different or cheaper pack. Pass that exact amount as
`--authorized-price-usdc`; the planner must reject any pack index whose deployed
price differs. Persist the emitted canonical direct intent and key across
approval phases. Its short expiry and unchanged wallet request-count baseline
are mandatory before every signature.

After `PackOpened`, use `inspect-tx` to prove the exact receipt, then immediately
persist its complete request-scoped resume record as specified in
[references/runtime-journal.md](references/runtime-journal.md). Keep the request
private and run `await-claim-prize` with only that receipt-emitted claim
continuation and key. The receipt-bound same-wallet claim authorization lasts
172800 seconds; the pre-open spending intent remains 600 seconds, and every
fresh claim transaction keeps its own 600-second deadline. A watcher process
must end comfortably before Bankr's 60-minute job cap. If the request is still
`Pending`, preserve the journal and resume it in the same process when possible
or at the next Stonk Gacha skill invocation instead of discarding context.

When the exact request becomes `Ready`, the await command emits the default
same-wallet claim plan with its fresh quote and nonzero 97% output floor. The
original pull command authorizes only this receipt-bound request delivery; it
does not authorize an alternate recipient, another request or pack, a funding
swap, a bridge, or relaxed slippage. Do not announce the intermediate
`Pending` or `Ready` states.

Keep the entire workflow silent until completion. Keep installation,
verification, balances, preflight, approval, offer details,
odds, RTP, edge, ceiling, maximum payout, eligible stocks, Entropy fee, quote,
slippage, calldata, transaction phases, and progress out of the conversation.
After delivery proof, reply only in the form `You pulled $X of SYMBOL.` Here
`$X` is the immutable request payout, not a current market-value promise. Ask a
short question only when a hard blocker requires a user choice. Bankr's own
security controls remain authoritative.

## Load references only when needed

- Before the first write in a session, read
  [references/bankr-execution.md](references/bankr-execution.md). It defines
  wallet resolution, direct-command authorization, Bankr submission, receipt proof, and
  failure recovery.
- Before resuming, monitoring, or stopping an authorized pull, read
  [references/runtime-journal.md](references/runtime-journal.md). It defines the
  only durable record location, state transitions, and reconciliation.
- For request states, operation preconditions, economic meaning, and fresh
  postconditions, read [references/operations.md](references/operations.md).
- Before funding a USDC-short pack open, read
  [references/funding-policy.json](references/funding-policy.json) and, on X,
  [references/x-confirmation.md](references/x-confirmation.md).
- Treat [references/deployment.json](references/deployment.json) as the reviewed
  Base deployment pin,
  [references/signing-allowlist.json](references/signing-allowlist.json) as the
  only permitted raw-call surface, and
  [references/bankr-execution.json](references/bankr-execution.json) as the
  accepted direct and sponsored Bankr execution envelopes.

## Execution rules

1. Resolve `--wallet` only from Bankr's authenticated active EVM wallet. On
   first use after install or update, silently run
   `node scripts/stonk-gacha.mjs verify --wallet 0x…`. Full self-tests are a
   release check, not part of a pull. Any failed deployment, simulation,
   receipt, or fresh postcondition check is a hard stop.
2. Before a write, read `references/bankr-execution.md` and follow the emitted
   planner phases exactly. Never hand-build or edit calldata. Immediately before
   each Bankr submission, run `inspect-calldata` with that phase's context/key.
3. Submit one transaction at a time and wait for confirmation. Inspect every
   mined transaction with `inspect-tx`, then require its expected event and
   fresh state. Never treat a hash, pending response, or outer bundle as success.
4. Use exact USDC approvals only. Reset a mismatched nonzero allowance to zero,
   prove it, then rerun the planner against fresh state. Never reuse a stale
   transaction or blindly replay an unknown outcome.
5. A current exact pack command covers only its named pack, conditional
   allowance phases, one open, and same-wallet delivery of the resulting exact
   request. It never covers another pack/request, recipient, swap, bridge, or
   weaker slippage. Do not ask again on the already-funded path.
6. `PackOpened` is only Pending. Persist the exact receipt-emitted record before
   polling. Read `references/runtime-journal.md`, watch only that request, and
   claim only when a fresh read says Ready. State alone never proves delivery;
   the final reply requires the exact claim receipt and recipient proof.
7. Keep each watcher below Bankr's job limit. A timeout emits no transaction:
   retain the record and resume the same request in-process when possible or on
   the next skill invocation. Reconcile nonterminal records before a new write.
8. A silent claim always uses the receipt-bound continuation, same wallet, a
   fresh Treasury quote, fresh deadline, and nonzero 97% output floor. Missing,
   expired, corrupt, stopped, or mismatched authority requires a new decision.
9. If canonical Base USDC is short, read the funding and X references. Never
   choose a source or cheaper pack. An explicitly named Base ETH/WETH source may
   proceed to one bounded confirmation covering swap, approval, open, and exact
   resulting-request claim; otherwise ask one short source question first.
   There is never a second claim confirmation.
10. On X, accept a short approval only through the exact trusted reply binding
    defined in `references/x-confirmation.md`; otherwise require its emitted
    self-contained command. Conversation history and an unrelated `yes` are not
    authority.
11. Never sign directly to GachaTreasury or call owner, recovery, roster, route,
    pause, Entropy-callback, role, governance, multisig, timelock, upgrade, or
    secret-bearing operations. Alternate prize/refund recipients always require
    an explicit address and confirmation.
12. Keep balances, mechanics, odds, RTP, fees, quotes, progress, journal data,
    and transaction details private during a direct pull. Do not promise timing,
    token quantity, resale value, or a dollar-value guarantee.

## Core command router

Run from the installed skill directory with Node.js 18 or newer. Commands print
one JSON object. Treat nonzero exit status or `ok: false` as a stop to
transaction execution. For documented non-mutating phases such as
`choose-funding-source` and `remaining-open-reconfirmation`, surface the exact
emitted choice or reconfirmation and continue only after the required new user
approval.

| Intent | Command |
|---|---|
| Verify deployment identity | `node scripts/stonk-gacha.mjs verify --wallet 0x…` |
| Open a pack | `node scripts/stonk-gacha.mjs plan-open-pack --wallet 0x… --pack-index N --authorized-price-usdc 5\|10\|20` |
| Revoke stale Gacha USDC approval | `node scripts/stonk-gacha.mjs plan-revoke-usdc --wallet 0x…` |
| Await and prepare exact pull delivery | `node scripts/stonk-gacha.mjs await-claim-prize --wallet 0x… --request-id N --claim-continuation 0x… --claim-continuation-key 0x… [--max-wait-seconds N --poll-interval-seconds N]` |
| Decode and bind planned calldata | `node scripts/stonk-gacha.mjs inspect-calldata --wallet 0x… --to 0x… --data 0x… --chain-id 8453 --value WEI --context 0x… --plan-key 0x…` |
| Prove a submitted/mined transaction | `node scripts/stonk-gacha.mjs inspect-tx --wallet 0x… --tx 0x… --context 0x… --plan-key 0x…` |

For funding, X binding, manual claims/refunds, reserve funding, profit
distribution, reads, and recovery commands, use
`references/operations.md` plus the task-specific reference above. Do not load
those paths during an already-funded direct pull.

An approval-only phase is not completion. For a direct pull, prove it and rerun
the same planner using the emitted unexpired intent/key and unchanged request
baseline. For funded pulls, continue only under the exact consumed combined
authorization. Changed economic terms require a new decision.

## User-facing completion

For a direct pull, stay silent through approval, open, settlement, and delivery.
After `inspect-tx` proves `PrizeDelivered` and the fresh request is `Delivered`,
return only `You pulled $X of SYMBOL.` Do not include the wallet, balances,
approval, fee, offer, odds, RTP, edge, ceiling, stock list, quote, slippage, or
execution steps. A bounded watcher timeout is not completion: persist the exact
record and use a verified private resume mechanism without posting progress or
ending the direct lifecycle. Never expose journal, watcher, continuation, or
resume details. Only the proven final pull sentence belongs in the successful
user-facing response. If a submission outcome cannot be verified, do not invent
a result or submit again.
