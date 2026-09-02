#!/usr/bin/env node
// Zero-dependency offline regression suite. Add --live for read-only Base
// deployment, offer, request, accounting, and Bankr execution-fixture proofs.

import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import {
  decodeAddress,
  decodeBool,
  decodeBytes32,
  decodeCallArguments,
  decodeParameters,
  encodeAddress,
  encodeCall,
  encodeParameters,
  encodeUint,
  formatUnits,
  normalizeAddress,
  parseUnits,
  strip0x,
  stripErc8021Suffix,
  toAddress,
} from "./lib/abi.mjs";
import {
  BEFORE_EXECUTION_EVENT_TOPIC,
  ECRECOVER_PRECOMPILE,
  ENTRY_POINT_V07,
  ENTRY_POINT_V07_CODE_HASH,
  HANDLE_OPS_SELECTOR,
  KERNEL_DELEGATION_DESIGNATOR,
  KERNEL_EXECUTE_SELECTOR,
  KERNEL_IMPLEMENTATION,
  KERNEL_IMPLEMENTATION_CODE_HASH,
  KERNEL_VALIDATION_STORAGE_SLOT,
  ROOT_VALIDATOR_SELECTOR,
  USER_OPERATION_EVENT_TOPIC,
  authorizationRecoveryCall,
  decodeAuthorizationAuthority,
  decodeBankrExecution,
  decodeRootValidator,
  proveKernelDelegationAtTransaction,
  sumCanonicalErc20Transfers,
  userOperationHashCall,
  verifyBankrExecutionReceipt,
} from "./lib/bankr.mjs";
import {
  beginSnapshot,
  confirmSnapshot,
  ethCall,
  getBlockByHash,
  getCode,
  getCodeHash,
  getReceipt,
  getStorageAt,
  getTransaction,
  getTransactionCount,
  isRetryableRpcTransportError,
  RpcError,
  RpcTransportError,
} from "./lib/chain.mjs";
import { eventTopic, keccak256, selector } from "./lib/keccak256.mjs";
import {
  DEFAULT_DIRECT_ENTROPY_FEE_CAP_WEI,
  DIRECT_CLAIM_TTL_SECONDS,
  DIRECT_CLAIM_SLIPPAGE_BPS,
  DIRECT_PULL_TTL_SECONDS,
  MAX_EXPLICIT_DIRECT_ENTROPY_FEE_CAP_WEI,
  assessDirectClaimContinuation,
  assessDirectPullIntent,
  createDirectClaimContinuation,
  createDirectPullIntent,
  decodeDirectClaimContinuation,
  decodeDirectPullIntent,
  directClaimContinuationKey,
  directPullIntentKey,
  directUserRandomNumber,
  encodeDirectClaimContinuation,
  encodeDirectPullIntent,
  validateDirectClaimContinuation,
  validateDirectPullIntent,
} from "./lib/direct.mjs";
import {
  DEFAULT_NATIVE_HEADROOM_WEI,
  FUNDING_POLICY,
  NATIVE_SENTINEL,
  bindXFundingIntent,
  createFundingIntent,
  decodeFundingIntent,
  encodeFundingIntent,
  fundingIntentKey,
  fundingResumeAssessment,
  fundingSourceOptions,
  rebaseFundingIntentForRemainingOpen,
  verifyXFundingApproval,
  xPendingIntentKey,
  xPreparedConfirmation,
  xSelfContainedCommand,
} from "./lib/funding.mjs";
import {
  ADDR,
  ALLOWED_ACTIONS,
  BANKR_EXECUTION,
  BPS,
  DEPLOYMENT,
  SIGNING_POLICY,
  SIG,
  confirmationKey,
  decodeTokenDecimals,
  knownActionBySelector,
  localOfferHash,
  profitStatus,
  protocolStatus,
  readOffer,
  readRequest,
  readUint,
  requiresAllowanceReset,
  verifyDeployment,
  walletRequests,
} from "./lib/protocol.mjs";
import { watchExactRequest } from "./lib/watch.mjs";

const LIVE = process.argv.includes("--live");
const results = [];
const FUNDING_FIXTURES = JSON.parse(readFileSync(new URL("../references/funding-fixtures.json", import.meta.url), "utf8"));

function check(name, pass, detail = "") {
  results.push({ status: pass ? "pass" : "fail", name, detail: pass ? "" : String(detail || "assertion was false") });
}

function equal(name, actual, expected) {
  const pass = actual === expected;
  check(name, pass, pass ? "" : `actual=${String(actual)} expected=${String(expected)}`);
}

function deepEqual(name, actual, expected) {
  const actualJson = JSON.stringify(actual, (_, value) => typeof value === "bigint" ? `${value}n` : value);
  const expectedJson = JSON.stringify(expected, (_, value) => typeof value === "bigint" ? `${value}n` : value);
  equal(name, actualJson, expectedJson);
}

function rejects(name, fn, expectedMessage) {
  try {
    fn();
    check(name, false, "did not reject");
  } catch (error) {
    check(name, String(error.message).includes(expectedMessage), error.message);
  }
}

async function rejectsAsync(name, fn, expectedMessage) {
  try {
    await fn();
    check(name, false, "did not reject");
  } catch (error) {
    check(name, String(error.message).includes(expectedMessage), error.message);
  }
}

function skip(name, detail) {
  results.push({ status: "skip", name, detail });
}

function encodeDynamicBytes(value) {
  const body = strip0x(value);
  if (!/^[0-9a-fA-F]*$/.test(body) || body.length % 2 !== 0) throw new Error("test bytes must be even-length hex");
  return encodeUint(body.length / 2) + body.toLowerCase().padEnd(Math.ceil(body.length / 64) * 64, "0");
}

function kernelExecute(target, value, data, mode = 0n) {
  const packed = `${strip0x(target)}${encodeUint(value)}${strip0x(data)}`;
  return `${KERNEL_EXECUTE_SELECTOR}${encodeUint(mode)}${encodeUint(64n)}${encodeDynamicBytes(`0x${packed}`)}`;
}

function userOperationTuple(sender, nonce, callData, { initCode = "0x", paymaster = "0x", signature = "0x5678" } = {}) {
  const headWords = 9;
  const encodedInitCode = encodeDynamicBytes(initCode);
  const encodedCallData = encodeDynamicBytes(callData);
  const encodedPaymaster = encodeDynamicBytes(paymaster);
  const encodedSignature = encodeDynamicBytes(signature);
  const initCodeOffset = headWords * 32;
  const callDataOffset = initCodeOffset + encodedInitCode.length / 2;
  const paymasterOffset = callDataOffset + encodedCallData.length / 2;
  const signatureOffset = paymasterOffset + encodedPaymaster.length / 2;
  return `${encodeAddress(sender)}${encodeUint(nonce)}${encodeUint(initCodeOffset)}${encodeUint(callDataOffset)}`
    + `${encodeUint(0n)}${encodeUint(100_000n)}${encodeUint(0n)}${encodeUint(paymasterOffset)}${encodeUint(signatureOffset)}`
    + `${encodedInitCode}${encodedCallData}${encodedPaymaster}${encodedSignature}`;
}

function handleOpsMany(tuples) {
  if (!Array.isArray(tuples) || tuples.length < 1) throw new Error("test handleOps requires tuples");
  const beneficiary = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  let offset = tuples.length * 32;
  let offsets = "";
  for (const tuple of tuples) {
    offsets += encodeUint(offset);
    offset += tuple.length / 2;
  }
  return `${HANDLE_OPS_SELECTOR}${encodeUint(64n)}${encodeAddress(beneficiary)}${encodeUint(tuples.length)}${offsets}${tuples.join("")}`;
}

function handleOps(sender, nonce, callData, options = {}) {
  return handleOpsMany([userOperationTuple(sender, nonce, callData, options)]);
}

function beforeExecutionEvent(entryPoint) {
  return { address: entryPoint, topics: [BEFORE_EXECUTION_EVENT_TOPIC], data: "0x" };
}

function userOperationEvent(entryPoint, sender, nonce, userOpHash, success = true) {
  return {
    address: entryPoint,
    topics: [
      USER_OPERATION_EVENT_TOPIC,
      userOpHash,
      `0x${encodeAddress(sender)}`,
      `0x${encodeAddress("0xcccccccccccccccccccccccccccccccccccccccc")}`,
    ],
    data: `0x${encodeUint(nonce)}${encodeUint(success ? 1n : 0n)}${encodeUint(123n)}${encodeUint(456n)}`,
  };
}

function syntheticAuthorization(target, nonce = 0n) {
  return {
    chainId: "0x2105",
    address: target,
    nonce: `0x${nonce.toString(16)}`,
    yParity: "0x0",
    r: "0x1",
    s: "0x1",
  };
}

const wallet = "0x1111111111111111111111111111111111111111";
const otherWallet = "0x2222222222222222222222222222222222222222";
const relayer = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function syntheticTransaction(index, { type = "0x2", from = relayer, to = null, input = "0x", authorizations } = {}) {
  return {
    hash: keccak256(`delegation-test-${index}-${type}-${authorizations?.length ?? 0}`),
    transactionIndex: `0x${index.toString(16)}`,
    type,
    from,
    to,
    input,
    ...(authorizations ? { authorizationList: authorizations } : {}),
  };
}

// Ethereum hashing primitives and reviewed selectors.
equal("keccak empty vector", keccak256(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
equal("keccak abc vector", keccak256("abc"), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
equal("ERC20 approve selector", selector("approve(address,uint256)"), "0x095ea7b3");
equal("open pack selector", selector("openPack(uint256,uint256,bytes32,bytes32)"), "0x19b4242f");
equal("claim prize selector", selector("claimPrize(uint256,uint256,uint256)"), "0xf6c94230");
equal("profit distribution selector", selector("distributeProfit(uint256,uint256,uint256)"), "0x077317e3");
equal("ERC20 Transfer topic", eventTopic("Transfer(address,address,uint256)"), "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");

// Canonical ABI round trips, fixed and dynamic shapes used by the protocol.
const sampleHash = keccak256("ordered-offer");
const userRandom = `0x${"42".repeat(32)}`;
const openPack = encodeCall(
  "openPack(uint256,uint256,bytes32,bytes32)",
  ["uint256", "uint256", "bytes32", "bytes32"],
  [1n, 100_000n, sampleHash, userRandom],
);
equal("open calldata selector", openPack.slice(0, 10), "0x19b4242f");
equal("open calldata byte length", (openPack.length - 2) / 2, 4 + 4 * 32);
deepEqual(
  "open calldata canonical round trip",
  decodeCallArguments(["uint256", "uint256", "bytes32", "bytes32"], openPack),
  [1n, 100_000n, sampleHash, userRandom],
);

const tokenSet = [wallet, otherWallet, ADDR.weth];
const routeSet = [keccak256("route-0"), keccak256("route-1"), keccak256("route-2")];
const dynamicOffer = encodeParameters(["uint256", "address[]", "bytes32[]"], [100_000n, tokenSet, routeSet]);
const decodedOffer = decodeParameters(["uint256", "address[]", "bytes32[]"], `0x${dynamicOffer}`);
equal("dynamic offer ceiling", decodedOffer[0], 100_000n);
deepEqual("dynamic address array", decodedOffer[1], tokenSet.map((entry) => entry.toLowerCase()));
deepEqual("dynamic bytes32 array", decodedOffer[2], routeSet);

const fixedOdds = encodeParameters(["uint32[4]", "bool", "uint8"], [[20_000n, 50_000n, 100_000n, 1_000_000n], true, 2n]);
const decodedFixedOdds = decodeParameters(["uint32[4]", "bool", "uint8"], `0x${fixedOdds}`);
deepEqual("fixed ceiling array", decodedFixedOdds[0], [20_000n, 50_000n, 100_000n, 1_000_000n]);
equal("canonical ABI bool true", decodedFixedOdds[1], true);
equal("canonical uint8", decodedFixedOdds[2], 2n);

const textAndBytes = encodeParameters(["string", "bytes"], ["Stonk Gacha", "0x00ff8021"]);
deepEqual("dynamic string and bytes", decodeParameters(["string", "bytes"], `0x${textAndBytes}`), ["Stonk Gacha", "0x00ff8021"]);
equal("address word round trip", toAddress(encodeAddress(wallet)), wallet);
equal("decode address result", decodeAddress(`0x${encodeAddress(otherWallet)}`), otherWallet);
equal("decode bool false", decodeBool(`0x${encodeUint(0n)}`), false);
equal("decode bytes32 result", decodeBytes32(sampleHash), sampleHash);
equal("canonical token decimals result", decodeTokenDecimals(`0x${encodeUint(18n)}`), 18);
rejects("empty token decimals falls back", () => decodeTokenDecimals("0x"), "exactly one ABI word");
rejects("short token decimals falls back", () => decodeTokenDecimals("0x12"), "exactly one ABI word");
rejects("trailing token decimals word falls back", () => decodeTokenDecimals(`0x${encodeUint(18n)}${encodeUint(0n)}`), "exactly one ABI word");
rejects("out-of-range token decimals falls back", () => decodeTokenDecimals(`0x${encodeUint(37n)}`), "supported display range");
equal("parse exact USDC units", parseUnits("20.000001", 6), 20_000_001n);
equal("format exact USDC units", formatUnits(20_000_001n, 6), "20.000001");
rejects("reject excess USDC decimals", () => parseUnits("1.0000001", 6), "more than 6 decimal places");
rejects("reject non-canonical decimal", () => parseUnits("01", 6), "invalid decimal amount");
rejects("reject invalid address", () => normalizeAddress("0x1234"), "invalid EVM address");
rejects("reject non-canonical address word", () => toAddress(`01${"0".repeat(22)}${"11".repeat(20)}`), "non-canonical ABI address");
rejects("reject non-canonical bool", () => decodeCallArguments(["bool"], `0x12345678${encodeUint(2n)}`), "non-canonical ABI bool");
rejects("reject uint8 overflow word", () => decodeCallArguments(["uint8"], `0x12345678${encodeUint(256n)}`), "non-canonical uint8");
rejects("reject calldata trailing word", () => decodeCallArguments(["uint256", "uint256", "bytes32", "bytes32"], `${openPack}${encodeUint(0n)}`), "canonical ABI re-encoding");
rejects("reject unaligned dynamic offset", () => decodeCallArguments(["address[]"], `0x12345678${encodeUint(33n)}${encodeUint(0n)}`), "unsafe offset");
rejects("reject overlapping dynamic offset", () => decodeCallArguments(["address[]"], `0x12345678${encodeUint(0n)}`), "canonical ABI re-encoding");
const gappedDynamic = `0x12345678${encodeUint(64n)}${encodeUint(0xdeadn)}${encodeUint(1n)}${encodeAddress(wallet)}`;
rejects("reject gapped dynamic ABI", () => decodeCallArguments(["address[]"], gappedDynamic), "canonical ABI re-encoding");
const nonzeroPadding = `0x12345678${encodeUint(32n)}${encodeUint(1n)}ff${"01".repeat(31)}`;
rejects("reject nonzero dynamic bytes padding", () => decodeCallArguments(["bytes"], nonzeroPadding), "canonical ABI re-encoding");
rejects("reject odd-length dynamic bytes input", () => encodeParameters(["bytes"], ["0x0"]), "even-length");
rejects("reject non-hex dynamic bytes input", () => encodeParameters(["bytes"], ["0xzz"]), "hex");

// Offer commitments are ordered. Reordering either dimension must change the
// local commitment; this is the core defense against post-payment re-derivation.
const commitment = localOfferHash(1, 100_000n, tokenSet, routeSet);
equal("offer commitment deterministic", localOfferHash(1, 100_000n, tokenSet, routeSet), commitment);
check("offer token order changes commitment", localOfferHash(1, 100_000n, [...tokenSet].reverse(), routeSet) !== commitment);
check("offer route order changes commitment", localOfferHash(1, 100_000n, tokenSet, [...routeSet].reverse()) !== commitment);
check("offer pack index changes commitment", localOfferHash(0, 100_000n, tokenSet, routeSet) !== commitment);
check("offer ceiling changes commitment", localOfferHash(1, 50_000n, tokenSet, routeSet) !== commitment);

// ERC-8021 suffixes accepted by the Bankr execution decoder.
const schema0 = `${openPack}62635f73746f6e6b67090080218021802180218021802180218021`;
const stripped0 = stripErc8021Suffix(schema0);
equal("ERC-8021 schema 0 strips to call", stripped0.calldata, openPack);
deepEqual("ERC-8021 schema 0 builder codes", stripped0.attribution.codes, ["bc_stonkg"]);
const schema1 = `${openPack}${"cc".repeat(20)}210502626173656170702c6d6f7270686f0e0180218021802180218021802180218021`;
const stripped1 = stripErc8021Suffix(schema1);
equal("ERC-8021 schema 1 strips to call", stripped1.calldata, openPack);
equal("ERC-8021 schema 1 registry", stripped1.attribution.codeRegistry.address, `0x${"cc".repeat(20)}`);
equal("ERC-8021 schema 1 chain", stripped1.attribution.codeRegistry.chainId, 8453);
deepEqual("ERC-8021 schema 1 codes", stripped1.attribution.codes, ["baseapp", "morpho"]);
const schema2 = `${openPack}a161616762617365617070000b0280218021802180218021802180218021`;
const stripped2 = stripErc8021Suffix(schema2);
equal("ERC-8021 schema 2 strips to call", stripped2.calldata, openPack);
equal("ERC-8021 schema 2 opaque", stripped2.attribution.opaque, true);
equal("ERC-8021 schema 2 byte length", stripped2.attribution.cborBytes, 11);
rejects("reject empty ERC-8021 builder entry", () => stripErc8021Suffix(`${openPack}612c2c62040080218021802180218021802180218021`), "invalid ERC-8021 builder codes");
rejects("reject unsupported ERC-8021 schema", () => stripErc8021Suffix(`${openPack}ff80218021802180218021802180218021`), "unsupported ERC-8021 schema");

// The signing policy itself is executable data: selectors are recomputed and
// the lookup remains target-and-selector scoped with a default deny.
equal("signing policy chain", SIGNING_POLICY.chainId, 8453);
check("signing policy default deny", SIGNING_POLICY.defaultDeny === true);
equal("one transaction per plan", SIGNING_POLICY.maxTransactionsPerPlan, 1);
equal("allowlisted action count", ALLOWED_ACTIONS.length, 9);
for (const action of ALLOWED_ACTIONS) {
  equal(`policy selector ${action.name}`, action.selector, selector(action.signature));
  equal(`policy lookup ${action.name}`, knownActionBySelector(action.target, action.selector)?.name, action.name);
  check(`policy context ${action.name}`, Array.isArray(action.contextActions) && action.contextActions.length > 0);
  check(`policy value rule ${action.name}`, action.valueRule === "zero" || action.valueRule === "exact-live-entropy-fee");
}
equal("wrong target defaults to deny", knownActionBySelector(otherWallet, selector("openPack(uint256,uint256,bytes32,bytes32)")), null);
equal("wrong selector defaults to deny", knownActionBySelector(ADDR.gacha, selector("transfer(address,uint256)")), null);
equal("Treasury direct write defaults to deny", knownActionBySelector(ADDR.treasury, selector("executePayout(bytes32,address,uint256,address,uint256)")), null);
equal("owner pause defaults to deny", knownActionBySelector(ADDR.gacha, selector("setSalesPaused(bool)")), null);
const openPolicy = ALLOWED_ACTIONS.find((entry) => entry.name === "open-pack");
equal("open is exact live fee only", openPolicy.valueRule, "exact-live-entropy-fee");
const approvePolicy = ALLOWED_ACTIONS.find((entry) => entry.name === "approve");
deepEqual("approval contexts are bounded", approvePolicy.contextActions, ["open-pack", "fund-reserve", "revoke-usdc"]);
check("approval rules require exact/reset", approvePolicy.rules.includes("amount-is-zero-reset-or-exact-fresh-plan"));
for (const denied of SIGNING_POLICY.explicitlyDenied.filter((entry) => entry.selector)) {
  equal(`denied selector pin ${denied.signature}`, denied.selector, selector(denied.signature));
  equal(`denied call remains absent ${denied.signature}`, knownActionBySelector(ADDR.gacha, denied.selector), null);
}
const userWrites = new Set(ALLOWED_ACTIONS.map((entry) => entry.signature));
for (const forbidden of [
  "setSalesPaused(bool)", "wireTreasury(address)", "recoverExcess(uint8,address,uint256,address)",
  "_entropyCallback(uint64,address,bytes32)", "executePayout(bytes32,address,uint256,address,uint256)",
]) {
  check(`privileged/authenticated call excluded: ${forbidden}`, !userWrites.has(forbidden));
}

// Confirmation is signer-specific even when the economic terms and action are
// identical. Address casing is normalized before hashing.
const confirmationTerms = { amountUsdc: 5_000_000n, recipient: wallet };
const normalizedConfirmation = confirmationKey(ADDR.gacha, "open-pack", confirmationTerms);
equal(
  "confirmation key normalizes wallet casing",
  confirmationKey(DEPLOYMENT.contracts.stonkGacha.address, "open-pack", confirmationTerms),
  normalizedConfirmation,
);
check("confirmation key changes with wallet", confirmationKey(otherWallet, "open-pack", confirmationTerms) !== normalizedConfirmation);
check("confirmation key changes with action", confirmationKey(ADDR.gacha, "fund-reserve", confirmationTerms) !== normalizedConfirmation);
check("confirmation key changes with terms", confirmationKey(ADDR.gacha, "open-pack", { ...confirmationTerms, amountUsdc: 10_000_000n }) !== normalizedConfirmation);

check("positive mismatched allowance requires reset", requiresAllowanceReset(7n, 5n));
check("exact desired allowance rejects reset", !requiresAllowanceReset(5n, 5n));
check("zero allowance rejects reset", !requiresAllowanceReset(0n, 5n));
rejects("reset predicate rejects nonpositive desired allowance", () => requiresAllowanceReset(5n, 0n), "positive desired amount");

// A normal-language pull is reduced to a short-lived, canonical one-time
// intent. The exact named dollar price, request-count baseline, offer, fee cap,
// randomness, same-wallet delivery policy, and later receipt-bound claim are
// executable invariants rather than prose instructions.
const directCreatedAt = 1_788_345_000n;
const directExpiresAt = directCreatedAt + DIRECT_PULL_TTL_SECONDS;
const directOfferHash = keccak256("direct-offer");
const directClaimCapabilitySecret = `0x${"24".repeat(32)}`;
const directCommittedUserRandom = directUserRandomNumber(directClaimCapabilitySecret);
check("direct claim capability commits to a nonzero distinct Pyth contribution", /^0x[0-9a-f]{64}$/.test(directCommittedUserRandom) && directCommittedUserRandom !== directClaimCapabilitySecret && !/^0x0{64}$/.test(directCommittedUserRandom));
const directIntent = createDirectPullIntent({
  wallet,
  packIndex: 1,
  authorizedPriceUsdcRaw: 10_000_000n,
  packPriceUsdcRaw: 10_000_000n,
  expectedOfferHash: directOfferHash,
  acceptedCeilingBps: 100_000n,
  entropyFeeObservedWei: DEFAULT_DIRECT_ENTROPY_FEE_CAP_WEI,
  entropyFeeCapWei: DEFAULT_DIRECT_ENTROPY_FEE_CAP_WEI,
  feeAuthorization: "reviewed-default-cap",
  claimCapabilitySecret: directClaimCapabilitySecret,
  userRandomNumber: directCommittedUserRandom,
  usdcBalance: 40_000_000n,
  ethBalance: 2_000_000_000_000_000n,
  allowance: 0n,
  requestCount: 7n,
  token: ADDR.usdc,
  spender: ADDR.gacha,
  createdAt: directCreatedAt,
  expiresAt: directExpiresAt,
});
const directIntentHex = encodeDirectPullIntent(directIntent);
const directIntentKeyValue = directPullIntentKey(directIntent);
deepEqual("direct pull intent canonical round trip", decodeDirectPullIntent(directIntentHex), directIntent);
equal("direct pull intent key survives round trip", directPullIntentKey(decodeDirectPullIntent(directIntentHex)), directIntentKeyValue);
const directFresh = {
  wallet,
  packIndex: 1,
  authorizedPriceUsdcRaw: 10_000_000n,
  timestamp: directCreatedAt,
  salesPaused: false,
  packPriceUsdcRaw: 10_000_000n,
  offerHash: directOfferHash,
  computedOfferHash: directOfferHash,
  ceilingBps: 100_000n,
  entropyFeeWei: DEFAULT_DIRECT_ENTROPY_FEE_CAP_WEI,
  usdcBalance: 40_000_000n,
  ethBalance: 2_000_000_000_000_000n,
  requestCount: 7n,
  token: ADDR.usdc,
  spender: ADDR.gacha,
};
check("unchanged direct pull intent resumes", assessDirectPullIntent(directIntent, directFresh).ok);
const replayAssessment = assessDirectPullIntent(directIntent, { ...directFresh, requestCount: 8n });
check("landed open blocks replay by request count", !replayAssessment.ok && replayAssessment.issues.some(({ code }) => code === "request-count-changed"));
const expiredDirectAssessment = assessDirectPullIntent(directIntent, { ...directFresh, timestamp: directExpiresAt });
check("direct pull expiry is exclusive", !expiredDirectAssessment.ok && expiredDirectAssessment.issues.some(({ code }) => code === "expired"));
const futureDirectAssessment = assessDirectPullIntent(directIntent, { ...directFresh, timestamp: directCreatedAt - 1n });
check("direct pull cannot start before creation", !futureDirectAssessment.ok && futureDirectAssessment.issues.some(({ code }) => code === "not-yet-valid"));
const wrongAuthorizedPriceAssessment = assessDirectPullIntent(directIntent, { ...directFresh, authorizedPriceUsdcRaw: 20_000_000n });
check("fresh direct pull preserves user-named price", !wrongAuthorizedPriceAssessment.ok && wrongAuthorizedPriceAssessment.issues.some(({ code }) => code === "authorization-price-changed"));
const wrongPackAssessment = assessDirectPullIntent(directIntent, { ...directFresh, packIndex: 2 });
check("fresh direct pull preserves exact pack index", !wrongPackAssessment.ok && wrongPackAssessment.issues.some(({ code }) => code === "pack-changed"));
const changedDirectOfferAssessment = assessDirectPullIntent(directIntent, { ...directFresh, offerHash: keccak256("changed-direct-offer") });
check("fresh direct pull preserves offer hash", !changedDirectOfferAssessment.ok && changedDirectOfferAssessment.issues.some(({ code }) => code === "offer-changed"));
const changedDirectCeilingAssessment = assessDirectPullIntent(directIntent, { ...directFresh, ceilingBps: 50_000n });
check("fresh direct pull preserves cash-backed ceiling", !changedDirectCeilingAssessment.ok && changedDirectCeilingAssessment.issues.some(({ code }) => code === "ceiling-changed"));
const changedDirectFeeAssessment = assessDirectPullIntent(directIntent, { ...directFresh, entropyFeeWei: DEFAULT_DIRECT_ENTROPY_FEE_CAP_WEI + 1n });
check("fresh direct pull enforces Entropy fee cap", !changedDirectFeeAssessment.ok && changedDirectFeeAssessment.issues.some(({ code }) => code === "fee-cap-exceeded"));
const requestEightIntent = structuredClone(directIntent);
requestEightIntent.preflight.walletRequestCount = "8";
check("direct pull intent key changes with request baseline", directPullIntentKey(requestEightIntent) !== directIntentKeyValue);
const changedRandomIntent = structuredClone(directIntent);
changedRandomIntent.pack.claimCapabilitySecret = `0x${"25".repeat(32)}`;
changedRandomIntent.pack.userRandomNumber = directUserRandomNumber(changedRandomIntent.pack.claimCapabilitySecret);
check("direct pull intent key changes with claim capability", directPullIntentKey(changedRandomIntent) !== directIntentKeyValue);
const changedExpiryIntent = structuredClone(directIntent);
changedExpiryIntent.expiresAt = (directExpiresAt - 1n).toString();
check("direct pull intent key changes with expiry", directPullIntentKey(changedExpiryIntent) !== directIntentKeyValue);
const changedIntentOffer = structuredClone(directIntent);
changedIntentOffer.pack.expectedOfferHash = keccak256("different-intent-offer");
check("direct pull intent key changes with offer", directPullIntentKey(changedIntentOffer) !== directIntentKeyValue);
const indexPriceMismatchIntent = structuredClone(directIntent);
indexPriceMismatchIntent.pack.packIndex = 2;
rejects("$10 cannot authorize deployed $20 pack index", () => validateDirectPullIntent(indexPriceMismatchIntent), "does not map");
const priceMismatchIntent = structuredClone(directIntent);
priceMismatchIntent.authorization.authorizedPriceUsdcRaw = "20000000";
rejects("contract price must equal user-authorized price", () => validateDirectPullIntent(priceMismatchIntent), "differs");
const longDirectIntent = structuredClone(directIntent);
longDirectIntent.expiresAt = (directCreatedAt + DIRECT_PULL_TTL_SECONDS + 1n).toString();
rejects("direct pull intent rejects excessive TTL", () => validateDirectPullIntent(longDirectIntent), "TTL");
const wrongChainDirectIntent = structuredClone(directIntent);
wrongChainDirectIntent.chainId = 1;
rejects("direct pull intent rejects wrong chain", () => validateDirectPullIntent(wrongChainDirectIntent), "not for Base");
const excessiveExplicitFeeIntent = structuredClone(directIntent);
excessiveExplicitFeeIntent.authorization.feeAuthorization = "explicit-user-cap";
excessiveExplicitFeeIntent.pack.entropyFeeCapWei = (MAX_EXPLICIT_DIRECT_ENTROPY_FEE_CAP_WEI + 1n).toString();
rejects("direct pull intent rejects excessive explicit fee cap", () => validateDirectPullIntent(excessiveExplicitFeeIntent), "planner maximum");
const zeroRandomDirectIntent = structuredClone(directIntent);
zeroRandomDirectIntent.pack.userRandomNumber = `0x${"0".repeat(64)}`;
rejects("direct pull intent rejects zero randomness", () => validateDirectPullIntent(zeroRandomDirectIntent), "cannot be zero");
const wrongCapabilityDirectIntent = structuredClone(directIntent);
wrongCapabilityDirectIntent.pack.claimCapabilitySecret = `0x${"26".repeat(32)}`;
rejects("direct pull intent rejects fabricated claim capability", () => validateDirectPullIntent(wrongCapabilityDirectIntent), "not committed");
const zeroCapabilityDirectIntent = structuredClone(directIntent);
zeroCapabilityDirectIntent.pack.claimCapabilitySecret = `0x${"0".repeat(64)}`;
rejects("direct pull intent rejects zero claim capability", () => validateDirectPullIntent(zeroCapabilityDirectIntent), "cannot be zero");
const wrongTokenDirectIntent = structuredClone(directIntent);
wrongTokenDirectIntent.approvalPolicy.token = otherWallet;
rejects("direct pull intent pins canonical Base USDC", () => validateDirectPullIntent(wrongTokenDirectIntent), "canonical Base USDC");
const wrongSpenderDirectIntent = structuredClone(directIntent);
wrongSpenderDirectIntent.approvalPolicy.spender = otherWallet;
rejects("direct pull intent pins verified Gacha spender", () => validateDirectPullIntent(wrongSpenderDirectIntent), "verified StonkGacha");
const wrongRecipientDirectIntent = structuredClone(directIntent);
wrongRecipientDirectIntent.deliveryPolicy.recipient = otherWallet;
rejects("direct pull intent pins same-wallet delivery", () => validateDirectPullIntent(wrongRecipientDirectIntent), "active wallet");
const wrongSlippageDirectIntent = structuredClone(directIntent);
wrongSlippageDirectIntent.deliveryPolicy.slippageBps = DIRECT_CLAIM_SLIPPAGE_BPS + 1;
rejects("direct pull intent pins delivery slippage", () => validateDirectPullIntent(wrongSlippageDirectIntent), "differs from policy");
const injectedDirectIntent = structuredClone(directIntent);
injectedDirectIntent.unreviewed = true;
rejects("direct pull intent rejects injected fields", () => validateDirectPullIntent(injectedDirectIntent), "unsupported field");
const consumedDirectIntent = structuredClone(directIntent);
consumedDirectIntent.consumed = true;
rejects("direct pull intent cannot begin consumed", () => validateDirectPullIntent(consumedDirectIntent), "begin unconsumed");

const directClaimContinuation = createDirectClaimContinuation({
  wallet,
  requestId: 42n,
  sourceAuthorizationKind: "direct-pull-intent",
  sourceAuthorizationKey: directIntentKeyValue,
  openTransactionHash: keccak256("direct-open-transaction"),
  openInspectionKey: keccak256("direct-open-inspection"),
  openInspectionContextHex: "0x7b7d",
  createdAt: directCreatedAt,
  expiresAt: directCreatedAt + DIRECT_CLAIM_TTL_SECONDS,
});
const directClaimHex = encodeDirectClaimContinuation(directClaimContinuation);
const directClaimKeyValue = directClaimContinuationKey(directClaimContinuation);
deepEqual("direct claim continuation canonical round trip", decodeDirectClaimContinuation(directClaimHex), directClaimContinuation);
equal("direct claim continuation key survives round trip", directClaimContinuationKey(decodeDirectClaimContinuation(directClaimHex)), directClaimKeyValue);
const directClaimFresh = {
  wallet,
  requestId: 42n,
  timestamp: directCreatedAt,
  recipient: wallet,
  slippageBps: DIRECT_CLAIM_SLIPPAGE_BPS,
};
check("exact receipt-bound direct claim continues", assessDirectClaimContinuation(directClaimContinuation, directClaimFresh).ok);
const wrongRequestClaim = assessDirectClaimContinuation(directClaimContinuation, { ...directClaimFresh, requestId: 41n });
check("direct claim cannot select another Ready request", !wrongRequestClaim.ok && wrongRequestClaim.issues.some(({ code }) => code === "request-changed"));
const expiredDirectClaim = assessDirectClaimContinuation(directClaimContinuation, { ...directClaimFresh, timestamp: directCreatedAt + DIRECT_CLAIM_TTL_SECONDS });
check("direct claim continuation expiry is exclusive", !expiredDirectClaim.ok && expiredDirectClaim.issues.some(({ code }) => code === "expired"));
const futureDirectClaim = assessDirectClaimContinuation(directClaimContinuation, { ...directClaimFresh, timestamp: directCreatedAt - 1n });
check("direct claim cannot start before creation", !futureDirectClaim.ok && futureDirectClaim.issues.some(({ code }) => code === "not-yet-valid"));
const changedRequestContinuation = structuredClone(directClaimContinuation);
changedRequestContinuation.requestId = "43";
check("direct claim key changes with request id", directClaimContinuationKey(changedRequestContinuation) !== directClaimKeyValue);
const changedSourceContinuation = structuredClone(directClaimContinuation);
changedSourceContinuation.sourceOpenProof.authorizationKey = keccak256("other-direct-intent");
check("direct claim key changes with source intent", directClaimContinuationKey(changedSourceContinuation) !== directClaimKeyValue);
const wrongSourceKindContinuation = structuredClone(directClaimContinuation);
wrongSourceKindContinuation.sourceOpenProof.authorizationKind = "arbitrary-request";
rejects("direct claim continuation rejects unknown source authorization", () => validateDirectClaimContinuation(wrongSourceKindContinuation), "unsupported");
const wrongRecipientContinuation = structuredClone(directClaimContinuation);
wrongRecipientContinuation.deliveryPolicy.recipient = otherWallet;
rejects("direct claim continuation rejects redirected recipient", () => validateDirectClaimContinuation(wrongRecipientContinuation), "active wallet");
const wrongSlippageContinuation = structuredClone(directClaimContinuation);
wrongSlippageContinuation.deliveryPolicy.slippageBps = DIRECT_CLAIM_SLIPPAGE_BPS + 1;
rejects("direct claim continuation rejects changed slippage", () => validateDirectClaimContinuation(wrongSlippageContinuation), "differs from policy");
const longClaimContinuation = structuredClone(directClaimContinuation);
longClaimContinuation.expiresAt = (directCreatedAt + DIRECT_CLAIM_TTL_SECONDS + 1n).toString();
rejects("direct claim continuation rejects excessive TTL", () => validateDirectClaimContinuation(longClaimContinuation), "TTL");
const zeroRequestContinuation = structuredClone(directClaimContinuation);
zeroRequestContinuation.requestId = "0";
rejects("direct claim continuation rejects zero request id", () => validateDirectClaimContinuation(zeroRequestContinuation), "must be nonzero");
const wrongChainClaimContinuation = structuredClone(directClaimContinuation);
wrongChainClaimContinuation.chainId = 1;
rejects("direct claim continuation rejects wrong chain", () => validateDirectClaimContinuation(wrongChainClaimContinuation), "not for Base");
const injectedClaimContinuation = structuredClone(directClaimContinuation);
injectedClaimContinuation.unreviewed = true;
rejects("direct claim continuation rejects injected fields", () => validateDirectClaimContinuation(injectedClaimContinuation), "unsupported field");

// Exact-request watching is a pure read-only state machine. A fake monotonic
// clock and injected request reader exercise every path without sleeping,
// touching Base, producing calldata, signing, or submitting anything.
function watchedRequest(status, overrides = {}) {
  return {
    requestId: "42",
    buyer: wallet,
    status,
    snapshot: { timestamp: "1000" },
    ...overrides,
  };
}

function fakeWatchClock() {
  let milliseconds = 0;
  return {
    now: () => milliseconds,
    sleep: async (delay) => { milliseconds += delay; },
    value: () => milliseconds,
  };
}

async function runWatch(sequence, overrides = {}) {
  const clock = overrides.clock ?? fakeWatchClock();
  const observations = [...sequence];
  const requestedIds = [];
  let last = observations.at(-1);
  const outcome = await watchExactRequest({
    wallet,
    requestId: 42n,
    continuationExpiresAt: 2_000n,
    timeoutMs: 1_000,
    pollIntervalMs: 100,
    maxConsecutiveTransportErrors: 2,
    monotonicNow: clock.now,
    sleep: clock.sleep,
    isRetryableTransportError: isRetryableRpcTransportError,
    readRequest: async (requestId) => {
      requestedIds.push(requestId);
      const next = observations.length > 0 ? observations.shift() : last;
      if (next instanceof Error) throw next;
      last = next;
      return next;
    },
    ...overrides.options,
  });
  return { outcome, requestedIds, clock };
}

const pendingReadyWatch = await runWatch([
  watchedRequest("Pending"),
  watchedRequest("Pending", { snapshot: { timestamp: "1001" } }),
  watchedRequest("Ready", { snapshot: { timestamp: "1002" } }),
]);
equal("exact watch observes Pending to Ready", pendingReadyWatch.outcome.outcome, "ready");
equal("exact watch Ready attempt count", pendingReadyWatch.outcome.attempts, 3);
equal("exact watch Ready successful observation count", pendingReadyWatch.outcome.observations, 3);
deepEqual("exact watch never changes request id", pendingReadyWatch.requestedIds, [42n, 42n, 42n]);
equal("exact watch fake elapsed time", pendingReadyWatch.outcome.elapsedMs, 200);
check("exact watch never emits transactions", !Object.hasOwn(pendingReadyWatch.outcome, "txs"));

const deliveredWatch = await runWatch([watchedRequest("Delivered")]);
equal("exact watch classifies Delivered", deliveredWatch.outcome.outcome, "delivered");
equal("Delivered watch does not sleep", deliveredWatch.clock.value(), 0);
check("Delivered watch never emits transactions", !Object.hasOwn(deliveredWatch.outcome, "txs"));

const expiredWatch = await runWatch([watchedRequest("Expired")]);
equal("exact watch classifies Expired", expiredWatch.outcome.outcome, "expired");
const refundedWatch = await runWatch([watchedRequest("Refunded")]);
equal("exact watch classifies Refunded", refundedWatch.outcome.outcome, "refunded");
const noneWatch = await runWatch([{ status: "None" }]);
equal("exact watch classifies None", noneWatch.outcome.outcome, "none");

const timeoutClock = fakeWatchClock();
const timeoutWatch = await runWatch([watchedRequest("Pending")], {
  clock: timeoutClock,
  options: { timeoutMs: 250, pollIntervalMs: 100 },
});
equal("exact watch classifies bounded Pending timeout", timeoutWatch.outcome.outcome, "pending-timeout");
equal("exact watch timeout is monotonic and exact", timeoutWatch.outcome.elapsedMs, 250);
equal("exact watch timeout does not poll after deadline", timeoutWatch.outcome.attempts, 3);
equal("exact watch timeout retry delay", timeoutWatch.outcome.retryAfterMs, 100);
check("Pending timeout never emits transactions", !Object.hasOwn(timeoutWatch.outcome, "txs"));

const continuationExpiredWatch = await runWatch([
  watchedRequest("Pending", { snapshot: { timestamp: "2000" } }),
]);
equal("exact watch stops when continuation expires", continuationExpiredWatch.outcome.outcome, "continuation-expired");
equal("expired continuation preserves observed Pending state", continuationExpiredWatch.outcome.status, "Pending");
equal("expired continuation does not sleep", continuationExpiredWatch.clock.value(), 0);
const readyAfterExpiryWatch = await runWatch([
  watchedRequest("Ready", { snapshot: { timestamp: "2000" } }),
]);
equal("exact watch never plans Ready after continuation expiry", readyAfterExpiryWatch.outcome.outcome, "continuation-expired");

const transientOne = new RpcTransportError("all configured Base RPCs failed", { retryable: true });
const transientTwo = new RpcTransportError("the configured Base RPC failed", { retryable: true });
const recoveredTransportWatch = await runWatch([
  transientOne,
  transientTwo,
  watchedRequest("Pending"),
  watchedRequest("Ready", { snapshot: { timestamp: "1001" } }),
]);
equal("exact watch recovers tagged transport failures", recoveredTransportWatch.outcome.outcome, "ready");
equal("exact watch counts tagged transport failures", recoveredTransportWatch.outcome.transportErrors, 2);
equal("exact watch resets consecutive errors after a read", recoveredTransportWatch.outcome.consecutiveTransportErrors, 0);
equal("exact watch exponentially backs off transient transport failures", recoveredTransportWatch.clock.value(), 400);

await rejectsAsync("exact watch rejects exhausted transport errors", async () => {
  await runWatch([
    new RpcTransportError("transport one", { retryable: true }),
    new RpcTransportError("transport two", { retryable: true }),
    new RpcTransportError("transport three", { retryable: true }),
  ]);
}, "exhausted its transport error allowance");

await rejectsAsync("exact watch does not retry untagged errors", async () => {
  await runWatch([new Error("malformed request proof")]);
}, "malformed request proof");

await rejectsAsync("exact watch does not retry semantic RPC errors", async () => {
  await runWatch([new RpcError("RPC -32603: execution reverted", "0xdeadbeef", -32603)]);
}, "execution reverted");

await rejectsAsync("exact watch rejects a different observed request", async () => {
  await runWatch([watchedRequest("Ready", { requestId: "43" })]);
}, "different request id");

await rejectsAsync("exact watch rejects a different request buyer", async () => {
  await runWatch([watchedRequest("Ready", { buyer: otherWallet })]);
}, "buyer differs");

await rejectsAsync("exact watch rejects unknown request status", async () => {
  await runWatch([watchedRequest("Cancelled")]);
}, "unsupported request status");

check("only explicitly tagged transport exhaustion is retryable", isRetryableRpcTransportError(transientOne));
check("untagged errors are not retryable transport exhaustion", !isRetryableRpcTransportError(new Error("fetch failed")));
check("semantic RpcError is not retryable transport exhaustion", !isRetryableRpcTransportError(new RpcError("RPC error")));

// The CLI's randomness boundary is intentionally tested as source evidence,
// because the command is a process entrypoint rather than an importable module.
const plannerSource = readFileSync(new URL("./stonk-gacha.mjs", import.meta.url), "utf8");
const protocolSource = readFileSync(new URL("./lib/protocol.mjs", import.meta.url), "utf8");
check("planner uses Node CSPRNG", plannerSource.includes("randomBytes(32)"));
const normalOpenPlannerSource = plannerSource.slice(
  plannerSource.indexOf("async function planOpenPack()"),
  plannerSource.indexOf("async function planOpenPackFunding()"),
);
check("normal direct plan-open-pack has no undefined funding intent dependency", !normalOpenPlannerSource.includes("intent.stage") && !normalOpenPlannerSource.includes("resumePreflight"));
check("normal direct pack command executes silently", normalOpenPlannerSource.includes("silentDirect: true"));
check("normal direct pack command emits no explanatory report", !normalOpenPlannerSource.includes("const report =") && !normalOpenPlannerSource.includes("nominalRtpBps"));
check("normal direct pack requires exact user-named price", normalOpenPlannerSource.includes("const authorizedPriceUsdc = authorizedPackPriceArg()") && normalOpenPlannerSource.includes("priceUsdc === authorizedPriceUsdc"));
check("normal direct pack reads replay baseline", normalOpenPlannerSource.includes("SIG.requestCountOf") && normalOpenPlannerSource.includes("requestCount"));
check("normal direct pack preserves canonical intent across approval replan", normalOpenPlannerSource.includes("--direct-intent ${directIntentHex}") && normalOpenPlannerSource.includes("--direct-intent-key ${directIntentKeyValue}"));
check("normal direct pack does not resume from bare supplied randomness", !normalOpenPlannerSource.includes("--user-random"));
check("verified open continues silently to the exact request claim", normalOpenPlannerSource.includes("continuation: silentPullContinuation(wallet)"));
check("successful open advances to receipt-bound await instead of replay planning", plannerSource.includes("On success, inspect the receipt, persist its exact PackOpened request continuation, and immediately run its await command") && !plannerSource.includes("then rerun the emitted resume command"));
const claimPrizePlannerSource = plannerSource.slice(
  plannerSource.indexOf("async function planClaimPrize()"),
  plannerSource.indexOf("async function planExpireRequest()"),
);
check("standalone default claim is not silently authorized", claimPrizePlannerSource.includes('const silentDirect = suppliedContinuationHex !== undefined'));
check("silent claim requires both continuation fields", claimPrizePlannerSource.includes("--claim-continuation and --claim-continuation-key must be supplied together"));
check("continuation-bound claim rejects recipient and slippage overrides", claimPrizePlannerSource.includes("continuation-bound delivery cannot override recipient or slippage"));
check("silent claim re-proves exact source open receipt", claimPrizePlannerSource.includes("await proveDirectClaimSource(directContinuation)"));
check("silent claim omits explanatory report and warnings", claimPrizePlannerSource.includes("report: silentDirect") && claimPrizePlannerSource.includes("warnings: silentDirect ? []"));
check("direct pull continuation is built from proven PackOpened request", plannerSource.includes("requestId: opened.requestId") && plannerSource.includes("createDirectClaimContinuation"));
check("direct claim source proves Bankr execution and exact PackOpened request", plannerSource.includes("async function proveDirectClaimSource") && plannerSource.includes("bound PackOpened receipt request id differs from the claim continuation"));
check("direct claim source requires hidden preimage and receipt-anchored windows", plannerSource.includes("decodeDirectPullIntent(inspection.context.terms.directPullIntent)") && plannerSource.includes("bound open receipt mined outside its direct intent validity window") && plannerSource.includes("claim continuation window is not anchored exactly to the bound open receipt"));
check("claim inspector rechecks canonical continuation", plannerSource.includes("decodeDirectClaimContinuation(terms.directClaimContinuation)") && plannerSource.includes("direct claim continuation failed the fresh pre-signing gate"));
const awaitClaimPlannerSource = plannerSource.slice(
  plannerSource.indexOf("async function awaitClaimPrize()"),
  plannerSource.indexOf("async function planExpireRequest()"),
);
check("integrated await command is routed", plannerSource.includes('case "await-claim-prize": return await awaitClaimPrize()'));
check("integrated await command watches only the exact request", awaitClaimPlannerSource.includes("watchExactRequest({") && awaitClaimPlannerSource.includes("requestId,"));
check("integrated await command reuses receipt-bound claim authorization", awaitClaimPlannerSource.includes("await proveDirectClaimSource(continuation)") && awaitClaimPlannerSource.includes("return await planClaimPrize()"));
check("integrated await command never builds a claim while Pending", awaitClaimPlannerSource.includes('outcome.outcome === "ready"') && awaitClaimPlannerSource.includes('outcome.outcome === "pending-timeout"'));
check("integrated await command keeps Pending progress private", awaitClaimPlannerSource.includes('mode: "silent-continue"') && awaitClaimPlannerSource.includes("Do not post progress"));
check("integrated await command returns only the verified delivery sentence", plannerSource.includes('rule: "Reply with finalMessage verbatim and nothing else."'));
check("Delivered state alone cannot produce the final pull sentence", awaitClaimPlannerSource.includes('phase: "delivered-needs-receipt-proof"') && awaitClaimPlannerSource.includes("Do not post a result from request state alone") && !plannerSource.includes("deliveredPullResult"));
check("verified open emits exact await command and private resume record", plannerSource.includes("awaitCommand") && plannerSource.includes('action: "upsert-before-await"') && plannerSource.includes("directPullJournalPath"));
check("open receipt inspection exposes the exact await as top-level next", plannerSource.includes("next: postStateProof.awaitCommand") && plannerSource.includes("Persist runtimeJournal, then run next immediately"));
check("claim journal transition accepts watcher-ready prior state", plannerSource.includes('expectedPriorStages: ["awaiting-settlement", "ready"]'));
check("claim journal preserves opaque receipt-inspection proof before submit", plannerSource.includes("claimInspectionContextHex: inspection.hex") && plannerSource.includes("claimInspectionKey: planInspectionKey") && plannerSource.includes("mark-needs-reconciliation-preserve-claim-proof"));
check("successful delivery proof returns concise Gacha result fields", plannerSource.includes("payoutUsdcFormatted") && plannerSource.includes("recordedStockOutFormatted") && plannerSource.includes('finalTemplate: "You pulled $X of SYMBOL."'));
check("offer reads do not expose RTP telemetry", !protocolSource.includes("nominalRtpBps") && !protocolSource.includes("effectiveRtpBps(uint256)"));
check("successful deployment verification emits only a summary", plannerSource.includes("deploymentIntegrity: true") && plannerSource.includes("verifiedChecks: result.checks.length") && !plannerSource.includes("out({ ok: result.ok, command, wallet, ...result }"));
const fundedResumePlannerSource = plannerSource.slice(
  plannerSource.indexOf("async function resumeOpenPackFunding()"),
  plannerSource.indexOf("function bindXIntent()"),
);
check("funded resume defines its stage-specific preflight before use", fundedResumePlannerSource.indexOf("const resumePreflight") > 0 && fundedResumePlannerSource.indexOf("const resumePreflight") < fundedResumePlannerSource.indexOf("fundingBaselineRequestCount"));
check("funded calldata inspection binds expiry replay baseline headroom and approval to the signed intent", [
  "funded-open intent expiry",
  "funded-open request-count baseline",
  "funded-open native headroom",
  "funded-open approval token",
  "funded-open approval spender",
  "funded-open approval amount",
].every((label) => plannerSource.includes(label)));
check("planner never accepts a caller-supplied claim capability", !plannerSource.includes('"user-random"') && !plannerSource.includes("--user-random"));
check("calldata inspector rejects zero randomness", plannerSource.includes("user randomness cannot be zero"));
check("generated randomness loops until nonzero", /do value = .*randomBytes\(32\).*while \(\/\^0x0\{64\}\$\//s.test(plannerSource));
check("every open inspection requires exactly one authorization mode", plannerSource.includes("open-pack requires a bound funded or direct one-time intent") && plannerSource.includes("cannot combine funded and direct authorization modes"));
check("direct approval and open pre-sign gates recheck expiry and request baseline", plannerSource.includes("assessDirectPullIntent(directIntent") && plannerSource.includes("direct pull intent failed the fresh pre-signing gate"));
equal("every plan confirmation call binds wallet", plannerSource.match(/confirmationKey\(wallet, action, terms\)/g)?.length, 2);
check("open/fund zero reset rejects exact desired allowance", plannerSource.includes("requiresAllowanceReset(current, terms.approval.exactAmount)"));
check("revocation inspection binds fresh current allowance", plannerSource.includes("assertContextString(current, terms.approval.currentAmount, \"fresh revocation allowance\")"));
check("simulation sends pinned block to gas estimate", plannerSource.includes("estimateGas(tx.to, tx.data, wallet, BigInt(tx.value), block)"));
check("status command propagates nested integrity failure", plannerSource.includes("out({ ok: status.ok, command, status }, status.ok ? 0 : 1)"));
check("request list command threads deployment snapshot", plannerSource.includes("walletRequests(wallet, cursor, limit, snapshot)"));
check("single request command threads deployment snapshot", plannerSource.includes("readRequest(requestIdArg(), snapshot)"));
check("profit status command threads deployment snapshot", plannerSource.includes("profitStatus(wallet, snapshot)"));
check("receipt proof filters exact transfer counterparties", plannerSource.includes("sumCanonicalErc20Transfers(logs, token, \"from\", from, to)") && plannerSource.includes("sumCanonicalErc20Transfers(logs, token, \"to\", to, from)"));
for (const label of ["pack charge", "prize purchase budget", "refund", "reserve funding", "profit Treasury pull", "profit worker bounty", "profit staker funding"]) {
  check(`receipt transfer proof is wired: ${label}`, plannerSource.includes(`\"${label}\"`));
}
check("planner does not overclaim arbitrary prize-token Transfer proof", !plannerSource.includes("recipient token delta equals recorded stockOut"));
const sampledRandom = `0x${randomBytes(32).toString("hex")}`;
check("test runtime produces a 32-byte CSPRNG sample", /^0x[0-9a-f]{64}$/.test(sampledRandom));
check("zero is outside valid buyer-random domain", !/^0x0{64}$/.test(userRandom) && /^0x0{64}$/.test(`0x${"0".repeat(64)}`));

// Funding is a structured Bankr-native layer around the protocol planner. It
// never adds a swap target to the raw-call allowlist and every economic bound
// is carried in a canonical, wallet-specific intent.
const fundingFixture = FUNDING_FIXTURES.baseWethWithNativeTopUp;
const fundingCreatedAt = 1_788_345_000n;
const fundingExpiresAt = fundingCreatedAt + 600n;
const fundingClaimCapabilitySecret = `0x${"27".repeat(32)}`;
const baseWethFundingParams = {
  wallet,
  packIndex: fundingFixture.packIndex,
  packPriceUsdc: BigInt(fundingFixture.packPriceUsdcRaw),
  usdcBalance: BigInt(fundingFixture.baseUsdcRaw),
  ethBalance: BigInt(fundingFixture.baseEthWei),
  wethBalance: BigInt(fundingFixture.baseWethWei),
  allowance: 0n,
  requestCount: 7n,
  spender: ADDR.gacha,
  expectedOfferHash: sampleHash,
  acceptedCeilingBps: 40_000n,
  entropyFeeWei: BigInt(fundingFixture.entropyFeeWei),
  nativeHeadroomWei: BigInt(fundingFixture.nativeHeadroomWei),
  sourceToken: "WETH",
  sourceAmountRaw: parseUnits(fundingFixture.usdcQuote.from.amount, 18),
  minUsdcOutRaw: parseUnits(fundingFixture.usdcQuote.minBuyAmount, 6),
  quotedUsdcOutRaw: BigInt(fundingFixture.usdcQuote.to.amount),
  swapSlippageBps: fundingFixture.usdcQuote.slippageBps,
  quoteId: fundingFixture.usdcQuote.quoteId,
  swapIdempotencyKey: fundingFixture.swapIdempotencyKey,
  nativeSourceAmountRaw: parseUnits(fundingFixture.nativeQuote.from.amount, 18),
  minNativeOutWei: parseUnits(fundingFixture.nativeQuote.minBuyAmount, 18),
  quotedNativeOutWei: BigInt(fundingFixture.nativeQuote.to.amount),
  nativeSwapSlippageBps: fundingFixture.nativeQuote.slippageBps,
  nativeQuoteId: fundingFixture.nativeQuote.quoteId,
  nativeSwapIdempotencyKey: fundingFixture.nativeSwapIdempotencyKey,
  claimCapabilitySecret: fundingClaimCapabilitySecret,
  createdAt: fundingCreatedAt,
  expiresAt: fundingExpiresAt,
};
const makeWethFundingIntent = (overrides = {}) => createFundingIntent({ ...baseWethFundingParams, ...overrides });
const wethFundingIntent = makeWethFundingIntent();

equal("funding policy chain", FUNDING_POLICY.network.chainId, 8453);
equal("funding policy canonical USDC", normalizeAddress(FUNDING_POLICY.canonicalAssets.usdc.address), ADDR.usdc);
equal("funding policy canonical WETH", normalizeAddress(FUNDING_POLICY.canonicalAssets.weth.address), ADDR.weth);
equal("funding policy native sentinel", NATIVE_SENTINEL, "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
equal("funding policy native headroom", DEFAULT_NATIVE_HEADROOM_WEI, 1_500_000_000_000_000n);
check("funding policy forbids automatic source", !FUNDING_POLICY.combinedOpen.allowAutomaticSourceSelection);
check("an explicitly named Base funding source is not asked twice", plannerSource.includes('sourceSelectionRequired: "only-if-current-command-did-not-explicitly-name-base-eth-or-base-weth"') && plannerSource.includes("use only that source without asking again"));
check("funding policy forbids automatic pack downgrade", !FUNDING_POLICY.combinedOpen.allowAutomaticPackDowngrade);
check("funding policy forbids swap calldata and vague prompts", !FUNDING_POLICY.combinedOpen.allowSwapCalldata && !FUNDING_POLICY.combinedOpen.allowNaturalLanguageSwapPrompt);
check("cross-chain never counts as Base balance", !FUNDING_POLICY.crossChain.countsAsBaseBalance && FUNDING_POLICY.crossChain.requiresSeparateConfirmation);
equal("cross-chain confirmation fails closed without visible cost", FUNDING_POLICY.crossChain.missingNetworkOrBridgeCost, "fail-closed-without-confirmation");

const sourceOptions = fundingSourceOptions({
  usdcBalance: 2_000_000n,
  packPriceUsdc: 10_000_000n,
  ethBalance: 0n,
  wethBalance: 1_000_000_000_000_000_000n,
  entropyFeeWei: 100_000_000_000_000n,
});
equal("funding source exact deficit", sourceOptions.exactDeficitUsdcRaw, "8000000");
deepEqual("funding source asks both explicit choices", sourceOptions.choices.map((entry) => entry.sourceToken), ["ETH", "WETH"]);
check("zero native ETH makes ETH ineligible", !sourceOptions.choices[0].eligible);
check("WETH remains separate from native msg.value", sourceOptions.choices[1].eligible && sourceOptions.choices[1].nativeTopUpRequired);
equal("WETH native top-up covers fee plus headroom", sourceOptions.choices[1].minimumNativeTopUpWei, "1600000000000000");

equal("WETH funding intent kind", wethFundingIntent.kind, "stonk-gacha-funded-open/v2");
equal("WETH funding exact deficit", wethFundingIntent.preflight.exactDeficitUsdcRaw, "8000000");
equal("funding intent retains its hidden claim capability", wethFundingIntent.pack.claimCapabilitySecret, fundingClaimCapabilitySecret);
equal("funding intent derives its Pyth contribution from the claim capability", wethFundingIntent.pack.userRandomNumber, directUserRandomNumber(fundingClaimCapabilitySecret));
check("funding claim capability and committed Pyth contribution are distinct", wethFundingIntent.pack.userRandomNumber !== fundingClaimCapabilitySecret);
deepEqual("funding intent pins default same-wallet delivery", wethFundingIntent.deliveryPolicy, { recipient: wallet, slippageBps: DIRECT_CLAIM_SLIPPAGE_BPS });
deepEqual("funding intent authorizes only bounded open and same-request delivery actions", wethFundingIntent.allowedActions, [
  "conditional-allowance-reset",
  "exact-usdc-approval",
  "open-pack",
  "same-request-claim-prize",
]);
deepEqual("WETH zero-native flow has ordered two legs", wethFundingIntent.fundingLegs.map((entry) => entry.purpose), ["native-top-up", "usdc-deficit"]);
equal("WETH aggregate maximum includes both legs", wethFundingIntent.source.aggregateMaximumInputRaw, "6000000000000000");
equal("USDC leg targets canonical Base USDC", wethFundingIntent.fundingLegs[1].toToken, ADDR.usdc);
equal("native leg targets Bankr native sentinel", wethFundingIntent.fundingLegs[0].toToken, NATIVE_SENTINEL);
equal("Bankr funding uses structured swap endpoint", wethFundingIntent.fundingLegs[1].bankr.path, "/wallet/swap");
equal("Bankr funding binds exact source amount", wethFundingIntent.fundingLegs[1].bankr.body.amount, fundingFixture.usdcQuote.from.amount);
equal("Bankr funding binds USDC floor", wethFundingIntent.fundingLegs[1].bankr.body.minBuyAmount, fundingFixture.usdcQuote.minBuyAmount);
equal("Bankr funding persists swap idempotency", wethFundingIntent.fundingLegs[1].bankr.body.idempotencyKey, fundingFixture.swapIdempotencyKey);
check("funding intent contains no route or calldata", !/(calldata|route)/i.test(JSON.stringify(wethFundingIntent)));

const encodedWethIntent = encodeFundingIntent(wethFundingIntent);
deepEqual("funding intent canonical hex round trip", decodeFundingIntent(encodedWethIntent), wethFundingIntent);
equal("funding intent key survives round trip", fundingIntentKey(decodeFundingIntent(encodedWethIntent)), fundingIntentKey(wethFundingIntent));
rejects("funding intent rejects a zero claim capability", () => makeWethFundingIntent({ claimCapabilitySecret: `0x${"0".repeat(64)}` }), "cannot be zero");
const changedFundingCapability = structuredClone(wethFundingIntent);
changedFundingCapability.pack.claimCapabilitySecret = `0x${"28".repeat(32)}`;
rejects("funding intent rejects a capability not committed by its Pyth contribution", () => fundingIntentKey(changedFundingCapability), "not committed");
const changedFundingRandomness = structuredClone(wethFundingIntent);
changedFundingRandomness.pack.userRandomNumber = directUserRandomNumber(`0x${"28".repeat(32)}`);
rejects("funding intent rejects randomness derived from another capability", () => fundingIntentKey(changedFundingRandomness), "not committed");
const redirectedFundingDelivery = structuredClone(wethFundingIntent);
redirectedFundingDelivery.deliveryPolicy.recipient = otherWallet;
rejects("funding intent rejects redirected prize delivery", () => fundingIntentKey(redirectedFundingDelivery), "active wallet");
const relaxedFundingDelivery = structuredClone(wethFundingIntent);
relaxedFundingDelivery.deliveryPolicy.slippageBps = DIRECT_CLAIM_SLIPPAGE_BPS + 1;
rejects("funding intent rejects changed prize slippage", () => fundingIntentKey(relaxedFundingDelivery), "differs from policy");
const widenedFundingActions = structuredClone(wethFundingIntent);
widenedFundingActions.allowedActions.push("other-request-claim-prize");
rejects("funding intent rejects widened prize authority", () => fundingIntentKey(widenedFundingActions), "unsupported action set");
rejects("funding floor below exact deficit", () => makeWethFundingIntent({ minUsdcOutRaw: 7_999_999n }), "must equal the exact required deficit");
rejects("funding floor above exact deficit", () => makeWethFundingIntent({ minUsdcOutRaw: 8_000_001n }), "must equal the exact required deficit");
rejects("oversized USDC quote is rejected", () => makeWethFundingIntent({ quotedUsdcOutRaw: 8_247_424n }), "quote is oversized");
rejects("funding intent rejects unsafe native headroom", () => makeWethFundingIntent({ nativeHeadroomWei: DEFAULT_NATIVE_HEADROOM_WEI - 1n }), "outside policy bounds");
rejects("WETH zero-native flow cannot omit native leg", () => makeWethFundingIntent({ nativeSourceAmountRaw: null, minNativeOutWei: null, quotedNativeOutWei: null, nativeSwapSlippageBps: null, nativeSwapIdempotencyKey: null, nativeQuoteId: null }), "requires a native top-up leg");
rejects("native top-up floor must equal the exact shortfall", () => makeWethFundingIntent({ minNativeOutWei: 1_600_000_000_000_001n }), "must equal the exact required deficit or shortfall");
rejects("oversized native top-up quote is rejected", () => makeWethFundingIntent({ quotedNativeOutWei: 1_700_000_000_000_000n }), "quote is oversized");
rejects("WETH aggregate spend cannot exceed balance", () => makeWethFundingIntent({ wethBalance: 5_999_999_999_999_999n }), "exceed the pinned Base WETH balance");
rejects("funding swap legs require different idempotency keys", () => makeWethFundingIntent({ nativeSwapIdempotencyKey: fundingFixture.swapIdempotencyKey }), "distinct idempotency keys");
const crossChainTamper = JSON.parse(JSON.stringify(wethFundingIntent));
crossChainTamper.fundingLegs[1].fromChain = "mainnet";
crossChainTamper.fundingLegs[1].bankr.body.fromChain = "mainnet";
rejects("combined funding rejects other-chain source", () => fundingIntentKey(crossChainTamper), "must stay on Base");
const routeTamper = JSON.parse(JSON.stringify(wethFundingIntent));
routeTamper.fundingLegs[1].route = "untrusted-route";
rejects("funding intent rejects injected route field", () => fundingIntentKey(routeTamper), "unsupported field route");
const calldataTamper = JSON.parse(JSON.stringify(wethFundingIntent));
calldataTamper.fundingLegs[1].bankr.body.calldata = "0xdeadbeef";
rejects("funding intent rejects injected swap calldata", () => fundingIntentKey(calldataTamper), "unsupported field calldata");

const baseEthFundingParams = {
  ...baseWethFundingParams,
  ethBalance: 1_000_000_000_000_000_000n,
  sourceToken: "ETH",
  sourceAmountRaw: 4_000_000_000_000_000n,
  nativeSourceAmountRaw: null,
  minNativeOutWei: null,
  quotedNativeOutWei: null,
  nativeSwapSlippageBps: null,
  nativeQuoteId: null,
  nativeSwapIdempotencyKey: null,
};
const makeEthFundingIntent = (overrides = {}) => createFundingIntent({ ...baseEthFundingParams, ...overrides });
const ethFundingIntent = makeEthFundingIntent();
equal("ETH funding intent has one leg", ethFundingIntent.fundingLegs.length, 1);
equal("ETH funding leg uses native sentinel", ethFundingIntent.fundingLegs[0].fromToken, NATIVE_SENTINEL);
rejects("ETH source cannot spend fee cap or headroom", () => makeEthFundingIntent({ sourceAmountRaw: 999_000_000_000_000_000n }), "would spend the Entropy fee cap or native headroom");
rejects("ETH source cannot smuggle a WETH top-up", () => makeEthFundingIntent({ nativeSourceAmountRaw: 1n, minNativeOutWei: 1n, quotedNativeOutWei: 1n, nativeSwapSlippageBps: 300, nativeSwapIdempotencyKey: fundingFixture.nativeSwapIdempotencyKey }), "cannot include a WETH native-top-up leg");

const baseEthKey = fundingIntentKey(ethFundingIntent);
check("intent key changes with wallet", fundingIntentKey(makeEthFundingIntent({ wallet: otherWallet })) !== baseEthKey);
check("intent key changes with source maximum", fundingIntentKey(makeEthFundingIntent({ sourceAmountRaw: 4_100_000_000_000_000n })) !== baseEthKey);
check("intent key changes with exact minimum USDC output", fundingIntentKey(makeEthFundingIntent({
  usdcBalance: 1_900_000n,
  minUsdcOutRaw: 8_100_000n,
  quotedUsdcOutRaw: 8_200_000n,
})) !== baseEthKey);
check("intent key changes with offer hash", fundingIntentKey(makeEthFundingIntent({ expectedOfferHash: keccak256("other-funding-offer") })) !== baseEthKey);
check("intent key changes with ceiling", fundingIntentKey(makeEthFundingIntent({ acceptedCeilingBps: 50_000n })) !== baseEthKey);
check("intent key changes with fee cap", fundingIntentKey(makeEthFundingIntent({ entropyFeeWei: 100_000_000_000_001n })) !== baseEthKey);
check("intent key changes with expiry", fundingIntentKey(makeEthFundingIntent({ expiresAt: fundingExpiresAt + 1n })) !== baseEthKey);
check("intent key changes with claim capability", fundingIntentKey(makeEthFundingIntent({ claimCapabilitySecret: `0x${"28".repeat(32)}` })) !== baseEthKey);
check("intent key changes with pack", fundingIntentKey(makeEthFundingIntent({
  packIndex: 2,
  packPriceUsdc: 20_000_000n,
  minUsdcOutRaw: 18_000_000n,
  quotedUsdcOutRaw: 18_100_000n,
})) !== baseEthKey);

const liveFundingState = {
  wallet,
  packIndex: ethFundingIntent.pack.packIndex,
  timestamp: fundingCreatedAt + 100n,
  salesPaused: false,
  packPriceUsdc: BigInt(ethFundingIntent.pack.priceUsdcRaw),
  offerHash: ethFundingIntent.pack.expectedOfferHash,
  computedOfferHash: ethFundingIntent.pack.expectedOfferHash,
  ceilingBps: BigInt(ethFundingIntent.pack.acceptedCeilingBps),
  entropyFeeWei: BigInt(ethFundingIntent.pack.entropyFeeCapWei),
  usdcBalance: BigInt(ethFundingIntent.pack.priceUsdcRaw),
  ethBalance: BigInt(ethFundingIntent.pack.entropyFeeCapWei) + BigInt(ethFundingIntent.preflight.nativeHeadroomWei),
  walletRequestCount: BigInt(ethFundingIntent.preflight.walletRequestCount),
};
check("unchanged post-swap state can resume", fundingResumeAssessment(ethFundingIntent, liveFundingState).ok);
const changedOfferAssessment = fundingResumeAssessment(ethFundingIntent, { ...liveFundingState, offerHash: keccak256("changed-after-swap") });
check("changed offer requires self-contained reconfirmation", !changedOfferAssessment.ok && changedOfferAssessment.reconfirmationRequired);
const changedCeilingAssessment = fundingResumeAssessment(ethFundingIntent, { ...liveFundingState, ceilingBps: BigInt(ethFundingIntent.pack.acceptedCeilingBps) + 1n });
check("changed ceiling requires reconfirmation", changedCeilingAssessment.reconfirmationRequired);
const feeCapAssessment = fundingResumeAssessment(ethFundingIntent, { ...liveFundingState, entropyFeeWei: BigInt(ethFundingIntent.pack.entropyFeeCapWei) + 1n, ethBalance: 1_000_000_000_000_000_000n });
check("fee above cap requires reconfirmation", feeCapAssessment.reconfirmationRequired);
const stillShortAssessment = fundingResumeAssessment(ethFundingIntent, { ...liveFundingState, usdcBalance: 9_999_999n });
check("still-short USDC stops without silently changing terms", !stillShortAssessment.ok && !stillShortAssessment.reconfirmationRequired);
const depletedHeadroomAssessment = fundingResumeAssessment(ethFundingIntent, { ...liveFundingState, ethBalance: BigInt(ethFundingIntent.pack.entropyFeeCapWei) });
check("post-swap resume preserves native fee headroom", !depletedHeadroomAssessment.ok && !depletedHeadroomAssessment.reconfirmationRequired);
const changedRequestCountAssessment = fundingResumeAssessment(ethFundingIntent, { ...liveFundingState, walletRequestCount: BigInt(ethFundingIntent.preflight.walletRequestCount) + 1n });
check("changed request count prevents funded-open replay", !changedRequestCountAssessment.ok && changedRequestCountAssessment.reconfirmationRequired);
const remainingOfferHash = keccak256("remaining-open-offer");
const remainingOpenIntent = rebaseFundingIntentForRemainingOpen(ethFundingIntent, {
  packPriceUsdc: BigInt(ethFundingIntent.pack.priceUsdcRaw),
  expectedOfferHash: remainingOfferHash,
  acceptedCeilingBps: BigInt(ethFundingIntent.pack.acceptedCeilingBps) + 1n,
  entropyFeeWei: BigInt(ethFundingIntent.pack.entropyFeeCapWei) + 1n,
  usdcBalance: BigInt(ethFundingIntent.pack.priceUsdcRaw),
  ethBalance: BigInt(ethFundingIntent.pack.entropyFeeCapWei) + 1n + BigInt(ethFundingIntent.preflight.nativeHeadroomWei),
  allowance: 0n,
  requestCount: BigInt(ethFundingIntent.preflight.walletRequestCount),
  createdAt: fundingCreatedAt + 101n,
  expiresAt: fundingCreatedAt + 701n,
});
equal("remaining-open reconfirmation has an explicit stage", remainingOpenIntent.stage, "remaining-open");
equal("remaining-open preserves the hidden claim capability", remainingOpenIntent.pack.claimCapabilitySecret, ethFundingIntent.pack.claimCapabilitySecret);
equal("remaining-open preserves the committed Pyth contribution", remainingOpenIntent.pack.userRandomNumber, ethFundingIntent.pack.userRandomNumber);
deepEqual("remaining-open preserves same-wallet delivery", remainingOpenIntent.deliveryPolicy, ethFundingIntent.deliveryPolicy);
check("remaining-open preserves exact same-request claim authority", remainingOpenIntent.allowedActions.includes("same-request-claim-prize"));
check("remaining-open reconfirmation gets a new economic key", fundingIntentKey(remainingOpenIntent) !== baseEthKey);
check("remaining-open intent carries no executable funding authority", !Object.hasOwn(remainingOpenIntent, "fundingLegs") && !Object.hasOwn(remainingOpenIntent, "source") && !Object.hasOwn(remainingOpenIntent, "minimumBaseUsdcOutputRaw") && !/(\/wallet\/swap|idempotencyKey|"bankr":)/i.test(JSON.stringify(remainingOpenIntent)));
check("remaining-open X confirmation authorizes claim but no swap replay", xPreparedConfirmation(remainingOpenIntent).includes("do=approve+open+claim") && !xPreparedConfirmation(remainingOpenIntent).includes("do=swap+approve+open+claim"));
deepEqual("remaining-open intent canonical hex round trip", decodeFundingIntent(encodeFundingIntent(remainingOpenIntent)), remainingOpenIntent);
check("fresh remaining-open terms can resume after reconfirmation", fundingResumeAssessment(remainingOpenIntent, {
  ...liveFundingState,
  timestamp: fundingCreatedAt + 102n,
  offerHash: remainingOfferHash,
  computedOfferHash: remainingOfferHash,
  ceilingBps: BigInt(remainingOpenIntent.pack.acceptedCeilingBps),
  entropyFeeWei: BigInt(remainingOpenIntent.pack.entropyFeeCapWei),
  ethBalance: BigInt(remainingOpenIntent.remainingPreflight.baseEthWei),
  walletRequestCount: BigInt(remainingOpenIntent.remainingPreflight.walletRequestCount),
}).ok);
rejects("remaining-open reconfirmation cannot cross request replay evidence", () => rebaseFundingIntentForRemainingOpen(ethFundingIntent, {
  packPriceUsdc: BigInt(ethFundingIntent.pack.priceUsdcRaw),
  expectedOfferHash: remainingOfferHash,
  acceptedCeilingBps: BigInt(ethFundingIntent.pack.acceptedCeilingBps),
  entropyFeeWei: BigInt(ethFundingIntent.pack.entropyFeeCapWei),
  usdcBalance: BigInt(ethFundingIntent.pack.priceUsdcRaw),
  ethBalance: BigInt(ethFundingIntent.pack.entropyFeeCapWei) + BigInt(ethFundingIntent.preflight.nativeHeadroomWei),
  allowance: 0n,
  requestCount: BigInt(ethFundingIntent.preflight.walletRequestCount) + 1n,
  createdAt: fundingCreatedAt + 101n,
  expiresAt: fundingCreatedAt + 701n,
}), "cannot cross a changed wallet request count");

const xFixture = FUNDING_FIXTURES.xDirectReply;
const xPending = bindXFundingIntent(wethFundingIntent, {
  confirmationTweetId: xFixture.confirmationTweetId,
  requesterXUserId: xFixture.requesterXUserId,
  confirmationChannel: "x",
  confirmationText: xPreparedConfirmation(wethFundingIntent),
});
const remainingXPending = bindXFundingIntent(remainingOpenIntent, {
  confirmationTweetId: "1777777777777777777",
  requesterXUserId: xFixture.requesterXUserId,
  confirmationChannel: "x",
  confirmationText: xPreparedConfirmation(remainingOpenIntent),
});
check("remaining-open X pending record carries no swap source bounds", remainingXPending.sourceToken === null && remainingXPending.maximumSourceInputRaw === null && remainingXPending.minimumBaseUsdcOutputRaw === null && !/(\/wallet\/swap|idempotencyKey|"bankr":)/i.test(JSON.stringify(remainingXPending.economicIntent)));
rejects("X binding rejects a non-X confirmation channel", () => bindXFundingIntent(wethFundingIntent, {
  confirmationTweetId: xFixture.confirmationTweetId,
  requesterXUserId: xFixture.requesterXUserId,
  confirmationChannel: "chat",
  confirmationText: xPreparedConfirmation(wethFundingIntent),
}), "trusted X post metadata");
rejects("X binding rejects altered posted confirmation text", () => bindXFundingIntent(wethFundingIntent, {
  confirmationTweetId: xFixture.confirmationTweetId,
  requesterXUserId: xFixture.requesterXUserId,
  confirmationChannel: "x",
  confirmationText: `${xPreparedConfirmation(wethFundingIntent)} altered`,
}), "differs from the exact prepared");
const xApprovalArgs = {
  mode: "reply",
  message: xFixture.message,
  approvalTweetId: xFixture.approvalTweetId,
  parentTweetId: xFixture.confirmationTweetId,
  referenceType: "replied_to",
  authorXUserId: xFixture.requesterXUserId,
  linkedWallet: wallet,
  now: fundingCreatedAt + 100n,
};
check("prepared X confirmation fits one tweet", xPreparedConfirmation(wethFundingIntent).length <= 280);
check("self-contained X fallback fits one tweet", xSelfContainedCommand(wethFundingIntent).length <= 280);
check("X confirmation encodes funding through same-request claim and compact units", ["do=swap+approve+open+claim", "s=B/W", "m=0.006W", "u=8U", "f=0.0001E"].every((term) => xPreparedConfirmation(wethFundingIntent).includes(term)));
check("X confirmation and fallback never expose the claim capability", !xPreparedConfirmation(wethFundingIntent).includes(fundingClaimCapabilitySecret.slice(2)) && !xSelfContainedCommand(wethFundingIntent).includes(fundingClaimCapabilitySecret.slice(2)));
const longDecimalFundingIntent = makeWethFundingIntent({
  usdcBalance: 2_000_001n,
  ethBalance: 123n,
  acceptedCeilingBps: 100_000n,
  entropyFeeWei: 10_000_000_000_000n,
  sourceAmountRaw: 4_123_456_789_012_345n,
  minUsdcOutRaw: 7_999_999n,
  quotedUsdcOutRaw: 7_999_999n,
  nativeSourceAmountRaw: 512_345_678_901_234n,
  minNativeOutWei: 1_509_999_999_999_877n,
  quotedNativeOutWei: 1_509_999_999_999_877n,
});
check("adversarial full-precision X confirmation falls back under 280 characters", xPreparedConfirmation(longDecimalFundingIntent).length <= 280 && xPreparedConfirmation(longDecimalFundingIntent).includes("m64=") && xPreparedConfirmation(longDecimalFundingIntent).includes("n64="));
check("worst-case exact-decimal self-contained X command stays under 280 characters", xSelfContainedCommand(longDecimalFundingIntent).length <= 280 && xSelfContainedCommand(longDecimalFundingIntent).includes("u64=") && xSelfContainedCommand(longDecimalFundingIntent).includes("f64="));
check("compact raw amount fields carry units in their labels without redundant suffixes", / m64=[A-Za-z0-9_-]+ u64=[A-Za-z0-9_-]+ n64=[A-Za-z0-9_-]+>[A-Za-z0-9_-]+ .* f64=[A-Za-z0-9_-]+ /.test(xPreparedConfirmation(longDecimalFundingIntent)));
const compactIntentKey = xSelfContainedCommand(wethFundingIntent).match(/\bi64=([A-Za-z0-9_-]+)/)?.[1];
equal("X self-contained command carries the full intent key", `0x${Buffer.from(compactIntentKey, "base64url").toString("hex")}`, fundingIntentKey(wethFundingIntent));
equal("X pending binds confirmation tweet", xPending.confirmationTweetId, xFixture.confirmationTweetId);
equal("X pending binds numeric user id", xPending.requesterXUserId, xFixture.requesterXUserId);
equal("X pending binds linked wallet", xPending.wallet, wallet);
equal("X pending begins unconsumed", xPending.consumed, false);
check("X pending key is bytes32", /^0x[0-9a-f]{64}$/.test(xPendingIntentKey(xPending)));
check("direct bound YES validates", verifyXFundingApproval(xPending, xApprovalArgs).ok);
rejects("standalone bare YES authorizes nothing", () => verifyXFundingApproval(xPending, { ...xApprovalArgs, parentTweetId: null }), "directly reply");
rejects("wrong parent tweet rejects YES", () => verifyXFundingApproval(xPending, { ...xApprovalArgs, parentTweetId: "1666666666666666666" }), "directly reply");
rejects("quote-tweet reference cannot authorize bare YES", () => verifyXFundingApproval(xPending, { ...xApprovalArgs, referenceType: "quoted" }), "trusted replied_to");
rejects("repost reference cannot authorize bare YES", () => verifyXFundingApproval(xPending, { ...xApprovalArgs, referenceType: "retweeted" }), "trusted replied_to");
rejects("confirmation tweet cannot approve itself", () => verifyXFundingApproval(xPending, { ...xApprovalArgs, approvalTweetId: xFixture.confirmationTweetId }), "must differ");
rejects("wrong numeric X identity rejects YES", () => verifyXFundingApproval(xPending, { ...xApprovalArgs, authorXUserId: "1555555555555555555" }), "numeric X author id");
rejects("changed linked wallet rejects YES", () => verifyXFundingApproval(xPending, { ...xApprovalArgs, linkedWallet: otherWallet }), "linked wallet");
rejects("expired X intent rejects YES", () => verifyXFundingApproval(xPending, { ...xApprovalArgs, now: fundingExpiresAt }), "expired");
const consumedXPending = { ...xPending, consumed: true };
rejects("consumed X intent rejects replay", () => verifyXFundingApproval(consumedXPending, xApprovalArgs), "already consumed");
check("exact self-contained X fallback validates", verifyXFundingApproval(xPending, {
  ...xApprovalArgs,
  mode: "self-contained",
  message: xPending.selfContainedCommand,
  parentTweetId: null,
}).ok);
rejects("short standalone command is not self-contained", () => verifyXFundingApproval(xPending, {
  ...xApprovalArgs,
  mode: "self-contained",
  message: "@bankrbot yes",
  parentTweetId: null,
}), "exact self-contained");
check("fixture covers required adversarial X and funding cases", [
  "standalone-bare-yes", "wrong-direct-parent", "same-handle-different-numeric-user-id",
  "linked-wallet-changed", "expired-intent", "already-consumed-intent",
  "different-chain-source-in-combined-flow", "duplicate-swap-idempotency-key",
  "offer-hash-changed-after-swap",
].every((entry) => FUNDING_FIXTURES.negativeCases.includes(entry)));

// Synthetic direct and EntryPoint v0.7 / Kernel envelopes.
const logicalTarget = ADDR.gacha;
const directEnvelope = decodeBankrExecution({
  from: wallet,
  to: logicalTarget,
  input: openPack,
  value: "0x2710",
}, wallet);
equal("direct execution mode", directEnvelope.mode, "direct-wallet-transaction");
equal("direct logical sender", directEnvelope.logicalSender, wallet);
equal("direct logical target", directEnvelope.logicalCall.target, logicalTarget);
equal("direct logical value", directEnvelope.logicalCall.value, 10_000n);
equal("direct logical calldata", directEnvelope.logicalCall.data, openPack);
const directAttributedEnvelope = decodeBankrExecution({
  from: wallet,
  to: logicalTarget,
  input: schema0,
  value: "0x0",
}, wallet);
equal("direct attribution strips to logical calldata", directAttributedEnvelope.logicalCall.data, openPack);
equal("direct attribution schema", directAttributedEnvelope.attribution.schemaId, 0);
equal("direct attribution builder code", directAttributedEnvelope.attribution.codes[0], "bc_stonkg");
rejects("reject direct type-4 side effect", () => decodeBankrExecution({
  from: wallet, to: logicalTarget, input: openPack, value: "0x0", type: "0x4", authorizationList: [syntheticAuthorization(KERNEL_IMPLEMENTATION)],
}, wallet), "must not carry EIP-7702 authorizations");
rejects("reject direct wallet self-call", () => decodeBankrExecution({ from: wallet, to: wallet, input: openPack, value: "0x0" }, wallet), "must not target the active wallet itself");
rejects("reject direct wrong sender", () => decodeBankrExecution({ from: relayer, to: logicalTarget, input: openPack, value: "0x0" }, wallet), "sender does not match");
rejects("reject direct contract creation", () => decodeBankrExecution({ from: wallet, to: null, input: openPack, value: "0x0" }, wallet), "cannot be a contract creation");

const v07Nonce = 17n;
const kernelCall = kernelExecute(logicalTarget, 10_000n, openPack);
const v07HandleOps = handleOps(wallet, v07Nonce, kernelCall);
const sponsoredEnvelope = decodeBankrExecution({ from: relayer, to: ENTRY_POINT_V07, input: v07HandleOps, value: "0x0" }, wallet);
equal("sponsored execution mode", sponsoredEnvelope.mode, "bankr-entrypoint-kernel-single");
equal("sponsored logical sender", sponsoredEnvelope.logicalSender, wallet);
equal("sponsored logical target", sponsoredEnvelope.logicalCall.target, logicalTarget);
equal("sponsored inner native value", sponsoredEnvelope.logicalCall.value, 10_000n);
equal("sponsored inner calldata", sponsoredEnvelope.logicalCall.data, openPack);
equal("sponsored native validation mode", sponsoredEnvelope.validation.mode, 0);
equal("sponsored native validation type", sponsoredEnvelope.validation.type, 0);
equal("sponsored empty initCode", sponsoredEnvelope.userOperation.initCode, "0x");
equal("sponsored empty paymaster", sponsoredEnvelope.userOperation.paymasterAndData, "0x");
equal("userOp hash call selector", userOperationHashCall(sponsoredEnvelope).slice(0, 10), selector("getUserOpHash((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes))"));
rejects("direct envelope has no userOp hash", () => userOperationHashCall(directEnvelope), "no user-operation hash call");

const attributedKernelCall = `${kernelCall}62635f69383571686767320b0080218021802180218021802180218021`;
const attributedEnvelope = decodeBankrExecution({
  from: relayer,
  to: ENTRY_POINT_V07,
  input: handleOps(wallet, v07Nonce, attributedKernelCall),
  value: "0x0",
}, wallet);
equal("sponsored attribution builder code", attributedEnvelope.attribution.codes[0], "bc_i85qhgg2");
equal("sponsored attributed logical calldata", attributedEnvelope.logicalCall.data, openPack);

rejects("reject sponsored outer value", () => decodeBankrExecution({ from: relayer, to: ENTRY_POINT_V07, input: v07HandleOps, value: "0x1" }, wallet), "outer transaction must carry zero native value");
rejects("reject sponsored unknown active wallet", () => decodeBankrExecution({ from: relayer, to: ENTRY_POINT_V07, input: v07HandleOps, value: "0x0" }, relayer), "exactly one user operation");
rejects("reject multiple active-wallet userOps", () => decodeBankrExecution({ from: relayer, to: ENTRY_POINT_V07, input: handleOpsMany([
  userOperationTuple(wallet, v07Nonce, kernelCall), userOperationTuple(wallet, v07Nonce + 1n, kernelCall),
]), value: "0x0" }, wallet), "exactly one user operation");
rejects("reject separate-account initCode", () => decodeBankrExecution({ from: relayer, to: ENTRY_POINT_V07, input: handleOps(wallet, v07Nonce, kernelCall, { initCode: "0x1234" }), value: "0x0" }, wallet), "must not deploy a separate account");
rejects("reject sponsored paymaster", () => decodeBankrExecution({ from: relayer, to: ENTRY_POINT_V07, input: handleOps(wallet, v07Nonce, kernelCall, { paymaster: "0x1234" }), value: "0x0" }, wallet), "must not use a paymaster");
rejects("reject non-native validation mode", () => decodeBankrExecution({ from: relayer, to: ENTRY_POINT_V07, input: handleOps(wallet, 1n << 248n, kernelCall), value: "0x0" }, wallet), "validation mode/type 0x00/0x00");
rejects("reject non-native validation type", () => decodeBankrExecution({ from: relayer, to: ENTRY_POINT_V07, input: handleOps(wallet, 1n << 240n, kernelCall), value: "0x0" }, wallet), "validation mode/type 0x00/0x00");
rejects("reject Kernel non-default execution mode", () => decodeBankrExecution({ from: relayer, to: ENTRY_POINT_V07, input: handleOps(wallet, v07Nonce, kernelExecute(logicalTarget, 0n, openPack, 1n)), value: "0x0" }, wallet), "single-call default mode");
rejects("reject Kernel wallet self-call", () => decodeBankrExecution({ from: relayer, to: ENTRY_POINT_V07, input: handleOps(wallet, v07Nonce, kernelExecute(wallet, 0n, openPack)), value: "0x0" }, wallet), "must not target the active wallet itself");
rejects("reject sponsored trailing ABI word", () => decodeBankrExecution({ from: relayer, to: ENTRY_POINT_V07, input: `${v07HandleOps}${encodeUint(0n)}`, value: "0x0" }, wallet), "trailing or overlapping");

const userOpHash = keccak256("synthetic-user-operation");
const boundary = beforeExecutionEvent(ENTRY_POINT_V07);
const successEvent = userOperationEvent(ENTRY_POINT_V07, wallet, v07Nonce, userOpHash);
const receiptProof = verifyBankrExecutionReceipt(sponsoredEnvelope, { logs: [boundary, successEvent] }, userOpHash);
check("synthetic user operation succeeded", receiptProof.success);
equal("synthetic receipt sender", receiptProof.sender, wallet);
equal("synthetic receipt nonce", receiptProof.nonce, v07Nonce);
equal("synthetic receipt gas used", receiptProof.actualGasUsed, 456n);
deepEqual("synthetic receipt trusted log window", receiptProof.receiptLogRange, { start: 1, end: 1 });
rejects("reject missing UserOperationEvent", () => verifyBankrExecutionReceipt(sponsoredEnvelope, { logs: [boundary] }, userOpHash), "exactly one matching");
rejects("reject duplicate UserOperationEvent", () => verifyBankrExecutionReceipt(sponsoredEnvelope, { logs: [boundary, successEvent, successEvent] }, userOpHash), "exactly one matching");
rejects("reject wrong userOp hash", () => verifyBankrExecutionReceipt(sponsoredEnvelope, { logs: [boundary, successEvent] }, keccak256("wrong")), "exactly one matching");
rejects("reject failed logical operation", () => verifyBankrExecutionReceipt(sponsoredEnvelope, {
  logs: [boundary, userOperationEvent(ENTRY_POINT_V07, wallet, v07Nonce, userOpHash, false)],
}, userOpHash), "logical call reverted");
rejects("reject missing execution boundary", () => verifyBankrExecutionReceipt(sponsoredEnvelope, { logs: [successEvent] }, userOpHash), "BeforeExecution boundary");
rejects("reject noncanonical receipt bool", () => verifyBankrExecutionReceipt(sponsoredEnvelope, {
  logs: [{ ...boundary }, { ...successEvent, data: `0x${encodeUint(v07Nonce)}${encodeUint(2n)}${encodeUint(123n)}${encodeUint(456n)}` }],
}, userOpHash), "not a canonical bool");

const otherKernelCall = kernelExecute(logicalTarget, 0n, openPack);
const bundleEnvelope = decodeBankrExecution({
  from: relayer,
  to: ENTRY_POINT_V07,
  input: handleOpsMany([userOperationTuple(otherWallet, 3n, otherKernelCall), userOperationTuple(wallet, v07Nonce, kernelCall)]),
  value: "0x0",
}, wallet);
equal("bundle selects active wallet index", bundleEnvelope.userOperation.index, 1);
equal("bundle size decoded", bundleEnvelope.userOperationCount, 2);
const otherHash = keccak256("other-operation");
const unrelatedLog = { address: ADDR.gacha, topics: [eventTopic("UnrelatedProof(uint256)")], data: `0x${encodeUint(1n)}` };
const bundleProof = verifyBankrExecutionReceipt(bundleEnvelope, {
  logs: [boundary, unrelatedLog, userOperationEvent(ENTRY_POINT_V07, otherWallet, 3n, otherHash), successEvent],
}, userOpHash);
deepEqual("bundle scopes only active operation logs", bundleProof.receiptLogRange, { start: 3, end: 3 });

equal("zero rootValidator decodes", decodeRootValidator(`0x${"0".repeat(64)}`), `0x${"0".repeat(42)}`);
rejects("reject malformed rootValidator", () => decodeRootValidator(`0x${"1".repeat(64)}`), "canonical ABI bytes21");
equal("zero ecrecover result is null", decodeAuthorizationAuthority(`0x${"0".repeat(64)}`), null);
equal("canonical ecrecover result", decodeAuthorizationAuthority(`0x${encodeAddress(wallet)}`), wallet);
const parsedAuthorization = authorizationRecoveryCall(syntheticAuthorization(KERNEL_IMPLEMENTATION));
equal("authorization target decoded", parsedAuthorization.target, KERNEL_IMPLEMENTATION);
equal("authorization chain decoded", parsedAuthorization.chainId, 8453n);
equal("authorization nonce decoded", parsedAuthorization.nonce, 0n);
check("authorization signature shape canonical", parsedAuthorization.signatureCanonical);

const transferLog = {
  address: ADDR.usdc,
  topics: [eventTopic("Transfer(address,address,uint256)"), `0x${encodeAddress(relayer)}`, `0x${encodeAddress(wallet)}`],
  data: `0x${encodeUint(5_000_000n)}`,
};
equal("canonical incoming USDC transfer sum", sumCanonicalErc20Transfers([transferLog], ADDR.usdc, "to", wallet), 5_000_000n);
equal("canonical outgoing USDC transfer sum", sumCanonicalErc20Transfers([transferLog], ADDR.usdc, "from", relayer), 5_000_000n);
equal("exact-counterparty transfer sum", sumCanonicalErc20Transfers([transferLog], ADDR.usdc, "from", relayer, wallet), 5_000_000n);
equal("wrong-counterparty transfer is excluded", sumCanonicalErc20Transfers([transferLog], ADDR.usdc, "from", relayer, otherWallet), 0n);
const selfTransfer = { ...transferLog, topics: [transferLog.topics[0], `0x${encodeAddress(wallet)}`, `0x${encodeAddress(wallet)}`] };
equal("self-transfer is not incoming evidence", sumCanonicalErc20Transfers([selfTransfer], ADDR.usdc, "to", wallet), 0n);
rejects("reject malformed transfer topic", () => sumCanonicalErc20Transfers([{ ...transferLog, topics: [transferLog.topics[0], `0x${"f".repeat(64)}`, transferLog.topics[2]] }], ADDR.usdc, "to", wallet), "canonical indexed address");
rejects("reject malformed transfer data", () => sumCanonicalErc20Transfers([{ ...transferLog, data: "0x01" }], ADDR.usdc, "to", wallet), "one uint256 word");

const zeroRootValidatorResult = `0x${"0".repeat(64)}`;
const persistentTarget = syntheticTransaction(0);
const persistentProof = await proveKernelDelegationAtTransaction({
  wallet,
  transaction: persistentTarget,
  block: { transactions: [persistentTarget] },
  parentWalletCode: KERNEL_DELEGATION_DESIGNATOR,
  parentWalletNonce: 7n,
  parentRootValidator: zeroRootValidatorResult,
  recoverAuthority: async () => wallet,
});
equal("persistent delegation parent state", persistentProof.parentState, "reviewed-kernel");
equal("persistent delegation target index", persistentProof.targetTransactionIndex, 0);

const firstUseTarget = syntheticTransaction(0, { type: "0x4", authorizations: [syntheticAuthorization(KERNEL_IMPLEMENTATION)] });
const firstUseProof = await proveKernelDelegationAtTransaction({
  wallet,
  transaction: firstUseTarget,
  block: { transactions: [firstUseTarget] },
  parentWalletCode: "0x",
  parentWalletNonce: 0n,
  parentRootValidator: zeroRootValidatorResult,
  recoverAuthority: async () => wallet,
});
equal("first-use delegation parent state", firstUseProof.parentState, "empty");
equal("first-use recovered authority", firstUseProof.observedWalletAuthorizations[0].authority, wallet);
equal("first-use reviewed target", firstUseProof.observedWalletAuthorizations[0].target, KERNEL_IMPLEMENTATION);

await rejectsAsync("reject malicious delegation target", () => {
  const malicious = syntheticTransaction(0, { type: "0x4", authorizations: [syntheticAuthorization(otherWallet, 7n)] });
  const target = syntheticTransaction(1);
  return proveKernelDelegationAtTransaction({
    wallet, transaction: target, block: { transactions: [malicious, target] },
    parentWalletCode: KERNEL_DELEGATION_DESIGNATOR, parentWalletNonce: 7n,
    parentRootValidator: zeroRootValidatorResult, recoverAuthority: async () => wallet,
  });
}, "non-reviewed EIP-7702 authorization");
await rejectsAsync("reject wrong first-use authorization nonce", () => {
  const target = syntheticTransaction(0, { type: "0x4", authorizations: [syntheticAuthorization(KERNEL_IMPLEMENTATION, 1n)] });
  return proveKernelDelegationAtTransaction({
    wallet, transaction: target, block: { transactions: [target] }, parentWalletCode: "0x",
    parentWalletNonce: 0n, parentRootValidator: zeroRootValidatorResult, recoverAuthority: async () => wallet,
  });
}, "authorization nonce");
await rejectsAsync("reject nonzero root validator", () => proveKernelDelegationAtTransaction({
  wallet, transaction: persistentTarget, block: { transactions: [persistentTarget] },
  parentWalletCode: KERNEL_DELEGATION_DESIGNATOR, parentWalletNonce: 7n,
  parentRootValidator: `0x01${"0".repeat(62)}`, recoverAuthority: async () => wallet,
}), "rootValidator was nonzero");

// Public RPCs have different historical-state retention. A pruned-state error
// is endpoint-specific and may move a read to the next configured public RPC,
// which must then become the preferred endpoint. An execution revert is a
// semantic result from the requested call and must remain fail-closed even when
// it uses the same broad -32603 server-error code.
const originalFetch = globalThis.fetch;
const originalStonkRpc = process.env.STONK_GACHA_RPC_URL;
const originalBaseRpc = process.env.BASE_RPC_URL;
delete process.env.STONK_GACHA_RPC_URL;
delete process.env.BASE_RPC_URL;
try {
  const fallbackCalls = [];
  globalThis.fetch = async (url) => {
    fallbackCalls.push(String(url));
    const body = String(url).includes("base-rpc.publicnode.com")
      ? { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "state at block 50487407 is pruned" } }
      : { jsonrpc: "2.0", id: 1, result: "0x2a" };
    return { ok: true, status: 200, json: async () => body };
  };
  const fallbackChain = await import(`./lib/chain.mjs?selftest-pruned-fallback=${Date.now()}`);
  equal("pruned historical state falls back", await fallbackChain.rpc("eth_getBalance", [wallet, "0x302644f"]), "0x2a");
  equal("successful fallback remains preferred", await fallbackChain.rpc("eth_getBalance", [wallet, "0x302644f"]), "0x2a");
  deepEqual("pruned endpoint is tried once then fallback is re-pinned", fallbackCalls, [
    "https://base-rpc.publicnode.com",
    "https://base-mainnet.public.blastapi.io",
    "https://base-mainnet.public.blastapi.io",
  ]);

  const revertCalls = [];
  globalThis.fetch = async (url) => {
    revertCalls.push(String(url));
    const body = String(url).includes("base-rpc.publicnode.com")
      ? { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "execution reverted", data: "0xdeadbeef" } }
      : { jsonrpc: "2.0", id: 1, result: "0x2a" };
    return { ok: true, status: 200, json: async () => body };
  };
  const strictChain = await import(`./lib/chain.mjs?selftest-revert-fail-closed=${Date.now()}`);
  let capturedRevert = null;
  try {
    await strictChain.rpc("eth_call", [{ to: ADDR.gacha, data: "0xdeadbeef" }, "latest"]);
  } catch (error) {
    capturedRevert = error;
  }
  check("execution-reverted -32603 remains RpcError", capturedRevert instanceof strictChain.RpcError, capturedRevert?.message);
  equal("execution-reverted -32603 code preserved", capturedRevert?.code, -32603);
  equal("execution-reverted -32603 data preserved", capturedRevert?.data, "0xdeadbeef");
  deepEqual("execution revert does not reroute", revertCalls, ["https://base-rpc.publicnode.com"]);

  let estimateRequest = null;
  globalThis.fetch = async (_url, options) => {
    estimateRequest = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x5208" }) };
  };
  const estimateChain = await import(`./lib/chain.mjs?selftest-pinned-estimate=${Date.now()}`);
  const estimateBlock = { blockHash: keccak256("pinned-estimate-block"), requireCanonical: true };
  equal(
    "estimateGas decodes pinned estimate",
    await estimateChain.estimateGas(ADDR.gacha, "0x12345678", wallet, 7n, estimateBlock),
    21_000n,
  );
  equal("estimateGas RPC method", estimateRequest?.method, "eth_estimateGas");
  deepEqual("estimateGas carries EIP-1898 block ref", estimateRequest?.params?.[1], estimateBlock);
  equal("estimateGas carries logical value", estimateRequest?.params?.[0]?.value, "0x7");
} finally {
  globalThis.fetch = originalFetch;
  if (originalStonkRpc === undefined) delete process.env.STONK_GACHA_RPC_URL;
  else process.env.STONK_GACHA_RPC_URL = originalStonkRpc;
  if (originalBaseRpc === undefined) delete process.env.BASE_RPC_URL;
  else process.env.BASE_RPC_URL = originalBaseRpc;
}

// Reference pins, install metadata, size limits, and cross-project contamination.
equal("deployment chain", DEPLOYMENT.chainId, 8453);
equal("reviewed source commit", DEPLOYMENT.release.sourceCommit, "c8d4b49e4f72fb39461ab93008e80308a2886b7c");
equal("Gacha address pin", ADDR.gacha, "0xfd2c0eaf1b4b46593a3887fec4af30ac4245687f");
equal("Treasury address pin", ADDR.treasury, "0x5da6595e587ac968e8355e2f5312fbe1967d6e1c");
equal("USDC address pin", ADDR.usdc, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
equal("USDC implementation slot pin", DEPLOYMENT.tokens.usdc.zeppelinosImplementationSlot, "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3");
equal("USDC implementation address pin", ADDR.usdcImplementation, "0x2ce6311ddae708829bc0784c967b7d77d19fd779");
equal("USDC implementation hash pin", DEPLOYMENT.tokens.usdc.implementationRuntimeCodeHash, "0x11b75a237997ab8328f65b2d5a55c10f0346d0a175741ed42ddf4f2c66b9e873");
check("USDC proxy and implementation hashes are independently pinned", DEPLOYMENT.tokens.usdc.runtimeCodeHash !== DEPLOYMENT.tokens.usdc.implementationRuntimeCodeHash);
equal("worker bounty pin", DEPLOYMENT.productTerms.workerBountyBps, 100);
equal("minimum distribution pin", DEPLOYMENT.productTerms.minimumDistributeUsdcRaw, 10_000_000);
equal("Bankr EntryPoint pin", BANKR_EXECUTION.sponsored.entryPoint.address.toLowerCase(), ENTRY_POINT_V07);
equal("Bankr EntryPoint hash pin", BANKR_EXECUTION.sponsored.entryPoint.runtimeCodeHash, ENTRY_POINT_V07_CODE_HASH);
equal("Bankr Kernel pin", BANKR_EXECUTION.sponsored.account.implementation, KERNEL_IMPLEMENTATION);
equal("Bankr Kernel hash pin", BANKR_EXECUTION.sponsored.account.implementationRuntimeCodeHash, KERNEL_IMPLEMENTATION_CODE_HASH);
equal("Bankr validation slot pin", BANKR_EXECUTION.sponsored.account.validationStorageSlot, KERNEL_VALIDATION_STORAGE_SLOT);
check("Bankr policy requires fail-on-error single call", BANKR_EXECUTION.policy.requireSingleLogicalCall && BANKR_EXECUTION.policy.requireFailOnError);
check("Bankr policy rejects batches and paymaster", BANKR_EXECUTION.policy.rejectWalletBatch && BANKR_EXECUTION.sponsored.account.requireEmptyPaymasterAndData);
equal("Bankr live fixture count", BANKR_EXECUTION.sponsored.liveRegressionFixtures.length, 3);
equal("Bankr direct live fixture count", BANKR_EXECUTION.direct.liveRegressionFixtures.length, 1);
equal("direct pull Entropy fee cap", BigInt(BANKR_EXECUTION.directPull.maximumEntropyFeeWei), 10_000_000_000_000n);
equal("direct pull claim slippage", BANKR_EXECUTION.directPull.claimSlippageBps, 300);
equal("direct pull poll interval", BANKR_EXECUTION.directPull.pollIntervalSeconds, 2);
equal("direct pull active watch", BANKR_EXECUTION.directPull.activeWatchSeconds, 300);
equal("direct pull maximum active watch", BANKR_EXECUTION.directPull.maximumActiveWatchSeconds, 3300);
equal("direct pull transport error cap", BANKR_EXECUTION.directPull.maximumConsecutiveTransportErrors, 8);
equal("direct pull transport backoff cap", BANKR_EXECUTION.directPull.maximumTransportBackoffSeconds, 30);
equal("direct pull runtime journal root", BANKR_EXECUTION.directPull.runtimeJournalRoot, "/stonk-gacha/pulls");
equal("direct pull intent TTL", BANKR_EXECUTION.directPull.intentTtlSeconds, 600);
equal("direct claim continuation TTL", BANKR_EXECUTION.directPull.claimContinuationTtlSeconds, 172800);
equal("direct claim continuation spans resolve plus delivery grace", BANKR_EXECUTION.directPull.claimContinuationTtlSeconds, DEPLOYMENT.productTerms.resolveWindowSeconds * 2);
check("direct pull policy binds price, request baseline, source receipt, and hidden capability", BANKR_EXECUTION.directPull.requireExactAuthorizedPrice && BANKR_EXECUTION.directPull.requireUnchangedRequestCountBeforeOpen && BANKR_EXECUTION.directPull.claimSource === "exact-proven-PackOpened-receipt-only" && BANKR_EXECUTION.directPull.claimCapability.includes("secret-preimage"));
check("normal direct open enforces reviewed Entropy fee cap", normalOpenPlannerSource.includes("entropyFee <= entropyFeeCap") && plannerSource.includes("exact Entropy fee exceeds the direct pull authorization cap"));
equal("acquisition stays structured Bankr-native", BANKR_EXECUTION.acquisition.mode, "structured-bankr-wallet-api");
equal("local acquisition calldata is forbidden", BANKR_EXECUTION.acquisition.localSwapCalldata, "forbidden");
equal("pack funding gets one bounded confirmation", BANKR_EXECUTION.acquisition.packFundingConfirmation, "one-bounded-confirmation-after-explicit-source-choice");
check("acquisition continuation rereads dual assets and offer", /canonical Base USDC.*native Base ETH.*unchanged offer hash and ceiling.*fee at or below the confirmed cap/.test(BANKR_EXECUTION.acquisition.continuationGate));
check("acquisition requires swap idempotency", BANKR_EXECUTION.acquisition.swap.requireIdempotencyKeyPerLeg && BANKR_EXECUTION.acquisition.swap.safeRetryUsesSameBodyAndKey);
deepEqual("acquisition marks ambiguous swap statuses", BANKR_EXECUTION.acquisition.swap.ambiguousStatuses, [502, 504]);
check("acquisition never auto-selects or downgrades", BANKR_EXECUTION.acquisition.sourceSelection.automaticSelection === "forbidden" && BANKR_EXECUTION.acquisition.sourceSelection.automaticLowerPack === "forbidden");
check("cross-chain acquisition is separate", !BANKR_EXECUTION.acquisition.crossChain.combinedWithPackOpen && BANKR_EXECUTION.acquisition.crossChain.requiresSeparateConfirmation);
equal("vague acquisition prompt is forbidden", BANKR_EXECUTION.acquisition.naturalLanguageSwapPrompt, "forbidden");
check("raw submit ambiguity requires state reconciliation", /allowance.*PackOpened\/request state/.test(BANKR_EXECUTION.acquisition.rawSubmitAmbiguity));

const skillMarkdown = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
const catalog = JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8"));
const frontmatter = skillMarkdown.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1] ?? "";
equal("Bankr skill name", frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim(), "stonk-gacha");
check("Bankr skill description exists", /^description:\s*\S.+$/m.test(frontmatter));
check("Bankr top-level tags exist", /^tags:\s*\[[^\]]+\]$/m.test(frontmatter));
equal("Bankr top-level version", Number(frontmatter.match(/^version:\s*(\d+)$/m)?.[1]), 5);
equal("Bankr top-level visibility", frontmatter.match(/^visibility:\s*(\S+)$/m)?.[1], "public");
equal("catalog slug", catalog.slug, "stonk-gacha");
equal("catalog schema", catalog.schemaVersion, 1);
equal("catalog repo path", catalog.install.repoPath, ".");
check("catalog points at public source", catalog.install.command.includes("github.com/panikadak/stonk-gacha-bankr-skill"));
const catalogDemoTweet = catalog.demo.code.split("\n")[0].replace(/^You:\s*/, "");
check("catalog demonstrates one-tweet install-to-delivery Gacha pull", catalogDemoTweet.startsWith("@bankrbot install the skill at https://github.com/panikadak/stonk-gacha-bankr-skill") && catalogDemoTweet.toLowerCase().includes("pull me a $10") && [...catalogDemoTweet].length <= 280 && catalog.demo.code.includes("You pulled $20 of GOOGLc.") && !catalog.demo.code.toLowerCase().includes("purchase"));
check("skill requires silent open-to-delivery lifecycle", skillMarkdown.includes("Keep the entire workflow silent until completion") && skillMarkdown.includes("await-claim-prize") && skillMarkdown.includes("exact claim receipt"));

for (const relative of [
  "SKILL.md", "references/operations.md", "references/bankr-execution.md",
  "references/deployment.json", "references/signing-allowlist.json", "references/bankr-execution.json",
  "references/funding-policy.json", "references/funding-fixtures.json", "references/x-confirmation.md",
  "scripts/lib/direct.mjs", "scripts/lib/watch.mjs",
]) {
  try {
    const bytes = statSync(new URL(`../${relative}`, import.meta.url)).size;
    check(`${relative} under 100 KB`, bytes < 100_000, `${bytes} bytes`);
  } catch (error) {
    check(`${relative} exists`, false, error.message);
  }
}
check("SKILL.md under Bankr 1 MB limit", statSync(new URL("../SKILL.md", import.meta.url)).size < 1_000_000);

const scanFiles = [];
function collectFiles(directory, prefix = "") {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = new URL(`../${relative}`, import.meta.url);
    if (entry.isDirectory()) collectFiles(absolute, relative);
    else if (relative !== "scripts/selftest.mjs") scanFiles.push(relative);
  }
}
collectFiles(new URL("../", import.meta.url));
const contaminationPatterns = [
  ["legacy project name", new RegExp(["PUNK", "TOWN"].join(""), "i")],
  ["legacy desk name", new RegExp(["PUNK", "AMM"].join(""), "i")],
  ["legacy token symbol", new RegExp(`\\b${["BA", "ES"].join("")}\\b`, "i")],
  ["legacy desk address", new RegExp(["0x555c246d004d2f24", "b5baddd186fc773eb6fb8445"].join(""), "i")],
];
for (const [label, pattern] of contaminationPatterns) {
  const matches = scanFiles.filter((relative) => {
    try { return pattern.test(readFileSync(new URL(`../${relative}`, import.meta.url), "utf8")); }
    catch { return false; }
  });
  check(`no ${label} contamination`, matches.length === 0, matches.join(", "));
}

async function liveDelegationProof(transaction, receipt, activeWallet) {
  const receiptBlock = await getBlockByHash(receipt.blockHash, true);
  const parentBlockRef = { blockHash: receiptBlock.parentHash, requireCanonical: true };
  const [parentWalletCode, parentWalletNonce] = await Promise.all([
    getCode(activeWallet, parentBlockRef),
    getTransactionCount(activeWallet, parentBlockRef),
  ]);
  let parentRootValidator;
  if (parentWalletCode === "0x") {
    equal("live empty parent has no retained validation state", await getStorageAt(activeWallet, KERNEL_VALIDATION_STORAGE_SLOT, parentBlockRef), zeroRootValidatorResult);
    parentRootValidator = zeroRootValidatorResult;
  } else {
    parentRootValidator = await ethCall(activeWallet, ROOT_VALIDATOR_SELECTOR, { block: parentBlockRef });
  }
  return await proveKernelDelegationAtTransaction({
    wallet: activeWallet,
    transaction,
    block: receiptBlock,
    parentWalletCode,
    parentWalletNonce,
    parentRootValidator,
    recoverAuthority: async (authorization) => decodeAuthorizationAuthority(await ethCall(
      ECRECOVER_PRECOMPILE,
      authorization.callData,
      { block: parentBlockRef },
    )),
  });
}

if (LIVE) {
  const snapshot = await beginSnapshot();
  const integrity = await verifyDeployment(snapshot);
  check("live deployment integrity", integrity.ok, integrity.failed?.join(", "));
  equal("live deployment release pin", integrity.release.sourceCommit, DEPLOYMENT.release.sourceCommit);
  equal("live snapshot block hash", integrity.snapshot.blockHash, snapshot.hash);
  const liveUsdcImplementationWord = await getStorageAt(ADDR.usdc, DEPLOYMENT.tokens.usdc.zeppelinosImplementationSlot, snapshot.ref);
  equal("live USDC implementation address", `0x${liveUsdcImplementationWord.slice(-40)}`, ADDR.usdcImplementation);
  equal("live USDC implementation runtime", await getCodeHash(ADDR.usdcImplementation, snapshot.ref), DEPLOYMENT.tokens.usdc.implementationRuntimeCodeHash);
  check("live deployment gate includes USDC implementation address", integrity.checks.some((entry) => entry.name === "USDCProxy.implementation" && entry.pass));
  check("live deployment gate includes USDC implementation runtime", integrity.checks.some((entry) => entry.name === "USDCImplementation.runtimeCodeHash" && entry.pass));

  const offers = [];
  for (let packIndex = 0; packIndex < DEPLOYMENT.productTerms.packCount; packIndex += 1) {
    const offer = await readOffer(packIndex, snapshot);
    offers.push(offer);
    equal(`live offer ${packIndex} index`, offer.packIndex, packIndex);
    equal(`live offer ${packIndex} price`, BigInt(offer.priceUsdc), BigInt(DEPLOYMENT.productTerms.packPricesUsdcRaw[packIndex]));
    check(`live offer ${packIndex} has eligible stocks`, offer.eligible.length >= 1 && offer.eligible.length <= 16);
    equal(`live offer ${packIndex} token/route count`, offer.eligible.filter((entry) => entry.routeHash).length, offer.eligible.length);
    check(`live offer ${packIndex} nonzero ceiling`, BigInt(offer.ceilingBps) >= BigInt(DEPLOYMENT.productTerms.minimumCeilingBps));
    check(`live offer ${packIndex} cash backed`, BigInt(offer.maxPayoutUsdc) <= BigInt(offer.freeReserveUsdc));
    check(`live offer ${packIndex} nonzero Entropy fee`, BigInt(offer.entropyFee) > 0n);
    const local = localOfferHash(
      packIndex,
      BigInt(offer.ceilingBps),
      offer.eligible.map((entry) => entry.token),
      offer.eligible.map((entry) => entry.routeHash),
    );
    equal(`live offer ${packIndex} local ordered commitment`, local, offer.offerHash);
    equal(`live offer ${packIndex} helper commitment`, offer.computedOfferHash, offer.offerHash);
  }
  equal("live all three offers available", offers.length, 3);
  const delivered = await readRequest(569705n, snapshot);
  const status = await protocolStatus(null, snapshot);
  const profit = await profitStatus(null, snapshot);
  const requestPage = await walletRequests(delivered.buyer, 0n, 1n, snapshot);
  equal("optional-snapshot request read stays pinned", delivered.snapshot.blockHash, snapshot.hash);
  equal("optional-snapshot status read stays pinned", status.snapshot.blockHash, snapshot.hash);
  equal("optional-snapshot profit read stays pinned", profit.snapshot.blockHash, snapshot.hash);
  equal("optional-snapshot request page stays pinned", requestPage.snapshot.blockHash, snapshot.hash);
  await confirmSnapshot(snapshot);

  equal("known request id", BigInt(delivered.requestId), 569705n);
  equal("known request is Delivered", delivered.status, "Delivered");
  equal("known request pack index", BigInt(delivered.packIndex), 0n);
  equal("known request paid 5 USDC", BigInt(delivered.paidUsdc), 5_000_000n);
  equal("known request 1x multiplier", BigInt(delivered.multiplierBps), 10_000n);
  equal("known request payout equals charge", BigInt(delivered.payoutUsdc), 5_000_000n);
  equal("known request stock output", BigInt(delivered.stockOut), 2_297_456n);
  check("known request has nonzero selected token", normalizeAddress(delivered.token) !== "0x0000000000000000000000000000000000000000");
  const chosen = delivered.eligible.find((entry) => normalizeAddress(entry.token) === normalizeAddress(delivered.token));
  check("known request token remains in pinned set", Boolean(chosen));
  equal("known request route matches pinned token", chosen?.routeHash?.toLowerCase(), delivered.routeHash.toLowerCase());
  check("known request delivery output is nonzero", BigInt(delivered.stockOut) > 0n);

  check("live protocol status passes deployment gate", status.ok === true);
  check("live salesPaused is boolean", typeof status.salesPaused === "boolean");
  equal("live status contains three offer slots", status.offers.length, 3);
  const ledger = Object.fromEntries(Object.entries(status.ledger).map(([key, value]) => [key, typeof value === "boolean" ? value : BigInt(value)]));
  equal("protected liability identity", ledger.protectedUsdc, ledger.pendingPayoutUsdc + ledger.readyPayoutUsdc + ledger.refundableUsdc);
  check("protected liabilities are solvent", ledger.protectedUsdc >= 0n && ledger.freeReserveUsdc >= 0n);
  check("pending count is bounded", ledger.pendingRequests <= ledger.totalRequests);
  check("distributable is bounded by free cash", ledger.distributableProfitUsdc <= ledger.freeReserveUsdc);
  check("distributable is bounded by accounting profit", ledger.distributableProfitUsdc <= ledger.accountingProfitAvailableUsdc);
  equal(
    "processed profit split identity",
    ledger.cumulativeProcessedProfitUsdc,
    ledger.cumulativeProfitBountyUsdc + ledger.cumulativeRetainedProfitUsdc + ledger.cumulativeStakerProfitUsdc,
  );
  equal("profit split retained and staker totals", ledger.cumulativeRetainedProfitUsdc, ledger.cumulativeStakerProfitUsdc);
  check("cumulative refunds do not exceed revenue", ledger.cumulativeRefundedUsdc <= ledger.cumulativeRevenueUsdc);
  const statusBlock = { blockHash: status.snapshot.blockHash, requireCanonical: true };
  const gachaUsdc = await readUint(ADDR.usdc, SIG.balanceOf, ["address"], [ADDR.gacha], statusBlock);
  equal("raw USDC conservation", gachaUsdc, ledger.protectedUsdc + ledger.freeReserveUsdc);

  for (const [fixtureIndex, fixture] of BANKR_EXECUTION.sponsored.liveRegressionFixtures.entries()) {
    const [transaction, receipt] = await Promise.all([
      getTransaction(fixture.transactionHash),
      getReceipt(fixture.transactionHash),
    ]);
    check(`Bankr fixture ${fixtureIndex + 1} transaction exists`, Boolean(transaction));
    check(`Bankr fixture ${fixtureIndex + 1} receipt exists`, Boolean(receipt));
    if (!transaction || !receipt) continue;
    equal(`Bankr fixture ${fixtureIndex + 1} outer success`, BigInt(receipt.status), 1n);
    const envelope = decodeBankrExecution(transaction, fixture.wallet);
    equal(`Bankr fixture ${fixtureIndex + 1} sponsored mode`, envelope.mode, "bankr-entrypoint-kernel-single");
    equal(`Bankr fixture ${fixtureIndex + 1} logical sender`, envelope.logicalSender, fixture.wallet.toLowerCase());
    equal(`Bankr fixture ${fixtureIndex + 1} native validation mode`, envelope.validation.mode, 0);
    equal(`Bankr fixture ${fixtureIndex + 1} native validation type`, envelope.validation.type, 0);
    equal(`Bankr fixture ${fixtureIndex + 1} no paymaster`, envelope.userOperation.paymasterAndData, "0x");
    if (fixture.userOperationIndex !== undefined) equal(`Bankr fixture ${fixtureIndex + 1} userOp index`, envelope.userOperation.index, fixture.userOperationIndex);
    if (fixture.bundleSize !== undefined) equal(`Bankr fixture ${fixtureIndex + 1} bundle size`, envelope.userOperationCount, fixture.bundleSize);
    if (fixture.erc8021BuilderCode) equal(`Bankr fixture ${fixtureIndex + 1} attribution`, envelope.attribution?.codes?.[0], fixture.erc8021BuilderCode);
    equal(`Bankr fixture ${fixtureIndex + 1} EntryPoint runtime`, await getCodeHash(ENTRY_POINT_V07, receipt.blockNumber), ENTRY_POINT_V07_CODE_HASH);
    equal(`Bankr fixture ${fixtureIndex + 1} Kernel runtime`, await getCodeHash(KERNEL_IMPLEMENTATION, receipt.blockNumber), KERNEL_IMPLEMENTATION_CODE_HASH);
    equal(`Bankr fixture ${fixtureIndex + 1} receipt-block delegation`, (await getCode(fixture.wallet, receipt.blockNumber)).toLowerCase(), KERNEL_DELEGATION_DESIGNATOR);
    const computedUserOpHash = decodeBytes32(await ethCall(
      envelope.entryPoint,
      userOperationHashCall(envelope),
      { block: receipt.blockNumber },
    ));
    if (fixture.userOpHash) equal(`Bankr fixture ${fixtureIndex + 1} pinned userOp hash`, computedUserOpHash, fixture.userOpHash);
    const receiptProof = verifyBankrExecutionReceipt(envelope, receipt, computedUserOpHash);
    check(`Bankr fixture ${fixtureIndex + 1} logical success`, receiptProof.success);
    equal(`Bankr fixture ${fixtureIndex + 1} proved sender`, receiptProof.sender, fixture.wallet.toLowerCase());
    const delegation = await liveDelegationProof(transaction, receipt, fixture.wallet);
    if (fixture.transactionType === 4) {
      equal(`Bankr fixture ${fixtureIndex + 1} type-4 transaction`, BigInt(transaction.type), 4n);
      equal(`Bankr fixture ${fixtureIndex + 1} empty parent`, delegation.parentState, "empty");
      equal(`Bankr fixture ${fixtureIndex + 1} one wallet authorization`, delegation.observedWalletAuthorizations.length, 1);
      equal(`Bankr fixture ${fixtureIndex + 1} authorization target`, delegation.observedWalletAuthorizations[0].target, fixture.authorizationTarget);
      equal(`Bankr fixture ${fixtureIndex + 1} authorization chain`, delegation.observedWalletAuthorizations[0].chainId, BigInt(fixture.authorizationChainId));
      equal(`Bankr fixture ${fixtureIndex + 1} authorization nonce`, delegation.observedWalletAuthorizations[0].nonce, BigInt(fixture.authorizationNonce));
    } else {
      equal(`Bankr fixture ${fixtureIndex + 1} persistent parent`, delegation.parentState, "reviewed-kernel");
    }
    equal(`Bankr fixture ${fixtureIndex + 1} zero parent validator`, delegation.parentRootValidator, `0x${"0".repeat(42)}`);
  }
  for (const [fixtureIndex, fixture] of BANKR_EXECUTION.direct.liveRegressionFixtures.entries()) {
    const [transaction, receipt] = await Promise.all([
      getTransaction(fixture.transactionHash),
      getReceipt(fixture.transactionHash),
    ]);
    check(`Bankr direct fixture ${fixtureIndex + 1} transaction exists`, Boolean(transaction));
    check(`Bankr direct fixture ${fixtureIndex + 1} receipt exists`, Boolean(receipt));
    if (!transaction || !receipt) continue;
    equal(`Bankr direct fixture ${fixtureIndex + 1} outer success`, BigInt(receipt.status), 1n);
    const envelope = decodeBankrExecution(transaction, fixture.wallet);
    equal(`Bankr direct fixture ${fixtureIndex + 1} mode`, envelope.mode, fixture.mode);
    equal(`Bankr direct fixture ${fixtureIndex + 1} sender`, envelope.logicalSender, fixture.wallet.toLowerCase());
    equal(`Bankr direct fixture ${fixtureIndex + 1} outer bytes`, (transaction.input.length - 2) / 2, fixture.outerInputBytes);
    equal(`Bankr direct fixture ${fixtureIndex + 1} logical bytes`, (envelope.logicalCall.data.length - 2) / 2, fixture.logicalInputBytes);
    equal(`Bankr direct fixture ${fixtureIndex + 1} attribution schema`, envelope.attribution?.schemaId, fixture.erc8021Schema);
    equal(`Bankr direct fixture ${fixtureIndex + 1} attribution code`, envelope.attribution?.codes?.[0], fixture.erc8021BuilderCode);
    equal(`Bankr direct fixture ${fixtureIndex + 1} logical action`, knownActionBySelector(envelope.logicalCall.target, envelope.logicalCall.data.slice(0, 10))?.name, "claim-prize");
  }
} else {
  skip("live deployment, offers, request, and accounting", "run with --live to execute read-only Base checks");
  skip("live Bankr single and multi-user fixtures", "run with --live to verify historical Base receipts");
  skip("live Bankr first-use EIP-7702 fixture", "run with --live to prove historical authorization ordering");
  skip("live Bankr direct ERC-8021 fixture", "run with --live to verify direct attribution stripping");
}

const failed = results.filter((result) => result.status === "fail");
const passed = results.filter((result) => result.status === "pass");
const skipped = results.filter((result) => result.status === "skip");
for (const result of results) {
  const label = result.status === "pass" ? "PASS" : result.status === "fail" ? "FAIL" : "SKIP";
  console.error(`${label}  ${result.name}${result.detail ? `  (${result.detail})` : ""}`);
}
console.log(JSON.stringify({
  ok: failed.length === 0,
  mode: LIVE ? "live-read-only" : "offline",
  checks: passed.length + failed.length,
  passed: passed.length,
  failed: failed.length,
  skipped: skipped.length,
  failures: failed.map((result) => result.name),
}));
process.exitCode = failed.length === 0 ? 0 : 1;
