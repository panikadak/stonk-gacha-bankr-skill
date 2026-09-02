import { readFileSync } from "node:fs";
import { formatUnits, jsonValue, normalizeAddress, parseUnits } from "./abi.mjs";
import { DIRECT_CLAIM_SLIPPAGE_BPS, directUserRandomNumber } from "./direct.mjs";
import { keccak256 } from "./keccak256.mjs";

export const FUNDING_POLICY = JSON.parse(
  readFileSync(new URL("../../references/funding-policy.json", import.meta.url), "utf8"),
);

export const FUNDING_KIND = "stonk-gacha-funded-open/v2";
export const REMAINING_OPEN_KIND = "stonk-gacha-remaining-open/v2";
export const X_PENDING_KIND = "stonk-gacha-x-pending/v1";
export const NATIVE_SENTINEL = normalizeAddress(FUNDING_POLICY.walletApi.nativeTokenSentinel);
export const FUNDING_USDC = normalizeAddress(FUNDING_POLICY.canonicalAssets.usdc.address);
export const FUNDING_WETH = normalizeAddress(FUNDING_POLICY.canonicalAssets.weth.address);
export const DEFAULT_NATIVE_HEADROOM_WEI = BigInt(FUNDING_POLICY.combinedOpen.defaultNativeHeadroomWei);
export const MIN_NATIVE_HEADROOM_WEI = BigInt(FUNDING_POLICY.combinedOpen.minimumNativeHeadroomWei);
export const MAX_NATIVE_HEADROOM_WEI = BigInt(FUNDING_POLICY.combinedOpen.maximumNativeHeadroomWei);
export const DEFAULT_INTENT_TTL_SECONDS = BigInt(FUNDING_POLICY.combinedOpen.intentTtlSeconds);
export const MAX_INTENT_TTL_SECONDS = BigInt(FUNDING_POLICY.combinedOpen.maximumIntentTtlSeconds);

const MAX_OPAQUE_JSON_BYTES = 65_536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const X_ID = /^[1-9][0-9]{0,24}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const DELIVERY_ALLOWED_ACTIONS = [
  "conditional-allowance-reset",
  "exact-usdc-approval",
  "open-pack",
  "same-request-claim-prize",
];

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
  invariant(typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(value), `${label} must be non-empty even-length hex`);
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

function canonicalUuid(value, label) {
  invariant(typeof value === "string" && UUID.test(value), `${label} must be a UUID`);
  return value.toLowerCase();
}

function optionalOpaqueId(value, label) {
  if (value === undefined || value === null || value === "") return null;
  invariant(typeof value === "string" && OPAQUE_ID.test(value), `${label} is malformed`);
  return value;
}

function sourceDetails(sourceToken) {
  const normalized = String(sourceToken).toUpperCase();
  invariant(FUNDING_POLICY.combinedOpen.allowedSources.includes(normalized), "source token must be explicitly selected as ETH or WETH");
  if (normalized === "ETH") {
    return { symbol: "ETH", kind: "native", address: NATIVE_SENTINEL, decimals: 18 };
  }
  return { symbol: "WETH", kind: "erc20", address: FUNDING_WETH, decimals: 18 };
}

function boundedSlippage(value, label) {
  const numeric = Number(value);
  invariant(Number.isInteger(numeric) && numeric >= 10 && numeric <= 2_000, `${label} must be 10..2000 bps`);
  return numeric;
}

function ceilDiv(numerator, denominator) {
  invariant(numerator >= 0n && denominator > 0n, "ceilDiv inputs are invalid");
  return (numerator + denominator - 1n) / denominator;
}

function exactFloorQuote({ quotedBuyAmountRaw, minimumBuyAmountRaw, requiredMinimumRaw, slippageBps, label }) {
  const quoted = BigInt(quotedBuyAmountRaw);
  const minimum = BigInt(minimumBuyAmountRaw);
  const required = BigInt(requiredMinimumRaw);
  const slippage = BigInt(boundedSlippage(slippageBps, `${label} slippage`));
  invariant(minimum === required, `${label} minimum output must equal the exact required deficit or shortfall`);
  invariant(quoted >= minimum, `${label} quoted output is below its minimum output`);
  const maximumQuoteForExactFloor = ceilDiv(required * 10_000n, 10_000n - slippage);
  invariant(quoted <= maximumQuoteForExactFloor, `${label} quote is oversized for the exact required deficit or shortfall`);
  return quoted;
}

function swapLeg({
  purpose,
  fromToken,
  toToken,
  amountRaw,
  amountDecimals,
  minBuyAmountRaw,
  minBuyDecimals,
  quotedBuyAmountRaw,
  slippageBps,
  quoteId,
  idempotencyKey,
}) {
  const amount = formatUnits(amountRaw, amountDecimals);
  const minBuyAmount = formatUnits(minBuyAmountRaw, minBuyDecimals);
  const quotedBuyAmount = formatUnits(quotedBuyAmountRaw, minBuyDecimals);
  const body = {
    fromChain: "base",
    fromToken,
    toChain: "base",
    toToken,
    amount,
    minBuyAmount,
    slippageBps: boundedSlippage(slippageBps, `${purpose} slippage`),
    ...(quoteId ? { quoteId: optionalOpaqueId(quoteId, `${purpose} quote id`) } : {}),
    idempotencyKey: canonicalUuid(idempotencyKey, `${purpose} idempotency key`),
  };
  return {
    purpose,
    fromChain: "base",
    fromToken,
    toChain: "base",
    toToken,
    amount,
    maxSellAmountRaw: amountRaw.toString(),
    minBuyAmount,
    minBuyAmountRaw: minBuyAmountRaw.toString(),
    quotedBuyAmount,
    quotedBuyAmountRaw: quotedBuyAmountRaw.toString(),
    slippageBps: body.slippageBps,
    quoteId: body.quoteId ?? null,
    idempotencyKey: body.idempotencyKey,
    bankr: {
      method: FUNDING_POLICY.walletApi.swap.method,
      path: FUNDING_POLICY.walletApi.swap.path,
      body,
    },
  };
}

export function exactUsdcDeficit(currentBalance, requiredBalance) {
  const current = BigInt(currentBalance);
  const required = BigInt(requiredBalance);
  invariant(current >= 0n && required > 0n, "USDC balance and requirement are invalid");
  return required > current ? required - current : 0n;
}

export function fundingSourceOptions({ usdcBalance, packPriceUsdc, ethBalance, wethBalance, entropyFeeWei, nativeHeadroomWei = DEFAULT_NATIVE_HEADROOM_WEI }) {
  const deficit = exactUsdcDeficit(usdcBalance, packPriceUsdc);
  const eth = BigInt(ethBalance);
  const weth = BigInt(wethBalance);
  const fee = BigInt(entropyFeeWei);
  const headroom = BigInt(nativeHeadroomWei);
  invariant(headroom >= MIN_NATIVE_HEADROOM_WEI && headroom <= MAX_NATIVE_HEADROOM_WEI, "native headroom is outside policy bounds");
  const nativeReserve = fee + headroom;
  const ethMaxSell = eth > nativeReserve ? eth - nativeReserve : 0n;
  const nativeShortfall = eth < nativeReserve ? nativeReserve - eth : 0n;
  return jsonValue({
    exactDeficitUsdcRaw: deficit,
    exactDeficitUsdc: formatUnits(deficit, 6),
    nativeFeeWei: fee,
    nativeHeadroomWei: headroom,
    nativeReserveWei: nativeReserve,
    baseBalances: { usdcRaw: BigInt(usdcBalance), ethWei: eth, wethWei: weth },
    choices: [
      {
        sourceToken: "ETH",
        sourceChain: "base",
        balanceWei: eth,
        maximumSwappableWei: ethMaxSell,
        eligible: deficit > 0n && ethMaxSell > 0n,
        reserveRule: "leave live Entropy fee cap plus native headroom unsold",
      },
      {
        sourceToken: "WETH",
        sourceChain: "base",
        balanceWei: weth,
        maximumSwappableWei: weth,
        eligible: deficit > 0n && weth > 0n,
        nativeTopUpRequired: nativeShortfall > 0n,
        minimumNativeTopUpWei: nativeShortfall,
        reserveRule: "WETH never counts as msg.value; preserve Base ETH and add a bounded WETH-to-native leg when needed",
      },
    ],
  });
}

export function createFundingIntent({
  wallet,
  packIndex,
  packPriceUsdc,
  usdcBalance,
  ethBalance,
  wethBalance,
  allowance,
  requestCount,
  spender,
  expectedOfferHash,
  acceptedCeilingBps,
  entropyFeeWei,
  nativeHeadroomWei = DEFAULT_NATIVE_HEADROOM_WEI,
  sourceToken,
  sourceAmountRaw,
  minUsdcOutRaw,
  quotedUsdcOutRaw,
  swapSlippageBps,
  quoteId = null,
  swapIdempotencyKey,
  nativeSourceAmountRaw = null,
  minNativeOutWei = null,
  quotedNativeOutWei = null,
  nativeSwapSlippageBps = null,
  nativeQuoteId = null,
  nativeSwapIdempotencyKey = null,
  claimCapabilitySecret,
  createdAt,
  expiresAt,
}) {
  const account = normalizeAddress(wallet);
  const source = sourceDetails(sourceToken);
  const price = BigInt(packPriceUsdc);
  const currentUsdc = BigInt(usdcBalance);
  const currentEth = BigInt(ethBalance);
  const currentWeth = BigInt(wethBalance);
  const currentAllowance = BigInt(allowance);
  const baselineRequests = BigInt(requestCount);
  const feeCap = BigInt(entropyFeeWei);
  const headroom = BigInt(nativeHeadroomWei);
  const sellAmount = BigInt(sourceAmountRaw);
  const minimumUsdc = BigInt(minUsdcOutRaw);
  const quotedUsdc = BigInt(quotedUsdcOutRaw);
  const created = BigInt(createdAt);
  const expiry = BigInt(expiresAt);
  const deficit = exactUsdcDeficit(currentUsdc, price);
  const capability = canonicalBytes32(String(claimCapabilitySecret).toLowerCase(), "funding claim capability secret");
  const userRandomNumber = directUserRandomNumber(capability);

  invariant(Number.isSafeInteger(packIndex) && packIndex >= 0, "pack index is invalid");
  invariant(deficit > 0n, "funding intent requires a current USDC deficit");
  invariant(feeCap > 0n, "Entropy fee cap must be nonzero");
  invariant(headroom >= MIN_NATIVE_HEADROOM_WEI && headroom <= MAX_NATIVE_HEADROOM_WEI, "native headroom is outside policy bounds");
  invariant(sellAmount > 0n, "source amount must be nonzero");
  exactFloorQuote({
    quotedBuyAmountRaw: quotedUsdc,
    minimumBuyAmountRaw: minimumUsdc,
    requiredMinimumRaw: deficit,
    slippageBps: swapSlippageBps,
    label: "Base USDC funding",
  });
  invariant(created > 0n && expiry > created, "funding intent expiry must be after creation");
  invariant(expiry - created <= MAX_INTENT_TTL_SECONDS, "funding intent exceeds the maximum TTL");
  invariant(typeof userRandomNumber === "string" && BYTES32.test(userRandomNumber) && !/^0x0{64}$/.test(userRandomNumber), "user randomness must be a nonzero lowercase bytes32");
  canonicalBytes32(expectedOfferHash, "expected offer hash");
  invariant(BigInt(acceptedCeilingBps) > 0n, "accepted ceiling must be nonzero");

  const reserve = feeCap + headroom;
  const nativeShortfall = currentEth < reserve ? reserve - currentEth : 0n;
  const legs = [];
  let nativeTopUpSell = 0n;

  if (source.symbol === "ETH") {
    invariant(nativeSourceAmountRaw === null && minNativeOutWei === null && quotedNativeOutWei === null && nativeSwapSlippageBps === null && nativeSwapIdempotencyKey === null && nativeQuoteId === null, "ETH source cannot include a WETH native-top-up leg");
    const maxSell = currentEth > reserve ? currentEth - reserve : 0n;
    invariant(sellAmount <= maxSell, "ETH source amount would spend the Entropy fee cap or native headroom");
  } else if (nativeShortfall > 0n) {
    invariant(nativeSourceAmountRaw !== null && minNativeOutWei !== null && nativeSwapIdempotencyKey !== null, "WETH source requires a native top-up leg when Base ETH is below fee cap plus headroom");
    nativeTopUpSell = BigInt(nativeSourceAmountRaw);
    const minimumNative = BigInt(minNativeOutWei);
    const quotedNative = BigInt(quotedNativeOutWei);
    invariant(nativeTopUpSell > 0n, "native top-up WETH amount must be nonzero");
    exactFloorQuote({
      quotedBuyAmountRaw: quotedNative,
      minimumBuyAmountRaw: minimumNative,
      requiredMinimumRaw: nativeShortfall,
      slippageBps: nativeSwapSlippageBps,
      label: "native top-up",
    });
    invariant(canonicalUuid(nativeSwapIdempotencyKey, "native top-up idempotency key") !== canonicalUuid(swapIdempotencyKey, "USDC swap idempotency key"), "swap legs require distinct idempotency keys");
    legs.push(swapLeg({
      purpose: "native-top-up",
      fromToken: FUNDING_WETH,
      toToken: NATIVE_SENTINEL,
      amountRaw: nativeTopUpSell,
      amountDecimals: 18,
      minBuyAmountRaw: minimumNative,
      minBuyDecimals: 18,
      quotedBuyAmountRaw: quotedNative,
      slippageBps: nativeSwapSlippageBps,
      quoteId: nativeQuoteId,
      idempotencyKey: nativeSwapIdempotencyKey,
    }));
  } else {
    invariant(nativeSourceAmountRaw === null && minNativeOutWei === null && quotedNativeOutWei === null && nativeSwapSlippageBps === null && nativeSwapIdempotencyKey === null && nativeQuoteId === null, "native top-up leg is forbidden when Base ETH already covers fee cap plus headroom");
  }

  if (source.symbol === "WETH") {
    invariant(sellAmount + nativeTopUpSell <= currentWeth, "aggregate WETH funding legs exceed the pinned Base WETH balance");
  }

  legs.push(swapLeg({
    purpose: "usdc-deficit",
    fromToken: source.address,
    toToken: FUNDING_USDC,
    amountRaw: sellAmount,
    amountDecimals: source.decimals,
    minBuyAmountRaw: minimumUsdc,
    minBuyDecimals: 6,
    quotedBuyAmountRaw: quotedUsdc,
    slippageBps: swapSlippageBps,
    quoteId,
    idempotencyKey: swapIdempotencyKey,
  }));

  const aggregateSourceSpend = sellAmount + nativeTopUpSell;
  return jsonValue({
    schemaVersion: 2,
    kind: FUNDING_KIND,
    stage: "fund-and-open",
    wallet: account,
    chainId: 8453,
    createdAt: created,
    expiresAt: expiry,
    pack: {
      packIndex,
      priceUsdcRaw: price,
      expectedOfferHash,
      acceptedCeilingBps: BigInt(acceptedCeilingBps),
      entropyFeeCapWei: feeCap,
      claimCapabilitySecret: capability,
      userRandomNumber,
    },
    preflight: {
      fundingPriceUsdcRaw: price,
      fundingEntropyFeeCapWei: feeCap,
      baseUsdcRaw: currentUsdc,
      exactDeficitUsdcRaw: deficit,
      baseEthWei: currentEth,
      baseWethWei: currentWeth,
      nativeHeadroomWei: headroom,
      allowanceUsdcRaw: currentAllowance,
      walletRequestCount: baselineRequests,
    },
    remainingPreflight: null,
    source: {
      chain: "base",
      token: source.symbol,
      kind: source.kind,
      address: source.address,
      aggregateMaximumInputRaw: aggregateSourceSpend,
      aggregateMaximumInput: formatUnits(aggregateSourceSpend, 18),
    },
    minimumBaseUsdcOutputRaw: minimumUsdc,
    fundingLegs: legs,
    approvalPolicy: {
      token: FUNDING_USDC,
      spender: normalizeAddress(spender),
      exactAmountUsdcRaw: price,
      resetMismatchedNonzeroFirst: true,
    },
    deliveryPolicy: {
      recipient: account,
      slippageBps: DIRECT_CLAIM_SLIPPAGE_BPS,
    },
    allowedActions: DELIVERY_ALLOWED_ACTIONS,
    crossChainIncluded: false,
    consumed: false,
  });
}

export function rebaseFundingIntentForRemainingOpen(intent, {
  packPriceUsdc,
  expectedOfferHash,
  acceptedCeilingBps,
  entropyFeeWei,
  usdcBalance,
  ethBalance,
  allowance,
  requestCount,
  createdAt,
  expiresAt,
}) {
  const prior = validateFundingIntent(intent);
  const priorResumePreflight = prior.stage === "remaining-open" ? prior.remainingPreflight : prior.preflight;
  const price = BigInt(packPriceUsdc);
  const fee = BigInt(entropyFeeWei);
  const currentUsdc = BigInt(usdcBalance);
  const currentEth = BigInt(ethBalance);
  const currentAllowance = BigInt(allowance);
  const currentRequestCount = BigInt(requestCount);
  const created = BigInt(createdAt);
  const expiry = BigInt(expiresAt);
  invariant(price > 0n && fee > 0n, "remaining-open price and fee must be nonzero");
  invariant(currentUsdc >= price, "remaining-open intent requires enough canonical Base USDC");
  invariant(currentEth >= fee + BigInt(priorResumePreflight.nativeHeadroomWei), "remaining-open intent requires exact msg.value plus confirmed native headroom");
  invariant(currentRequestCount === BigInt(priorResumePreflight.walletRequestCount), "remaining-open intent cannot cross a changed wallet request count");
  invariant(created > 0n && expiry > created && expiry - created <= MAX_INTENT_TTL_SECONDS, "remaining-open intent TTL is invalid");
  canonicalBytes32(expectedOfferHash, "remaining-open expected offer hash");
  invariant(BigInt(acceptedCeilingBps) > 0n, "remaining-open ceiling must be nonzero");
  return validateFundingIntent(jsonValue({
    schemaVersion: 2,
    kind: REMAINING_OPEN_KIND,
    stage: "remaining-open",
    wallet: prior.wallet,
    chainId: 8453,
    createdAt: created,
    expiresAt: expiry,
    pack: {
      packIndex: prior.pack.packIndex,
      priceUsdcRaw: price,
      expectedOfferHash,
      acceptedCeilingBps: BigInt(acceptedCeilingBps),
      entropyFeeCapWei: fee,
      claimCapabilitySecret: prior.pack.claimCapabilitySecret,
      userRandomNumber: directUserRandomNumber(prior.pack.claimCapabilitySecret),
    },
    remainingPreflight: {
      baseUsdcRaw: currentUsdc,
      baseEthWei: currentEth,
      nativeHeadroomWei: BigInt(priorResumePreflight.nativeHeadroomWei),
      allowanceUsdcRaw: currentAllowance,
      walletRequestCount: currentRequestCount,
    },
    approvalPolicy: {
      token: FUNDING_USDC,
      spender: prior.approvalPolicy.spender,
      exactAmountUsdcRaw: price,
      resetMismatchedNonzeroFirst: true,
    },
    deliveryPolicy: prior.deliveryPolicy,
    allowedActions: DELIVERY_ALLOWED_ACTIONS,
    crossChainIncluded: false,
    consumed: false,
  }));
}

export function encodeFundingIntent(intent) {
  const validated = validateFundingIntent(intent);
  const bytes = canonicalBytes(validated);
  invariant(bytes.length <= MAX_OPAQUE_JSON_BYTES, "funding intent exceeds 64 KiB");
  return bytesToHex(bytes);
}

export function fundingIntentKey(intent) {
  return keccak256(canonicalBytes(validateFundingIntent(intent)));
}

export function decodeFundingIntent(value) {
  return validateFundingIntent(decodeCanonicalJson(value, "funding intent"));
}

export function validateFundingIntent(intent) {
  if (intent?.kind === REMAINING_OPEN_KIND) return validateRemainingOpenIntent(intent);
  return validateInitialFundingIntent(intent);
}

function validateRemainingOpenIntent(intent) {
  invariant(intent && typeof intent === "object" && !Array.isArray(intent), "remaining-open intent must be an object");
  rejectUnknownKeys(intent, [
    "schemaVersion", "kind", "stage", "wallet", "chainId", "createdAt", "expiresAt", "pack",
    "remainingPreflight", "approvalPolicy", "deliveryPolicy", "allowedActions", "crossChainIncluded", "consumed",
  ], "remaining-open intent");
  invariant(intent.schemaVersion === 2 && intent.kind === REMAINING_OPEN_KIND && intent.stage === "remaining-open", "unsupported remaining-open intent schema");
  invariant(intent.wallet === normalizeAddress(intent.wallet), "remaining-open wallet must be canonical lowercase");
  invariant(intent.chainId === 8453, "remaining-open intent is not for Base");
  const created = canonicalUint(intent.createdAt, "remaining-open createdAt");
  const expiry = canonicalUint(intent.expiresAt, "remaining-open expiresAt");
  invariant(expiry > created && expiry - created <= MAX_INTENT_TTL_SECONDS, "remaining-open intent TTL is invalid");
  invariant(intent.consumed === false && intent.crossChainIncluded === false, "remaining-open intent must begin unconsumed and contain no cross-chain authority");
  invariant(JSON.stringify(intent.allowedActions) === JSON.stringify(DELIVERY_ALLOWED_ACTIONS), "remaining-open intent has an unsupported action set");

  rejectUnknownKeys(intent.pack, ["packIndex", "priceUsdcRaw", "expectedOfferHash", "acceptedCeilingBps", "entropyFeeCapWei", "claimCapabilitySecret", "userRandomNumber"], "remaining-open pack");
  invariant(Number.isSafeInteger(intent.pack.packIndex) && intent.pack.packIndex >= 0, "remaining-open pack index is malformed");
  const price = canonicalUint(intent.pack.priceUsdcRaw, "remaining-open pack price");
  canonicalBytes32(intent.pack.expectedOfferHash, "remaining-open expected offer hash");
  const ceiling = canonicalUint(intent.pack.acceptedCeilingBps, "remaining-open accepted ceiling");
  const feeCap = canonicalUint(intent.pack.entropyFeeCapWei, "remaining-open Entropy fee cap");
  invariant(price > 0n && ceiling > 0n && feeCap > 0n, "remaining-open pack terms must be nonzero");
  canonicalBytes32(intent.pack.claimCapabilitySecret, "remaining-open claim capability secret");
  canonicalBytes32(intent.pack.userRandomNumber, "remaining-open user randomness");
  invariant(!/^0x0{64}$/.test(intent.pack.claimCapabilitySecret), "remaining-open claim capability secret cannot be zero");
  invariant(!/^0x0{64}$/.test(intent.pack.userRandomNumber), "remaining-open user randomness cannot be zero");
  invariant(directUserRandomNumber(intent.pack.claimCapabilitySecret) === intent.pack.userRandomNumber, "remaining-open user randomness is not committed to the claim capability secret");

  rejectUnknownKeys(intent.remainingPreflight, ["baseUsdcRaw", "baseEthWei", "nativeHeadroomWei", "allowanceUsdcRaw", "walletRequestCount"], "remaining-open preflight");
  const remaining = Object.fromEntries(
    ["baseUsdcRaw", "baseEthWei", "nativeHeadroomWei", "allowanceUsdcRaw", "walletRequestCount"]
      .map((key) => [key, canonicalUint(intent.remainingPreflight[key], `remainingPreflight.${key}`)]),
  );
  invariant(remaining.nativeHeadroomWei >= MIN_NATIVE_HEADROOM_WEI && remaining.nativeHeadroomWei <= MAX_NATIVE_HEADROOM_WEI, "remaining-open native headroom is outside policy bounds");
  invariant(remaining.baseUsdcRaw >= price, "remaining-open preflight does not cover the current pack price");
  invariant(remaining.baseEthWei >= feeCap + remaining.nativeHeadroomWei, "remaining-open preflight does not preserve exact msg.value plus native headroom");

  rejectUnknownKeys(intent.approvalPolicy, ["token", "spender", "exactAmountUsdcRaw", "resetMismatchedNonzeroFirst"], "remaining-open approval policy");
  invariant(intent.approvalPolicy.token === FUNDING_USDC, "remaining-open approval token is not canonical Base USDC");
  invariant(intent.approvalPolicy.spender === normalizeAddress(intent.approvalPolicy.spender), "remaining-open approval spender must be canonical lowercase");
  invariant(canonicalUint(intent.approvalPolicy.exactAmountUsdcRaw, "remaining-open approval exact amount") === price, "remaining-open approval amount differs from the pack price");
  invariant(intent.approvalPolicy.resetMismatchedNonzeroFirst === true, "remaining-open approval policy must reset a mismatched nonzero allowance first");
  rejectUnknownKeys(intent.deliveryPolicy, ["recipient", "slippageBps"], "remaining-open delivery policy");
  invariant(intent.deliveryPolicy.recipient === intent.wallet, "remaining-open delivery recipient must be the active wallet");
  invariant(intent.deliveryPolicy.slippageBps === DIRECT_CLAIM_SLIPPAGE_BPS, "remaining-open delivery slippage differs from policy");
  return intent;
}

function validateInitialFundingIntent(intent) {
  invariant(intent && typeof intent === "object" && !Array.isArray(intent), "funding intent must be an object");
  rejectUnknownKeys(intent, [
    "schemaVersion", "kind", "stage", "wallet", "chainId", "createdAt", "expiresAt", "pack", "preflight", "remainingPreflight",
    "source", "minimumBaseUsdcOutputRaw", "fundingLegs", "approvalPolicy", "deliveryPolicy", "allowedActions", "crossChainIncluded", "consumed",
  ], "funding intent");
  invariant(intent.schemaVersion === 2 && intent.kind === FUNDING_KIND, "unsupported funding intent schema");
  invariant(intent.stage === "fund-and-open", "unsupported funding intent stage");
  invariant(intent.wallet === normalizeAddress(intent.wallet), "funding intent wallet must be canonical lowercase");
  invariant(intent.chainId === 8453, "funding intent is not for Base");
  const created = canonicalUint(intent.createdAt, "createdAt");
  const expiry = canonicalUint(intent.expiresAt, "expiresAt");
  invariant(expiry > created && expiry - created <= MAX_INTENT_TTL_SECONDS, "funding intent TTL is invalid");
  invariant(intent.consumed === false, "immutable funding intent must begin unconsumed");
  invariant(intent.crossChainIncluded === false, "combined funding intent cannot contain a cross-chain leg");
  rejectUnknownKeys(intent.pack, ["packIndex", "priceUsdcRaw", "expectedOfferHash", "acceptedCeilingBps", "entropyFeeCapWei", "claimCapabilitySecret", "userRandomNumber"], "funding intent pack");
  invariant(intent.pack && Number.isSafeInteger(intent.pack.packIndex) && intent.pack.packIndex >= 0, "funding intent pack is malformed");
  const price = canonicalUint(intent.pack.priceUsdcRaw, "pack price");
  canonicalBytes32(intent.pack.expectedOfferHash, "expected offer hash");
  const ceiling = canonicalUint(intent.pack.acceptedCeilingBps, "accepted ceiling");
  const feeCap = canonicalUint(intent.pack.entropyFeeCapWei, "Entropy fee cap");
  invariant(price > 0n && ceiling > 0n && feeCap > 0n, "funding intent pack terms must be nonzero");
  canonicalBytes32(intent.pack.claimCapabilitySecret, "funding claim capability secret");
  canonicalBytes32(intent.pack.userRandomNumber, "user randomness");
  invariant(!/^0x0{64}$/.test(intent.pack.claimCapabilitySecret), "funding claim capability secret cannot be zero");
  invariant(!/^0x0{64}$/.test(intent.pack.userRandomNumber), "user randomness cannot be zero");
  invariant(directUserRandomNumber(intent.pack.claimCapabilitySecret) === intent.pack.userRandomNumber, "funding user randomness is not committed to the claim capability secret");
  invariant(intent.preflight && typeof intent.preflight === "object", "funding intent preflight is missing");
  rejectUnknownKeys(intent.preflight, ["fundingPriceUsdcRaw", "fundingEntropyFeeCapWei", "baseUsdcRaw", "exactDeficitUsdcRaw", "baseEthWei", "baseWethWei", "nativeHeadroomWei", "allowanceUsdcRaw", "walletRequestCount"], "funding intent preflight");
  const preflightValues = Object.fromEntries(
    ["fundingPriceUsdcRaw", "fundingEntropyFeeCapWei", "baseUsdcRaw", "exactDeficitUsdcRaw", "baseEthWei", "baseWethWei", "nativeHeadroomWei", "allowanceUsdcRaw", "walletRequestCount"]
      .map((key) => [key, canonicalUint(intent.preflight[key], `preflight.${key}`)]),
  );
  invariant(preflightValues.baseUsdcRaw < preflightValues.fundingPriceUsdcRaw, "funding intent does not begin with a USDC deficit");
  invariant(preflightValues.exactDeficitUsdcRaw === preflightValues.fundingPriceUsdcRaw - preflightValues.baseUsdcRaw, "funding intent exact USDC deficit is inconsistent");
  invariant(preflightValues.fundingEntropyFeeCapWei > 0n, "funding intent original Entropy fee cap must be nonzero");
  invariant(preflightValues.nativeHeadroomWei >= MIN_NATIVE_HEADROOM_WEI && preflightValues.nativeHeadroomWei <= MAX_NATIVE_HEADROOM_WEI, "funding intent native headroom is outside policy bounds");
  invariant(intent.remainingPreflight === null, "initial funding intent cannot contain a remaining-open preflight");
  invariant(price === preflightValues.fundingPriceUsdcRaw && feeCap === preflightValues.fundingEntropyFeeCapWei, "initial funding intent pack terms differ from its quote preflight");
  invariant(intent.source?.chain === "base" && ["ETH", "WETH"].includes(intent.source?.token), "funding intent source is not explicit Base ETH or WETH");
  rejectUnknownKeys(intent.source, ["chain", "token", "kind", "address", "aggregateMaximumInputRaw", "aggregateMaximumInput"], "funding intent source");
  const sourceAddress = normalizeAddress(intent.source.address);
  invariant(intent.source.address === sourceAddress, "funding intent source address must be canonical lowercase");
  invariant(sourceAddress === (intent.source.token === "ETH" ? NATIVE_SENTINEL : FUNDING_WETH), "funding intent source address is not canonical");
  invariant(intent.source.kind === (intent.source.token === "ETH" ? "native" : "erc20"), "funding intent source kind is inconsistent");
  const aggregateMaximum = canonicalUint(intent.source.aggregateMaximumInputRaw, "aggregate source maximum");
  const minimumBaseUsdc = canonicalUint(intent.minimumBaseUsdcOutputRaw, "minimum Base USDC output");
  invariant(aggregateMaximum > 0n && minimumBaseUsdc >= preflightValues.exactDeficitUsdcRaw, "funding intent source maximum or Base USDC floor is invalid");
  invariant(intent.source.aggregateMaximumInput === formatUnits(aggregateMaximum, 18), "funding intent aggregate source display is inconsistent");
  invariant(Array.isArray(intent.fundingLegs) && intent.fundingLegs.length >= 1 && intent.fundingLegs.length <= 2, "funding intent must have one or two bounded swap legs");
  const keys = new Set();
  for (const leg of intent.fundingLegs) {
    rejectUnknownKeys(leg, [
      "purpose", "fromChain", "fromToken", "toChain", "toToken", "amount", "maxSellAmountRaw",
      "minBuyAmount", "minBuyAmountRaw", "quotedBuyAmount", "quotedBuyAmountRaw",
      "slippageBps", "quoteId", "idempotencyKey", "bankr",
    ], "funding leg");
    invariant(["native-top-up", "usdc-deficit"].includes(leg.purpose), "funding leg purpose is invalid");
    invariant(leg.fromChain === "base" && leg.toChain === "base", "combined funding leg must stay on Base");
    invariant(leg.fromToken === normalizeAddress(leg.fromToken) && leg.toToken === normalizeAddress(leg.toToken), "funding leg token addresses must be canonical lowercase");
    const maximumSell = canonicalUint(leg.maxSellAmountRaw, "funding leg maximum sell");
    const minimumBuy = canonicalUint(leg.minBuyAmountRaw, "funding leg minimum buy");
    const quotedBuy = canonicalUint(leg.quotedBuyAmountRaw, "funding leg quoted buy");
    invariant(maximumSell > 0n && minimumBuy > 0n && quotedBuy >= minimumBuy, "funding leg amounts must be nonzero and internally ordered");
    boundedSlippage(leg.slippageBps, "funding leg slippage");
    optionalOpaqueId(leg.quoteId, "funding leg quote id");
    const key = canonicalUuid(leg.idempotencyKey, "funding leg idempotency key");
    invariant(!keys.has(key), "funding legs must use distinct idempotency keys");
    keys.add(key);
    rejectUnknownKeys(leg.bankr, ["method", "path", "body"], "Bankr swap envelope");
    rejectUnknownKeys(leg.bankr.body, ["fromChain", "fromToken", "toChain", "toToken", "amount", "minBuyAmount", "slippageBps", "quoteId", "idempotencyKey"], "Bankr swap body");
    invariant(leg.bankr?.method === "POST" && leg.bankr?.path === "/wallet/swap", "funding leg must use the structured Bankr swap endpoint");
    invariant(JSON.stringify(leg.bankr.body) === JSON.stringify({
      fromChain: leg.fromChain,
      fromToken: leg.fromToken,
      toChain: leg.toChain,
      toToken: leg.toToken,
      amount: leg.amount,
      minBuyAmount: leg.minBuyAmount,
      slippageBps: leg.slippageBps,
      ...(leg.quoteId ? { quoteId: leg.quoteId } : {}),
      idempotencyKey: leg.idempotencyKey,
    }), "Bankr swap body diverges from the bounded funding leg");
  }
  const usdcLegs = intent.fundingLegs.filter((leg) => leg.purpose === "usdc-deficit");
  const nativeLegs = intent.fundingLegs.filter((leg) => leg.purpose === "native-top-up");
  invariant(usdcLegs.length === 1 && normalizeAddress(usdcLegs[0].toToken) === FUNDING_USDC, "funding intent requires exactly one canonical Base USDC leg");
  invariant(nativeLegs.length <= 1 && nativeLegs.every((leg) => normalizeAddress(leg.fromToken) === FUNDING_WETH && normalizeAddress(leg.toToken) === NATIVE_SENTINEL), "native top-up must be canonical Base WETH to native ETH");
  const usdcLeg = usdcLegs[0];
  invariant(normalizeAddress(usdcLeg.fromToken) === sourceAddress, "USDC funding leg source differs from the selected source");
  invariant(BigInt(usdcLeg.minBuyAmountRaw) === minimumBaseUsdc, "USDC funding leg floor differs from the combined floor");
  invariant(minimumBaseUsdc === preflightValues.exactDeficitUsdcRaw, "USDC funding floor must equal the exact pinned deficit");
  invariant(usdcLeg.amount === formatUnits(usdcLeg.maxSellAmountRaw, 18), "USDC funding leg human amount is inconsistent");
  invariant(usdcLeg.minBuyAmount === formatUnits(usdcLeg.minBuyAmountRaw, 6), "USDC funding leg human floor is inconsistent");
  invariant(usdcLeg.quotedBuyAmount === formatUnits(usdcLeg.quotedBuyAmountRaw, 6), "USDC funding leg human quote is inconsistent");
  exactFloorQuote({
    quotedBuyAmountRaw: usdcLeg.quotedBuyAmountRaw,
    minimumBuyAmountRaw: usdcLeg.minBuyAmountRaw,
    requiredMinimumRaw: preflightValues.exactDeficitUsdcRaw,
    slippageBps: usdcLeg.slippageBps,
    label: "Base USDC funding",
  });
  const nativeReserve = preflightValues.fundingEntropyFeeCapWei + preflightValues.nativeHeadroomWei;
  const nativeShortfall = preflightValues.baseEthWei < nativeReserve ? nativeReserve - preflightValues.baseEthWei : 0n;
  if (intent.source.token === "ETH") {
    invariant(nativeLegs.length === 0, "ETH source cannot contain a native top-up leg");
    const maximumEthSell = preflightValues.baseEthWei > nativeReserve ? preflightValues.baseEthWei - nativeReserve : 0n;
    invariant(BigInt(usdcLeg.maxSellAmountRaw) <= maximumEthSell, "ETH funding leg spends the fee cap or native headroom");
    invariant(aggregateMaximum === BigInt(usdcLeg.maxSellAmountRaw), "ETH aggregate maximum is inconsistent");
  } else {
    invariant((nativeShortfall > 0n) === (nativeLegs.length === 1), "WETH native top-up presence does not match the pinned Base ETH shortfall");
    if (nativeLegs.length === 1) {
      const nativeLeg = nativeLegs[0];
      invariant(nativeLeg.amount === formatUnits(nativeLeg.maxSellAmountRaw, 18), "native top-up human amount is inconsistent");
      invariant(nativeLeg.minBuyAmount === formatUnits(nativeLeg.minBuyAmountRaw, 18), "native top-up human floor is inconsistent");
      invariant(nativeLeg.quotedBuyAmount === formatUnits(nativeLeg.quotedBuyAmountRaw, 18), "native top-up human quote is inconsistent");
      exactFloorQuote({
        quotedBuyAmountRaw: nativeLeg.quotedBuyAmountRaw,
        minimumBuyAmountRaw: nativeLeg.minBuyAmountRaw,
        requiredMinimumRaw: nativeShortfall,
        slippageBps: nativeLeg.slippageBps,
        label: "native top-up",
      });
    }
    const totalWeth = BigInt(usdcLeg.maxSellAmountRaw) + (nativeLegs[0] ? BigInt(nativeLegs[0].maxSellAmountRaw) : 0n);
    invariant(totalWeth === aggregateMaximum && totalWeth <= preflightValues.baseWethWei, "aggregate WETH maximum is inconsistent or exceeds balance");
  }
  invariant(intent.approvalPolicy?.token && intent.approvalPolicy.token === normalizeAddress(intent.approvalPolicy.token) && intent.approvalPolicy.token === FUNDING_USDC, "approval policy token is not canonical Base USDC");
  rejectUnknownKeys(intent.approvalPolicy, ["token", "spender", "exactAmountUsdcRaw", "resetMismatchedNonzeroFirst"], "approval policy");
  invariant(intent.approvalPolicy.spender === normalizeAddress(intent.approvalPolicy.spender), "approval policy spender must be canonical lowercase");
  invariant(canonicalUint(intent.approvalPolicy.exactAmountUsdcRaw, "approval exact amount") === price, "approval exact amount differs from the pack price");
  invariant(intent.approvalPolicy.resetMismatchedNonzeroFirst === true, "approval policy must reset mismatched nonzero allowance first");
  rejectUnknownKeys(intent.deliveryPolicy, ["recipient", "slippageBps"], "funding delivery policy");
  invariant(intent.deliveryPolicy.recipient === intent.wallet, "funding delivery recipient must be the active wallet");
  invariant(intent.deliveryPolicy.slippageBps === DIRECT_CLAIM_SLIPPAGE_BPS, "funding delivery slippage differs from policy");
  invariant(JSON.stringify(intent.allowedActions) === JSON.stringify(DELIVERY_ALLOWED_ACTIONS), "funding intent has an unsupported action set");
  return intent;
}

export function fundingResumeAssessment(intent, live) {
  const bound = validateFundingIntent(intent);
  const resumePreflight = bound.stage === "remaining-open" ? bound.remainingPreflight : bound.preflight;
  const issues = [];
  const add = (code, detail, reconfirmationRequired) => issues.push({ code, detail, reconfirmationRequired });
  if (normalizeAddress(live.wallet) !== bound.wallet) add("wallet-changed", "active linked wallet differs from the funding intent", true);
  if (Number(live.packIndex) !== bound.pack.packIndex) add("pack-changed", "pack index differs from the funding intent", true);
  if (BigInt(live.timestamp) >= BigInt(bound.expiresAt)) add("intent-expired", "funding intent expired", true);
  if (BigInt(live.walletRequestCount) !== BigInt(resumePreflight.walletRequestCount)) add("request-count-changed", "wallet request count changed after the funding intent was prepared; reconcile the prior open before creating a new intent", true);
  if (live.salesPaused) add("sales-paused", "new pack sales are paused", false);
  if (BigInt(live.packPriceUsdc) !== BigInt(bound.pack.priceUsdcRaw)) add("price-changed", "pack price changed", true);
  if (String(live.offerHash).toLowerCase() !== bound.pack.expectedOfferHash) add("offer-changed", "expected offer hash changed", true);
  if (String(live.computedOfferHash).toLowerCase() !== bound.pack.expectedOfferHash) add("offer-local-mismatch", "fresh local offer commitment does not equal the confirmed hash", true);
  if (BigInt(live.ceilingBps) !== BigInt(bound.pack.acceptedCeilingBps)) add("ceiling-changed", "cash-backed ceiling changed", true);
  if (BigInt(live.entropyFeeWei) > BigInt(bound.pack.entropyFeeCapWei)) add("fee-cap-exceeded", "live Entropy fee exceeds the confirmed cap", true);
  if (BigInt(live.usdcBalance) < BigInt(bound.pack.priceUsdcRaw)) add("usdc-still-short", "canonical Base USDC still does not cover the pack", false);
  if (BigInt(live.ethBalance) < BigInt(live.entropyFeeWei) + BigInt(resumePreflight.nativeHeadroomWei)) add("native-reserve-still-short", "native Base ETH still does not cover exact msg.value plus the confirmed headroom", false);
  return { ok: issues.length === 0, issues, reconfirmationRequired: issues.some((entry) => entry.reconfirmationRequired) };
}

function compactUint(value) {
  let hex = BigInt(value).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return Buffer.from(hex, "hex").toString("base64url");
}

function compactFundingTerms(intent, verb, compactAmounts = false) {
  const bound = validateFundingIntent(intent);
  const compactHex = (value) => Buffer.from(String(value).slice(2), "hex").toString("base64url");
  const key = compactHex(fundingIntentKey(bound));
  const price = formatUnits(bound.pack.priceUsdcRaw, 6);
  const fee = formatUnits(bound.pack.entropyFeeCapWei, 18);
  const initialFunding = bound.kind === FUNDING_KIND;
  const sourceCode = initialFunding && bound.source.token === "ETH" ? "E" : "W";
  const nativeLeg = initialFunding ? bound.fundingLegs.find((leg) => leg.purpose === "native-top-up") : null;
  const maximum = initialFunding
    ? compactAmounts
      ? compactUint(bound.source.aggregateMaximumInputRaw)
      : `${formatUnits(bound.source.aggregateMaximumInputRaw, 18)}${sourceCode}`
    : "";
  const minimumUsdc = initialFunding
    ? compactAmounts
      ? compactUint(bound.minimumBaseUsdcOutputRaw)
      : `${formatUnits(bound.minimumBaseUsdcOutputRaw, 6)}U`
    : "";
  const topUp = nativeLeg
    ? compactAmounts
      ? ` n64=${compactUint(nativeLeg.maxSellAmountRaw)}>${compactUint(nativeLeg.minBuyAmountRaw)}`
      : ` n=${nativeLeg.amount}W>${nativeLeg.minBuyAmount}E`
    : "";
  const feeDisplay = compactAmounts ? `f64=${compactUint(bound.pack.entropyFeeCapWei)}` : `f=${fee}E`;
  const ceilingDisplay = compactAmounts ? `c=${bound.pack.acceptedCeilingBps}` : `c=${bound.pack.acceptedCeilingBps}bp`;
  const action = bound.stage === "remaining-open" ? "approve+open+claim" : "swap+approve+open+claim";
  const funding = !initialFunding
    ? ""
    : ` s=B/${sourceCode} ${compactAmounts ? "m64" : "m"}=${maximum} ${compactAmounts ? "u64" : "u"}=${minimumUsdc}${topUp}`;
  return `@bankrbot ${verb} SG do=${action} w64=${compactHex(bound.wallet)} p=${bound.pack.packIndex}:${price}U${funding} h64=${compactHex(bound.pack.expectedOfferHash)} ${ceilingDisplay} ${feeDisplay} x=${bound.expiresAt} i64=${key}`;
}

export function xPreparedConfirmation(intent) {
  let text = `${compactFundingTerms(intent, "CONFIRM")} r=YES`;
  if ([...text].length > 280) text = `${compactFundingTerms(intent, "CONFIRM", true)} r=YES`;
  invariant([...text].length <= 280, `prepared X confirmation exceeds 280 characters (${[...text].length})`);
  return text;
}

export function xSelfContainedCommand(intent) {
  const preparedNeedsCompactAmounts = [...`${compactFundingTerms(intent, "CONFIRM")} r=YES`].length > 280;
  const text = compactFundingTerms(intent, "YES", preparedNeedsCompactAmounts);
  invariant([...text].length <= 280, `self-contained X command exceeds 280 characters (${[...text].length})`);
  return text;
}

export function bindXFundingIntent(intent, {
  confirmationTweetId,
  requesterXUserId,
  confirmationChannel,
  confirmationText,
}) {
  const economicIntent = validateFundingIntent(intent);
  invariant(X_ID.test(String(confirmationTweetId)), "confirmation tweet id must be a canonical numeric X id");
  invariant(X_ID.test(String(requesterXUserId)), "requester X user id must be a canonical numeric X id");
  invariant(confirmationChannel === "x", "confirmation must come from trusted X post metadata");
  invariant(confirmationText === xPreparedConfirmation(economicIntent), "posted confirmation text differs from the exact prepared X confirmation");
  return jsonValue({
    schemaVersion: 1,
    kind: X_PENDING_KIND,
    economicIntent,
    economicIntentKey: fundingIntentKey(economicIntent),
    confirmationTweetId: String(confirmationTweetId),
    confirmationChannel,
    confirmationText,
    requesterXUserId: String(requesterXUserId),
    wallet: economicIntent.wallet,
    packIndex: economicIntent.pack.packIndex,
    sourceToken: economicIntent.kind === FUNDING_KIND ? economicIntent.source.token : null,
    maximumSourceInputRaw: economicIntent.kind === FUNDING_KIND ? economicIntent.source.aggregateMaximumInputRaw : null,
    minimumBaseUsdcOutputRaw: economicIntent.kind === FUNDING_KIND ? economicIntent.minimumBaseUsdcOutputRaw : null,
    expectedOfferHash: economicIntent.pack.expectedOfferHash,
    acceptedCeilingBps: economicIntent.pack.acceptedCeilingBps,
    entropyFeeCapWei: economicIntent.pack.entropyFeeCapWei,
    expiresAt: economicIntent.expiresAt,
    selfContainedCommand: xSelfContainedCommand(economicIntent),
    consumed: false,
  });
}

export function validateXPendingIntent(pending) {
  invariant(pending && typeof pending === "object" && pending.schemaVersion === 1 && pending.kind === X_PENDING_KIND, "unsupported X pending intent schema");
  rejectUnknownKeys(pending, [
    "schemaVersion", "kind", "economicIntent", "economicIntentKey", "confirmationTweetId", "requesterXUserId",
    "confirmationChannel", "confirmationText",
    "wallet", "packIndex", "sourceToken", "maximumSourceInputRaw", "minimumBaseUsdcOutputRaw",
    "expectedOfferHash", "acceptedCeilingBps", "entropyFeeCapWei", "expiresAt", "selfContainedCommand", "consumed",
  ], "X pending intent");
  const economic = validateFundingIntent(pending.economicIntent);
  invariant(pending.economicIntentKey === fundingIntentKey(economic), "X pending intent economic key mismatch");
  invariant(X_ID.test(String(pending.confirmationTweetId)) && X_ID.test(String(pending.requesterXUserId)), "X pending ids are malformed");
  invariant(pending.confirmationChannel === "x", "X pending confirmation channel mismatch");
  invariant(pending.confirmationText === xPreparedConfirmation(economic), "X pending confirmation text mismatch");
  invariant(normalizeAddress(pending.wallet) === economic.wallet, "X pending wallet mismatch");
  invariant(pending.packIndex === economic.pack.packIndex, "X pending pack mismatch");
  const sourceToken = economic.kind === FUNDING_KIND ? economic.source.token : null;
  const maximumSourceInputRaw = economic.kind === FUNDING_KIND ? economic.source.aggregateMaximumInputRaw : null;
  const minimumBaseUsdcOutputRaw = economic.kind === FUNDING_KIND ? economic.minimumBaseUsdcOutputRaw : null;
  invariant(pending.sourceToken === sourceToken, "X pending source mismatch");
  invariant(pending.maximumSourceInputRaw === maximumSourceInputRaw, "X pending maximum input mismatch");
  invariant(pending.minimumBaseUsdcOutputRaw === minimumBaseUsdcOutputRaw, "X pending minimum output mismatch");
  invariant(pending.expectedOfferHash === economic.pack.expectedOfferHash, "X pending offer hash mismatch");
  invariant(pending.acceptedCeilingBps === economic.pack.acceptedCeilingBps, "X pending ceiling mismatch");
  invariant(pending.entropyFeeCapWei === economic.pack.entropyFeeCapWei, "X pending fee cap mismatch");
  invariant(pending.expiresAt === economic.expiresAt, "X pending expiry mismatch");
  invariant(pending.selfContainedCommand === xSelfContainedCommand(economic), "X pending self-contained command mismatch");
  invariant(typeof pending.consumed === "boolean", "X pending consumed flag is malformed");
  return pending;
}

export function encodeXPendingIntent(pending) {
  const validated = validateXPendingIntent(pending);
  const bytes = canonicalBytes(validated);
  invariant(bytes.length <= MAX_OPAQUE_JSON_BYTES, "X pending intent exceeds 64 KiB");
  return bytesToHex(bytes);
}

export function decodeXPendingIntent(value) {
  return validateXPendingIntent(decodeCanonicalJson(value, "X pending intent"));
}

export function xPendingIntentKey(pending) {
  return keccak256(canonicalBytes(validateXPendingIntent(pending)));
}

export function verifyXFundingApproval(pending, {
  mode,
  message,
  approvalTweetId,
  parentTweetId = null,
  referenceType = null,
  authorXUserId,
  linkedWallet,
  now,
}) {
  const bound = validateXPendingIntent(pending);
  invariant(bound.consumed === false, "X funding intent was already consumed");
  invariant(BigInt(now) < BigInt(bound.expiresAt), "X funding intent expired");
  invariant(X_ID.test(String(approvalTweetId)), "approval tweet id must be canonical numeric X id");
  invariant(String(approvalTweetId) !== bound.confirmationTweetId, "approval tweet id must differ from the confirmation tweet id");
  invariant(String(authorXUserId) === bound.requesterXUserId, "numeric X author id does not match the pending intent");
  invariant(normalizeAddress(linkedWallet) === bound.wallet, "current Bankr-linked wallet does not match the pending intent");
  if (mode === "reply") {
    invariant(referenceType === "replied_to", "bare confirmation requires trusted replied_to metadata, not a quote, repost, or generic reference");
    invariant(parentTweetId !== null && String(parentTweetId) === bound.confirmationTweetId, "bare confirmation must directly reply to the prepared confirmation tweet");
    invariant(/^(yes|confirm)$/i.test(String(message).trim()), "direct reply must be exactly YES or CONFIRM");
  } else if (mode === "self-contained") {
    invariant(String(message).trim() === bound.selfContainedCommand, "missing parent metadata requires the exact self-contained confirmation command");
  } else {
    throw new Error("X approval mode must be reply or self-contained");
  }
  return jsonValue({
    ok: true,
    pendingIntentKey: xPendingIntentKey(bound),
    economicIntentKey: bound.economicIntentKey,
    approvalTweetId: String(approvalTweetId),
    approvedAt: BigInt(now),
    consumeTransition: {
      from: false,
      to: true,
      requirements: [
        "runtime must atomically compare-and-set before the first external mutation",
        "the same atomic authorization boundary must recheck current time is before expiry",
        "the runtime must immediately re-resolve the authenticated Bankr-linked wallet and require the exact bound wallet",
        "before every structured swap, recheck expiry, current linked wallet, exact next journal step, body, and idempotency key",
      ],
    },
  });
}

export function parseSourceAmount(value) {
  return parseUnits(value, 18);
}

export function parseMinimumUsdc(value) {
  return parseUnits(value, 6);
}

export function parseMinimumNative(value) {
  return parseUnits(value, 18);
}
