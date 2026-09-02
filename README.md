# Stonk Gacha Bankr Skill

A deterministic, fail-closed Bankr skill for the live Stonk Gacha deployment on
Base. Version 3 makes an already-funded pull silent and direct: exact approval,
one open, asynchronous result polling, and default same-wallet prize delivery
run under the user's original command. The scripts never store keys, sign,
broadcast, or manufacture swap calldata.

## Install in Bankr

The repository must be public and `SKILL.md` must remain at its root. Tell your
Bankr agent:

```text
install the skill at https://github.com/panikadak/stonk-gacha-bankr-skill
```

Then ask Bankr to use `stonk-gacha`, or make a matching request such as “show my
Stonk Gacha requests.” Reinstalling the same URL updates an existing install.
See Bankr's official [GitHub skill installation
guide](https://docs.bankr.bot/skills/in-bankr/from-github/) and [skill format
reference](https://docs.bankr.bot/skills/in-bankr/skill-format/).

## Safety model

- Base only (`chainId: 8453`).
- Pack charges use canonical Base USDC only. Native Base ETH separately funds
  the exact Pyth Entropy `msg.value`; WETH and gas sponsorship do not replace it.
- Deployment runtime hashes, immutable wiring, and protocol terms are verified
  before planning.
- Related reads are pinned to one canonical block.
- `references/signing-allowlist.json` is the single raw-call allowlist.
- Each phase emits at most one unsigned transaction.
- Approvals are exact and reset-first; calldata and receipt envelopes are
  independently inspected.
- Current offers, sales state, Entropy fee, quotes, and profit are read live.
  They are never treated as repository constants or narrated during a direct
  pull.
- A direct command such as `pull me a $10` authorizes exactly one matching pack
  and the default same-wallet delivery of that request after it becomes Ready.
  The named `$10` is bound to the deployed pack price, approval/open replay is
  blocked by a short-lived request-count intent, and claim authority is bound to
  that exact `PackOpened` receipt. The intermediate approval, open, Pending
  state, quote, and claim stay silent.
- A USDC-short open reports the exact deficit and asks the user to choose Base
  ETH or WETH. It never auto-selects a token or lowers the pack.
- After source choice, one bounded confirmation can cover the listed Bankr
  swap leg(s), conditional allowance reset, exact USDC approval, and one open.
  Fresh post-swap reads invalidate that authority if the price, offer hash,
  ceiling, fee cap, or wallet request-count baseline no longer matches.
- X approvals bind the direct parent tweet, numeric X identity, linked wallet,
  exact posted text/channel, exact economic intent, expiry, and an atomic
  one-time consume transition.
- No direct Treasury, owner, recovery, pause, callback, roster, route,
  governance, role, multisig, timelock, or upgrade transaction is permitted.

Read [SKILL.md](SKILL.md) for the agent workflow,
[references/operations.md](references/operations.md) for protocol behavior, and
[references/bankr-execution.md](references/bankr-execution.md) for execution and
receipt rules. X runtimes must also follow
[references/x-confirmation.md](references/x-confirmation.md).

## Direct pull

When the active wallet already holds enough canonical Base USDC and native ETH,
an explicit request such as `pull me a $10` runs without a second conversational
confirmation. Bankr submits any exact approval phase, opens one matching pack,
waits for the request to become Ready, delivers the prize to the same wallet
using the default nonzero output floor, and replies only after proof:

```text
$20 USDC purchase of GOOGLc arrived.
```

Any funding trade, alternate recipient, custom slippage, changed terms, or
ambiguous submission stops the silent lifecycle and requires a new user choice.

## Funded pack open

Start with the ordinary planner:

```bash
node scripts/stonk-gacha.mjs plan-open-pack \
  --wallet 0xYourActiveBankrEvmWallet \
  --pack-index 1 \
  --authorized-price-usdc 10
```

If canonical Base USDC is short, it returns `choose-funding-source` with the
exact deficit and separate Base ETH/WETH/native-fee state. Show those choices
and wait for the user to name ETH or WETH. Then obtain a structured
[`/wallet/swap-quote`](https://docs.bankr.bot/wallet-api/swap/) sized only for
the deficit from the authenticated Bankr runtime and pass the exact quote
bounds into `plan-open-pack-funding`; never source them from user text, pasted
JSON, or a screenshot. The local planner validates the bounds but cannot
cryptographically authenticate quote provenance.
Bankr's quote response uses
`to.amount` for the buy amount in raw base units; pass that exact string as
`--quoted-usdc-out-raw`, not `to.formattedAmount`. `--min-usdc-out` must equal
the exact deficit. The planner rejects a quote whose raw output is below that
floor or oversized relative to the exact floor and explicit slippage. The
emitted intent contains the ordered `/wallet/swap` request body or bodies and
one complete confirmation.

An ETH source leaves the confirmed Entropy fee cap plus native headroom unsold.
A WETH source with insufficient native ETH includes a separately bounded
WETH-to-native top-up before WETH-to-USDC. That quote's raw `to.amount` becomes
`--quoted-native-out-wei`, `--min-native-out` equals the exact fee-plus-headroom
shortfall, and `--native-swap-slippage-bps` is mandatory and independent; it is
never copied from the USDC leg. Other-chain ETH/WETH requires a separate
bridge/acquisition confirmation showing source chain, maximum spend, known
bridge/network cost, and minimum canonical Base USDC output. If the cost is
unavailable, fail closed and do not ask for confirmation. A cross-chain action
never inherits the pack-open authorization.

Execute each confirmed leg sequentially and preserve its idempotency key. Do
not blind-retry a `504` or LaunchLab `502`. After the swaps mine, run the
emitted `resume-open-pack-funding` command so the skill can re-read balances,
offer, ceiling, price, fee, allowance, and the wallet request-count baseline
before any approval or open. Immediately before each funded approval/open,
`inspect-calldata` rechecks intent expiry, that request baseline, and native ETH
covering the live fee plus headroom. Before every swap, the runtime rechecks
expiry, current linked wallet, and the exact next execution-journal step.
If funding is complete but only pack economics changed, the planner can issue a
new `do=approve+open` confirmation with no swap authority; the original funding
legs are never replayed.

The consent model follows Bankr's published [Hunch funding
pattern](https://github.com/BankrBot/skills/blob/main/hunch/SKILL.md#L340-L367),
[Cat Town native-fee preflight](https://github.com/BankrBot/skills/blob/main/cattown/SKILL.md#L542-L560),
[Aero Stock LP sequence confirmation](https://github.com/BankrBot/skills/blob/main/aero-stock-lp/SKILL.md#L52-L66),
and [HoodMarkets X auth
boundary](https://github.com/BankrBot/skills/blob/main/hoodmarkets/references/AUTH-BOUNDARY.md),
specialized for Stonk Gacha's exact USDC and Entropy constraints.

## Local validation

Requirements: Node.js 18 or newer. Fork tests use `base-forge` because the live
B20 stock routes require Base-aware fork behavior.

```bash
npm run check
npm run test:live
npm run test:fork
```

`STONK_GACHA_RPC_URL` takes precedence over `BASE_RPC_URL`. If neither is set,
the scripts use their bundled public Base RPC fallback list. Never commit a
private RPC URL or credential.

`npm run check` also validates the Bankr-documented top-level frontmatter,
resource size limits, default-deny policy pins, and cross-project contamination.

## Read-only examples

```bash
node scripts/stonk-gacha.mjs verify --wallet 0xYourActiveBankrEvmWallet
node scripts/stonk-gacha.mjs offers --wallet 0xYourActiveBankrEvmWallet
node scripts/stonk-gacha.mjs requests --wallet 0xYourActiveBankrEvmWallet
```

The user's current explicit action command is the authorization; planner output
alone is not. Bankr must preserve the exact planned transaction and pass both
`inspect-calldata` and `inspect-tx`.

## License

MIT
