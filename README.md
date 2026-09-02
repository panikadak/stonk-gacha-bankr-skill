# Stonk Gacha Bankr Skill

A deterministic, fail-closed Bankr skill for the live Stonk Gacha deployment on
Base. It reads current offers and request state, plans the public user and worker
operations, produces unsigned transactions, and verifies submitted receipts.
It never stores keys, signs, or broadcasts.

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
- Deployment runtime hashes, immutable wiring, and protocol terms are verified
  before planning.
- Related reads are pinned to one canonical block.
- `references/signing-allowlist.json` is the single raw-call allowlist.
- Each phase emits at most one unsigned transaction.
- Approvals are exact and reset-first; calldata and receipt envelopes are
  independently inspected.
- Current offers, sales state, Entropy fee, odds, quotes, and profit are read
  live. They are never treated as repository constants.
- No direct Treasury, owner, recovery, pause, callback, roster, route,
  governance, role, multisig, timelock, or upgrade transaction is permitted.

Read [SKILL.md](SKILL.md) for the agent workflow,
[references/operations.md](references/operations.md) for protocol behavior, and
[references/bankr-execution.md](references/bankr-execution.md) for execution and
receipt rules.

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

Planner output is not authorization and is not submitted by these scripts. A
Bankr execution must preserve the exact planned transaction and pass both
`inspect-calldata` and `inspect-tx`.

## License

MIT
