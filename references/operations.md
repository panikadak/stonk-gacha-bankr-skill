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
If the wallet lacks USDC, report the exact deficit and stop. Any Bankr token swap
is a separate Bankr-native acquisition with its own confirmation and mined
receipt, not locally invented router calldata. Rerun the planner afterward; its
fresh official-Base-USDC balance read is the gate for continuing.

Postcondition: a scoped `PackOpened` event, an exact canonical official-USDC
transfer from the wallet to Gacha, and a fresh request in `Pending`. Do not
report a token, multiplier, payout, win, or delivery yet.

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
- If an expected event or postcondition is absent, report "submitted but
  unverified" and stop before any dependent action.
- Bankr security controls are authoritative. Explain a rejection and stop; do
  not route around it with another wallet, endpoint, site, or contract.
