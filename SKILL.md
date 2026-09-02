---
name: stonk-gacha
description: Inspect and safely plan public Stonk Gacha actions on Base through an active Bankr EVM wallet, including opening packs, claiming prizes or refunds, reserve funding, and permissionless profit distribution.
tags: [base, bankr, gacha, onchain-game, stonk-gacha]
version: 1
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

## Load references only when needed

- Before the first write in a session, read
  [references/bankr-execution.md](references/bankr-execution.md). It defines
  wallet resolution, user confirmation, Bankr submission, receipt proof, and
  failure recovery.
- For request states, operation preconditions, economic meaning, and fresh
  postconditions, read [references/operations.md](references/operations.md).
- Treat [references/deployment.json](references/deployment.json) as the reviewed
  Base deployment pin,
  [references/signing-allowlist.json](references/signing-allowlist.json) as the
  only permitted raw-call surface, and
  [references/bankr-execution.json](references/bankr-execution.json) as the
  accepted direct and sponsored Bankr execution envelopes.

## Non-negotiable boundary

1. Resolve the active EVM wallet from Bankr's authenticated context. A pasted
   address is not proof of the signer. Pass the resolved wallet as `--wallet`.
2. On first use after install or update, run `node scripts/selftest.mjs --live`,
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
5. Obtain explicit confirmation for the complete economic action before the
   first approval or protocol call. Name the active wallet, current pack or
   amount, exact approval and spender when applicable, exact native fee,
   recipient, quote floor, deadline, and any irreversible donation. Reconfirm
   when a fresh plan changes an economic term.
6. Submit one transaction at a time through Bankr with confirmation waiting.
   Inspect the mined hash with `inspect-tx`, then require the expected event and
   a fresh state read. A hash, pending response, or successful outer bundle is
   not completion.
7. USDC approvals are exact, never unlimited. A mismatched nonzero allowance is
   reset to zero first. After any approval mines, rerun the original planner;
   never submit a cached action. If an open or reserve-funding flow is abandoned,
   use `plan-revoke-usdc`.
8. `plan-open-pack` must bind the current pack price, reserve-backed ceiling,
   ordered eligible tokens, ordered route hashes, and locally reproduced offer
   hash from one pinned snapshot. It generates a fresh nonzero 32-byte CSPRNG
   contribution and uses the exact current Pyth Entropy fee. The same
   still-unsubmitted contribution may cross only this planner's reset/exact
   approval phases. After any open submission attempt, including an unknown
   outcome, never reuse it; inspect requests first and generate a new value for
   any new attempt. Never reuse an old offer. The native fee is separate from
   USDC and is not part of an expired pack's refund.
9. Pack settlement is asynchronous. `PackOpened` proves only `Pending`; it is
   not a win. Do not claim an outcome until a fresh request read says `Ready`,
   and never promise a settlement time or stock quantity.
10. Prize and refund delivery are buyer-only. Alternate recipients require an
    explicit address and confirmation. There is no claim-all, cancel, reroll,
    prize sale, buyback, or guaranteed dollar value. Never add one to the flow.
11. Never restate odds from memory or documentation. Read `odds`, `packPrice`,
    `ceilingTiers`, `effectiveRtpBps`, and the current offer from the contract,
    and label RTP and edge as nominal. A Ready request's `payoutUsdc` is a stock
    purchase budget; its delivered token quantity is the later measured DEX
    output.
12. Use a fresh Treasury quote through `eth_call` for prize or profit delivery.
    Default to a 3% slippage tolerance, producing a nonzero 97% output floor,
    unless the user explicitly chooses another valid tolerance.
13. Never sign directly to GachaTreasury or invoke owner, recovery, roster,
    route, pause, Entropy callback, governance, role, multisig, timelock, or
    upgrade operations. Never expose private keys, seed phrases, API keys,
    session tokens, or RPC secrets.

## Command router

Run from the installed skill directory with Node.js 18 or newer. Commands print
one JSON object; treat nonzero exit status or `ok: false` as a stop.

| Intent | Command |
|---|---|
| Verify deployment identity | `node scripts/stonk-gacha.mjs verify --wallet 0x…` |
| Protocol and wallet overview | `node scripts/stonk-gacha.mjs status --wallet 0x…` |
| All current pack offers | `node scripts/stonk-gacha.mjs offers --wallet 0x…` |
| One current offer | `node scripts/stonk-gacha.mjs offer --wallet 0x… --pack-index N` |
| Wallet request page | `node scripts/stonk-gacha.mjs requests --wallet 0x… [--cursor N] [--limit N]` |
| One request | `node scripts/stonk-gacha.mjs request --wallet 0x… --request-id N` |
| Profit and distribution state | `node scripts/stonk-gacha.mjs profit-status --wallet 0x…` |
| Open a pack | `node scripts/stonk-gacha.mjs plan-open-pack --wallet 0x… --pack-index N` |
| Revoke stale Gacha USDC approval | `node scripts/stonk-gacha.mjs plan-revoke-usdc --wallet 0x…` |
| Deliver one Ready prize | `node scripts/stonk-gacha.mjs plan-claim-prize --wallet 0x… --request-id N [--recipient 0x…] [--slippage-bps 300]` |
| Expire one overdue Pending request | `node scripts/stonk-gacha.mjs plan-expire-request --wallet 0x… --request-id N` |
| Claim one Expired refund | `node scripts/stonk-gacha.mjs plan-claim-refund --wallet 0x… --request-id N [--recipient 0x…]` |
| Irreversibly fund the cash reserve | `node scripts/stonk-gacha.mjs plan-fund-reserve --wallet 0x… --amount-usdc AMOUNT` |
| Process realized profit | `node scripts/stonk-gacha.mjs plan-distribute-profit --wallet 0x… [--amount-usdc AMOUNT] [--slippage-bps 300]` |
| Decode and bind planned calldata | `node scripts/stonk-gacha.mjs inspect-calldata --wallet 0x… --to 0x… --data 0x… --chain-id 8453 --value WEI --context 0x… --plan-key 0x…` |
| Prove a submitted/mined transaction | `node scripts/stonk-gacha.mjs inspect-tx --wallet 0x… --tx 0x… --context 0x… --plan-key 0x…` |

An open or reserve-funding planner may emit an approval-only phase. Submit and
verify that one approval, then rerun the same planner against fresh state. An
offer may change between reading and execution; that should revert before USDC
moves and requires a new plan, review, and confirmation.

## User-facing completion

Lead with the outcome and keep routine reads compact. Show current values as an
observation at the pinned Base block, never as permanent product state. Report a
write as complete only after `inspect-tx` proves the logical Bankr wallet call,
the operation-specific event, and the fresh postcondition in `operations.md`.
Include one Basescan transaction link and the exact request, amount, recipient,
and resulting state. Otherwise say "submitted but unverified" and stop.
