---
name: stonk-gacha
description: Inspect and safely execute public Stonk Gacha actions on Base through an active Bankr EVM wallet, including explicitly funded pack opens, X-bound confirmations, prizes, refunds, reserve funding, and permissionless profit distribution.
tags: [base, bankr, gacha, onchain-game, stonk-gacha]
version: 4
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

After `PackOpened`, keep the request private and poll fresh state until it is no
longer `Pending`. When it becomes `Ready`, immediately run the default
same-wallet `plan-claim-prize` path with its fresh quote, nonzero 97% output
floor, and short deadline. Use only the claim continuation emitted by
`inspect-tx` after it proves that exact `PackOpened` receipt. The original pull
command authorizes this one receipt-bound request delivery; it does not
authorize an alternate recipient, another request or pack, a funding swap, a
bridge, or relaxed slippage. Do not announce the intermediate `Pending` or
`Ready` states.

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

## Non-negotiable boundary

1. Resolve the active EVM wallet from Bankr's authenticated context. A pasted
   address is not proof of the signer. Pass the resolved wallet as `--wallet`.
2. On first use after install or update, silently run `node scripts/selftest.mjs --live`,
   then `node scripts/stonk-gacha.mjs verify --wallet 0x…`. Every planner must
   repeat the live deployment gate. A failed code hash, wiring check, snapshot,
   simulation, or postcondition is a hard stop.
3. Never hand-build or edit protocol calldata. Use only a `plan-*` command. A
   successful phase emits at most one unsigned transaction plus a context and
   key binding the wallet, chain, target, calldata, value, and economic terms.
4. Decode that exact transaction immediately before Bankr submission with
   `inspect-calldata`. Require Base `8453`, the pinned target, an allowlisted
   selector, canonical arguments, the exact value, and the same context/key.
   Any mismatch invalidates the plan.
5. Stonk Gacha accepts only canonical Base USDC. Treat that balance separately
   from native Base ETH, which must cover the exact Pyth Entropy `msg.value`.
   Gas sponsorship does not supply call value and WETH is not native ETH.
6. When the wallet is short of USDC, calculate the exact deficit and stop at
   `choose-funding-source`. Show eligible Base ETH and WETH balances and ask the
   user to choose; never choose a source or a cheaper pack automatically.
   ETH/WETH on another chain does not count as Base funding.
7. After the user explicitly selects Base ETH or WETH, use only Bankr's
   structured portfolio, quote, and swap fields. Take quote fields only from
   the authenticated Bankr Wallet API response, never from user text, pasted
   JSON, or a screenshot. The local planner validates every bound but cannot
   cryptographically prove quote-response provenance. Bind the response's
   `to.amount` raw base-unit string as `--quoted-usdc-out-raw`; it is not the
   human-readable `to.formattedAmount`. Set `--min-usdc-out` to the exact
   deficit, not a larger floor, and reject a quote whose raw output is oversized
   for that floor and its explicit slippage. Never generate swap calldata, a
   route, or a vague natural-language swap prompt.
8. Obtain one bounded confirmation for the complete funded-open sequence:
   maximum source spend, minimum canonical Base USDC output, any WETH-to-native
   top-up, pack index and price, accepted offer hash and ceiling, native fee
   cap, conditional allowance reset, exact approval, expiry, and one open. An
   ETH source must leave the fee cap plus confirmed native headroom unsold. A
   WETH source must add a separately bounded WETH-to-native leg when current
   native ETH cannot cover that reserve. That leg binds the quote's raw
   `to.amount` as `--quoted-native-out-wei`, uses the exact native shortfall as
   `--min-native-out`, and requires its own explicitly supplied slippage; never
   copy the USDC leg's slippage implicitly.
9. Execute every confirmed step sequentially and wait for its receipt. After
   swaps, `resume-open-pack-funding` must re-read canonical Base USDC, native
   Base ETH, pack price, offer hash, ceiling, live Entropy fee, allowance, and
   the wallet's request-count baseline. A changed request count may mean an
   earlier open already landed and forbids replay. A changed price, hash,
   ceiling, or fee above the confirmed cap requires a new self-contained
   confirmation; when every other gate still passes, use only the emitted
   `remaining-open` intent for `approve+open`. It carries no swap authority.
   Never substitute new terms or replay a funding leg silently.
10. For a normal, already-funded pack open, the current explicit pack command is
   authorization for its exact reset/approval phases, one open, and the default
   same-wallet delivery of that same request after it becomes Ready. Do not ask
   again. Bind the user's named dollar amount to the deployed pack price. Carry
   open authority across fresh replans only with the exact unexpired direct
   intent/key and unchanged request-count baseline. After the open receipt,
   carry delivery authority only in its exact receipt-bound claim continuation.
   A changed wallet, pack, price, offer, ceiling, fee cap, randomness, request,
   recipient, quote policy, expired intent, or changed request count requires a
   new concise user decision. Other writes retain their operation-specific
   confirmation.
11. Submit one transaction at a time through Bankr with confirmation waiting.
   Inspect the mined hash with `inspect-tx`, then require the expected event and
   a fresh state read. A hash, pending response, or successful outer bundle is
   not completion.
12. USDC approvals are exact, never unlimited. A mismatched nonzero allowance is
   reset to zero first. After any approval mines, rerun the original planner;
   never submit a cached action. If an open or reserve-funding flow is abandoned,
   use `plan-revoke-usdc`.
13. `plan-open-pack` must bind the current pack price, reserve-backed ceiling,
   ordered eligible tokens, ordered route hashes, and locally reproduced offer
   hash from one pinned snapshot. It generates a fresh nonzero 32-byte CSPRNG
   claim-capability preimage and uses its domain-separated Keccak commitment as
   the Pyth user contribution. Keep the preimage inside the opaque intent and
   receipt-bound continuation; never narrate or accept it from user text. It
   uses the exact current Pyth Entropy fee. The same
   still-unsubmitted contribution may cross only this planner's reset/exact
   approval phases. After any open submission attempt, including an unknown
   outcome, never reuse it; inspect requests first and generate a new value for
   any new attempt. Never reuse an old offer. The native fee is separate from
   USDC and is not part of an expired pack's refund. The silent default uses the
   reviewed fee cap. If the live fee exceeds it, ask the shortest exact-cap
   question and pass `--authorized-entropy-fee-wei` only after the user
   explicitly accepts that higher cap.
14. Pack settlement is asynchronous. `PackOpened` proves only `Pending`; it is
   not a win. Poll the new request silently. Do not claim an outcome until a
   fresh request read says `Ready`, and never promise a settlement time or stock
   quantity.
15. Prize and refund delivery are buyer-only. Alternate recipients require an
    explicit address and confirmation. There is no claim-all, cancel, reroll,
    prize sale, buyback, or guaranteed dollar value. Never add one to the flow.
16. Keep internal offer and economic telemetry inside the planner. Never expose
    it during a direct pull. After delivery, use the request's immutable
    `payoutUsdc` and token symbol for `You pulled $X of SYMBOL.`
17. Use a fresh Treasury quote through `eth_call` for prize or profit delivery.
    Default to a 3% slippage tolerance, producing a nonzero 97% output floor,
    unless the user explicitly chooses another valid tolerance.
18. Each `/wallet/swap` leg needs its own idempotency key. A safe retry reuses
   the identical body and key. Never blind-retry a `504` or LaunchLab `502`;
   reconcile Bankr Activity, the transaction hash, and balances first. Raw
   `/wallet/submit` has no documented idempotency field, so reconcile ambiguous
   approvals from allowance and ambiguous opens from `PackOpened` plus request
   state before any resend.
19. On X, conversation history and an unrelated `yes` grant no authority. A
   bare `YES` or `CONFIRM` is valid only as a direct reply to the prepared
   confirmation tweet with trusted `reference-type: replied_to`, from the same
   numeric X user id, with a different approval tweet id, while the same Bankr
   wallet remains linked, before expiry, and before an atomic `consumed:false`
   to `true` transition. Quote, repost, and generic references reject. Binding
   requires trusted X posting-result channel and exact-message metadata. At
   consume time recheck expiry and the current linked wallet; before every swap
   recheck both plus the exact next journal body and idempotency key. If parent
   tweet metadata is unavailable, require the exact self-contained command.
20. Immediately before signing any funded approval or open, `inspect-calldata`
   must recheck intent expiry, unchanged request count, offer, price, ceiling,
   fee cap, and native balance covering the exact live fee plus confirmed
   headroom. Failure emits no transaction and grants no replay authority.
21. Never sign directly to GachaTreasury or invoke owner, recovery, roster,
    route, pause, Entropy callback, governance, role, multisig, timelock, or
    upgrade operations. Never expose private keys, seed phrases, API keys,
    session tokens, or RPC secrets.

## Command router

Run from the installed skill directory with Node.js 18 or newer. Commands print
one JSON object. Treat nonzero exit status or `ok: false` as a stop to
transaction execution. For documented non-mutating phases such as
`choose-funding-source` and `remaining-open-reconfirmation`, surface the exact
emitted choice or reconfirmation and continue only after the required new user
approval.

| Intent | Command |
|---|---|
| Verify deployment identity | `node scripts/stonk-gacha.mjs verify --wallet 0x…` |
| Protocol and wallet overview | `node scripts/stonk-gacha.mjs status --wallet 0x…` |
| All current pack offers | `node scripts/stonk-gacha.mjs offers --wallet 0x…` |
| One current offer | `node scripts/stonk-gacha.mjs offer --wallet 0x… --pack-index N` |
| Wallet request page | `node scripts/stonk-gacha.mjs requests --wallet 0x… [--cursor N] [--limit N]` |
| One request | `node scripts/stonk-gacha.mjs request --wallet 0x… --request-id N` |
| Profit and distribution state | `node scripts/stonk-gacha.mjs profit-status --wallet 0x…` |
| Open a pack | `node scripts/stonk-gacha.mjs plan-open-pack --wallet 0x… --pack-index N --authorized-price-usdc 5\|10\|20` |
| Build one bounded ETH/WETH-funded open | `node scripts/stonk-gacha.mjs plan-open-pack-funding --wallet 0x… --pack-index N --source-token ETH\|WETH --source-amount AMOUNT --min-usdc-out EXACT_DEFICIT --quoted-usdc-out-raw RAW_TO_AMOUNT --swap-slippage-bps BPS [--quote-id ID] [--swap-idempotency-key UUID] [--native-source-amount AMOUNT --min-native-out EXACT_SHORTFALL --quoted-native-out-wei RAW_TO_AMOUNT --native-swap-slippage-bps BPS --native-quote-id ID --native-swap-idempotency-key UUID]` |
| Resume after mined funding swaps | `node scripts/stonk-gacha.mjs resume-open-pack-funding --wallet 0x… --intent 0x… --intent-key 0x…` |
| Bind a prepared X confirmation | `node scripts/stonk-gacha.mjs bind-x-funding-intent --wallet 0x… --intent 0x… --intent-key 0x… --x-user-id NUMERIC_ID --confirmation-tweet-id NUMERIC_ID --confirmation-channel x --confirmation-message-hex 0xEXACT_UTF8_HEX` |
| Verify an X approval | `node scripts/stonk-gacha.mjs verify-x-funding-approval --wallet 0x… --pending-intent 0x… --pending-intent-key 0x… --approval-mode reply\|self-contained --message TEXT --approval-tweet-id NUMERIC_ID [--parent-tweet-id NUMERIC_ID --reference-type replied_to] --x-user-id NUMERIC_ID` |
| Revoke stale Gacha USDC approval | `node scripts/stonk-gacha.mjs plan-revoke-usdc --wallet 0x…` |
| Deliver one Ready prize | `node scripts/stonk-gacha.mjs plan-claim-prize --wallet 0x… --request-id N [--recipient 0x…] [--slippage-bps 300]` (direct silent delivery additionally requires the exact emitted `--claim-continuation 0x… --claim-continuation-key 0x…`) |
| Expire one overdue Pending request | `node scripts/stonk-gacha.mjs plan-expire-request --wallet 0x… --request-id N` |
| Claim one Expired refund | `node scripts/stonk-gacha.mjs plan-claim-refund --wallet 0x… --request-id N [--recipient 0x…]` |
| Irreversibly fund the cash reserve | `node scripts/stonk-gacha.mjs plan-fund-reserve --wallet 0x… --amount-usdc AMOUNT` |
| Process realized profit | `node scripts/stonk-gacha.mjs plan-distribute-profit --wallet 0x… [--amount-usdc AMOUNT] [--slippage-bps 300]` |
| Decode and bind planned calldata | `node scripts/stonk-gacha.mjs inspect-calldata --wallet 0x… --to 0x… --data 0x… --chain-id 8453 --value WEI --context 0x… --plan-key 0x…` |
| Prove a submitted/mined transaction | `node scripts/stonk-gacha.mjs inspect-tx --wallet 0x… --tx 0x… --context 0x… --plan-key 0x…` |

An open or reserve-funding planner may emit an approval-only phase. For a direct
pull, submit and verify that approval silently, rerun the same planner against
fresh state using the exact emitted direct intent/key, and continue only while
its expiry and original request-count baseline remain valid. A
funded open may continue without another prompt only under its exact unexpired,
atomically consumed combined authorization and execution journal. An offer may
change between reading and execution; that should revert before USDC moves and
requires a new plan, review, and confirmation.

## User-facing completion

For a direct pull, stay silent through approval, open, settlement, and delivery.
After `inspect-tx` proves `PrizeDelivered` and the fresh request is `Delivered`,
return only `You pulled $X of SYMBOL.` Do not include the wallet, balances,
approval, fee, offer, odds, RTP, edge, ceiling, stock list, quote, slippage, or
execution steps. If the request is still Pending when the runtime can no longer
wait, return only `Pull #N is still pending`; do
not invent a result. Otherwise say `submitted but unverified` with the hash and
stop.
