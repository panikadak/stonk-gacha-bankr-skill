#!/usr/bin/env node
// Deterministic Stonk Gacha planner for Bankr. This program reads Base,
// verifies the reviewed deployment, and emits at most one unsigned transaction.
// It never signs, submits, swaps wallet assets, or chooses an outcome.

import { randomBytes, randomUUID } from "node:crypto";
import {
  decodeCallArguments,
  decodeBytes32,
  decodeParameters,
  decodeUint,
  encodeCall,
  formatUnits,
  jsonValue,
  normalizeAddress,
  parseUnits,
  stripErc8021Suffix,
} from "./lib/abi.mjs";
import {
  beginSnapshot,
  confirmSnapshot,
  estimateGas,
  ethCall,
  getBalance,
  getBlockByHash,
  getCode,
  getCodeHash,
  getReceipt,
  getStorageAt,
  getTransaction,
  getTransactionCount,
  revertData,
  txSelector,
  unsignedTx,
} from "./lib/chain.mjs";
import {
  ECRECOVER_PRECOMPILE,
  ENTRY_POINT_V07_CODE_HASH,
  KERNEL_DELEGATION_DESIGNATOR,
  KERNEL_IMPLEMENTATION,
  KERNEL_IMPLEMENTATION_CODE_HASH,
  KERNEL_VALIDATION_STORAGE_SLOT,
  ROOT_VALIDATOR_SELECTOR,
  decodeAuthorizationAuthority,
  decodeBankrExecution,
  decodeRootValidator,
  proveKernelDelegationAtTransaction,
  sumCanonicalErc20Transfers,
  userOperationHashCall,
  verifyBankrExecutionReceipt,
} from "./lib/bankr.mjs";
import { eventTopic, keccak256 } from "./lib/keccak256.mjs";
import {
  DEFAULT_INTENT_TTL_SECONDS,
  DEFAULT_NATIVE_HEADROOM_WEI,
  FUNDING_POLICY,
  MAX_INTENT_TTL_SECONDS,
  MAX_NATIVE_HEADROOM_WEI,
  MIN_NATIVE_HEADROOM_WEI,
  bindXFundingIntent,
  createFundingIntent,
  decodeFundingIntent,
  decodeXPendingIntent,
  encodeFundingIntent,
  encodeXPendingIntent,
  fundingIntentKey,
  fundingResumeAssessment,
  fundingSourceOptions,
  parseMinimumNative,
  parseMinimumUsdc,
  parseSourceAmount,
  rebaseFundingIntentForRemainingOpen,
  verifyXFundingApproval,
  xPendingIntentKey,
  xPreparedConfirmation,
  xSelfContainedCommand,
} from "./lib/funding.mjs";
import {
  ADDR,
  BPS,
  DEPLOYMENT,
  EVENT_BY_EMITTER_TOPIC,
  SIG,
  USDC_DECIMALS,
  ZERO_ADDRESS,
  call,
  confirmationKey,
  describeRevert,
  knownActionBySelector,
  localOfferHash,
  profitStatus,
  protocolStatus,
  quotePayout,
  readBool,
  readOffer,
  readRequest,
  readUint,
  requiresAllowanceReset,
  verifyDeployment,
  walletRequests,
} from "./lib/protocol.mjs";

const [, , command, ...argv] = process.argv;
const ZERO_ROOT_VALIDATOR_RESULT = `0x${"0".repeat(64)}`;
const APPROVAL_TOPIC = eventTopic("Approval(address,address,uint256)").toLowerCase();
const TRANSFER_TOPIC = eventTopic("Transfer(address,address,uint256)").toLowerCase();
const COMMAND_FLAGS = Object.freeze({
  help: [],
  verify: ["wallet"],
  status: ["wallet"],
  offers: ["wallet"],
  offer: ["wallet", "pack-index"],
  requests: ["wallet", "cursor", "limit"],
  request: ["wallet", "request-id"],
  "profit-status": ["wallet"],
  "plan-open-pack": ["wallet", "pack-index", "user-random"],
  "plan-open-pack-funding": [
    "wallet", "pack-index", "source-token", "source-amount", "min-usdc-out", "quoted-usdc-out-raw",
    "swap-slippage-bps", "quote-id", "swap-idempotency-key",
    "native-source-amount", "min-native-out", "quoted-native-out-wei", "native-swap-slippage-bps",
    "native-quote-id", "native-swap-idempotency-key", "native-headroom-wei",
    "intent-ttl-seconds", "user-random",
  ],
  "resume-open-pack-funding": ["wallet", "intent", "intent-key"],
  "bind-x-funding-intent": [
    "wallet", "intent", "intent-key", "x-user-id", "confirmation-tweet-id",
    "confirmation-channel", "confirmation-message-hex",
  ],
  "verify-x-funding-approval": [
    "wallet", "pending-intent", "pending-intent-key", "approval-mode", "message", "message-hex",
    "approval-tweet-id", "parent-tweet-id", "reference-type", "x-user-id",
  ],
  "plan-revoke-usdc": ["wallet"],
  "plan-claim-prize": ["wallet", "request-id", "recipient", "slippage-bps"],
  "plan-expire-request": ["wallet", "request-id"],
  "plan-claim-refund": ["wallet", "request-id", "recipient"],
  "plan-fund-reserve": ["wallet", "amount-usdc"],
  "plan-distribute-profit": ["wallet", "amount-usdc", "slippage-bps"],
  "inspect-calldata": ["wallet", "chain-id", "to", "data", "value", "context", "plan-key"],
  "inspect-tx": ["wallet", "tx", "context", "plan-key"],
});

const args = {};
let argumentParseError = null;
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index];
  if (!flag.startsWith("--")) {
    argumentParseError = `unexpected positional argument: ${flag}`;
    break;
  }
  const key = flag.slice(2);
  if (!key || Object.hasOwn(args, key)) {
    argumentParseError = !key ? "empty -- flag is not allowed" : `duplicate flag: --${key}`;
    break;
  }
  const next = argv[index + 1];
  if (next !== undefined && !next.startsWith("--")) {
    args[key] = next;
    index += 1;
  } else {
    args[key] = true;
  }
}

class GateError extends Error {
  constructor(gateName, detail, extra = {}) {
    super(detail);
    this.gate = gateName;
    this.extra = extra;
  }
}

function gate(condition, gateName, detail, extra = {}) {
  if (!condition) throw new GateError(gateName, detail, extra);
}

function need(name) {
  const value = args[name];
  gate(value !== undefined && value !== true, "args", `--${name} is required`);
  return value;
}

function integerArg(name, { min = 0n, max = (1n << 256n) - 1n, required = true } = {}) {
  const raw = required ? need(name) : args[name];
  if (raw === undefined) return null;
  gate(raw !== true && /^(0|[1-9][0-9]*)$/.test(String(raw)), "args", `--${name} must be a canonical non-negative integer`);
  const value = BigInt(raw);
  gate(value >= min && value <= max, "args", `--${name} must be between ${min} and ${max}`);
  return value;
}

function walletArg() {
  const wallet = normalizeAddress(need("wallet"));
  gate(wallet !== ZERO_ADDRESS, "wallet", "active Bankr wallet cannot be the zero address");
  return wallet;
}

function recipientArg(wallet) {
  const recipient = args.recipient ? normalizeAddress(args.recipient) : wallet;
  gate(recipient !== ZERO_ADDRESS && recipient !== ADDR.gacha && recipient !== ADDR.treasury, "recipient", "recipient cannot be zero, StonkGacha, or GachaTreasury");
  return recipient;
}

function packIndexArg() {
  return Number(integerArg("pack-index", { min: 0n, max: BigInt(DEPLOYMENT.productTerms.packCount - 1) }));
}

function requestIdArg() {
  return integerArg("request-id", { min: 1n });
}

function slippageBps(defaultValue = 300n) {
  return args["slippage-bps"] === undefined
    ? defaultValue
    : integerArg("slippage-bps", { min: 1n, max: 1_000n });
}

function amountUsdcArg() {
  let amount;
  try {
    amount = parseUnits(need("amount-usdc"), USDC_DECIMALS);
  } catch (error) {
    throw new GateError("args", error.message);
  }
  gate(amount > 0n, "args", "--amount-usdc must be greater than zero");
  return amount;
}

function bytes32Arg(name) {
  const value = need(name);
  gate(/^0x[0-9a-fA-F]{64}$/.test(value), "args", `--${name} must be exactly 32 bytes of hex`);
  return value.toLowerCase();
}

function decimalAmountArg(name, parser) {
  try {
    const amount = parser(need(name));
    gate(amount > 0n, "args", `--${name} must be greater than zero`);
    return amount;
  } catch (error) {
    if (error instanceof GateError) throw error;
    throw new GateError("args", error.message);
  }
}

function optionalBoundedText(name, pattern, description) {
  const value = args[name];
  if (value === undefined) return null;
  gate(value !== true && pattern.test(String(value)), "args", `--${name} ${description}`);
  return String(value);
}

function decodeUtf8HexArg(name) {
  const value = need(name);
  gate(/^0x(?:[0-9a-fA-F]{2})+$/.test(value) && value.length <= 2 + 4096 * 2, "args", `--${name} must be non-empty UTF-8 hex under 4 KiB`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(value.slice(2).match(/.{2}/g).map((entry) => Number.parseInt(entry, 16))),
    );
  } catch {
    throw new GateError("args", `--${name} is not valid UTF-8`);
  }
}

function rejectUnknownFlags() {
  if (command === undefined) {
    gate(Object.keys(args).length === 0, "args", "help takes no flags when no command is supplied");
    return;
  }
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) return;
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  gate(unknown.length === 0, "args", `unsupported flag for ${command}: --${unknown[0]}`, { allowedFlags: allowed });
}

function out(value, exitCode = 0) {
  console.log(JSON.stringify(jsonValue(value), null, 2));
  process.exitCode = exitCode;
}

function snapshotView(snapshot) {
  return { blockNumber: snapshot.number, blockHash: snapshot.hash, timestamp: snapshot.timestamp };
}

async function deploymentGate(snapshot = null) {
  const ownSnapshot = snapshot ?? await beginSnapshot();
  const integrity = await verifyDeployment(ownSnapshot);
  gate(integrity.ok, "deployment-integrity", "live Base deployment does not match the reviewed release pin", {
    failed: integrity.failed,
    snapshot: integrity.snapshot,
  });
  return { snapshot: ownSnapshot, integrity };
}

async function simulation(tx, wallet, block = "latest") {
  try {
    const result = await ethCall(tx.to, tx.data, { from: wallet, value: BigInt(tx.value), block });
    const gasEstimate = await estimateGas(tx.to, tx.data, wallet, BigInt(tx.value), block);
    return { ok: true, returnData: result || "0x", gasEstimate };
  } catch (error) {
    const data = revertData(error);
    throw new GateError("simulation", data ? describeRevert(data) : error.message, {
      revertSelector: data?.slice(0, 10) ?? null,
    });
  }
}

function encodeInspectionContext(action, terms) {
  const context = jsonValue({ action, terms });
  const raw = JSON.stringify(context);
  const bytes = new TextEncoder().encode(raw);
  gate(bytes.length <= 65_536, "planner", "inspection context exceeds 64 KiB");
  return {
    context,
    hex: `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  };
}

function decodeInspectionContext(value) {
  gate(typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(value), "args", "--context must be non-empty UTF-8 JSON encoded as hex");
  gate(value.length <= 2 + 65_536 * 2, "args", "--context exceeds 64 KiB");
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(value.slice(2).match(/.{2}/g).map((entry) => Number.parseInt(entry, 16))),
    );
  } catch {
    throw new GateError("args", "--context is not valid UTF-8");
  }
  let context;
  try {
    context = JSON.parse(raw);
  } catch {
    throw new GateError("args", "--context is not valid JSON");
  }
  gate(context && typeof context === "object" && !Array.isArray(context), "args", "--context must decode to an object");
  gate(typeof context.action === "string" && context.terms && typeof context.terms === "object" && !Array.isArray(context.terms), "args", "--context must contain action and terms");
  gate(JSON.stringify(context) === raw, "args", "--context JSON is not in canonical planner form");
  return { context, hex: value.toLowerCase() };
}

function inspectionKey(wallet, tx, contextHex) {
  return keccak256(JSON.stringify({
    chainId: Number(BigInt(tx.chainId)),
    wallet: normalizeAddress(wallet),
    to: normalizeAddress(tx.to),
    data: tx.data.toLowerCase(),
    value: BigInt(tx.value).toString(),
    context: contextHex.toLowerCase(),
  }));
}

async function finalPlan({ action, wallet, tx, terms, report, reads, expectedEvents, postconditions, warnings = [], snapshot, resume = null, authorization = null }) {
  const preflight = await simulation(tx, wallet, snapshot.ref);
  await confirmSnapshot(snapshot);
  const inspection = encodeInspectionContext(action, terms);
  return {
    ok: true,
    command,
    phase: "action",
    network: { name: "Base", chainId: 8453 },
    deployment: { sourceCommit: DEPLOYMENT.release.sourceCommit, integrity: true },
    snapshot: snapshotView(snapshot),
    wallet,
    reads,
    terms,
    confirmationKey: confirmationKey(wallet, action, terms),
    inspectionContext: inspection.context,
    inspectionContextHex: inspection.hex,
    inspectionKey: inspectionKey(wallet, tx, inspection.hex),
    report,
    warnings,
    txs: [tx],
    preflight,
    expectedEvents,
    postconditions,
    ...(authorization ? { authorization } : {}),
    ...(resume ? { resume } : {}),
    submitRule: authorization
      ? "Do not ask again only if the runtime has the exact unexpired combined funding authorization, its one-time confirmation was atomically consumed, and this phase is the next unreconciled step in that execution journal. Submit only this transaction, wait for a successful receipt, then rerun the emitted resume command. A missing journal, changed term, or ambiguous prior submit is a hard stop, not permission to recreate approval."
      : "Show the complete report and exact terms. Obtain explicit confirmation for this confirmationKey. Immediately re-run from fresh chain state using the emitted resume command when present. If the key or terms changed, obtain new confirmation. Submit only this one transaction with waitForConfirmation=true. Treat an unknown outcome as pending investigation, never as permission to replay.",
  };
}

async function approvalPlan({ action, wallet, tx, terms, report, reads, warnings = [], snapshot, resume, authorization = null }) {
  const preflight = await simulation(tx, wallet, snapshot.ref);
  await confirmSnapshot(snapshot);
  const inspection = encodeInspectionContext(action, terms);
  return {
    ok: true,
    command,
    phase: "approval",
    network: { name: "Base", chainId: 8453 },
    deployment: { sourceCommit: DEPLOYMENT.release.sourceCommit, integrity: true },
    snapshot: snapshotView(snapshot),
    wallet,
    reads,
    terms,
    confirmationKey: confirmationKey(wallet, action, terms),
    inspectionContext: inspection.context,
    inspectionContextHex: inspection.hex,
    inspectionKey: inspectionKey(wallet, tx, inspection.hex),
    report,
    warnings,
    txs: [tx],
    preflight,
    expectedEvents: ["Approval"],
    ...(authorization ? { authorization } : {}),
    next: authorization
      ? `Only under the still-valid recorded combined authorization, submit this one scoped approval and wait for a successful receipt. Then run: ${resume}. Reconcile an ambiguous result from current allowance and Bankr activity before any resend; /wallet/submit has no documented idempotency key.`
      : `After explicit confirmation, submit this one scoped approval and wait for a successful receipt. Then run: ${resume}. Re-read every mutable term; do not submit an action from this stale approval plan. If the action is abandoned after a nonzero approval, run plan-revoke-usdc.`,
  };
}

function exactApprovalTx(currentAllowance, required, label) {
  if (currentAllowance === required) return null;
  const next = requiresAllowanceReset(currentAllowance, required) ? 0n : required;
  return unsignedTx(
    ADDR.usdc,
    encodeCall(SIG.approve, ["address", "uint256"], [ADDR.gacha, next]),
    next === 0n ? `reset mismatched USDC allowance: ${label}` : `exact USDC approval: ${label}`,
    { value: 0n },
  );
}

function fundingRequired(wallet, balance, required, resume, purpose) {
  const deficit = required - balance;
  out({
    ok: false,
    command,
    phase: "needs-usdc",
    gate: "balance",
    wallet,
    token: { symbol: "USDC", address: ADDR.usdc, decimals: USDC_DECIMALS },
    currentBalance: balance,
    requiredBalance: required,
    deficit,
    purpose,
    instruction: `Stop this Stonk Gacha plan. This output is not swap authorization. If the user separately asks Bankr to acquire at least ${formatUnits(deficit, USDC_DECIMALS)} official Base USDC, confirm the source asset, exact input or maximum input, output floor, fees, and slippage as a separate Bankr-native trade. This skill does not trust or manufacture swap calldata. After Bankr proves that trade mined, run the fresh balance gate again with: ${resume}`,
  }, 2);
}

function openPackFundingRequired({ wallet, packIndex, usdcBalance, wethBalance, ethBalance, offer, snapshot }) {
  const options = fundingSourceOptions({
    usdcBalance,
    packPriceUsdc: BigInt(offer.priceUsdc),
    ethBalance,
    wethBalance,
    entropyFeeWei: BigInt(offer.entropyFee),
  });
  out({
    ok: true,
    command,
    phase: "choose-funding-source",
    gate: "canonical-base-usdc-balance",
    network: { name: "Base", chainId: 8453 },
    snapshot: snapshotView(snapshot),
    wallet,
    pack: {
      packIndex,
      priceUsdcRaw: offer.priceUsdc,
      priceUsdc: offer.priceUsdcFormatted,
      expectedOfferHash: offer.offerHash,
      acceptedCeilingBps: offer.ceilingBps,
      entropyFeeWei: offer.entropyFee,
    },
    canonicalAssets: {
      usdc: { address: ADDR.usdc, decimals: 6, balanceRaw: usdcBalance },
      nativeEth: { address: FUNDING_POLICY.walletApi.nativeTokenSentinel, decimals: 18, balanceWei: ethBalance },
      weth: { address: ADDR.weth, decimals: 18, balanceWei: wethBalance },
    },
    funding: options,
    bankrPortfolioRead: {
      method: FUNDING_POLICY.walletApi.portfolio.method,
      path: FUNDING_POLICY.walletApi.portfolio.path,
      rule: "Match Base ERC-20 balances by exact address and keep decimal strings exact; do not parse balances as floating point.",
    },
    sourceSelectionRequired: true,
    instruction: `Do not choose or swap automatically. Show the eligible Base ETH and Base WETH balances above and ask the user which source to use. After the user names ETH or WETH, obtain the smallest exact-input Bankr quote whose minBuyAmount equals the ${options.exactDeficitUsdc} USDC deficit, then run plan-open-pack-funding with that quote's exact input amount, raw to.amount, floor, slippage, and a persistent UUID idempotency key. WETH does not satisfy native msg.value.`,
    crossChainRule: "ETH or WETH on any other chain is not a Base balance. Any cross-chain acquisition is a separate confirmation that must name the source chain/token, maximum spend, bridge or network cost, and minimum canonical Base USDC output; it is never bundled silently with openPack.",
    lowerPackRule: "Never downgrade the pack automatically. A lower pack index requires a new explicit user choice and a fresh planner run.",
  });
}

function freshRandomArg() {
  if (args["user-random"] !== undefined) {
    const provided = bytes32Arg("user-random");
    gate(!/^0x0{64}$/.test(provided), "randomness", "--user-random cannot be zero");
    return { value: provided, generated: false };
  }
  let value;
  do value = `0x${randomBytes(32).toString("hex")}`; while (/^0x0{64}$/.test(value));
  return { value, generated: true };
}

function amountFloor(quote, slippage) {
  const floor = quote * (BPS - slippage) / BPS;
  gate(quote > 0n && floor > 0n, "quote", "live route quote or computed nonzero floor is unavailable");
  return floor;
}

async function commandVerify() {
  const wallet = args.wallet ? walletArg() : null;
  const result = await verifyDeployment();
  out({ ok: result.ok, command, wallet, ...result }, result.ok ? 0 : 1);
}

async function commandStatus() {
  const wallet = args.wallet ? walletArg() : null;
  const snapshot = await beginSnapshot();
  const status = await protocolStatus(wallet, snapshot);
  await confirmSnapshot(snapshot);
  out({ ok: status.ok, command, status }, status.ok ? 0 : 1);
}

async function commandOffers() {
  const wallet = args.wallet ? walletArg() : null;
  const { snapshot } = await deploymentGate();
  const salesPaused = await readBool(ADDR.gacha, "salesPaused()", [], [], snapshot.ref);
  const offers = [];
  for (let index = 0; index < DEPLOYMENT.productTerms.packCount; index += 1) {
    try { offers.push(await readOffer(index, snapshot)); }
    catch (error) { offers.push({ packIndex: index, available: false, reason: error.message }); }
  }
  await confirmSnapshot(snapshot);
  out({ ok: true, command, wallet, snapshot: snapshotView(snapshot), salesPaused, offers });
}

async function commandOffer() {
  const wallet = args.wallet ? walletArg() : null;
  const packIndex = packIndexArg();
  const { snapshot } = await deploymentGate();
  const offer = await readOffer(packIndex, snapshot);
  const salesPaused = await readBool(ADDR.gacha, "salesPaused()", [], [], snapshot.ref);
  await confirmSnapshot(snapshot);
  out({ ok: true, command, wallet, snapshot: snapshotView(snapshot), salesPaused, offer });
}

async function commandRequests() {
  const wallet = walletArg();
  const cursor = args.cursor === undefined ? 0n : integerArg("cursor");
  const limit = args.limit === undefined ? 20n : integerArg("limit", { min: 1n, max: 100n });
  const { snapshot } = await deploymentGate();
  const page = await walletRequests(wallet, cursor, limit, snapshot);
  await confirmSnapshot(snapshot);
  out({ ok: true, command, wallet, page });
}

async function commandRequest() {
  const wallet = args.wallet ? walletArg() : null;
  const { snapshot } = await deploymentGate();
  const request = await readRequest(requestIdArg(), snapshot);
  await confirmSnapshot(snapshot);
  out({ ok: true, command, wallet, request });
}

async function commandProfitStatus() {
  const wallet = args.wallet ? walletArg() : null;
  const { snapshot } = await deploymentGate();
  const profit = await profitStatus(wallet, snapshot);
  await confirmSnapshot(snapshot);
  out({ ok: true, command, profit });
}

async function planOpenPack() {
  const wallet = walletArg();
  const packIndex = packIndexArg();
  const { snapshot } = await deploymentGate();
  const [salesPaused, offer, usdcBalance, wethBalance, allowance, ethBalance] = await Promise.all([
    readBool(ADDR.gacha, "salesPaused()", [], [], snapshot.ref),
    readOffer(packIndex, snapshot),
    readUint(ADDR.usdc, SIG.balanceOf, ["address"], [wallet], snapshot.ref),
    readUint(ADDR.weth, SIG.balanceOf, ["address"], [wallet], snapshot.ref),
    readUint(ADDR.usdc, SIG.allowance, ["address", "address"], [wallet, ADDR.gacha], snapshot.ref),
    getBalance(wallet, snapshot.ref),
  ]);
  gate(!salesPaused, "sales", "new pack sales are currently paused; claims, refunds, and expiry remain available");
  const priceUsdc = BigInt(offer.priceUsdc);
  const entropyFee = BigInt(offer.entropyFee);
  const ceilingBps = BigInt(offer.ceilingBps);
  const resumeBase = `node scripts/stonk-gacha.mjs plan-open-pack --wallet ${wallet} --pack-index ${packIndex}`;
  if (usdcBalance < priceUsdc) {
    await confirmSnapshot(snapshot);
    return openPackFundingRequired({ wallet, packIndex, usdcBalance, wethBalance, ethBalance, offer, snapshot });
  }
  gate(ethBalance >= entropyFee, "native-fee", "wallet ETH balance is below the exact live Pyth Entropy fee", { ethBalance, entropyFee });

  const random = freshRandomArg();
  const resume = `${resumeBase} --user-random ${random.value}`;
  const terms = {
    packIndex,
    packPriceUsdc: priceUsdc,
    minCeilingBps: ceilingBps,
    nominalRtpBps: BigInt(offer.nominalRtpBps),
    expectedOfferHash: offer.offerHash,
    orderedEligible: offer.eligible.map(({ token, routeHash }) => ({ token, routeHash })),
    maxPayoutUsdc: BigInt(offer.maxPayoutUsdc),
    entropyFeeWei: entropyFee,
    userRandomNumber: random.value,
    approval: { token: ADDR.usdc, spender: ADDR.gacha, exactAmount: priceUsdc },
  };
  const report = `Open one ${formatUnits(priceUsdc, 6)} USDC Stonk Gacha pack with the exact current ${formatUnits(BigInt(offer.maxPayoutUsdc), 6)} USDC maximum cash-backed payout budget, ${offer.nominalRtpBps} bps nominal RTP at this ceiling, the exact ordered ${offer.eligible.length}-stock commitment, and exactly ${formatUnits(entropyFee, 18)} ETH forwarded to Pyth Entropy? A successful open is Pending, not a win; the delivered token amount is known only after a later buyer-approved delivery swap.`;
  const approval = exactApprovalTx(allowance, priceUsdc, `pack index ${packIndex}`);
  if (approval) {
    out(await approvalPlan({
      action: "open-pack",
      wallet,
      tx: approval,
      terms,
      report,
      reads: { usdcBalance, currentAllowance: allowance, ethBalance, offer },
      warnings: ["The native Entropy fee is separate from the refundable USDC pack charge and is not refunded by Stonk Gacha."],
      snapshot,
      resume,
    }));
    return;
  }
  const tx = unsignedTx(
    ADDR.gacha,
    encodeCall("openPack(uint256,uint256,bytes32,bytes32)", ["uint256", "uint256", "bytes32", "bytes32"], [BigInt(packIndex), ceilingBps, offer.offerHash, random.value]),
    `open Stonk Gacha pack index ${packIndex}`,
    { value: entropyFee },
  );
  out(await finalPlan({
    action: "open-pack",
    wallet,
    tx,
    terms,
    report,
    reads: { usdcBalance, exactAllowance: allowance, ethBalance, offer, randomGeneratedByPlanner: random.generated },
    warnings: [
      "PackOpened proves only a Pending request. Do not describe a stock, multiplier, payout, or win until PackReady is mined.",
      "The Entropy fee is paid in native ETH and is separate from the USDC refund liability.",
      "If submission has an unknown outcome, inspect the wallet's requests before considering any new pack; never replay this calldata blindly.",
    ],
    expectedEvents: ["PackOpened", "exact USDC Transfer wallet->StonkGacha"],
    postconditions: ["a new request owned by the active wallet is Pending", "request terms match the exact pinned offer", "USDC charge equals the selected pack price"],
    snapshot,
    resume,
  }));
}

async function planOpenPackFunding() {
  const wallet = walletArg();
  const packIndex = packIndexArg();
  const sourceToken = String(need("source-token")).toUpperCase();
  gate(sourceToken === "ETH" || sourceToken === "WETH", "args", "--source-token must be explicitly selected as ETH or WETH");
  const sourceAmountRaw = decimalAmountArg("source-amount", parseSourceAmount);
  const minUsdcOutRaw = decimalAmountArg("min-usdc-out", parseMinimumUsdc);
  const quotedUsdcOutRaw = integerArg("quoted-usdc-out-raw", { min: 1n });
  const swapSlippage = Number(integerArg("swap-slippage-bps", { min: 10n, max: 2_000n }));
  const quoteId = optionalBoundedText("quote-id", /^[A-Za-z0-9._:-]{1,256}$/, "must be a bounded opaque Bankr quote id");
  const swapIdempotencyKey = args["swap-idempotency-key"] === undefined
    ? randomUUID()
    : optionalBoundedText("swap-idempotency-key", /^[0-9a-fA-F-]{36}$/, "must be a UUID");
  const nativeHeadroomWei = args["native-headroom-wei"] === undefined
    ? DEFAULT_NATIVE_HEADROOM_WEI
    : integerArg("native-headroom-wei", { min: MIN_NATIVE_HEADROOM_WEI, max: MAX_NATIVE_HEADROOM_WEI });
  const ttl = args["intent-ttl-seconds"] === undefined
    ? DEFAULT_INTENT_TTL_SECONDS
    : integerArg("intent-ttl-seconds", { min: 60n, max: MAX_INTENT_TTL_SECONDS });

  const nativeSourceAmountRaw = args["native-source-amount"] === undefined
    ? null
    : decimalAmountArg("native-source-amount", parseSourceAmount);
  const minNativeOutWei = args["min-native-out"] === undefined
    ? null
    : decimalAmountArg("min-native-out", parseMinimumNative);
  const quotedNativeOutWei = args["quoted-native-out-wei"] === undefined
    ? null
    : integerArg("quoted-native-out-wei", { min: 1n });
  const nativeSwapSlippage = args["native-swap-slippage-bps"] === undefined
    ? null
    : Number(integerArg("native-swap-slippage-bps", { min: 10n, max: 2_000n }));
  const nativeQuoteId = optionalBoundedText("native-quote-id", /^[A-Za-z0-9._:-]{1,256}$/, "must be a bounded opaque Bankr quote id");
  const nativeSwapIdempotencyKey = args["native-swap-idempotency-key"] === undefined
    ? (nativeSourceAmountRaw === null ? null : randomUUID())
    : optionalBoundedText("native-swap-idempotency-key", /^[0-9a-fA-F-]{36}$/, "must be a UUID");

  const { snapshot } = await deploymentGate();
  const [salesPaused, offer, usdcBalance, wethBalance, allowance, ethBalance, requestCount] = await Promise.all([
    readBool(ADDR.gacha, "salesPaused()", [], [], snapshot.ref),
    readOffer(packIndex, snapshot),
    readUint(ADDR.usdc, SIG.balanceOf, ["address"], [wallet], snapshot.ref),
    readUint(ADDR.weth, SIG.balanceOf, ["address"], [wallet], snapshot.ref),
    readUint(ADDR.usdc, SIG.allowance, ["address", "address"], [wallet, ADDR.gacha], snapshot.ref),
    getBalance(wallet, snapshot.ref),
    readUint(ADDR.gacha, SIG.requestCountOf, ["address"], [wallet], snapshot.ref),
  ]);
  gate(!salesPaused, "sales", "new pack sales are currently paused; funding must not proceed for a pack that cannot open");
  gate(usdcBalance < BigInt(offer.priceUsdc), "funding", "wallet already has enough canonical Base USDC; use plan-open-pack instead of moving another asset");
  const random = freshRandomArg();
  let intent;
  try {
    intent = createFundingIntent({
      wallet,
      packIndex,
      packPriceUsdc: BigInt(offer.priceUsdc),
      usdcBalance,
      ethBalance,
      wethBalance,
      allowance,
      requestCount,
      spender: ADDR.gacha,
      expectedOfferHash: offer.offerHash,
      acceptedCeilingBps: BigInt(offer.ceilingBps),
      entropyFeeWei: BigInt(offer.entropyFee),
      nativeHeadroomWei,
      sourceToken,
      sourceAmountRaw,
      minUsdcOutRaw,
      quotedUsdcOutRaw,
      swapSlippageBps: swapSlippage,
      quoteId,
      swapIdempotencyKey,
      nativeSourceAmountRaw,
      minNativeOutWei,
      quotedNativeOutWei,
      nativeSwapSlippageBps: nativeSwapSlippage,
      nativeQuoteId,
      nativeSwapIdempotencyKey,
      userRandomNumber: random.value,
      createdAt: snapshot.timestamp,
      expiresAt: snapshot.timestamp + ttl,
    });
  } catch (error) {
    throw new GateError("funding-intent", error.message);
  }
  const intentHex = encodeFundingIntent(intent);
  const intentKey = fundingIntentKey(intent);
  const preparedXConfirmation = xPreparedConfirmation(intent);
  const preparedXConfirmationHex = `0x${Buffer.from(preparedXConfirmation, "utf8").toString("hex")}`;
  const nativeLeg = intent.fundingLegs.find((leg) => leg.purpose === "native-top-up");
  const usdcLeg = intent.fundingLegs.find((leg) => leg.purpose === "usdc-deficit");
  const approvalText = `reset any mismatched nonzero allowance first, then approve exactly ${formatUnits(intent.pack.priceUsdcRaw, 6)} USDC if needed`;
  const fundingText = nativeLeg
    ? `run two Base swaps with at most ${intent.source.aggregateMaximumInput} WETH total: at most ${nativeLeg.amount} WETH for at least ${nativeLeg.minBuyAmount} native ETH at ${nativeLeg.slippageBps} bps, then at most ${usdcLeg.amount} WETH for at least ${usdcLeg.minBuyAmount} canonical Base USDC at ${usdcLeg.slippageBps} bps`
    : `swap at most ${usdcLeg.amount} ${intent.source.token} on Base for at least ${usdcLeg.minBuyAmount} canonical Base USDC at ${usdcLeg.slippageBps} bps`;
  const report = `From wallet ${wallet}, ${fundingText}; ${approvalText}; then open pack index ${packIndex} for ${formatUnits(intent.pack.priceUsdcRaw, 6)} USDC using offer ${intent.pack.expectedOfferHash}, ceiling ${intent.pack.acceptedCeilingBps} bps, and a Pyth native fee capped at ${formatUnits(intent.pack.entropyFeeCapWei, 18)} ETH before intent expiry ${intent.expiresAt}?`;
  await confirmSnapshot(snapshot);
  out({
    ok: true,
    command,
    phase: "combined-confirmation",
    network: { name: "Base", chainId: 8453 },
    snapshot: snapshotView(snapshot),
    wallet,
    intent,
    intentHex,
    intentKey,
    report,
    x: {
      preparedConfirmationTweet: preparedXConfirmation,
      selfContainedFallbackCommand: xSelfContainedCommand(intent),
      bindAfterPosting: `node scripts/stonk-gacha.mjs bind-x-funding-intent --wallet ${wallet} --intent ${intentHex} --intent-key ${intentKey} --x-user-id NUMERIC_X_USER_ID --confirmation-tweet-id POSTED_TWEET_ID --confirmation-channel x --confirmation-message-hex ${preparedXConfirmationHex}`,
      bindingRule: "The tweet id, channel, and exact post text must come from trusted X posting-result metadata. Never accept user-supplied ids or text as proof that this confirmation was posted.",
    },
    bankrSequence: [
      ...intent.fundingLegs.map((leg, index) => ({
        order: index + 1,
        action: `Bankr structured ${leg.purpose} swap`,
        request: leg.bankr,
        receiptRule: "Submit this exact body. Wait for a mined response and require success:true. A 200 success:false is a mined revert. Preserve this idempotencyKey for every safe retry.",
      })),
      {
        order: intent.fundingLegs.length + 1,
        action: "fresh funded-open resume",
        command: `node scripts/stonk-gacha.mjs resume-open-pack-funding --wallet ${wallet} --intent ${intentHex} --intent-key ${intentKey}`,
        receiptRule: "Run only after every swap leg is reconciled as mined successfully; reread canonical USDC, native ETH, fee, price, offer hash, ceiling, and allowance.",
      },
    ],
    confirmationPolicy: {
      count: 1,
      covers: ["every listed Bankr swap leg", "conditional stale-allowance reset", "exact USDC approval", "one openPack call"],
      condition: "The runtime must persist this exact intent and atomically consume the user's explicit approval once. A different source, maximum input, minimum output, pack, offer, ceiling, fee cap, wallet, or expiry requires a new confirmation.",
    },
    retryPolicy: {
      swap: "For 429/503 or another proven pre-broadcast retry, resend the identical /wallet/swap body with the same idempotencyKey. Never blind-retry 504 or LaunchLab 502; reconcile Bankr Activity, hash, and balances first.",
      rawSubmit: "/wallet/submit has no documented idempotency field. Reconcile ambiguous approval from allowance plus Bankr activity/nonce, and ambiguous openPack from PackOpened/request state plus Bankr activity before any resend.",
    },
    crossChainRule: "This intent contains Base-only legs. Any other-chain ETH/WETH acquisition is a separate confirmation and cannot inherit this combined authorization.",
    lowerPackRule: "A lower pack requires a new explicit user choice; never downgrade automatically.",
    txs: [],
  });
}

async function resumeOpenPackFunding() {
  const wallet = walletArg();
  const intentHex = need("intent");
  const expectedIntentKey = bytes32Arg("intent-key");
  let intent;
  try {
    intent = decodeFundingIntent(intentHex);
  } catch (error) {
    throw new GateError("funding-intent", error.message);
  }
  gate(fundingIntentKey(intent) === expectedIntentKey, "funding-intent", "funding intent key mismatch");
  gate(intent.wallet === wallet, "funding-intent", "funding intent wallet differs from the active Bankr wallet");
  gate(normalizeAddress(intent.approvalPolicy.spender) === ADDR.gacha, "funding-intent", "funding intent spender is not the verified StonkGacha deployment");
  const packIndex = intent.pack.packIndex;
  gate(packIndex >= 0 && packIndex < DEPLOYMENT.productTerms.packCount, "funding-intent", "funding intent pack is outside the deployed product");

  const { snapshot } = await deploymentGate();
  const [salesPaused, offer, usdcBalance, allowance, ethBalance, requestCount] = await Promise.all([
    readBool(ADDR.gacha, "salesPaused()", [], [], snapshot.ref),
    readOffer(packIndex, snapshot),
    readUint(ADDR.usdc, SIG.balanceOf, ["address"], [wallet], snapshot.ref),
    readUint(ADDR.usdc, SIG.allowance, ["address", "address"], [wallet, ADDR.gacha], snapshot.ref),
    getBalance(wallet, snapshot.ref),
    readUint(ADDR.gacha, SIG.requestCountOf, ["address"], [wallet], snapshot.ref),
  ]);
  const intentResumePreflight = intent.stage === "remaining-open" ? intent.remainingPreflight : intent.preflight;
  const assessment = fundingResumeAssessment(intent, {
    wallet,
    packIndex,
    timestamp: snapshot.timestamp,
    salesPaused,
    packPriceUsdc: BigInt(offer.priceUsdc),
    offerHash: offer.offerHash,
    computedOfferHash: offer.computedOfferHash,
    ceilingBps: BigInt(offer.ceilingBps),
    entropyFeeWei: BigInt(offer.entropyFee),
    usdcBalance,
    ethBalance,
    walletRequestCount: requestCount,
  });
  if (!assessment.ok) {
    const reconfirmableCodes = new Set(["price-changed", "offer-changed", "ceiling-changed", "fee-cap-exceeded"]);
    const canPrepareRemainingOpen = assessment.issues.length > 0
      && assessment.issues.every((entry) => reconfirmableCodes.has(entry.code))
      && offer.offerHash.toLowerCase() === offer.computedOfferHash.toLowerCase()
      && usdcBalance >= BigInt(offer.priceUsdc)
      && ethBalance >= BigInt(offer.entropyFee) + BigInt(intentResumePreflight.nativeHeadroomWei)
      && requestCount === BigInt(intentResumePreflight.walletRequestCount);
    if (canPrepareRemainingOpen) {
      let remainingIntent;
      try {
        remainingIntent = rebaseFundingIntentForRemainingOpen(intent, {
          packPriceUsdc: BigInt(offer.priceUsdc),
          expectedOfferHash: offer.offerHash,
          acceptedCeilingBps: BigInt(offer.ceilingBps),
          entropyFeeWei: BigInt(offer.entropyFee),
          usdcBalance,
          ethBalance,
          allowance,
          requestCount,
          createdAt: snapshot.timestamp,
          expiresAt: snapshot.timestamp + DEFAULT_INTENT_TTL_SECONDS,
        });
      } catch (error) {
        throw new GateError("remaining-open-intent", error.message);
      }
      const remainingIntentHex = encodeFundingIntent(remainingIntent);
      const remainingIntentKey = fundingIntentKey(remainingIntent);
      const preparedX = xPreparedConfirmation(remainingIntent);
      const preparedXHex = `0x${Buffer.from(preparedX, "utf8").toString("hex")}`;
      await confirmSnapshot(snapshot);
      out({
        ok: true,
        command,
        phase: "remaining-open-reconfirmation",
        gate: "fresh-confirmation-required",
        wallet,
        invalidatedIntentKey: expectedIntentKey,
        changedTerms: assessment.issues,
        fresh: { snapshot: snapshotView(snapshot), offer, usdcBalance, allowance, ethBalance, requestCount, salesPaused },
        remainingIntent,
        remainingIntentHex,
        remainingIntentKey,
        report: `Funding is complete, but the confirmed pack economics changed. Confirm only the remaining conditional allowance reset, exact ${formatUnits(BigInt(offer.priceUsdc), 6)} USDC approval, and one pack ${packIndex} open using offer ${offer.offerHash}, ceiling ${offer.ceilingBps} bps, exact native fee ${formatUnits(BigInt(offer.entropyFee), 18)} ETH, and expiry ${remainingIntent.expiresAt}. No swap is authorized by this replacement intent.`,
        x: {
          preparedConfirmationTweet: preparedX,
          selfContainedFallbackCommand: xSelfContainedCommand(remainingIntent),
          bindAfterPosting: `node scripts/stonk-gacha.mjs bind-x-funding-intent --wallet ${wallet} --intent ${remainingIntentHex} --intent-key ${remainingIntentKey} --x-user-id NUMERIC_X_USER_ID --confirmation-tweet-id POSTED_TWEET_ID --confirmation-channel x --confirmation-message-hex ${preparedXHex}`,
        },
        resumeAfterFreshConfirmation: `node scripts/stonk-gacha.mjs resume-open-pack-funding --wallet ${wallet} --intent ${remainingIntentHex} --intent-key ${remainingIntentKey}`,
        authorizationPolicy: "This is a new one-time intent for approve+open only. The old consumed authorization cannot approve these changed terms, and no funding swap may be replayed.",
        txs: [],
      });
      return;
    }
    await confirmSnapshot(snapshot);
    out({
      ok: false,
      command,
      phase: assessment.reconfirmationRequired ? "needs-reconfirmation" : "funding-incomplete",
      gate: "funded-open-resume",
      wallet,
      intentKey: expectedIntentKey,
      assessment,
      fresh: { snapshot: snapshotView(snapshot), offer, usdcBalance, allowance, ethBalance, requestCount, salesPaused },
      instruction: assessment.reconfirmationRequired
        ? "Emit no transaction. The old combined confirmation cannot authorize changed economic terms. Prepare a new self-contained confirmation; never substitute the fresh offer hash, ceiling, price, fee cap, source bounds, or a lower pack silently."
        : "Emit no transaction. Reconcile each Bankr funding leg and current balances. Do not repeat a swap or raw submission from this output.",
      txs: [],
    }, 2);
    return;
  }

  const resume = `node scripts/stonk-gacha.mjs resume-open-pack-funding --wallet ${wallet} --intent ${intentHex} --intent-key ${expectedIntentKey}`;
  const priceUsdc = BigInt(offer.priceUsdc);
  const entropyFee = BigInt(offer.entropyFee);
  const ceilingBps = BigInt(offer.ceilingBps);
  const resumePreflight = intentResumePreflight;
  const terms = {
    packIndex,
    packPriceUsdc: priceUsdc,
    minCeilingBps: ceilingBps,
    nominalRtpBps: BigInt(offer.nominalRtpBps),
    expectedOfferHash: offer.offerHash,
    orderedEligible: offer.eligible.map(({ token, routeHash }) => ({ token, routeHash })),
    maxPayoutUsdc: BigInt(offer.maxPayoutUsdc),
    entropyFeeWei: entropyFee,
    entropyFeeCapWei: BigInt(intent.pack.entropyFeeCapWei),
    userRandomNumber: intent.pack.userRandomNumber,
    approval: { token: ADDR.usdc, spender: ADDR.gacha, exactAmount: priceUsdc },
    fundingIntentKey: expectedIntentKey,
    fundingIntentExpiresAt: BigInt(intent.expiresAt),
    fundingBaselineRequestCount: BigInt(resumePreflight.walletRequestCount),
    fundingNativeHeadroomWei: BigInt(resumePreflight.nativeHeadroomWei),
  };
  const authorization = {
    mode: intent.stage === "remaining-open" ? "remaining-open-intent" : "combined-funding-intent",
    intentKey: expectedIntentKey,
    additionalConfirmationRequired: false,
    runtimeGate: "Require the persisted unexpired authorization/execution journal for this exact intent. Its confirmation must already be atomically consumed once; only the next unreconciled step may run.",
  };
  const report = `Continue the already confirmed ${intent.stage === "remaining-open" ? "remaining approve+open" : "funded open"} for pack index ${packIndex}: canonical Base USDC now covers ${formatUnits(priceUsdc, 6)} USDC, offer ${offer.offerHash} and ceiling ${ceilingBps} bps are unchanged, and the exact current Pyth fee ${formatUnits(entropyFee, 18)} ETH remains within the confirmed ${formatUnits(BigInt(intent.pack.entropyFeeCapWei), 18)} ETH cap.`;
  const approval = exactApprovalTx(allowance, priceUsdc, `funded pack index ${packIndex}`);
  if (approval) {
    out(await approvalPlan({
      action: "open-pack",
      wallet,
      tx: approval,
      terms,
      report,
      reads: { usdcBalance, currentAllowance: allowance, ethBalance, requestCount, offer, fundingResume: assessment },
      warnings: ["This exact/reset approval is covered only by the recorded combined intent; no unrelated yes or conversation history may authorize it."],
      snapshot,
      resume,
      authorization,
    }));
    return;
  }
  const tx = unsignedTx(
    ADDR.gacha,
    encodeCall("openPack(uint256,uint256,bytes32,bytes32)", ["uint256", "uint256", "bytes32", "bytes32"], [BigInt(packIndex), ceilingBps, offer.offerHash, intent.pack.userRandomNumber]),
    `open funded Stonk Gacha pack index ${packIndex}`,
    { value: entropyFee },
  );
  out(await finalPlan({
    action: "open-pack",
    wallet,
    tx,
    terms,
    report,
    reads: { usdcBalance, exactAllowance: allowance, ethBalance, requestCount, offer, fundingResume: assessment },
    warnings: [
      "Mark the execution journal's open step consumed before submission. An unknown outcome permanently forbids replaying this userRandomNumber.",
      "PackOpened proves only Pending. Reconcile a missing /wallet/submit result from wallet request state and Bankr activity before considering any new attempt.",
    ],
    expectedEvents: ["PackOpened", "exact USDC Transfer wallet->StonkGacha"],
    postconditions: ["a new request owned by the active wallet is Pending", "request terms match the exact confirmed offer", "USDC charge equals the selected pack price"],
    snapshot,
    resume,
    authorization,
  }));
}

function bindXIntent() {
  const wallet = walletArg();
  const intentHex = need("intent");
  const expectedIntentKey = bytes32Arg("intent-key");
  let intent;
  try {
    intent = decodeFundingIntent(intentHex);
  } catch (error) {
    throw new GateError("funding-intent", error.message);
  }
  gate(intent.wallet === wallet && fundingIntentKey(intent) === expectedIntentKey, "funding-intent", "intent wallet or key mismatch");
  gate(normalizeAddress(intent.approvalPolicy.spender) === ADDR.gacha, "funding-intent", "intent spender is not the verified StonkGacha deployment");
  gate(intent.pack.packIndex >= 0 && intent.pack.packIndex < DEPLOYMENT.productTerms.packCount, "funding-intent", "intent pack is outside the deployed product");
  let pending;
  try {
    pending = bindXFundingIntent(intent, {
      confirmationTweetId: need("confirmation-tweet-id"),
      requesterXUserId: need("x-user-id"),
      confirmationChannel: need("confirmation-channel"),
      confirmationText: decodeUtf8HexArg("confirmation-message-hex"),
    });
  } catch (error) {
    throw new GateError("x-binding", error.message);
  }
  const pendingHex = encodeXPendingIntent(pending);
  const pendingKey = xPendingIntentKey(pending);
  out({
    ok: true,
    command,
    phase: "x-pending-bound",
    wallet,
    pendingIntent: pending,
    pendingIntentHex: pendingHex,
    pendingIntentKey: pendingKey,
    persistenceRule: "The confirmation tweet id, exact text, and channel must come from trusted X posting-result metadata, never user input. Persist this record in the Bankr runtime's durable, atomic store, never in the installed skill. Bare YES is valid only with trusted replied_to metadata from requesterXUserId while the same wallet remains linked, before expiry, and while consumed is false.",
    verifyReply: `node scripts/stonk-gacha.mjs verify-x-funding-approval --wallet ${wallet} --pending-intent ${pendingHex} --pending-intent-key ${pendingKey} --approval-mode reply --message YES --approval-tweet-id REPLY_TWEET_ID --parent-tweet-id ${pending.confirmationTweetId} --reference-type replied_to --x-user-id ${pending.requesterXUserId}`,
    selfContainedFallbackCommand: pending.selfContainedCommand,
  });
}

function verifyXApproval() {
  const wallet = walletArg();
  const pendingHex = need("pending-intent");
  const expectedPendingKey = bytes32Arg("pending-intent-key");
  let pending;
  try {
    pending = decodeXPendingIntent(pendingHex);
  } catch (error) {
    throw new GateError("x-binding", error.message);
  }
  gate(xPendingIntentKey(pending) === expectedPendingKey, "x-binding", "pending X intent key mismatch");
  gate(pending.wallet === wallet, "x-binding", "pending X intent wallet differs from the current Bankr-linked wallet");
  gate(normalizeAddress(pending.economicIntent.approvalPolicy.spender) === ADDR.gacha, "x-binding", "pending X intent spender is not the verified StonkGacha deployment");
  const mode = need("approval-mode");
  gate(mode === "reply" || mode === "self-contained", "args", "--approval-mode must be reply or self-contained");
  gate(!args.message || !args["message-hex"], "args", "provide only one of --message or --message-hex");
  const message = args["message-hex"] !== undefined ? decodeUtf8HexArg("message-hex") : need("message");
  let proof;
  try {
    proof = verifyXFundingApproval(pending, {
      mode,
      message,
      approvalTweetId: need("approval-tweet-id"),
      parentTweetId: args["parent-tweet-id"] === undefined ? null : need("parent-tweet-id"),
      referenceType: args["reference-type"] === undefined ? null : need("reference-type"),
      authorXUserId: need("x-user-id"),
      linkedWallet: wallet,
      now: BigInt(Math.floor(Date.now() / 1_000)),
    });
  } catch (error) {
    throw new GateError("x-approval", error.message);
  }
  out({
    ok: true,
    command,
    phase: "validated-awaiting-atomic-consume",
    wallet,
    proof,
    instruction: "The tweet id, exact replied_to reference type/parent id, and numeric author id must come from authenticated X event metadata, never parsed user text or conversation history. At consume time, re-resolve the linked wallet and current time, then atomically require the same wallet, an unexpired record, consumed:false, and create its execution journal while flipping consumed:true. If that boundary loses or any value changed, stop. Before every structured swap, recheck expiry, the current linked wallet, and the exact next journal body/idempotency key. This validation alone is not mutation authorization and must not be replayed.",
  });
}

async function planRevokeUsdc() {
  const wallet = walletArg();
  const { snapshot } = await deploymentGate();
  const allowance = await readUint(ADDR.usdc, SIG.allowance, ["address", "address"], [wallet, ADDR.gacha], snapshot.ref);
  if (allowance === 0n) {
    await confirmSnapshot(snapshot);
    out({ ok: true, command, phase: "nothing-to-do", wallet, allowance, message: "StonkGacha already has zero USDC allowance." });
    return;
  }
  const terms = { approval: { token: ADDR.usdc, spender: ADDR.gacha, currentAmount: allowance, nextAmount: 0n } };
  const tx = unsignedTx(ADDR.usdc, encodeCall(SIG.approve, ["address", "uint256"], [ADDR.gacha, 0n]), "revoke StonkGacha USDC allowance");
  out(await finalPlan({
    action: "revoke-usdc",
    wallet,
    tx,
    terms,
    report: `Revoke the current ${formatUnits(allowance, 6)} USDC StonkGacha allowance?`,
    reads: { currentAllowance: allowance },
    expectedEvents: ["Approval"],
    postconditions: ["USDC.allowance(wallet, StonkGacha) == 0"],
    snapshot,
  }));
}

async function planClaimPrize() {
  const wallet = walletArg();
  const requestId = requestIdArg();
  const recipient = recipientArg(wallet);
  const slippage = slippageBps();
  const { snapshot } = await deploymentGate();
  const request = await readRequest(requestId, snapshot);
  gate(request.buyer === wallet, "buyer", "only the request buyer may deliver this prize", { buyer: request.buyer, wallet });
  gate(request.status === "Ready", "request-status", `request is ${request.status}, not Ready`);
  gate(BigInt(request.stockOut) === 0n && BigInt(request.payoutUsdc) > 0n && request.routeHash, "request", "Ready request has invalid delivery terms");
  const quote = await quotePayout(request.routeHash, BigInt(request.payoutUsdc), snapshot, wallet);
  const minOut = amountFloor(quote, slippage);
  const deadline = snapshot.timestamp + 600n;
  const tokenDecimals = request.tokenMeta?.decimals;
  const quoted = tokenDecimals === null || tokenDecimals === undefined ? quote.toString() : formatUnits(quote, tokenDecimals);
  const minimum = tokenDecimals === null || tokenDecimals === undefined ? minOut.toString() : formatUnits(minOut, tokenDecimals);
  const terms = {
    requestId,
    buyer: wallet,
    recipient,
    token: request.token,
    payoutUsdc: BigInt(request.payoutUsdc),
    routeHash: request.routeHash,
    quoteStockOut: quote,
    minStockOut: minOut,
    slippageBps: slippage,
    deadline,
  };
  const signature = recipient === wallet ? "claimPrize(uint256,uint256,uint256)" : "claimPrizeTo(uint256,address,uint256,uint256)";
  const types = recipient === wallet ? ["uint256", "uint256", "uint256"] : ["uint256", "address", "uint256", "uint256"];
  const values = recipient === wallet ? [requestId, minOut, deadline] : [requestId, recipient, minOut, deadline];
  const tx = unsignedTx(ADDR.gacha, encodeCall(signature, types, values), `deliver Stonk Gacha request ${requestId} prize`);
  out(await finalPlan({
    action: "claim-prize",
    wallet,
    tx,
    terms,
    report: `Spend request ${requestId}'s immutable ${formatUnits(BigInt(request.payoutUsdc), 6)} USDC purchase budget through its pinned route to deliver ${request.tokenMeta?.symbol ?? request.token} to ${recipient}; current quote ${quoted}, minimum ${minimum} after ${slippage} bps slippage? This is stock delivery, not a USDC redemption or buyback.`,
    reads: { request, quoteBlock: snapshot.number, quoteStockOut: quote },
    warnings: ["The route commitment is immutable, but pool liquidity, router availability, and token transfer policy can still make this attempt fail. A failed atomic call leaves the request Ready."],
    expectedEvents: ["PayoutExecuted", "PrizeDelivered", "exact USDC Transfer StonkGacha->GachaTreasury"],
    postconditions: ["request.status == Delivered", "request.stockOut >= minStockOut", "Treasury and Gacha measured-delta events agree with recorded stockOut"],
    snapshot,
  }));
}

async function planExpireRequest() {
  const wallet = walletArg();
  const requestId = requestIdArg();
  const { snapshot } = await deploymentGate();
  const request = await readRequest(requestId, snapshot);
  gate(request.buyer === wallet, "buyer", "this planner only expires the active wallet's own request");
  gate(request.status === "Pending", "request-status", `request is ${request.status}, not Pending`);
  gate(snapshot.timestamp >= BigInt(request.refundableAt), "resolve-window", "request is still inside its Entropy resolution window", {
    currentTimestamp: snapshot.timestamp,
    refundableAt: request.refundableAt,
  });
  const terms = { requestId, buyer: wallet, refundCreditUsdc: BigInt(request.paidUsdc), refundableAt: BigInt(request.refundableAt) };
  const tx = unsignedTx(ADDR.gacha, encodeCall("expireRequest(uint256)", ["uint256"], [requestId]), `expire timed-out request ${requestId}`);
  out(await finalPlan({
    action: "expire-request",
    wallet,
    tx,
    terms,
    report: `Mark timed-out Pending request ${requestId} Expired and create exactly ${formatUnits(BigInt(request.paidUsdc), 6)} USDC of buyer-only refund credit? This does not transfer funds; claim-refund is a separate buyer action.`,
    reads: { request, currentTimestamp: snapshot.timestamp },
    expectedEvents: ["PackExpired"],
    postconditions: ["request.status == Expired", "refundClaimable == paidUsdc"],
    snapshot,
  }));
}

async function planClaimRefund() {
  const wallet = walletArg();
  const requestId = requestIdArg();
  const recipient = recipientArg(wallet);
  const { snapshot } = await deploymentGate();
  const request = await readRequest(requestId, snapshot);
  gate(request.buyer === wallet, "buyer", "only the request buyer may redirect or claim its refund");
  gate(request.status === "Expired", "request-status", `request is ${request.status}, not Expired`);
  const claimable = BigInt(request.refundClaimable);
  gate(claimable === BigInt(request.paidUsdc) && claimable > 0n, "refund", "request has no exact full pack refund available");
  const terms = { requestId, buyer: wallet, recipient, exactRefundUsdc: claimable };
  const signature = recipient === wallet ? "claimRefund(uint256)" : "claimRefundTo(uint256,address)";
  const types = recipient === wallet ? ["uint256"] : ["uint256", "address"];
  const values = recipient === wallet ? [requestId] : [requestId, recipient];
  const tx = unsignedTx(ADDR.gacha, encodeCall(signature, types, values), `claim request ${requestId} USDC refund`);
  out(await finalPlan({
    action: "claim-refund",
    wallet,
    tx,
    terms,
    report: `Claim the full ${formatUnits(claimable, 6)} USDC refund for expired request ${requestId} to ${recipient}? The native Entropy fee is not part of this USDC refund.`,
    reads: { request },
    expectedEvents: ["RefundClaimed", "exact USDC Transfer StonkGacha->recipient"],
    postconditions: ["request.status == Refunded", "refundClaimable == 0", "recipient USDC transfer equals exactRefundUsdc"],
    snapshot,
  }));
}

async function planFundReserve() {
  const wallet = walletArg();
  const amount = amountUsdcArg();
  const { snapshot } = await deploymentGate();
  const [balance, allowance] = await Promise.all([
    readUint(ADDR.usdc, SIG.balanceOf, ["address"], [wallet], snapshot.ref),
    readUint(ADDR.usdc, SIG.allowance, ["address", "address"], [wallet, ADDR.gacha], snapshot.ref),
  ]);
  const resume = `node scripts/stonk-gacha.mjs plan-fund-reserve --wallet ${wallet} --amount-usdc ${formatUnits(amount, 6)}`;
  if (balance < amount) {
    await confirmSnapshot(snapshot);
    return fundingRequired(wallet, balance, amount, resume, "irreversible reserve funding");
  }
  const terms = {
    amountUsdc: amount,
    funder: wallet,
    destination: ADDR.gacha,
    accounting: "reserve top-up only; does not create revenue, profit, ownership, claim, or guaranteed return",
    approval: { token: ADDR.usdc, spender: ADDR.gacha, exactAmount: amount },
  };
  const report = `Permanently contribute ${formatUnits(amount, 6)} USDC to Stonk Gacha's cash reserve? This is not a pack purchase, investment, loan, profit contribution, or claimable deposit and cannot be withdrawn by the funder.`;
  const approval = exactApprovalTx(allowance, amount, "reserve funding");
  if (approval) {
    out(await approvalPlan({
      action: "fund-reserve",
      wallet,
      tx: approval,
      terms,
      report,
      reads: { usdcBalance: balance, currentAllowance: allowance },
      warnings: ["Reserve funding is an irreversible contribution with no ownership or repayment right."],
      snapshot,
      resume,
    }));
    return;
  }
  const tx = unsignedTx(ADDR.gacha, encodeCall("fundReserve(uint256)", ["uint256"], [amount]), "fund Stonk Gacha reserve");
  out(await finalPlan({
    action: "fund-reserve",
    wallet,
    tx,
    terms,
    report,
    reads: { usdcBalance: balance, exactAllowance: allowance },
    warnings: ["Reserve funding does not enter the realized-profit ledger and grants no repayment or governance right."],
    expectedEvents: ["ReserveFunded", "exact USDC Transfer wallet->StonkGacha"],
    postconditions: ["ReserveFunded amount equals amountUsdc", "StonkGacha USDC balance rises by amountUsdc", "cumulativeFundedReserveUsdc rises by amountUsdc"],
    snapshot,
  }));
}

async function planDistributeProfit() {
  const wallet = walletArg();
  const slippage = slippageBps();
  const { snapshot } = await deploymentGate();
  const block = snapshot.ref;
  const [available, lastDistributeBlock] = await Promise.all([
    readUint(ADDR.gacha, "distributableProfitUsdc()", [], [], block),
    readUint(ADDR.treasury, "lastDistributeBlock()", [], [], block),
  ]);
  const minimum = BigInt(DEPLOYMENT.productTerms.minimumDistributeUsdcRaw);
  const maximum = BigInt(DEPLOYMENT.productTerms.maximumDistributeUsdcRaw);
  const amount = args["amount-usdc"] === undefined ? (available > maximum ? maximum : available) : amountUsdcArg();
  gate(amount >= minimum && amount <= maximum, "profit-amount", `profit chunk must be ${formatUnits(minimum, 6)}..${formatUnits(maximum, 6)} USDC`);
  gate(amount <= available, "profit-available", "requested chunk exceeds currently distributable realized profit", { amount, available });
  gate(lastDistributeBlock !== snapshot.number, "rate-limit", "a profit distribution already occurred in this block; wait for the next block");
  const [previewResult, quoteResult] = await Promise.all([
    call(ADDR.treasury, SIG.previewProfitSplit, ["uint256"], [amount], { block }),
    call(ADDR.treasury, SIG.quoteProfit, ["uint256"], [amount], { from: wallet, block }),
  ]);
  const [bountyUsdc, retainedUsdc, stakerUsdc] = decodeParameters(["uint256", "uint256", "uint256"], previewResult);
  gate(bountyUsdc + retainedUsdc + stakerUsdc === amount && bountyUsdc > 0n && stakerUsdc > 0n, "profit-split", "Treasury returned an invalid cumulative-target split");
  const quoteWeth = decodeUint(quoteResult);
  const minWethOut = amountFloor(quoteWeth, slippage);
  const deadline = snapshot.timestamp + 300n;
  const terms = { amountUsdc: amount, bountyUsdc, retainedUsdc, stakerUsdc, quoteWeth, minWethOut, slippageBps: slippage, deadline, worker: wallet };
  const tx = unsignedTx(
    ADDR.gacha,
    encodeCall("distributeProfit(uint256,uint256,uint256)", ["uint256", "uint256", "uint256"], [amount, minWethOut, deadline]),
    `permissionlessly distribute ${formatUnits(amount, 6)} USDC realized profit`,
  );
  out(await finalPlan({
    action: "distribute-profit",
    wallet,
    tx,
    terms,
    report: `Process ${formatUnits(amount, 6)} USDC of current realized net profit: ${formatUnits(bountyUsdc, 6)} USDC worker bounty to this wallet, ${formatUnits(retainedUsdc, 6)} USDC retained in Gacha, and ${formatUnits(stakerUsdc, 6)} USDC swapped toward at least ${formatUnits(minWethOut, 18)} WETH for StockLock after ${slippage} bps slippage?`,
    reads: { distributableProfitUsdc: available, lastDistributeBlock, quoteBlock: snapshot.number },
    warnings: ["This permissionless call processes only contract-accounted realized profit. Reserve donations and buyer liabilities are excluded by the deployed accounting."],
    expectedEvents: ["TreasuryProfitDistributed", "GachaProfitDistributed", "exact USDC Treasury pull and worker bounty Transfers", "exact WETH GachaTreasury->StockLock Transfer"],
    postconditions: ["both contracts advance identical cumulative split totals", "worker receives exact bountyUsdc", "StockLock receives measured WETH", "whole call is atomic"],
    snapshot,
  }));
}

function assertContextString(actual, expected, label) {
  gate(String(actual).toLowerCase() === String(expected).toLowerCase(), "inspection-context", `${label} does not match the signed calldata or fresh chain state`, { actual, expected });
}

function canonicalTxArg() {
  const chain = integerArg("chain-id", { min: 1n, max: BigInt(Number.MAX_SAFE_INTEGER) });
  gate(chain === 8453n, "chain", "transaction must stay on Base chainId 8453");
  const to = normalizeAddress(need("to"));
  const rawData = need("data");
  gate(/^0x[0-9a-fA-F]{8,}$/.test(rawData) && rawData.length % 2 === 0, "args", "--data must be even-length hex with a selector");
  let attributed;
  try { attributed = stripErc8021Suffix(rawData); }
  catch (error) { throw new GateError("attribution", error.message); }
  const data = attributed.calldata;
  gate(/^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{64})*$/.test(data), "args", "logical calldata must be selector plus whole ABI words");
  const value = integerArg("value");
  return {
    tx: { chainId: Number(chain), to, data: data.toLowerCase(), value: value.toString() },
    attribution: attributed.attribution,
    submittedData: rawData.toLowerCase(),
  };
}

async function inspectLogicalCall({ wallet, tx, contextHex, expectedInspectionKey, verifyFreshState = true }) {
  const decodedContext = decodeInspectionContext(contextHex);
  const computedKey = inspectionKey(wallet, tx, decodedContext.hex);
  gate(computedKey === expectedInspectionKey.toLowerCase(), "inspection-key", "inspection key does not bind this exact wallet, target, calldata, value, chain, and context", { computedKey });
  const action = knownActionBySelector(tx.to, txSelector(tx.data));
  gate(action, "allowlist", "logical target and selector are not in the default-deny signing allowlist");
  const contextAction = decodedContext.context.action;
  gate(action.contextActions.includes(contextAction), "allowlist", "selector is not allowed for the bound action context");
  const values = decodeCallArguments(action.inputTypes, tx.data);
  const snapshot = verifyFreshState ? await beginSnapshot() : null;
  const block = snapshot?.ref ?? null;
  const terms = decodedContext.context.terms;
  const value = BigInt(tx.value);
  if (action.valueRule === "zero") gate(value === 0n, "value", "this logical call must carry zero native value");

  const fundedOpen = contextAction === "open-pack" && terms.fundingIntentKey !== undefined;
  if (fundedOpen) {
    gate(/^0x[0-9a-f]{64}$/.test(String(terms.fundingIntentKey)), "inspection-context", "funding intent key is malformed");
    const intentExpiry = BigInt(terms.fundingIntentExpiresAt);
    const baselineRequestCount = BigInt(terms.fundingBaselineRequestCount);
    const nativeHeadroom = BigInt(terms.fundingNativeHeadroomWei);
    gate(intentExpiry > 0n && baselineRequestCount >= 0n && nativeHeadroom >= MIN_NATIVE_HEADROOM_WEI, "inspection-context", "funded-open expiry, request baseline, or native headroom is malformed");
    if (verifyFreshState) {
      gate(snapshot.timestamp < intentExpiry, "funding-intent", "combined funding authorization expired before signing");
      const packIndex = Number(BigInt(terms.packIndex));
      const [requestCount, freshOffer, freshNativeBalance] = await Promise.all([
        readUint(ADDR.gacha, SIG.requestCountOf, ["address"], [wallet], block),
        readOffer(packIndex, snapshot),
        getBalance(wallet, block),
      ]);
      assertContextString(requestCount, baselineRequestCount, "funded-open wallet request count");
      assertContextString(freshOffer.priceUsdc, terms.packPriceUsdc, "funded-open fresh pack price");
      assertContextString(freshOffer.offerHash, terms.expectedOfferHash, "funded-open fresh offer hash");
      assertContextString(freshOffer.ceilingBps, terms.minCeilingBps, "funded-open fresh ceiling");
      gate(BigInt(freshOffer.entropyFee) <= BigInt(terms.entropyFeeCapWei), "funding-intent", "fresh Entropy fee exceeds the combined funding authorization cap");
      gate(freshNativeBalance >= BigInt(freshOffer.entropyFee) + nativeHeadroom, "funding-intent", "fresh native ETH does not preserve exact msg.value plus confirmed headroom");
    }
  }

  if (action.name === "approve") {
    const [spender, amount] = values;
    gate(spender === ADDR.gacha, "approval", "USDC spender must be the pinned StonkGacha contract");
    if (contextAction === "revoke-usdc") {
      gate(amount === 0n, "approval", "revoke-usdc must approve exactly zero");
      assertContextString(amount, terms.approval?.nextAmount, "revocation amount");
      gate(BigInt(terms.approval?.currentAmount) > 0n, "inspection-context", "bound revocation allowance must be positive");
    } else {
      gate(terms.approval?.token === ADDR.usdc && terms.approval?.spender === ADDR.gacha, "inspection-context", "bound approval token or spender is not the pinned USDC/Gacha pair");
      const exact = BigInt(terms.approval?.exactAmount);
      if (contextAction === "open-pack") {
        assertContextString(exact, terms.packPriceUsdc, "approval versus pack price");
        const packIndex = Number(BigInt(terms.packIndex));
        gate(Number.isSafeInteger(packIndex) && packIndex >= 0 && packIndex < DEPLOYMENT.productTerms.packCount, "inspection-context", "bound pack index is invalid");
        assertContextString(exact, DEPLOYMENT.productTerms.packPricesUsdcRaw[packIndex], "approval versus deployed pack price");
      } else if (contextAction === "fund-reserve") {
        assertContextString(exact, terms.amountUsdc, "approval versus reserve amount");
      }
      gate(amount === 0n || amount === exact, "approval", "approval must be a zero reset or the exact bound action amount");
    }
    if (verifyFreshState) {
      const current = await readUint(ADDR.usdc, SIG.allowance, ["address", "address"], [wallet, ADDR.gacha], block);
      if (amount === 0n && contextAction === "revoke-usdc") {
        assertContextString(current, terms.approval.currentAmount, "fresh revocation allowance");
      } else if (amount === 0n) {
        gate(
          requiresAllowanceReset(current, terms.approval.exactAmount),
          "approval",
          "zero reset requires a positive mismatched allowance; the current allowance is zero or already equals the exact bound action amount",
        );
      } else {
        gate(current === 0n, "approval", "nonzero exact approval requires a zero current allowance");
        const balance = await readUint(ADDR.usdc, SIG.balanceOf, ["address"], [wallet], block);
        gate(balance >= amount, "balance", "wallet no longer holds the exact approved USDC amount");
      }
    }
  } else if (action.name === "open-pack") {
    const [packIndex, minCeiling, offerHash, userRandom] = values;
    gate(!/^0x0{64}$/.test(userRandom), "randomness", "user randomness cannot be zero");
    assertContextString(packIndex, terms.packIndex, "pack index");
    assertContextString(minCeiling, terms.minCeilingBps, "minimum ceiling");
    assertContextString(offerHash, terms.expectedOfferHash, "offer hash");
    assertContextString(userRandom, terms.userRandomNumber, "buyer randomness");
    assertContextString(value, terms.entropyFeeWei, "bound Entropy fee");
    if (fundedOpen) {
      gate(BigInt(terms.entropyFeeCapWei) >= value, "inspection-context", "exact Entropy fee exceeds the combined funding authorization cap");
    }
    assertContextString(terms.packPriceUsdc, DEPLOYMENT.productTerms.packPricesUsdcRaw[Number(packIndex)], "deployed pack price");
    const expectedMaxPayout = BigInt(terms.packPriceUsdc) * minCeiling / BPS;
    assertContextString(terms.maxPayoutUsdc, expectedMaxPayout, "maximum cash-backed payout");
    gate(terms.approval?.token === ADDR.usdc && terms.approval?.spender === ADDR.gacha, "inspection-context", "open approval token or spender is not pinned");
    assertContextString(terms.approval?.exactAmount, terms.packPriceUsdc, "open approval amount");
    const boundEligible = terms.orderedEligible;
    gate(Array.isArray(boundEligible) && boundEligible.length >= 1, "inspection-context", "bound ordered offer is missing");
    const boundHash = localOfferHash(
      Number(packIndex),
      minCeiling,
      boundEligible.map((entry) => entry.token),
      boundEligible.map((entry) => entry.routeHash),
    );
    assertContextString(boundHash, offerHash, "bound ordered offer commitment");
    if (verifyFreshState) {
      const salesPaused = await readBool(ADDR.gacha, "salesPaused()", [], [], block);
      gate(!salesPaused, "sales", "new pack sales are paused");
      const offer = await readOffer(Number(packIndex), snapshot);
      assertContextString(offer.offerHash, offerHash, "fresh offer hash");
      assertContextString(offer.ceilingBps, minCeiling, "fresh cash-backed ceiling");
      assertContextString(offer.entropyFee, value, "exact live Entropy fee");
      assertContextString(offer.priceUsdc, terms.packPriceUsdc, "fresh pack price");
      assertContextString(offer.maxPayoutUsdc, terms.maxPayoutUsdc, "fresh maximum payout");
      assertContextString(offer.nominalRtpBps, terms.nominalRtpBps, "fresh nominal RTP");
      gate(offer.eligible.length === boundEligible.length && offer.eligible.every((entry, index) => (
        entry.token === normalizeAddress(boundEligible[index].token)
        && entry.routeHash.toLowerCase() === String(boundEligible[index].routeHash).toLowerCase()
      )), "inspection-context", "fresh ordered token/route offer differs from the bound report");
      const allowance = await readUint(ADDR.usdc, SIG.allowance, ["address", "address"], [wallet, ADDR.gacha], block);
      gate(allowance === BigInt(offer.priceUsdc), "approval", "USDC allowance is no longer exactly the current pack price");
    }
  } else if (action.name === "claim-prize" || action.name === "claim-prize-to") {
    const [requestId, recipient, minOut, deadline] = action.name === "claim-prize"
      ? [values[0], wallet, values[1], values[2]]
      : values;
    gate(recipient !== ZERO_ADDRESS && recipient !== ADDR.gacha && recipient !== ADDR.treasury, "recipient", "invalid prize recipient");
    assertContextString(requestId, terms.requestId, "request id");
    assertContextString(wallet, terms.buyer, "buyer");
    assertContextString(recipient, terms.recipient, "recipient");
    assertContextString(minOut, terms.minStockOut, "minimum stock output");
    assertContextString(deadline, terms.deadline, "deadline");
    gate(minOut > 0n, "quote", "minimum stock output cannot be zero");
    const slippage = BigInt(terms.slippageBps);
    gate(slippage >= 1n && slippage <= 1_000n, "inspection-context", "bound delivery slippage is outside the planner range");
    assertContextString(minOut, BigInt(terms.quoteStockOut) * (BPS - slippage) / BPS, "quote-derived stock floor");
    if (verifyFreshState) {
      const request = await readRequest(requestId, snapshot);
      gate(request.buyer === wallet && request.status === "Ready", "request", "request is not a Ready prize owned by the active wallet");
      assertContextString(request.token, terms.token, "won token");
      assertContextString(request.routeHash, terms.routeHash, "pinned payout route");
      assertContextString(request.payoutUsdc, terms.payoutUsdc, "payout purchase budget");
      const quote = await quotePayout(request.routeHash, BigInt(request.payoutUsdc), snapshot, wallet);
      assertContextString(quote, terms.quoteStockOut, "fresh stock quote");
      gate(minOut <= quote, "quote", "minimum stock output exceeds the fresh pinned-route quote");
      gate(deadline > snapshot.timestamp && deadline <= snapshot.timestamp + 600n, "deadline", "delivery deadline expired or exceeds the planner's ten-minute window");
    }
  } else if (action.name === "expire-request") {
    const [requestId] = values;
    assertContextString(requestId, terms.requestId, "request id");
    assertContextString(wallet, terms.buyer, "buyer");
    gate(BigInt(terms.refundCreditUsdc) > 0n, "inspection-context", "bound refund credit must be positive");
    if (verifyFreshState) {
      const request = await readRequest(requestId, snapshot);
      gate(request.buyer === wallet && request.status === "Pending", "request", "request is not the active wallet's Pending request");
      assertContextString(request.paidUsdc, terms.refundCreditUsdc, "full pack refund credit");
      assertContextString(request.refundableAt, terms.refundableAt, "refund availability time");
      gate(snapshot.timestamp >= BigInt(request.refundableAt), "resolve-window", "request is still inside its resolve window");
    }
  } else if (action.name === "claim-refund" || action.name === "claim-refund-to") {
    const [requestId, recipient] = action.name === "claim-refund" ? [values[0], wallet] : values;
    assertContextString(requestId, terms.requestId, "request id");
    assertContextString(wallet, terms.buyer, "buyer");
    assertContextString(recipient, terms.recipient, "recipient");
    gate(BigInt(terms.exactRefundUsdc) > 0n, "inspection-context", "bound refund amount must be positive");
    if (verifyFreshState) {
      const request = await readRequest(requestId, snapshot);
      gate(request.buyer === wallet && request.status === "Expired", "request", "request is not an Expired refund owned by the active wallet");
      gate(BigInt(request.refundClaimable) === BigInt(request.paidUsdc) && BigInt(request.refundClaimable) > 0n, "refund", "full pack refund is no longer claimable");
      assertContextString(request.refundClaimable, terms.exactRefundUsdc, "exact full refund");
    }
  } else if (action.name === "fund-reserve") {
    const [amount] = values;
    gate(amount > 0n, "amount", "reserve contribution must be positive");
    assertContextString(amount, terms.amountUsdc, "reserve amount");
    assertContextString(wallet, terms.funder, "reserve funder");
    assertContextString(ADDR.gacha, terms.destination, "reserve destination");
    gate(terms.accounting === "reserve top-up only; does not create revenue, profit, ownership, claim, or guaranteed return", "inspection-context", "reserve accounting disclosure was altered");
    gate(terms.approval?.token === ADDR.usdc && terms.approval?.spender === ADDR.gacha, "inspection-context", "reserve approval token or spender is not pinned");
    assertContextString(terms.approval?.exactAmount, amount, "reserve approval amount");
    if (verifyFreshState) {
      const [balance, allowance] = await Promise.all([
        readUint(ADDR.usdc, SIG.balanceOf, ["address"], [wallet], block),
        readUint(ADDR.usdc, SIG.allowance, ["address", "address"], [wallet, ADDR.gacha], block),
      ]);
      gate(balance >= amount && allowance === amount, "funding", "wallet balance or exact USDC allowance no longer covers the contribution");
    }
  } else if (action.name === "distribute-profit") {
    const [amount, minWethOut, deadline] = values;
    const minimum = BigInt(DEPLOYMENT.productTerms.minimumDistributeUsdcRaw);
    const maximum = BigInt(DEPLOYMENT.productTerms.maximumDistributeUsdcRaw);
    gate(amount >= minimum && amount <= maximum && minWethOut > 0n, "profit", "profit amount or WETH floor is outside fixed bounds");
    assertContextString(amount, terms.amountUsdc, "profit amount");
    assertContextString(minWethOut, terms.minWethOut, "minimum WETH output");
    assertContextString(deadline, terms.deadline, "deadline");
    assertContextString(wallet, terms.worker, "profit worker");
    const slippage = BigInt(terms.slippageBps);
    gate(slippage >= 1n && slippage <= 1_000n, "inspection-context", "bound profit slippage is outside the planner range");
    assertContextString(minWethOut, BigInt(terms.quoteWeth) * (BPS - slippage) / BPS, "quote-derived WETH floor");
    gate(BigInt(terms.bountyUsdc) + BigInt(terms.retainedUsdc) + BigInt(terms.stakerUsdc) === amount, "inspection-context", "bound profit split does not sum to the processed amount");
    if (verifyFreshState) {
      const available = await readUint(ADDR.gacha, "distributableProfitUsdc()", [], [], block);
      gate(amount <= available, "profit", "profit amount is no longer within the available bounded tranche");
      const preview = decodeParameters(
        ["uint256", "uint256", "uint256"],
        await call(ADDR.treasury, SIG.previewProfitSplit, ["uint256"], [amount], { block }),
      );
      assertContextString(preview[0], terms.bountyUsdc, "fresh worker bounty");
      assertContextString(preview[1], terms.retainedUsdc, "fresh retained profit");
      assertContextString(preview[2], terms.stakerUsdc, "fresh staker profit");
      const quote = decodeUint(await call(ADDR.treasury, SIG.quoteProfit, ["uint256"], [amount], { from: wallet, block }));
      assertContextString(quote, terms.quoteWeth, "fresh WETH quote");
      gate(minWethOut <= quote && deadline > snapshot.timestamp && deadline <= snapshot.timestamp + 300n, "quote", "profit floor is above the fresh quote or deadline is outside the planner window");
    }
  } else {
    throw new GateError("allowlist", `inspection is not implemented for ${action.name}`);
  }
  if (verifyFreshState) {
    await simulation(tx, wallet, block);
    await confirmSnapshot(snapshot);
  }
  return {
    action,
    values,
    context: decodedContext.context,
    inspectionKey: computedKey,
    snapshot: snapshot ? snapshotView(snapshot) : null,
    freshStateVerified: verifyFreshState,
  };
}

async function commandInspectCalldata() {
  const wallet = walletArg();
  const { tx, attribution, submittedData } = canonicalTxArg();
  const contextHex = need("context");
  const expectedInspectionKey = bytes32Arg("plan-key");
  const result = await inspectLogicalCall({ wallet, tx, contextHex, expectedInspectionKey });
  out({ ok: true, command, wallet, tx, submittedData, attribution, ...result, verdict: "allowlisted logical calldata, recognized attribution if present, bound context, fresh state, and simulation all passed" });
}

function topicAddress(topic) {
  gate(/^0x0{24}[0-9a-fA-F]{40}$/.test(topic ?? ""), "receipt", "indexed address topic is non-canonical");
  return normalizeAddress(`0x${topic.slice(-40)}`);
}

function topicUint(topic) {
  gate(/^0x[0-9a-fA-F]{64}$/.test(topic ?? ""), "receipt", "indexed uint topic is non-canonical");
  return BigInt(topic);
}

function actionLogs(logs) {
  return logs.map((log, index) => {
    let emitter;
    try { emitter = normalizeAddress(log.address); } catch { return null; }
    const topic0 = log.topics?.[0]?.toLowerCase();
    const known = EVENT_BY_EMITTER_TOPIC.get(`${emitter}:${topic0}`);
    return known ? { index, emitter, topic0, name: known.name, log } : null;
  }).filter(Boolean);
}

function findOneEvent(events, name) {
  const matches = events.filter((entry) => entry.name === name);
  gate(matches.length === 1, "receipt-events", `receipt must contain exactly one ${name} event in the logical call scope`, { count: matches.length });
  return matches[0].log;
}

function proveExactErc20Transfer(logs, token, from, to, amount, label) {
  let outgoing;
  let incoming;
  try {
    outgoing = sumCanonicalErc20Transfers(logs, token, "from", from, to);
    incoming = sumCanonicalErc20Transfers(logs, token, "to", to, from);
  } catch (error) {
    throw new GateError("receipt-events", `${label} ERC-20 Transfer log is malformed: ${error.message}`);
  }
  gate(
    outgoing === amount && incoming === amount,
    "receipt-events",
    `${label} requires one exact canonical pinned-token transfer delta`,
    { token, from, to, expected: amount, outgoing, incoming },
  );
  return { token, from, to, amount };
}

async function proveBankrExecutionReceipt(envelope, transaction, receipt) {
  gate(receipt.blockNumber && receipt.blockHash, "receipt", "receipt has no mined block identity");
  gate(transaction.hash?.toLowerCase() === receipt.transactionHash?.toLowerCase(), "receipt", "transaction and receipt hashes do not match");
  const receiptBlock = await getBlockByHash(receipt.blockHash, true);
  gate(receiptBlock?.hash?.toLowerCase() === receipt.blockHash.toLowerCase(), "receipt", "receipt block could not be pinned by hash");
  const blockNumber = BigInt(receipt.blockNumber);
  gate(BigInt(receiptBlock.number) === blockNumber && blockNumber > 0n, "receipt", "receipt block number mismatch or missing parent");
  gate(transaction.blockHash?.toLowerCase() === receiptBlock.hash.toLowerCase(), "receipt", "transaction is not in the pinned receipt block");
  const transactionIndex = Number(BigInt(transaction.transactionIndex));
  gate(receiptBlock.transactions?.[transactionIndex]?.hash?.toLowerCase() === transaction.hash.toLowerCase(), "receipt", "transaction index is not a member of the pinned block");
  const receiptBlockIdentity = {
    hash: receiptBlock.hash.toLowerCase(),
    parentHash: receiptBlock.parentHash.toLowerCase(),
    number: BigInt(receiptBlock.number),
    timestamp: BigInt(receiptBlock.timestamp),
  };
  if (envelope.mode === "direct-wallet-transaction") {
    return {
      accountKind: envelope.accountKind,
      transactionProof: { hash: transaction.hash, blockHash: receiptBlock.hash, blockNumber, transactionIndex },
      userOperationEvent: null,
      receiptBlockIdentity,
    };
  }
  const blockRef = { blockHash: receiptBlock.hash, requireCanonical: true };
  const parentRef = { blockHash: receiptBlock.parentHash, requireCanonical: true };
  let entryPointCodeHash;
  let expectedUserOpHash;
  let parentWalletCode;
  let parentWalletNonce;
  let walletCode;
  let implementationCodeHash;
  let endRootValidatorResult;
  try {
    [entryPointCodeHash, expectedUserOpHash, parentWalletCode, parentWalletNonce, walletCode, implementationCodeHash, endRootValidatorResult] = await Promise.all([
      getCodeHash(envelope.entryPoint, blockRef),
      ethCall(envelope.entryPoint, userOperationHashCall(envelope), { block: blockRef }).then(decodeBytes32),
      getCode(envelope.logicalSender, parentRef),
      getTransactionCount(envelope.logicalSender, parentRef),
      getCode(envelope.logicalSender, blockRef),
      getCodeHash(KERNEL_IMPLEMENTATION, blockRef),
      ethCall(envelope.logicalSender, ROOT_VALIDATOR_SELECTOR, { block: blockRef }),
    ]);
  } catch (error) {
    throw new GateError("receipt", `could not pin sponsored execution state: ${error.message}`);
  }
  gate(entryPointCodeHash === ENTRY_POINT_V07_CODE_HASH, "receipt", "supported EntryPoint runtime identity changed");
  let userOperationEvent;
  try { userOperationEvent = verifyBankrExecutionReceipt(envelope, receipt, expectedUserOpHash); }
  catch (error) { throw new GateError("receipt", error.message); }
  let parentRootValidator = ZERO_ROOT_VALIDATOR_RESULT;
  if (parentWalletCode === "0x") {
    const storage = await getStorageAt(envelope.logicalSender, KERNEL_VALIDATION_STORAGE_SLOT, parentRef);
    gate(/^0x0{64}$/.test(storage), "receipt", "first-use wallet retained prior Kernel validation state");
  } else {
    parentRootValidator = await ethCall(envelope.logicalSender, ROOT_VALIDATOR_SELECTOR, { block: parentRef });
  }
  let delegationProof;
  try {
    delegationProof = await proveKernelDelegationAtTransaction({
      wallet: envelope.logicalSender,
      transaction,
      block: receiptBlock,
      parentWalletCode,
      parentWalletNonce,
      parentRootValidator,
      recoverAuthority: async (authorization) => decodeAuthorizationAuthority(await ethCall(
        ECRECOVER_PRECOMPILE,
        authorization.callData,
        { block: parentRef },
      )),
    });
  } catch (error) {
    throw new GateError("receipt", `could not prove transaction-time Bankr delegation: ${error.message}`);
  }
  gate(walletCode.toLowerCase() === KERNEL_DELEGATION_DESIGNATOR, "receipt", "wallet was not delegated to the reviewed Kernel at receipt-block end");
  gate(implementationCodeHash === KERNEL_IMPLEMENTATION_CODE_HASH, "receipt", "reviewed Kernel runtime identity changed");
  const endRootValidator = decodeRootValidator(endRootValidatorResult);
  gate(endRootValidator === `0x${"0".repeat(42)}`, "receipt", "Bankr wallet rootValidator is nonzero at receipt-block end");
  return {
    entryPoint: envelope.entryPoint,
    entryPointCodeHash,
    accountKind: envelope.accountKind,
    implementation: KERNEL_IMPLEMENTATION,
    implementationCodeHash,
    endRootValidator,
    delegationProof,
    userOperationEvent,
    receiptBlockIdentity,
  };
}

function proveActionEvents(actionName, events, scopedLogs, wallet, values, context) {
  const terms = context.terms;
  if (actionName === "approve") {
    const event = events.filter(({ log }) => normalizeAddress(log.address) === ADDR.usdc && log.topics?.[0]?.toLowerCase() === APPROVAL_TOPIC);
    gate(event.length === 1, "receipt-events", "approval receipt must contain exactly one canonical USDC Approval");
    const log = event[0].log;
    gate(topicAddress(log.topics[1]) === wallet && topicAddress(log.topics[2]) === ADDR.gacha, "receipt-events", "Approval owner or spender mismatch");
    gate(decodeUint(log.data) === values[1], "receipt-events", "Approval amount mismatch");
    return { Approval: { owner: wallet, spender: ADDR.gacha, amount: values[1] } };
  }
  if (actionName === "open-pack") {
    const log = findOneEvent(events, "PackOpened");
    const requestId = topicUint(log.topics[1]);
    gate(topicAddress(log.topics[2]) === wallet && topicUint(log.topics[3]) === values[0], "receipt-events", "PackOpened buyer or pack mismatch");
    const [paidUsdc, ceilingBps, maxPayoutUsdc, eligible, routeHashes] = decodeParameters(["uint256", "uint256", "uint256", "address[]", "bytes32[]"], log.data);
    gate(paidUsdc === BigInt(terms.packPriceUsdc) && ceilingBps === values[1] && maxPayoutUsdc === BigInt(terms.maxPayoutUsdc), "receipt-events", "PackOpened economic terms mismatch");
    gate(localOfferHash(Number(values[0]), ceilingBps, eligible, routeHashes) === String(terms.expectedOfferHash).toLowerCase(), "receipt-events", "PackOpened ordered offer commitment mismatch");
    const usdcTransfer = proveExactErc20Transfer(scopedLogs, ADDR.usdc, wallet, ADDR.gacha, paidUsdc, "pack charge");
    return { PackOpened: { requestId, buyer: wallet, packIndex: values[0], paidUsdc, ceilingBps, maxPayoutUsdc, eligible, routeHashes }, USDCTransfer: usdcTransfer };
  }
  if (actionName === "claim-prize" || actionName === "claim-prize-to") {
    const delivered = findOneEvent(events, "PrizeDelivered");
    const payout = findOneEvent(events, "PayoutExecuted");
    const requestId = values[0];
    const recipient = actionName === "claim-prize" ? wallet : values[1];
    gate(topicUint(delivered.topics[1]) === requestId && topicAddress(delivered.topics[2]) === wallet && topicAddress(delivered.topics[3]) === recipient, "receipt-events", "PrizeDelivered indexed terms mismatch");
    const [token, payoutUsdc, stockOut] = decodeParameters(["address", "uint256", "uint256"], delivered.data);
    assertContextString(token, terms.token, "delivered token");
    assertContextString(payoutUsdc, terms.payoutUsdc, "delivered USDC purchase budget");
    gate(topicAddress(payout.topics[2]) === token && topicAddress(payout.topics[3]) === recipient, "receipt-events", "PayoutExecuted token or recipient mismatch");
    const [payoutIn, payoutOut] = decodeParameters(["uint256", "uint256"], payout.data);
    gate(payout.topics[1].toLowerCase() === String(terms.routeHash).toLowerCase() && payoutIn === payoutUsdc && payoutOut === stockOut && stockOut >= BigInt(terms.minStockOut), "receipt-events", "prize execution amounts or route mismatch");
    const usdcTransfer = proveExactErc20Transfer(scopedLogs, ADDR.usdc, ADDR.gacha, ADDR.treasury, payoutUsdc, "prize purchase budget");
    return { PrizeDelivered: { requestId, buyer: wallet, recipient, token, payoutUsdc, stockOut }, PayoutExecuted: { routeHash: payout.topics[1].toLowerCase(), token, recipient, payoutIn, payoutOut }, USDCTransfer: usdcTransfer };
  }
  if (actionName === "expire-request") {
    const log = findOneEvent(events, "PackExpired");
    gate(topicUint(log.topics[1]) === values[0] && topicAddress(log.topics[2]) === wallet, "receipt-events", "PackExpired request or buyer mismatch");
    const refundCreditUsdc = decodeUint(log.data);
    gate(refundCreditUsdc === BigInt(terms.refundCreditUsdc), "receipt-events", "PackExpired refund credit mismatch");
    return { PackExpired: { requestId: values[0], buyer: wallet, refundCreditUsdc } };
  }
  if (actionName === "claim-refund" || actionName === "claim-refund-to") {
    const log = findOneEvent(events, "RefundClaimed");
    const requestId = values[0];
    const recipient = actionName === "claim-refund" ? wallet : values[1];
    gate(topicUint(log.topics[1]) === requestId && topicAddress(log.topics[2]) === wallet && topicAddress(log.topics[3]) === recipient, "receipt-events", "RefundClaimed indexed terms mismatch");
    const amount = decodeUint(log.data);
    gate(amount === BigInt(terms.exactRefundUsdc), "receipt-events", "refund amount mismatch");
    const usdcTransfer = proveExactErc20Transfer(scopedLogs, ADDR.usdc, ADDR.gacha, recipient, amount, "refund");
    return { RefundClaimed: { requestId, buyer: wallet, recipient, amount }, USDCTransfer: usdcTransfer };
  }
  if (actionName === "fund-reserve") {
    const log = findOneEvent(events, "ReserveFunded");
    gate(topicAddress(log.topics[1]) === wallet && decodeUint(log.data) === values[0], "receipt-events", "ReserveFunded terms mismatch");
    const usdcTransfer = proveExactErc20Transfer(scopedLogs, ADDR.usdc, wallet, ADDR.gacha, values[0], "reserve funding");
    return { ReserveFunded: { funder: wallet, amount: values[0] }, USDCTransfer: usdcTransfer };
  }
  if (actionName === "distribute-profit") {
    const gachaLog = findOneEvent(events, "GachaProfitDistributed");
    const treasuryLog = findOneEvent(events, "TreasuryProfitDistributed");
    gate(topicAddress(gachaLog.topics[1]) === wallet && topicAddress(treasuryLog.topics[1]) === wallet, "receipt-events", "profit worker mismatch");
    const gachaValues = decodeParameters(["uint256", "uint256", "uint256", "uint256", "uint256"], gachaLog.data);
    const treasuryValues = decodeParameters(["uint256", "uint256", "uint256", "uint256", "uint256"], treasuryLog.data);
    gate(gachaValues.every((entry, index) => entry === treasuryValues[index]), "receipt-events", "Gacha and Treasury profit events disagree");
    gate(
      gachaValues[0] === values[0]
      && gachaValues[1] === BigInt(terms.bountyUsdc)
      && gachaValues[2] === BigInt(terms.retainedUsdc)
      && gachaValues[3] === BigInt(terms.stakerUsdc)
      && gachaValues[4] >= BigInt(terms.minWethOut),
      "receipt-events",
      "profit event split or WETH floor mismatch",
    );
    const amountToTreasury = gachaValues[1] + gachaValues[3];
    const treasuryPull = proveExactErc20Transfer(scopedLogs, ADDR.usdc, ADDR.gacha, ADDR.treasury, amountToTreasury, "profit Treasury pull");
    const workerBounty = proveExactErc20Transfer(scopedLogs, ADDR.usdc, ADDR.treasury, wallet, gachaValues[1], "profit worker bounty");
    const stakerWeth = proveExactErc20Transfer(scopedLogs, ADDR.weth, ADDR.treasury, ADDR.stockLock, gachaValues[4], "profit staker funding");
    return {
      ProfitDistributed: { worker: wallet, processedProfitUsdc: gachaValues[0], bountyUsdc: gachaValues[1], retainedUsdc: gachaValues[2], stakerUsdc: gachaValues[3], wethToStakers: gachaValues[4] },
      TokenTransfers: { treasuryPull, workerBounty, stakerWeth },
    };
  }
  throw new GateError("receipt-events", `receipt proof is not implemented for ${actionName}`);
}

async function postActionState(actionName, eventProof, context) {
  if (actionName === "open-pack") {
    const opened = eventProof.PackOpened;
    const request = await readRequest(opened.requestId);
    gate(request.buyer === opened.buyer, "post-state", "opened request buyer changed or cannot be proven");
    gate(BigInt(request.packIndex) === opened.packIndex && BigInt(request.paidUsdc) === opened.paidUsdc, "post-state", "opened request pack terms do not match its receipt");
    gate(BigInt(request.ceilingBps) === opened.ceilingBps && BigInt(request.maxPayoutUsdc) === opened.maxPayoutUsdc, "post-state", "opened request funding terms do not match its receipt");
    const requestHash = localOfferHash(
      Number(opened.packIndex),
      opened.ceilingBps,
      request.eligible.map((entry) => entry.token),
      request.eligible.map((entry) => entry.routeHash),
    );
    gate(requestHash === String(context.terms.expectedOfferHash).toLowerCase(), "post-state", "stored request offer commitment does not match the confirmed receipt");
    const nominalRtpBps = await readUint(ADDR.gacha, SIG.effectiveRtp, ["uint256"], [opened.ceilingBps]);
    assertContextString(nominalRtpBps, context.terms.nominalRtpBps, "current immutable nominal RTP calculation");
    return { requestId: opened.requestId, currentStatus: request.status, immutableRequestTermsMatch: true, nominalRtpBps };
  }
  if (actionName === "claim-prize" || actionName === "claim-prize-to") {
    const delivered = eventProof.PrizeDelivered;
    const request = await readRequest(delivered.requestId);
    gate(request.status === "Delivered" && BigInt(request.stockOut) === delivered.stockOut, "post-state", "delivered request record does not match its receipt");
    gate(request.buyer === delivered.buyer && request.token === delivered.token && BigInt(request.payoutUsdc) === delivered.payoutUsdc, "post-state", "delivered request outcome changed or mismatches its receipt");
    return { requestId: delivered.requestId, currentStatus: request.status, recordedStockOut: request.stockOut };
  }
  if (actionName === "expire-request") {
    const expired = eventProof.PackExpired;
    const request = await readRequest(expired.requestId);
    gate(request.buyer === expired.buyer && (request.status === "Expired" || request.status === "Refunded"), "post-state", "expired request is not in a compatible later state");
    return { requestId: expired.requestId, currentStatus: request.status, refundClaimable: request.refundClaimable };
  }
  if (actionName === "claim-refund" || actionName === "claim-refund-to") {
    const refund = eventProof.RefundClaimed;
    const request = await readRequest(refund.requestId);
    gate(request.status === "Refunded" && request.buyer === refund.buyer && BigInt(request.refundClaimable) === 0n, "post-state", "refunded request record does not match its receipt");
    return { requestId: refund.requestId, currentStatus: request.status, refundClaimable: request.refundClaimable };
  }
  if (actionName === "distribute-profit") {
    const integrity = await verifyDeployment();
    gate(integrity.ok, "post-state", "current Gacha/Treasury accounting parity or deployment identity failed after distribution", { failed: integrity.failed });
    return { currentDeploymentIntegrity: true, accountingParity: true };
  }
  if (actionName === "approve") {
    return { note: "The exact Approval is proven from the scoped receipt. Current allowance may legitimately be consumed or replaced by a later transaction." };
  }
  if (actionName === "fund-reserve") {
    const cumulative = await readUint(ADDR.gacha, "cumulativeFundedReserveUsdc()");
    gate(cumulative >= eventProof.ReserveFunded.amount, "post-state", "current cumulative reserve funding is below the proven contribution");
    return { cumulativeFundedReserveUsdc: cumulative };
  }
  return null;
}

async function commandInspectTx() {
  const wallet = walletArg();
  const hash = bytes32Arg("tx");
  const contextHex = need("context");
  const expectedInspectionKey = bytes32Arg("plan-key");
  const [transaction, receipt] = await Promise.all([getTransaction(hash), getReceipt(hash)]);
  gate(transaction && receipt, "pending", "transaction is pending or unavailable; do not retry an unknown outcome", { hash });
  gate(Number(BigInt(transaction.chainId)) === 8453, "chain", "transaction is not on Base chainId 8453");
  gate(BigInt(receipt.status) === 1n, "receipt", "transaction mined with reverted status");
  let envelope;
  try { envelope = decodeBankrExecution(transaction, wallet); }
  catch (error) { throw new GateError("bankr-envelope", error.message); }
  const tx = {
    chainId: 8453,
    to: envelope.logicalCall.target,
    data: envelope.logicalCall.data.toLowerCase(),
    value: envelope.logicalCall.value.toString(),
  };
  const inspection = await inspectLogicalCall({ wallet, tx, contextHex, expectedInspectionKey, verifyFreshState: false });
  const executionProof = await proveBankrExecutionReceipt(envelope, transaction, receipt);
  const receiptIdentity = executionProof.receiptBlockIdentity;
  const receiptSnapshot = {
    number: receiptIdentity.number,
    timestamp: receiptIdentity.timestamp,
    hash: receiptIdentity.hash,
    parentHash: receiptIdentity.parentHash,
    ref: { blockHash: receiptIdentity.hash, requireCanonical: true },
  };
  const deploymentIdentityProof = await verifyDeployment(receiptSnapshot);
  gate(deploymentIdentityProof.ok, "receipt-deployment", "the complete Stonk Gacha dependency graph did not match the reviewed release at the receipt block", {
    failed: deploymentIdentityProof.failed,
  });
  const range = executionProof.userOperationEvent?.receiptLogRange ?? null;
  const scopedLogs = range ? receipt.logs.slice(range.start, range.end) : receipt.logs;
  const events = actionLogs(scopedLogs);
  const eventProof = proveActionEvents(inspection.action.name, events, scopedLogs, wallet, inspection.values, inspection.context);
  const postStateProof = await postActionState(inspection.action.name, eventProof, inspection.context);
  out({
    ok: true,
    command,
    hash,
    wallet,
    executionMode: envelope.mode,
    logicalCall: tx,
    inspection,
    executionProof,
    deploymentIdentityProof,
    receiptLogScope: range,
    eventProof,
    postStateProof,
    verdict: "mined successfully; supported Bankr execution, exact logical call, allowlisted context, and action-specific receipt evidence all passed",
  });
}

function help() {
  out({
    ok: true,
    command: command ?? null,
    usage: "node scripts/stonk-gacha.mjs <command> [flags]",
    reads: [
      "verify", "status [--wallet]", "offers", "offer --pack-index", "requests --wallet [--cursor --limit]",
      "request --request-id", "profit-status [--wallet]",
    ],
    planners: [
      "plan-open-pack --wallet --pack-index [--user-random]", "plan-revoke-usdc --wallet",
      "plan-open-pack-funding --wallet --pack-index --source-token ETH|WETH --source-amount --min-usdc-out --quoted-usdc-out-raw --swap-slippage-bps [--quote-id --swap-idempotency-key --native-source-amount --min-native-out --quoted-native-out-wei --native-swap-slippage-bps --native-quote-id --native-swap-idempotency-key --native-headroom-wei --intent-ttl-seconds --user-random]",
      "resume-open-pack-funding --wallet --intent --intent-key",
      "plan-claim-prize --wallet --request-id [--recipient --slippage-bps]",
      "plan-expire-request --wallet --request-id", "plan-claim-refund --wallet --request-id [--recipient]",
      "plan-fund-reserve --wallet --amount-usdc", "plan-distribute-profit --wallet [--amount-usdc --slippage-bps]",
    ],
    inspection: [
      "inspect-calldata --wallet --chain-id 8453 --to --data --value --context --plan-key",
      "inspect-tx --wallet --tx --context --plan-key",
    ],
    xConfirmation: [
      "bind-x-funding-intent --wallet --intent --intent-key --x-user-id --confirmation-tweet-id --confirmation-channel x --confirmation-message-hex",
      "verify-x-funding-approval --wallet --pending-intent --pending-intent-key --approval-mode reply|self-contained --message|--message-hex --approval-tweet-id [--parent-tweet-id --reference-type replied_to] --x-user-id",
    ],
    invariant: "Every planner emits zero or one unsigned allowlisted transaction. This program never signs or submits.",
  });
}

async function main() {
  if (argumentParseError) throw new GateError("args", argumentParseError);
  rejectUnknownFlags();
  switch (command) {
    case undefined:
    case "help": return help();
    case "verify": return await commandVerify();
    case "status": return await commandStatus();
    case "offers": return await commandOffers();
    case "offer": return await commandOffer();
    case "requests": return await commandRequests();
    case "request": return await commandRequest();
    case "profit-status": return await commandProfitStatus();
    case "plan-open-pack": return await planOpenPack();
    case "plan-open-pack-funding": return await planOpenPackFunding();
    case "resume-open-pack-funding": return await resumeOpenPackFunding();
    case "bind-x-funding-intent": return bindXIntent();
    case "verify-x-funding-approval": return verifyXApproval();
    case "plan-revoke-usdc": return await planRevokeUsdc();
    case "plan-claim-prize": return await planClaimPrize();
    case "plan-expire-request": return await planExpireRequest();
    case "plan-claim-refund": return await planClaimRefund();
    case "plan-fund-reserve": return await planFundReserve();
    case "plan-distribute-profit": return await planDistributeProfit();
    case "inspect-calldata": return await commandInspectCalldata();
    case "inspect-tx": return await commandInspectTx();
    default: throw new GateError("args", `unknown command: ${command}`);
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof GateError) {
    out({ ok: false, command: command ?? null, gate: error.gate, error: error.message, ...error.extra }, 1);
  } else {
    out({ ok: false, command: command ?? null, gate: "unexpected", error: error?.message ?? String(error) }, 1);
  }
}
