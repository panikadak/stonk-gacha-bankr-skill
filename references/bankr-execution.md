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

## Plan and confirm

Run the relevant `plan-*` command. Treat its stdout as one JSON document:

- `ok: false` or nonzero process exit: relay the error and stop;
- empty `txs`: no transaction is ready;
- one `txs` entry: one approval or action is ready for review;
- approval phase: submit only that approval, prove it, then rerun the original
  planner against fresh state;
- `next`: the fresh read or planner step expected after success.

Before the first transaction, show the user:

- Base and the active signer;
- the action, pack index or request id, and current contract-read amount;
- exact USDC approval and Stonk Gacha spender when applicable;
- exact inner native Entropy fee for an open;
- recipient, slippage tolerance, nonzero output floor, and deadline;
- any irreversible reserve donation;
- expected approval/action order and the fact that settlement is asynchronous.

One explicit confirmation may cover sequential phases only while these economic
terms remain unchanged. Reconfirm if the current offer, price, ceiling, token
set, route hashes, pack/request, amount, fee, quote floor, recipient, spender,
or irreversible effect changes. A plan context/key proves integrity, not user
authorization.

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
value. Never edit calldata to repair a mismatch.

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

If a planner reports a USDC deficit, acquisition is a separate Bankr-native
trade. Confirm that trade's source asset, exact input or maximum input, output
floor, fees, and slippage in Bankr; require its mined receipt; then rerun this
skill's planner. This skill creates no local swap calldata and claims no source-
asset allowlist. The continuation gate is the fresh planner read of the pinned
official Base USDC balance.

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
