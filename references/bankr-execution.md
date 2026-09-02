# Bankr execution and recovery

Read this before the first Stonk Gacha write in every session. The local scripts
prepare and validate unsigned Base transactions; Bankr alone signs and
broadcasts them.

## Resolve the active wallet

Use Bankr's authenticated context or wallet profile to resolve the active EVM
wallet. Pass it to every command as `--wallet` and require the logical signer in
receipt inspection to match it.

- Never ask for or expose a private key, seed phrase, Bankr API key, session
  token, or RPC secret.
- Never accept a pasted address as proof of the signer. It may be a separately
  confirmed recipient only after the active wallet is resolved.
- Do not compare a sponsored transaction's outer `from` directly to the wallet;
  it may be a relayer. `inspect-tx` proves the inner logical call.
- Do not place credentials in command arguments, logs, issues, repository
  files, or chat.

## First-use gate

From the installed skill directory:

```bash
node scripts/selftest.mjs
node scripts/selftest.mjs --live
node scripts/stonk-gacha.mjs verify --wallet 0xActiveBankrEvmWallet
```

`STONK_GACHA_RPC_URL` takes precedence over `BASE_RPC_URL`. An explicit override
is fail-closed; do not silently substitute remembered addresses, a frontend
manifest, a broadcast file, explorer labels, or another RPC result after it
fails. A deployment-pin change requires a reviewed skill update.

## Plan and authorize

Run the relevant `plan-*` command. Treat its stdout as one JSON document:

- `ok: false` or nonzero process exit: relay the error and stop;
- empty `txs`: no transaction is ready;
- one `txs` entry: one approval or action is ready for review;
- approval phase: submit only that approval, prove it, then rerun the original
  planner against fresh state;
- `next`: the fresh read or planner step expected after success.

For a normal pack open, a current explicit command naming one exact pack amount
is the authorization. Pass that amount as `--authorized-price-usdc`; the
deployed pack index must map to exactly that price. When the active wallet
already has sufficient Base USDC and native ETH, do not show preflight,
balances, offer details, fees, approval phases, or progress and do not ask
again. Persist the emitted direct intent/key, submit each planner phase
sequentially, rerun after approvals with that exact intent, and require its
short expiry plus unchanged request-count baseline before every signature.
The opaque intent also holds a fresh claim-capability preimage whose
domain-separated Keccak commitment is the open's onchain user-random input;
never expose it conversationally or accept a replacement from public data.

After the open receipt proves the new request, poll that request without posting
progress. `inspect-tx` on the successful open emits a claim continuation bound
to the exact Bankr execution, `PackOpened` request id, wallet, source intent,
same-wallet recipient, and 300 bps policy. When that exact request becomes
`Ready`, pass only that continuation and key to `plan-claim-prize`. The planner
and calldata inspector re-prove the source receipt before silent submission.
After delivery proof, return only `You pulled $X of SYMBOL.`

For writes that are not already authorized by that direct lifecycle, present
only the essential decision fields:

- Base and the active signer;
- the action, pack index or request id, and current contract-read amount;
- exact USDC approval and Stonk Gacha spender when applicable;
- exact inner native Entropy fee for an open;
- recipient, slippage tolerance, nonzero output floor, and deadline;
- any irreversible reserve donation;
- expected approval/action order and the fact that settlement is asynchronous.

One explicit authorization may cover sequential phases only while these economic
terms remain unchanged. Reconfirm if the current offer, price, ceiling, token
set, route hashes, pack/request, amount, fee, quote floor, recipient, spender,
or irreversible effect changes. A plan context/key proves integrity, not user
authorization.

For a funded pack open, the planner's one bounded confirmation additionally
names the explicitly chosen Base ETH/WETH source, aggregate maximum source
spend, minimum canonical Base USDC output, any WETH-to-native top-up bounds,
offer hash, accepted ceiling, native fee cap, expiry, and the conditional
reset/exact-approval/open sequence. Do not split those known steps into repeated
prompts, and do not reuse the confirmation for changed terms or another action.

## Inspect calldata

Immediately before each submission, use the context and key from that exact
fresh planner phase:

```bash
node scripts/stonk-gacha.mjs inspect-calldata \
  --wallet 0xActiveBankrEvmWallet \
  --to 0xReviewedTarget \
  --data 0xAllowlistedCalldata \
  --chain-id 8453 \
  --value WEI \
  --context 0xFreshInspectionContextHex \
  --plan-key 0xFreshInspectionKey
```

Require exactly one transaction, chain 8453, a pinned target/runtime identity,
an operation in `signing-allowlist.json`, canonical decoded arguments, and an
exact recomputed binding. USDC approval must name Stonk Gacha as spender and be
either zero or the exact fresh requirement. `openPack` alone has nonzero value,
equal to the bound live Entropy fee; every other allowlisted operation has zero
value. Every direct approve/open revalidates the canonical intent key, expiry,
user-authorized price, live pack mapping, offer, ceiling, fee cap, wallet, and
unchanged request-count baseline. Every silent claim revalidates its canonical
continuation and re-proves the exact historical Bankr `PackOpened` receipt and
request id. Never edit calldata to repair a mismatch.

## Submit through Bankr

Prefer Bankr's native arbitrary-transaction capability. If integrating the
Wallet API directly, send the unchanged planner object to `POST /wallet/submit`
with `waitForConfirmation: true`:

```json
{
  "transaction": {
    "to": "0xReviewedTarget",
    "data": "0xAllowlistedCalldata",
    "value": "EXACT_PLANNED_WEI",
    "chainId": 8453
  },
  "description": "Stonk Gacha: exact confirmed action",
  "waitForConfirmation": true
}
```

Use the runtime's protected authentication mechanism; never generate a command
containing a real key. Submit one transaction at a time. Never parallelize an
approval with its dependent action, and never replay a stale plan.

## Fund a USDC-short pack open

Stonk Gacha pulls canonical Base USDC for the pack and forwards a separate exact
native Base ETH `msg.value` to Pyth Entropy. Treat these as two independent
preflight assets. Sponsored gas does not supply call value, and WETH does not
count as native ETH.

### 1. Calculate, show, and ask

Run `plan-open-pack` with the exact named amount passed as
`--authorized-price-usdc`. When canonical Base USDC is below the current pack price,
the planner emits `choose-funding-source` with the exact raw and formatted
deficit, Base ETH balance, Base WETH balance, live Entropy fee, and required
native reserve.

Cross-check balances with Bankr's structured Base portfolio read. Match USDC and
WETH by the canonical addresses in `funding-policy.json`, not by symbol. Show
eligible Base ETH and WETH balances and ask the user which one to use. Never:

- choose ETH, WETH, or any other token automatically;
- count ETH/WETH on another chain as a Base balance;
- lower the pack without a new explicit pack choice; or
- swap anything merely because it appears in the portfolio.

### 2. Quote the explicitly selected source

Use Bankr's official structured flow: `POST /wallet/swap-quote`, then pass the
exact quote bounds to `plan-open-pack-funding`. In Bankr's quote response,
`from.amount` is human-readable input but `to.amount` is the quoted buy amount
in raw base units. Bind that exact `to.amount` string as
`--quoted-usdc-out-raw`; never substitute `to.formattedAmount`, `minBuyAmount`,
or a locally converted estimate.

Quote fields must come from the authenticated Bankr Wallet API response owned
by the runtime, never from user text, pasted JSON, a screenshot, or conversation
history. The local CLI can validate and bind every economic field but cannot
cryptographically authenticate quote-response provenance; the authenticated
runtime-to-CLI handoff is an explicit trust boundary.

Set `--min-usdc-out` to the exact human-readable canonical Base USDC deficit,
not merely an amount at least as large. Use the quote's explicit slippage bps.
The planner requires quoted raw output at or above the floor and rejects an
oversized quote above `ceil(deficitRaw * 10000 / (10000 - slippageBps))`. Resize
and requote instead of accepting excess output as authority for extra source
spend.

- **ETH source:** maximum sell must leave the live Entropy fee cap plus the
  confirmed native headroom in Base ETH. Never sell the full balance.
- **WETH source:** the USDC leg spends only enough WETH to cover the deficit. If
  native Base ETH is below fee cap plus headroom, also quote a small bounded
  WETH-to-native ETH leg whose minimum output equals that exact shortfall. The
  planner orders this top-up before the USDC leg. Bind that quote's raw
  `to.amount` in wei as `--quoted-native-out-wei`; set `--min-native-out` to the
  exact human-readable shortfall. Supply `--native-swap-slippage-bps`
  explicitly. It is mandatory for this leg and must never inherit the USDC
  leg's slippage by omission. The same oversized-quote bound applies using the
  native shortfall and native-leg slippage.

Every quote and intent must bind `fromChain`, `fromToken`, `toChain`, `toToken`,
maximum sell amount, `minBuyAmount`, slippage, and an optional opaque quote id.
The output token for the pack deficit is the canonical Base USDC address. Use
the native sentinel pinned in `funding-policy.json` for ETH. Do not generate or
accept router calldata, routes, token-name guesses, or a natural-language swap
prompt.

If the only source is on another chain, stop the combined flow. Offer a separate
cross-chain acquisition confirmation that visibly names source chain/token,
maximum source spend, bridge or network cost, and minimum canonical Base USDC
output. If the bridge/network cost is unavailable or cannot be bounded, fail
closed and do not present a confirmation. Only a mined and reconciled arrival
on Base can start a new funded-open plan.

### 3. Confirm once, then execute sequentially

`plan-open-pack-funding` emits `combined-confirmation`, an opaque intent/key, and
the exact ordered Bankr sequence. Show its full `report`. One confirmation covers
only:

1. each listed structured Bankr funding leg;
2. a conditional zero reset of a mismatched nonzero USDC allowance;
3. approval of exactly the current pack price; and
4. one `openPack` using the confirmed pack, offer hash, ceiling, fee cap, and
   fresh randomness.

Persist the exact unexpired intent and execution journal, including the wallet's
`requestCountOf(wallet)` baseline captured before funding. Atomically consume
the authorization once before the first mutation, then submit one step at a
time and wait for its mined result. Before every structured swap, re-resolve the
current linked wallet, recheck intent expiry, and require the exact next journal
step, request body, and idempotency key. A missing journal, already-consumed
intent, reordered step, changed wallet, expired intent, or changed bound is a
hard stop.

For every `/wallet/swap` leg, use a distinct UUID `idempotencyKey`. A safe retry
uses the identical body and same key. A `200` with `success:false` is a mined
revert, not a filled swap. Never blind-retry a `504` or LaunchLab `502`: either
may already be onchain, so reconcile Bankr Activity, the transaction hash, and
fresh balances first. `429` and `503` are safe to retry with the same body/key;
do not generate a new key for a retry of the same logical leg.

### 4. Re-read before approval and open

After every swap leg is reconciled as mined success, run the exact emitted
`resume-open-pack-funding` command. It rechecks:

- same active linked wallet, pack, unexpired intent, and live sales state;
- the same wallet request-count baseline captured before the swaps;
- enough canonical Base USDC for the pack;
- enough native Base ETH for the exact current Entropy `msg.value` plus the
  confirmed headroom;
- unchanged pack price, expected/local offer hash, and accepted ceiling;
- live Entropy fee at or below the confirmed cap; and
- current USDC allowance.

If only price, offer hash, ceiling, or live fee changed after funding completed,
the planner may emit `remaining-open-reconfirmation` only when the fresh local
offer commitment is valid, canonical Base USDC covers the new price, native ETH
still covers fee plus headroom, and request count is unchanged. Its new
short-lived intent/key and X line use `do=approve+open`; they authorize only the
conditional allowance work and one open. They carry no swap authority. Never
silently replace a hash, accept a different ceiling, raise a fee cap, downgrade
the pack, or replay a funding leg.

A changed wallet, pack, expiry, request count, invalid local offer, short
balance, or paused sale cannot use that remaining-open rebase and emits no
transaction.
Any changed request count means a prior open may already have landed: stop,
reconcile `PackOpened` and request state, and never replay the funded intent.

The unchanged flow may proceed under the original consumed authorization: zero
reset if needed, exact approval if needed, then one open, each sequentially.
Immediately before signing each funded approval or open, run
`inspect-calldata`. Its fresh gate rechecks intent expiry, request count, price,
offer hash, ceiling, fee cap, and native ETH covering the live fee plus
headroom. Failure emits no transaction and is not permission to regenerate or
replay a step.

## X-bound confirmation

Follow [x-confirmation.md](x-confirmation.md). Bind only from trusted X posting-
result metadata using `--confirmation-channel x` and the exact posted UTF-8 text
as `--confirmation-message-hex`. User-supplied tweet ids, channels, or copied
text do not prove the confirmation was posted.

A bare `YES` or `CONFIRM` is valid only as a direct reply to the prepared
confirmation tweet with trusted `--reference-type replied_to`, from the same
numeric X user id, with an approval tweet id different from the confirmation
tweet id, while the same Bankr wallet remains linked, before expiry, and while
the durable pending intent remains unconsumed. Quote-tweet, repost, and generic
reference metadata reject. Conversation history, handles, and an unrelated
`@bankrbot yes` are not authorization.

If the runtime cannot prove the parent/referenced tweet id, require the exact
self-contained command emitted by the planner. Before any external mutation,
atomically compare-and-set the pending record from `consumed:false` to
`consumed:true` and create the execution journal. That same atomic boundary must
recheck current time against expiry and freshly resolve the current linked
wallet. Before every swap, repeat the expiry, linked-wallet, and next-journal-
body/idempotency checks.

## Bankr source patterns

The funding boundary follows Bankr's published
[Wallet API swap documentation](https://docs.bankr.bot/wallet-api/swap/),
[Hunch source-selection consent](https://github.com/BankrBot/skills/blob/main/hunch/SKILL.md#L340-L367),
[Cat Town's token-plus-native gacha preflight](https://github.com/BankrBot/skills/blob/main/cattown/SKILL.md#L542-L560),
[Aero Stock LP's bounded sequence confirmation](https://github.com/BankrBot/skills/blob/main/aero-stock-lp/SKILL.md#L52-L66),
and the [HoodMarkets X wallet/thread boundary](https://github.com/BankrBot/skills/blob/main/hoodmarkets/references/AUTH-BOUNDARY.md).
These are design references; Stonk Gacha's pinned deployment, assets, exact
deficit, offer commitment, and native fee rules remain authoritative here.

Bankr access controls may reject arbitrary calldata, recipients, amounts, or
daily limits. Do not ask the user to weaken a control or route around it through
another wallet, site, endpoint, transfer, or direct Treasury call. Explain the
blocking control and stop.

## Supported receipt envelopes

`references/bankr-execution.json` pins the only accepted shapes:

- a direct Base transaction from the active wallet; or
- Bankr's reviewed gas-sponsored EntryPoint v0.7 transaction containing exactly
  one supported fail-on-error logical call for the active EIP-7702/Kernel
  wallet.

For sponsored execution, the verifier selects the unique operation for the
active wallet, unwraps exactly one call, pins EntryPoint and Kernel identities,
reconstructs transaction-ordered delegation where applicable, recomputes the
UserOperation hash, and requires its successful `UserOperationEvent`. It scopes
protocol and token logs to that operation even when unrelated users share the
outer bundle.

Unknown wrappers, wallet self-calls, batches, try/delegate modes, a second
operation for the wallet, non-reviewed validators or policies, paymasters,
account deployment, noncanonical ABI, unsupported authorization changes, or
unknown code identities fail closed. The sponsored outer transaction value is
normally zero; the verifier checks the inner `openPack` value.

Recognized ERC-8021 attribution metadata may be reported after it is safely
removed for strict inner-call comparison. Attribution is never wallet identity
or permission to change the planned call.

## Receipt and postcondition gate

After Bankr returns a transaction hash:

```bash
node scripts/stonk-gacha.mjs inspect-tx \
  --wallet 0xActiveBankrEvmWallet \
  --tx 0xBaseTransactionHash \
  --context 0xFreshInspectionContextHex \
  --plan-key 0xFreshInspectionKey
```

Require all of the following before reporting completion or starting a
dependent phase:

1. the transaction is mined on Base and its receipt succeeded;
2. direct sender or sponsored logical sender is the active wallet;
3. the exact bound logical target, calldata, value, and chain are proven;
4. the expected event appears from the expected emitter inside the scoped call;
5. the operation-specific fresh read in `operations.md` proves the new state;
6. exact token balance and allowance changes are proven where applicable.

A pending, unavailable, reverted, or ambiguous transaction is not permission to
retry. Recover from its hash and fresh Base state. If receipt or postcondition
proof remains incomplete, report "submitted but unverified," include the hash,
and stop.

`/wallet/submit` has no documented idempotency field. For an ambiguous approval,
reconcile Bankr Activity/nonce and the current USDC allowance before any resend.
For an ambiguous `openPack`, reconcile Bankr Activity, scoped `PackOpened`, and
the wallet's fresh request state. Never recreate approval or replay pack
randomness merely because the HTTP response was lost.
