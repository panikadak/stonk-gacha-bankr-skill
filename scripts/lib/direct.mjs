import { readFileSync } from "node:fs";
import { jsonValue, normalizeAddress } from "./abi.mjs";
import { keccak256 } from "./keccak256.mjs";

const BANKR_POLICY = JSON.parse(
  readFileSync(new URL("../../references/bankr-execution.json", import.meta.url), "utf8"),
);
const DEPLOYMENT_POLICY = JSON.parse(
  readFileSync(new URL("../../references/deployment.json", import.meta.url), "utf8"),
);

export const DIRECT_PULL_KIND = "stonk-gacha-direct-pull/v1";
export const DIRECT_CLAIM_KIND = "stonk-gacha-direct-claim/v1";
export const DIRECT_PULL_TTL_SECONDS = BigInt(BANKR_POLICY.directPull.intentTtlSeconds);
export const DIRECT_CLAIM_TTL_SECONDS = BigInt(BANKR_POLICY.directPull.claimContinuationTtlSeconds);
export const DIRECT_CLAIM_SLIPPAGE_BPS = Number(BANKR_POLICY.directPull.claimSlippageBps);
export const DEFAULT_DIRECT_ENTROPY_FEE_CAP_WEI = BigInt(BANKR_POLICY.directPull.maximumEntropyFeeWei);
export const MAX_EXPLICIT_DIRECT_ENTROPY_FEE_CAP_WEI = 1_000_000_000_000_000_000n;
const DIRECT_USDC = normalizeAddress(DEPLOYMENT_POLICY.tokens.usdc.address);
const DIRECT_GACHA = normalizeAddress(DEPLOYMENT_POLICY.contracts.stonkGacha.address);

const MAX_OPAQUE_JSON_BYTES = 65_536;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const EVEN_HEX = /^0x(?:[0-9a-f]{2})+$/;
const CLAIM_CAPABILITY_DOMAIN = new TextEncoder().encode("stonk-gacha-direct-claim-capability/v1:");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function rejectUnknownKeys(value, allowed, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  invariant(unexpected.length === 0, `${label} contains unsupported field ${unexpected[0]}`);
}

function canonicalBytes(value) {
  return new TextEncoder().encode(JSON.stringify(jsonValue(value)));
}

function bytesToHex(bytes) {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function hexToBytes(value, label) {
  invariant(typeof value === "string" && EVEN_HEX.test(value), `${label} must be non-empty canonical even-length hex`);
  invariant(value === value.toLowerCase(), `${label} must be lowercase`);
  invariant(value.length <= 2 + MAX_OPAQUE_JSON_BYTES * 2, `${label} exceeds 64 KiB`);
  return Uint8Array.from(value.slice(2).match(/.{2}/g).map((entry) => Number.parseInt(entry, 16)));
}

function decodeCanonicalJson(value, label) {
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(value, label));
  } catch (error) {
    throw new Error(`${label} is not canonical UTF-8 JSON: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  invariant(parsed && typeof parsed === "object" && !Array.isArray(parsed), `${label} must decode to an object`);
  invariant(JSON.stringify(parsed) === raw, `${label} JSON is not in canonical form`);
  return parsed;
}

function canonicalUint(value, label) {
  invariant(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), `${label} must be a canonical uint string`);
  return BigInt(value);
}

function canonicalBytes32(value, label) {
  invariant(typeof value === "string" && BYTES32.test(value), `${label} must be canonical lowercase bytes32`);
  return value;
}

function canonicalOpaqueHex(value, label) {
  hexToBytes(value, label);
  return value;
}

export function directUserRandomNumber(claimCapabilitySecret) {
  canonicalBytes32(claimCapabilitySecret, "direct pull claim capability secret");
  invariant(!/^0x0{64}$/.test(claimCapabilitySecret), "direct pull claim capability secret cannot be zero");
  const secret = hexToBytes(claimCapabilitySecret, "direct pull claim capability secret");
  const domainSeparated = new Uint8Array(CLAIM_CAPABILITY_DOMAIN.length + secret.length);
  domainSeparated.set(CLAIM_CAPABILITY_DOMAIN);
  domainSeparated.set(secret, CLAIM_CAPABILITY_DOMAIN.length);
  return keccak256(domainSeparated);
}

export function createDirectPullIntent({
  wallet,
  packIndex,
  authorizedPriceUsdcRaw,
  packPriceUsdcRaw,
  expectedOfferHash,
  acceptedCeilingBps,
  entropyFeeObservedWei,
  entropyFeeCapWei,
  feeAuthorization,
  claimCapabilitySecret,
  userRandomNumber,
  usdcBalance,
  ethBalance,
  allowance,
  requestCount,
  token,
  spender,
  createdAt,
  expiresAt,
}) {
  return validateDirectPullIntent(jsonValue({
    schemaVersion: 1,
    kind: DIRECT_PULL_KIND,
    stage: "open-and-deliver",
    wallet: normalizeAddress(wallet),
    chainId: 8453,
    createdAt: BigInt(createdAt),
    expiresAt: BigInt(expiresAt),
    authorization: {
      authorizedPriceUsdcRaw: BigInt(authorizedPriceUsdcRaw),
      feeAuthorization,
    },
    pack: {
      packIndex,
      priceUsdcRaw: BigInt(packPriceUsdcRaw),
      expectedOfferHash: String(expectedOfferHash).toLowerCase(),
      acceptedCeilingBps: BigInt(acceptedCeilingBps),
      entropyFeeObservedWei: BigInt(entropyFeeObservedWei),
      entropyFeeCapWei: BigInt(entropyFeeCapWei),
      claimCapabilitySecret: String(claimCapabilitySecret).toLowerCase(),
      userRandomNumber: String(userRandomNumber).toLowerCase(),
    },
    preflight: {
      baseUsdcRaw: BigInt(usdcBalance),
      baseEthWei: BigInt(ethBalance),
      allowanceUsdcRaw: BigInt(allowance),
      walletRequestCount: BigInt(requestCount),
    },
    approvalPolicy: {
      token: normalizeAddress(token),
      spender: normalizeAddress(spender),
      exactAmountUsdcRaw: BigInt(packPriceUsdcRaw),
      resetMismatchedNonzeroFirst: true,
    },
    deliveryPolicy: {
      recipient: normalizeAddress(wallet),
      slippageBps: DIRECT_CLAIM_SLIPPAGE_BPS,
    },
    allowedActions: [
      "conditional-allowance-reset",
      "exact-usdc-approval",
      "open-pack",
      "same-request-claim-prize",
    ],
    consumed: false,
  }));
}

export function validateDirectPullIntent(intent) {
  rejectUnknownKeys(intent, [
    "schemaVersion", "kind", "stage", "wallet", "chainId", "createdAt", "expiresAt",
    "authorization", "pack", "preflight", "approvalPolicy", "deliveryPolicy", "allowedActions", "consumed",
  ], "direct pull intent");
  invariant(intent.schemaVersion === 1 && intent.kind === DIRECT_PULL_KIND && intent.stage === "open-and-deliver", "unsupported direct pull intent schema");
  invariant(intent.wallet === normalizeAddress(intent.wallet), "direct pull wallet must be canonical lowercase");
  invariant(intent.chainId === 8453, "direct pull intent is not for Base");
  const created = canonicalUint(intent.createdAt, "direct pull createdAt");
  const expiry = canonicalUint(intent.expiresAt, "direct pull expiresAt");
  invariant(expiry > created && expiry - created <= DIRECT_PULL_TTL_SECONDS, "direct pull intent TTL is invalid");
  invariant(intent.consumed === false, "immutable direct pull intent must begin unconsumed");

  rejectUnknownKeys(intent.authorization, ["authorizedPriceUsdcRaw", "feeAuthorization"], "direct pull authorization");
  const authorizedPrice = canonicalUint(intent.authorization.authorizedPriceUsdcRaw, "authorized pack price");
  invariant(authorizedPrice > 0n, "authorized pack price must be nonzero");
  invariant(["reviewed-default-cap", "explicit-user-cap"].includes(intent.authorization.feeAuthorization), "direct pull fee authorization is invalid");

  rejectUnknownKeys(intent.pack, [
    "packIndex", "priceUsdcRaw", "expectedOfferHash", "acceptedCeilingBps",
    "entropyFeeObservedWei", "entropyFeeCapWei", "claimCapabilitySecret", "userRandomNumber",
  ], "direct pull pack");
  invariant(Number.isSafeInteger(intent.pack.packIndex) && intent.pack.packIndex >= 0, "direct pull pack index is malformed");
  const price = canonicalUint(intent.pack.priceUsdcRaw, "direct pull pack price");
  const ceiling = canonicalUint(intent.pack.acceptedCeilingBps, "direct pull accepted ceiling");
  const observedFee = canonicalUint(intent.pack.entropyFeeObservedWei, "direct pull observed Entropy fee");
  const feeCap = canonicalUint(intent.pack.entropyFeeCapWei, "direct pull Entropy fee cap");
  invariant(price === authorizedPrice && price > 0n, "direct pull contract price differs from the user-authorized price");
  invariant(
    intent.pack.packIndex < DEPLOYMENT_POLICY.productTerms.packPricesUsdcRaw.length
      && price === BigInt(DEPLOYMENT_POLICY.productTerms.packPricesUsdcRaw[intent.pack.packIndex]),
    "direct pull pack index does not map to the user-authorized deployed price",
  );
  invariant(ceiling > 0n && observedFee > 0n && feeCap >= observedFee, "direct pull pack terms or Entropy fee cap are invalid");
  if (intent.authorization.feeAuthorization === "reviewed-default-cap") {
    invariant(feeCap === DEFAULT_DIRECT_ENTROPY_FEE_CAP_WEI, "default direct pull fee cap differs from reviewed policy");
  } else {
    invariant(feeCap <= MAX_EXPLICIT_DIRECT_ENTROPY_FEE_CAP_WEI, "explicit direct pull fee cap exceeds the planner maximum");
  }
  canonicalBytes32(intent.pack.expectedOfferHash, "direct pull expected offer hash");
  canonicalBytes32(intent.pack.claimCapabilitySecret, "direct pull claim capability secret");
  canonicalBytes32(intent.pack.userRandomNumber, "direct pull user randomness");
  invariant(!/^0x0{64}$/.test(intent.pack.claimCapabilitySecret), "direct pull claim capability secret cannot be zero");
  invariant(!/^0x0{64}$/.test(intent.pack.userRandomNumber), "direct pull user randomness cannot be zero");
  invariant(
    directUserRandomNumber(intent.pack.claimCapabilitySecret) === intent.pack.userRandomNumber,
    "direct pull user randomness is not committed to the claim capability secret",
  );

  rejectUnknownKeys(intent.preflight, ["baseUsdcRaw", "baseEthWei", "allowanceUsdcRaw", "walletRequestCount"], "direct pull preflight");
  const baseUsdc = canonicalUint(intent.preflight.baseUsdcRaw, "direct pull preflight USDC");
  const baseEth = canonicalUint(intent.preflight.baseEthWei, "direct pull preflight ETH");
  canonicalUint(intent.preflight.allowanceUsdcRaw, "direct pull preflight allowance");
  canonicalUint(intent.preflight.walletRequestCount, "direct pull preflight request count");
  invariant(baseUsdc >= price, "direct pull preflight does not cover the pack price");
  invariant(baseEth >= observedFee, "direct pull preflight does not cover the observed Entropy fee");

  rejectUnknownKeys(intent.approvalPolicy, ["token", "spender", "exactAmountUsdcRaw", "resetMismatchedNonzeroFirst"], "direct pull approval policy");
  invariant(intent.approvalPolicy.token === normalizeAddress(intent.approvalPolicy.token), "direct pull approval token must be canonical lowercase");
  invariant(intent.approvalPolicy.spender === normalizeAddress(intent.approvalPolicy.spender), "direct pull approval spender must be canonical lowercase");
  invariant(intent.approvalPolicy.token === DIRECT_USDC, "direct pull approval token is not canonical Base USDC");
  invariant(intent.approvalPolicy.spender === DIRECT_GACHA, "direct pull approval spender is not the verified StonkGacha deployment");
  invariant(canonicalUint(intent.approvalPolicy.exactAmountUsdcRaw, "direct pull exact approval") === price, "direct pull approval amount differs from the pack price");
  invariant(intent.approvalPolicy.resetMismatchedNonzeroFirst === true, "direct pull approval policy must reset a mismatched nonzero allowance first");

  rejectUnknownKeys(intent.deliveryPolicy, ["recipient", "slippageBps"], "direct pull delivery policy");
  invariant(intent.deliveryPolicy.recipient === intent.wallet, "direct pull delivery recipient must be the active wallet");
  invariant(intent.deliveryPolicy.slippageBps === DIRECT_CLAIM_SLIPPAGE_BPS, "direct pull delivery slippage differs from policy");
  invariant(JSON.stringify(intent.allowedActions) === JSON.stringify([
    "conditional-allowance-reset",
    "exact-usdc-approval",
    "open-pack",
    "same-request-claim-prize",
  ]), "direct pull intent has an unsupported action set");
  return intent;
}

export function encodeDirectPullIntent(intent) {
  const bytes = canonicalBytes(validateDirectPullIntent(intent));
  invariant(bytes.length <= MAX_OPAQUE_JSON_BYTES, "direct pull intent exceeds 64 KiB");
  return bytesToHex(bytes);
}

export function decodeDirectPullIntent(value) {
  return validateDirectPullIntent(decodeCanonicalJson(value, "direct pull intent"));
}

export function directPullIntentKey(intent) {
  return keccak256(canonicalBytes(validateDirectPullIntent(intent)));
}

export function assessDirectPullIntent(intentValue, fresh) {
  const intent = validateDirectPullIntent(intentValue);
  const issues = [];
  const compare = (condition, code, detail) => {
    if (!condition) issues.push({ code, detail });
  };
  let wallet;
  try { wallet = normalizeAddress(fresh.wallet); } catch { wallet = null; }
  compare(wallet === intent.wallet, "wallet-changed", "active wallet differs from the direct pull intent");
  compare(Number(fresh.packIndex) === intent.pack.packIndex, "pack-changed", "pack index differs from the direct pull intent");
  compare(BigInt(fresh.authorizedPriceUsdcRaw) === BigInt(intent.authorization.authorizedPriceUsdcRaw), "authorization-price-changed", "user-authorized price differs from the direct pull intent");
  compare(BigInt(fresh.timestamp) >= BigInt(intent.createdAt), "not-yet-valid", "direct pull intent creation time is in the future");
  compare(BigInt(fresh.timestamp) < BigInt(intent.expiresAt), "expired", "direct pull intent expired");
  compare(fresh.salesPaused === false, "sales-paused", "new pack sales are paused");
  compare(BigInt(fresh.packPriceUsdcRaw) === BigInt(intent.pack.priceUsdcRaw), "price-changed", "live pack price differs from the direct pull intent");
  compare(String(fresh.offerHash).toLowerCase() === intent.pack.expectedOfferHash, "offer-changed", "live offer hash differs from the direct pull intent");
  compare(String(fresh.computedOfferHash).toLowerCase() === intent.pack.expectedOfferHash, "offer-invalid", "live offer hash is not locally reproducible");
  compare(BigInt(fresh.ceilingBps) === BigInt(intent.pack.acceptedCeilingBps), "ceiling-changed", "live ceiling differs from the direct pull intent");
  compare(BigInt(fresh.entropyFeeWei) <= BigInt(intent.pack.entropyFeeCapWei), "fee-cap-exceeded", "live Entropy fee exceeds the direct pull intent cap");
  compare(BigInt(fresh.usdcBalance) >= BigInt(intent.pack.priceUsdcRaw), "usdc-balance", "canonical Base USDC no longer covers the pack price");
  compare(BigInt(fresh.ethBalance) >= BigInt(fresh.entropyFeeWei), "native-balance", "native Base ETH no longer covers the live Entropy fee");
  compare(BigInt(fresh.requestCount) === BigInt(intent.preflight.walletRequestCount), "request-count-changed", "wallet request count changed after the intent was created");
  if (fresh.token !== undefined) {
    let token;
    try { token = normalizeAddress(fresh.token); } catch { token = null; }
    compare(token === intent.approvalPolicy.token, "approval-token-changed", "approval token differs from the direct pull intent");
  }
  if (fresh.spender !== undefined) {
    let spender;
    try { spender = normalizeAddress(fresh.spender); } catch { spender = null; }
    compare(spender === intent.approvalPolicy.spender, "approval-spender-changed", "approval spender differs from the direct pull intent");
  }
  return { ok: issues.length === 0, issues };
}

export function createDirectClaimContinuation({
  wallet,
  requestId,
  directPullIntentKey: sourceIntentKey,
  openTransactionHash,
  openInspectionKey,
  openInspectionContextHex,
  createdAt,
  expiresAt,
}) {
  return validateDirectClaimContinuation(jsonValue({
    schemaVersion: 1,
    kind: DIRECT_CLAIM_KIND,
    wallet: normalizeAddress(wallet),
    chainId: 8453,
    requestId: BigInt(requestId),
    createdAt: BigInt(createdAt),
    expiresAt: BigInt(expiresAt),
    sourceOpenProof: {
      directPullIntentKey: String(sourceIntentKey).toLowerCase(),
      transactionHash: String(openTransactionHash).toLowerCase(),
      inspectionKey: String(openInspectionKey).toLowerCase(),
      inspectionContextHex: String(openInspectionContextHex).toLowerCase(),
    },
    deliveryPolicy: {
      recipient: normalizeAddress(wallet),
      slippageBps: DIRECT_CLAIM_SLIPPAGE_BPS,
    },
  }));
}

export function validateDirectClaimContinuation(continuation) {
  rejectUnknownKeys(continuation, [
    "schemaVersion", "kind", "wallet", "chainId", "requestId", "createdAt", "expiresAt",
    "sourceOpenProof", "deliveryPolicy",
  ], "direct claim continuation");
  invariant(continuation.schemaVersion === 1 && continuation.kind === DIRECT_CLAIM_KIND, "unsupported direct claim continuation schema");
  invariant(continuation.wallet === normalizeAddress(continuation.wallet), "direct claim wallet must be canonical lowercase");
  invariant(continuation.chainId === 8453, "direct claim continuation is not for Base");
  const requestId = canonicalUint(continuation.requestId, "direct claim request id");
  const created = canonicalUint(continuation.createdAt, "direct claim createdAt");
  const expiry = canonicalUint(continuation.expiresAt, "direct claim expiresAt");
  invariant(requestId > 0n, "direct claim request id must be nonzero");
  invariant(expiry > created && expiry - created <= DIRECT_CLAIM_TTL_SECONDS, "direct claim continuation TTL is invalid");

  rejectUnknownKeys(continuation.sourceOpenProof, [
    "directPullIntentKey", "transactionHash", "inspectionKey", "inspectionContextHex",
  ], "direct claim source proof");
  canonicalBytes32(continuation.sourceOpenProof.directPullIntentKey, "direct claim source intent key");
  canonicalBytes32(continuation.sourceOpenProof.transactionHash, "direct claim open transaction hash");
  canonicalBytes32(continuation.sourceOpenProof.inspectionKey, "direct claim open inspection key");
  canonicalOpaqueHex(continuation.sourceOpenProof.inspectionContextHex, "direct claim open inspection context");

  rejectUnknownKeys(continuation.deliveryPolicy, ["recipient", "slippageBps"], "direct claim delivery policy");
  invariant(continuation.deliveryPolicy.recipient === continuation.wallet, "direct claim recipient must be the active wallet");
  invariant(continuation.deliveryPolicy.slippageBps === DIRECT_CLAIM_SLIPPAGE_BPS, "direct claim slippage differs from policy");
  return continuation;
}

export function encodeDirectClaimContinuation(continuation) {
  const bytes = canonicalBytes(validateDirectClaimContinuation(continuation));
  invariant(bytes.length <= MAX_OPAQUE_JSON_BYTES, "direct claim continuation exceeds 64 KiB");
  return bytesToHex(bytes);
}

export function decodeDirectClaimContinuation(value) {
  return validateDirectClaimContinuation(decodeCanonicalJson(value, "direct claim continuation"));
}

export function directClaimContinuationKey(continuation) {
  return keccak256(canonicalBytes(validateDirectClaimContinuation(continuation)));
}

export function assessDirectClaimContinuation(continuationValue, fresh) {
  const continuation = validateDirectClaimContinuation(continuationValue);
  const issues = [];
  const compare = (condition, code, detail) => {
    if (!condition) issues.push({ code, detail });
  };
  let wallet;
  try { wallet = normalizeAddress(fresh.wallet); } catch { wallet = null; }
  let recipient;
  try { recipient = normalizeAddress(fresh.recipient); } catch { recipient = null; }
  compare(wallet === continuation.wallet, "wallet-changed", "active wallet differs from the direct claim continuation");
  compare(BigInt(fresh.requestId) === BigInt(continuation.requestId), "request-changed", "request id differs from the receipt-bound continuation");
  compare(BigInt(fresh.timestamp) >= BigInt(continuation.createdAt), "not-yet-valid", "direct claim continuation creation time is in the future");
  compare(BigInt(fresh.timestamp) < BigInt(continuation.expiresAt), "expired", "direct claim continuation expired");
  compare(recipient === continuation.deliveryPolicy.recipient, "recipient-changed", "claim recipient differs from the direct claim continuation");
  compare(Number(fresh.slippageBps) === continuation.deliveryPolicy.slippageBps, "slippage-changed", "claim slippage differs from the direct claim continuation");
  return { ok: issues.length === 0, issues };
}
