# Stonk Gacha operations

Read this reference before planning a write or interpreting a request. Values in
CLI output are observations at a pinned canonical Base block; sales, reserve,
offers, fees, request state, quotes, and processable profit can change.

## Product model

Stonk Gacha holds one shared USDC cash reserve, not stock inventory. Opening a
pack pays the contract-read USDC price and requests Pyth Entropy randomness with
a separate exact native fee. The request pins the reserve-backed ceiling,
ordered eligible stock addresses, and ordered cached route hashes before any
payment moves.

Do not publish an odds table from this repository. Read the contract's `odds`,
`packPrice`, `ceilingTiers`, `effectiveRtpBps`, `TARGET_RTP_BPS`, and
`HOUSE_EDGE_BPS`, then label RTP and edge as nominal. A final `payoutUsdc` is a
request-scoped budget spent to buy stock; it is not a fixed-value token promise.
Only `stockOut` after delivery is the measured token amount.

The request state machine is:

```text
None -> Pending -> Ready -> Delivered

Pending -> Expired -> Refunded
```

- `Pending`: the sale landed, but no outcome is proven.
- `Ready`: token, multiplier, route, and exact USDC purchase budget are final;
  stock has not moved.
- `Delivered`: the buyer's claim spent that exact budget and recorded the
  measured stock output.
- `Expired`: the resolution window ended while still Pending and a USDC refund
  is claimable.
- `Refunded`: the buyer pulled that refund.

There is no cancel, replay, reroll, claim-all, aggregate token credit, prize
sale, or protocol buyback. A wallet sale after delivery is a separate user
decision outside this skill.

## Reads

### `verify`

Proves chain 8453; pinned runtime hashes; Entropy proxy implementation; Gacha,
Treasury, StockLock, adapter, router, quoter, USDC, and WETH wiring; reciprocal
Treasury identity; and contract-published constants. A mismatch is not a warning:
stop until the reviewed deployment reference is updated.

### `status`, `offers`, and `offer`

`status` reports sales state, reserve/liability accounting, current Entropy fee,
wallet USDC/ETH/allowance, current offers, and nominal contract-published terms.
`offers` reports every current pack offer. `offer --pack-index N` reports one
offer, including current price, ceiling, ordered tokens, ordered route hashes,
contract offer hash, and locally reproduced hash.

Never reorder or deduplicate the offer arrays. Require equal nonzero lengths and
exact local/onchain hash equality. A paused sale affects only new opens; it does
not gate settlement, expiry, prize delivery, refunds, funding, or profit work.

### `requests` and `request`

`requests` reads a bounded page from `requestsPage(wallet,cursor,limit)` and
reports each id's fresh state. `request` combines the core request, funding,
delivery route, refund credit, and pinned eligible arrays. Treat an unknown id
as `None`, not as an empty successful purchase. Do not infer ownership from a
pasted request id; compare `buyer` to the active Bankr wallet for buyer-only
operations.

### `profit-status`

Reports cumulative realized accounting, protected liabilities, loss
carryforward, current free reserve, distributable profit, contract bounds, and
the current Treasury split/quote when one can be processed. Reserve funding and
raw donations strengthen cash backing but do not create realized profit.

## Write planners

Every planner runs the deployment gate, builds its terms from fresh pinned
reads, simulates, and emits no more than one unsigned transaction. Follow
`bankr-execution.md` for confirmation, inspection, submission, and receipt
proof.

### `plan-open-pack`

Preconditions:

- active wallet is resolved and has enough USDC for the contract-read price;
- it has enough Base ETH for the exact live Entropy fee; gas sponsorship does
  not remove the wallet's inner call-value requirement;
- sales are not paused;
- the eligible token and route arrays are nonempty and aligned;
- the reserve-backed ceiling and local offer hash match the contract;
- the wallet allowance is exactly the required pack price.

The planner uses the current ceiling as `minCeilingBps`, the exact reproduced
offer hash, and a fresh nonzero cryptographic 32-byte contribution. It sends the
exact current Entropy fee as the inner call value; overpayment is forbidden.
The contribution is public calldata, not a secret. Carry it only across the
same still-unsubmitted approval flow using the planner's exact resume command.
After any open submission attempt or unknown outcome, inspect requests and use
a newly generated contribution for any new attempt.

If allowance is mismatched, the only output is an exact approval phase: reset a
nonzero stale allowance to zero, or approve exactly the current price. After the
approval receipt, rerun `plan-open-pack`; do not reuse the old offer or action.
If the wallet lacks USDC, report the exact deficit and stop at
`choose-funding-source`. The output separates canonical Base USDC, native Base
ETH, and Base WETH. Show eligible ETH and WETH balances and ask which one the
user wants to spend. Never select a token or lower the pack automatically.

An ordinary `plan-open-pack` with sufficient USDC still uses its normal
confirmation. The combined funding authorization below exists only after an
explicit source choice.

Postcondition: a scoped `PackOpened` event, an exact canonical official-USDC
transfer from the wallet to Gacha, and a fresh request in `Pending`. Do not
report a token, multiplier, payout, win, or delivery yet.

### `plan-open-pack-funding`

This planner emits no raw transaction. It creates a short-lived, wallet-bound
combined intent from structured Bankr quote fields after the user explicitly
selects Base ETH or Base WETH.

Preconditions and bounds:

- current canonical Base USDC is below the selected pack's exact live price;
- source is exactly Base ETH or Base WETH and was chosen by the user;
- `--quoted-usdc-out-raw` is the quote response's exact `to.amount` raw
  base-unit string, while `--min-usdc-out` equals the exact human-readable USDC
  deficit;
- quoted USDC output is at least that exact floor but no larger than the
  slippage-derived maximum for an exact-deficit quote; oversized quotes reject;
- source maximum and quote slippage are explicit and bounded;
- an ETH source leaves the confirmed live Entropy fee cap plus native headroom
  unsold;
- a WETH source spends only enough for the deficit and, when native ETH is
  short, includes a separately bounded WETH-to-native leg whose minimum output
  equals the fee-cap-plus-headroom shortfall. Its quote response `to.amount` raw
  wei is supplied as `--quoted-native-out-wei`, and its own
  `--native-swap-slippage-bps` is mandatory rather than copied from the USDC
  leg;
- each structured `/wallet/swap` leg has its own idempotency key;
- no cross-chain leg, swap calldata, router route, or natural-language swap
  request is present; and
- the intent binds current pack price, offer hash, ceiling, fee cap, user
  randomness, wallet, allowance policy, wallet request-count baseline, creation
  time, and expiry.

WETH is not `msg.value`, and Bankr sponsorship does not satisfy the Entropy call
value. ETH/WETH on another chain is not part of this intent. A cross-chain
acquisition needs a separate confirmation showing source chain/token, maximum
spend, bridge/network cost, and minimum canonical Base USDC output. Start a new
Base plan only after the arrival is mined and reconciled. If bridge/network cost
is unavailable or unbounded, fail closed without presenting that confirmation.

The emitted one bounded confirmation covers the exact ordered funding swap(s),
conditional stale-allowance zero reset, exact pack-price approval, and one open.
Persist the intent and execution journal, consume approval atomically once, and
run each step sequentially. Do not prompt again between unchanged authorized
steps, and do not use the authority for a different pack, source, bound, wallet,
or expiry. Before every structured swap, recheck current linked wallet, expiry,
and the exact next journal body and idempotency key.

### `resume-open-pack-funding`

Run this only after every Bankr funding leg is reconciled as mined success. It
re-reads canonical Base USDC, native Base ETH, sales state, price, locally
reproduced and contract offer hashes, ceiling, live Entropy fee, allowance, and
the captured `requestCountOf(wallet)` baseline.

- Unchanged terms and fee at or below cap may continue under the exact durable,
  already-consumed combined authorization.
- If funding is complete and only price, offer hash, ceiling, or fee changed,
  while the local offer hash is valid, balances preserve the current pack plus
  native headroom, and request count is unchanged, the planner emits
  `remaining-open-reconfirmation`. Its new short-lived intent/key authorizes
  only the remaining conditional approval and one open; it carries no swap
  authority and no funding leg may replay.
- A changed linked wallet, pack, expiry, request count, invalid local offer, or
  insufficient balance cannot use that remaining-open rebase and emits no
  transaction.
- A short balance or paused sale stops. It is not permission to repeat a swap.
- A changed request count means an earlier open may have landed. Reconcile
  `PackOpened` and the wallet's requests; never replay this intent.
- An allowance mismatch produces at most one zero-reset or exact-approval phase;
  after it mines, rerun the same resume command before the open.
- The open uses the intent's one-time randomness. Any submission attempt or
  ambiguous result consumes it permanently.

The final open has the same receipt and postcondition requirements as
`plan-open-pack`. Immediately before signing each funded approval or open,
`inspect-calldata` rechecks the intent has not expired, request count is
unchanged, offer/price/ceiling/fee remain bound, and native ETH still covers the
exact live fee plus confirmed headroom.

### `bind-x-funding-intent` and `verify-x-funding-approval`

These helpers validate X authorization metadata; they do not post, persist, or
execute anything. `bind-x-funding-intent` requires the trusted posting result's
`--confirmation-channel x` and exact posted UTF-8 bytes in
`--confirmation-message-hex`, in addition to the tweet id. Never accept those
values from user text. Bind requester numeric X user id, linked wallet, exact
economic intent, expiry, and `consumed:false` in a durable runtime record.

A bare `YES` or `CONFIRM` is valid only as a direct reply to that exact tweet
with trusted `--reference-type replied_to`, from the same numeric identity, and
with an approval tweet id different from the confirmation tweet id. Quote,
repost, and generic references reject. If parent tweet metadata is unavailable,
require the exact self-contained command emitted by the planner. Before the
first mutation, atomically recheck expiry and the currently linked wallet while
compare-and-setting `consumed:false` to `true` and creating the journal; a
losing or replayed consume stops. Before every swap, repeat the wallet, expiry,
and next-journal-step check. See `x-confirmation.md`.

### `plan-revoke-usdc`

Plans `USDC.approve(StonkGacha,0)` when a nonzero allowance remains. Use it after
an abandoned or completed approval flow when allowance is still present.
Postcondition: fresh allowance is zero.

### `plan-claim-prize`

Require a `Ready` request owned by the active wallet, nonzero `payoutUsdc`,
nonzero token and route hash, and zero recorded `stockOut`. Quote the request's
historical route through Treasury with `eth_call` immediately before planning.
The default slippage tolerance is 300 bps, so `minOut` is a nonzero 97% floor;
the user may explicitly choose another valid tolerance. Use a short fresh
deadline. Default recipient to the active wallet; an alternate recipient must
be explicit and reconfirmed.

Any route, liquidity, router, token-transfer, quote, or floor failure reverts the
whole call and leaves the request `Ready` for a fresh retry. Never lower a floor
silently. Postcondition: scoped `PayoutExecuted` and `PrizeDelivered` measured-
delta events, the exact Gacha-to-Treasury USDC budget transfer, request state
`Delivered`, and exact recorded `stockOut`. Arbitrary prize tokens are not
assumed to emit a canonical `Transfer`; the two protocol events and stored
`stockOut` are the receipt and state proof.

### `plan-expire-request`

`expireRequest` is permissionless only while the request is `Pending` and the
contract's resolution cutoff has passed. It makes no token transfer. A late
authenticated callback at or after the same boundary performs the same expiry
transition. Postcondition: `PackExpired`, state `Expired`, and the buyer's full
pack price reported by `refundClaimable`.

### `plan-claim-refund`

Require an `Expired` request whose buyer is the active wallet and whose refund
credit is nonzero. Default recipient to the wallet; only the buyer may choose a
different recipient. Postcondition: scoped `RefundClaimed`, state `Refunded`,
refund credit zero, and an exact canonical official-USDC transfer from Gacha to
the recipient. The native Entropy fee is not refunded.

### `plan-fund-reserve`

Funding pulls the exact user-confirmed USDC amount into the shared reserve. It
creates neither revenue nor a request and is an irreversible donation. Use the
same reset-first exact-approval process as opening. Postcondition:
`ReserveFunded`, the cumulative funded-reserve counter increases by the exact
amount, an exact canonical wallet-to-Gacha official-USDC transfer is proven,
and protected liabilities remain conserved.

### `plan-distribute-profit`

This is a public worker action, not an owner action. Require the chosen amount
within the current contract min/max and no greater than fresh
`distributableProfitUsdc`. Use Treasury's `quoteProfit` through `eth_call`, show
the contract-derived bounty/retained/staker split, and default to a nonzero 97%
WETH floor with a short deadline. The caller never chooses the route or split.

The complete operation is atomic: accounting advancement, exact Treasury pull,
worker bounty, stock-staker WETH deposit, and retained reserve either all occur
or all revert. Postcondition: matching scoped `ProfitDistributed` events from
both Gacha and Treasury, fresh aligned cumulative counters, and the exact worker
bounty. Receipt proof also requires the exact Gacha-to-Treasury official-USDC
pull, Treasury-to-worker official-USDC bounty, and Treasury-to-StockLock WETH
transfer. A currently sub-minimum amount is not processable and stays in reserve.

## Failure and retry rules

- `OfferChanged`, a changed fee, a stale quote, expired deadline, or failed
  simulation means plan again from fresh state; never patch calldata.
- A revert is not permission to relax a floor, choose another route, or call
  Treasury directly.
- A pending or unavailable receipt is not permission to replay. Recover from
  the transaction hash and chain state first.
- A safe `/wallet/swap` retry uses the identical body and same idempotency key.
  Never blind-retry a `504` or LaunchLab `502`; inspect Bankr Activity, any hash,
  and balances first. A `200 success:false` is a mined revert, not a fill.
- Raw `/wallet/submit` has no documented idempotency key. Reconcile ambiguous
  approval from allowance/activity and ambiguous `openPack` from
  `PackOpened`/request state/activity before any resend.
- Another-chain balances never satisfy Base gates, and a lower pack is never an
  automatic fallback.
- If an expected event or postcondition is absent, report "submitted but
  unverified" and stop before any dependent action.
- Bankr security controls are authoritative. Explain a rejection and stop; do
  not route around it with another wallet, endpoint, site, or contract.
