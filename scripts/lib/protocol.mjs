import { readFileSync } from "node:fs";
import {
  decodeAddress,
  decodeBool,
  decodeBytes32,
  decodeParameters,
  decodeString,
  decodeUint,
  encodeCall,
  encodeParameters,
  formatUnits,
  jsonValue,
  normalizeAddress,
} from "./abi.mjs";
import {
  beginSnapshot,
  chainId,
  confirmSnapshot,
  ethCall,
  getBalance,
  getCodeHash,
  getStorageAt,
} from "./chain.mjs";
import { eventTopic, keccak256, selector } from "./keccak256.mjs";

export const DEPLOYMENT = JSON.parse(readFileSync(new URL("../../references/deployment.json", import.meta.url), "utf8"));
export const SIGNING_POLICY = JSON.parse(readFileSync(new URL("../../references/signing-allowlist.json", import.meta.url), "utf8"));
export const BANKR_EXECUTION = JSON.parse(readFileSync(new URL("../../references/bankr-execution.json", import.meta.url), "utf8"));

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const BPS = 10_000n;
export const USDC_DECIMALS = 6;
export const MAX_STOCKS = 16;
export const MAX_PAGE = 100;

export function confirmationKey(wallet, action, terms) {
  return keccak256(JSON.stringify(jsonValue({
    chainId: DEPLOYMENT.chainId,
    wallet: normalizeAddress(wallet),
    action,
    terms,
  })));
}

export function requiresAllowanceReset(currentAllowance, exactDesiredAllowance) {
  const current = BigInt(currentAllowance);
  const desired = BigInt(exactDesiredAllowance);
  if (current < 0n || desired <= 0n) throw new Error("allowance reset inputs must be a non-negative current amount and positive desired amount");
  return current > 0n && current !== desired;
}

export function decodeTokenDecimals(result) {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
    throw new Error("token decimals result must be exactly one ABI word");
  }
  const value = decodeUint(result);
  if (value > 36n) throw new Error("token decimals exceeds the supported display range");
  return Number(value);
}

export const ADDR = Object.freeze({
  gacha: normalizeAddress(DEPLOYMENT.contracts.stonkGacha.address),
  treasury: normalizeAddress(DEPLOYMENT.contracts.gachaTreasury.address),
  stockLock: normalizeAddress(DEPLOYMENT.contracts.stockLock.address),
  stockAdapter: normalizeAddress(DEPLOYMENT.contracts.stockAdapter.address),
  router: normalizeAddress(DEPLOYMENT.contracts.slipstreamRouter.address),
  quoter: normalizeAddress(DEPLOYMENT.contracts.slipstreamQuoter.address),
  usdc: normalizeAddress(DEPLOYMENT.tokens.usdc.address),
  usdcImplementation: normalizeAddress(DEPLOYMENT.tokens.usdc.implementation),
  weth: normalizeAddress(DEPLOYMENT.tokens.weth.address),
  entropy: normalizeAddress(DEPLOYMENT.entropy.proxy),
  entropyImplementation: normalizeAddress(DEPLOYMENT.entropy.implementation),
  entropyProvider: normalizeAddress(DEPLOYMENT.entropy.provider),
  owner: normalizeAddress(DEPLOYMENT.owner),
});

export const SIG = Object.freeze({
  balanceOf: "balanceOf(address)",
  allowance: "allowance(address,address)",
  approve: "approve(address,uint256)",
  symbol: "symbol()",
  decimals: "decimals()",
  owner: "owner()",
  packPrice: "packPrice(uint256)",
  odds: "odds()",
  ceilingTiers: "ceilingTiers()",
  eligibleOffer: "eligibleOffer(uint256)",
  offerHash: "offerHash(uint256)",
  entropyFee: "entropyFee()",
  requests: "requests(uint256)",
  requestFunding: "requestFunding(uint256)",
  requestDelivery: "requestDelivery(uint256)",
  refundClaimable: "refundClaimable(uint256)",
  requestEligible: "requestEligible(uint256)",
  requestEligibleRouteHashes: "requestEligibleRouteHashes(uint256)",
  requestCountOf: "requestCountOf(address)",
  requestsPage: "requestsPage(address,uint256,uint256)",
  quotePayout: "quotePayout(bytes32,uint256)",
  quoteProfit: "quoteProfit(uint256)",
  previewProfitSplit: "previewProfitSplit(uint256)",
  isCanonicalFor: "isCanonicalFor(address)",
});

export const EVENTS = Object.freeze({
  Approval: { signature: "Approval(address,address,uint256)", emitter: ADDR.usdc },
  Transfer: { signature: "Transfer(address,address,uint256)", emitter: ADDR.usdc },
  PackOpened: { signature: "PackOpened(uint256,address,uint8,uint256,uint256,uint256,address[],bytes32[])", emitter: ADDR.gacha },
  PackReady: { signature: "PackReady(uint256,address,address,uint256,uint256,uint256,bytes32)", emitter: ADDR.gacha },
  PackExpired: { signature: "PackExpired(uint256,address,uint256)", emitter: ADDR.gacha },
  RefundClaimed: { signature: "RefundClaimed(uint256,address,address,uint256)", emitter: ADDR.gacha },
  PrizeDelivered: { signature: "PrizeDelivered(uint256,address,address,address,uint256,uint256)", emitter: ADDR.gacha },
  ReserveFunded: { signature: "ReserveFunded(address,uint256)", emitter: ADDR.gacha },
  GachaProfitDistributed: { signature: "ProfitDistributed(address,uint256,uint256,uint256,uint256,uint256)", emitter: ADDR.gacha },
  TreasuryProfitDistributed: { signature: "ProfitDistributed(address,uint256,uint256,uint256,uint256,uint256)", emitter: ADDR.treasury },
  PayoutExecuted: { signature: "PayoutExecuted(bytes32,address,address,uint256,uint256)", emitter: ADDR.treasury },
});

export const EVENT_BY_EMITTER_TOPIC = new Map(
  Object.entries(EVENTS).map(([name, entry]) => [
    `${entry.emitter}:${eventTopic(entry.signature).toLowerCase()}`,
    { name, ...entry, topic0: eventTopic(entry.signature).toLowerCase() },
  ]),
);

const ERROR_SIGNATURES = [
  "AdapterNotWired()", "CeilingBelowMinimum()", "DeadlineExpired()", "EntropyNotContract()",
  "IncorrectEntropyFee(uint256,uint256)", "InvalidAmount()", "InvalidEntropyConfig()", "InvalidPack()",
  "InvalidPaymentToken()", "InvalidProfitAmount()", "InvalidRoute()", "InvalidTreasury()",
  "InvalidUserRandomNumber()", "MismatchedPeers()", "NativeETHRejected()", "NoCompatibleRoute()",
  "NotTheGachaTreasury()", "NothingToClaim()", "NothingToRefund()", "OfferChanged()",
  "OnlyEntropyCanFulfill()", "PageTooLarge()", "ProfitAccountingMismatch()", "ProfitUnavailable()",
  "RateLimited()", "RecoveryNotExcess()", "RecoveryTransferFailed()", "RecoveryUnauthorized()",
  "ReentrancyGuardReentrantCall()", "RequestCollision()", "RequestNotPending()", "ReserveUnavailable()",
  "ResolveWindowOpen()", "SafeERC20FailedOperation(address)", "SalesPausedError()", "SlippageExceeded()",
  "TreasuryAlreadyWired()", "TreasuryNotWired()", "Unauthorized()", "UnexpectedBalanceDelta()",
  "UnknownRoute()", "ZeroAddress()", "ZeroBounty()", "ZeroEntropy()",
];

export const ERROR_BY_SELECTOR = new Map(
  ERROR_SIGNATURES.map((signature) => [selector(signature).toLowerCase(), signature]),
);

function resolveRef(path) {
  let value = DEPLOYMENT;
  for (const key of path.split(".")) value = value?.[key];
  if (typeof value !== "string") throw new Error(`deployment reference is not a string: ${path}`);
  return value;
}

export const ALLOWED_ACTIONS = Object.freeze(
  Object.entries(SIGNING_POLICY.targets).flatMap(([targetName, target]) => {
    const address = normalizeAddress(resolveRef(target.addressRef));
    return Object.entries(target.operations).map(([name, operation]) => {
      const computedSelector = selector(operation.signature).toLowerCase();
      if (computedSelector !== operation.selector.toLowerCase()) {
        throw new Error(`selector mismatch in signing policy for ${name}`);
      }
      return Object.freeze({ targetName, target: address, name, ...operation, selector: computedSelector });
    });
  }),
);

const ACTION_BY_TARGET_SELECTOR = new Map(
  ALLOWED_ACTIONS.map((action) => [`${action.target}:${action.selector}`, action]),
);

export function knownActionBySelector(target, dataSelector) {
  if (!target || !dataSelector) return null;
  return ACTION_BY_TARGET_SELECTOR.get(`${normalizeAddress(target)}:${dataSelector.toLowerCase()}`) ?? null;
}

export function describeRevert(data) {
  if (!data || data.length < 10) return "execution reverted without decodable data";
  const key = data.slice(0, 10).toLowerCase();
  const signature = ERROR_BY_SELECTOR.get(key);
  if (signature === "IncorrectEntropyFee(uint256,uint256)" && data.length >= 138) {
    return `${signature}: expected ${decodeUint(`0x${data.slice(10)}`, 0)}, received ${decodeUint(`0x${data.slice(10)}`, 1)}`;
  }
  return signature ?? `unknown custom error ${key}`;
}

export async function call(to, signature, types = [], values = [], { from = null, value = null, block = "latest" } = {}) {
  return await ethCall(to, encodeCall(signature, types, values), { from, value, block });
}

export async function readUint(to, signature, types = [], values = [], block = "latest") {
  return decodeUint(await call(to, signature, types, values, { block }));
}

export async function readAddress(to, signature, types = [], values = [], block = "latest") {
  return decodeAddress(await call(to, signature, types, values, { block }));
}

export async function readBool(to, signature, types = [], values = [], block = "latest") {
  return decodeBool(await call(to, signature, types, values, { block }));
}

function compare(actual, expected) {
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}

function addCheck(checks, name, actual, expected) {
  checks.push({ name, pass: compare(actual, expected), actual, expected });
}

export async function verifyDeployment(existingSnapshot = null) {
  const snapshot = existingSnapshot ?? await beginSnapshot();
  const block = snapshot.ref;
  const checks = [];
  addCheck(checks, "chainId", await chainId(), DEPLOYMENT.chainId);

  const codeIdentities = [
    ["StonkGacha", ADDR.gacha, DEPLOYMENT.contracts.stonkGacha.runtimeCodeHash],
    ["GachaTreasury", ADDR.treasury, DEPLOYMENT.contracts.gachaTreasury.runtimeCodeHash],
    ["StockLock", ADDR.stockLock, DEPLOYMENT.contracts.stockLock.runtimeCodeHash],
    ["stockAdapter", ADDR.stockAdapter, DEPLOYMENT.contracts.stockAdapter.runtimeCodeHash],
    ["SlipstreamRouter", ADDR.router, DEPLOYMENT.contracts.slipstreamRouter.runtimeCodeHash],
    ["SlipstreamQuoter", ADDR.quoter, DEPLOYMENT.contracts.slipstreamQuoter.runtimeCodeHash],
    ["USDC", ADDR.usdc, DEPLOYMENT.tokens.usdc.runtimeCodeHash],
    ["USDCImplementation", ADDR.usdcImplementation, DEPLOYMENT.tokens.usdc.implementationRuntimeCodeHash],
    ["WETH", ADDR.weth, DEPLOYMENT.tokens.weth.runtimeCodeHash],
    ["EntropyProxy", ADDR.entropy, DEPLOYMENT.entropy.proxyRuntimeCodeHash],
    ["EntropyImplementation", ADDR.entropyImplementation, DEPLOYMENT.entropy.implementationRuntimeCodeHash],
  ];
  const hashes = await Promise.all(codeIdentities.map(([, address]) => getCodeHash(address, block)));
  codeIdentities.forEach(([name,, expected], index) => addCheck(checks, `${name}.runtimeCodeHash`, hashes[index], expected));

  const [entropyImplementationWord, usdcImplementationWord] = await Promise.all([
    getStorageAt(ADDR.entropy, DEPLOYMENT.entropy.eip1967ImplementationSlot, block),
    getStorageAt(ADDR.usdc, DEPLOYMENT.tokens.usdc.zeppelinosImplementationSlot, block),
  ]);
  addCheck(checks, "EntropyProxy.implementation", `0x${entropyImplementationWord.slice(-40)}`, ADDR.entropyImplementation);
  addCheck(checks, "USDCProxy.implementation", `0x${usdcImplementationWord.slice(-40)}`, ADDR.usdcImplementation);

  const gachaWiring = [
    ["gacha.owner", "owner()", ADDR.owner],
    ["gacha.usdc", "usdc()", ADDR.usdc],
    ["gacha.stockLock", "stockLock()", ADDR.stockLock],
    ["gacha.stockAdapter", "stockAdapter()", ADDR.stockAdapter],
    ["gacha.entropy", "entropy()", ADDR.entropy],
    ["gacha.entropyProvider", "entropyProvider()", ADDR.entropyProvider],
    ["gacha.treasury", "treasury()", ADDR.treasury],
  ];
  const gachaAddresses = await Promise.all(gachaWiring.map(([, signature]) => readAddress(ADDR.gacha, signature, [], [], block)));
  gachaWiring.forEach(([name,, expected], index) => addCheck(checks, name, gachaAddresses[index], expected));

  const treasuryWiring = [
    ["treasury.owner", "owner()", ADDR.owner],
    ["treasury.gacha", "gacha()", ADDR.gacha],
    ["treasury.usdc", "usdc()", ADDR.usdc],
    ["treasury.weth", "weth()", ADDR.weth],
    ["treasury.stockLock", "stockLock()", ADDR.stockLock],
    ["treasury.stockAdapter", "stockAdapter()", ADDR.stockAdapter],
    ["treasury.router", "slipstreamRouter()", ADDR.router],
    ["treasury.quoter", "slipstreamQuoter()", ADDR.quoter],
  ];
  const treasuryAddresses = await Promise.all(treasuryWiring.map(([, signature]) => readAddress(ADDR.treasury, signature, [], [], block)));
  treasuryWiring.forEach(([name,, expected], index) => addCheck(checks, name, treasuryAddresses[index], expected));
  addCheck(checks, "treasury.isWired", await readBool(ADDR.treasury, "isWired()", [], [], block), true);
  addCheck(checks, "treasury.isCanonicalFor", await readBool(ADDR.treasury, SIG.isCanonicalFor, ["address"], [ADDR.gacha], block), true);

  const terms = DEPLOYMENT.productTerms;
  const constantChecks = [
    ["gacha.BPS", ADDR.gacha, "BPS()", 10_000n],
    ["gacha.BOUNTY_BPS", ADDR.gacha, "BOUNTY_BPS()", BigInt(terms.workerBountyBps)],
    ["gacha.RESERVE_BPS", ADDR.gacha, "RESERVE_BPS()", BigInt(terms.reserveBps)],
    ["gacha.STAKER_BPS", ADDR.gacha, "STAKER_BPS()", BigInt(terms.stakerBps)],
    ["gacha.PACK_COUNT", ADDR.gacha, "PACK_COUNT()", BigInt(terms.packCount)],
    ["gacha.USD_UNIT", ADDR.gacha, "USD_UNIT()", BigInt(terms.usdcUnit)],
    ["gacha.RESOLVE_WINDOW", ADDR.gacha, "RESOLVE_WINDOW()", BigInt(terms.resolveWindowSeconds)],
    ["gacha.TARGET_RTP_BPS", ADDR.gacha, "TARGET_RTP_BPS()", BigInt(terms.targetRtpBps)],
    ["gacha.HOUSE_EDGE_BPS", ADDR.gacha, "HOUSE_EDGE_BPS()", BigInt(terms.houseEdgeBps)],
    ["gacha.MIN_CEILING_BPS", ADDR.gacha, "MIN_CEILING_BPS()", BigInt(terms.minimumCeilingBps)],
    ["gacha.MIN_DISTRIBUTE", ADDR.gacha, "MIN_DISTRIBUTE()", BigInt(terms.minimumDistributeUsdcRaw)],
    ["gacha.MAX_DISTRIBUTE", ADDR.gacha, "MAX_DISTRIBUTE()", BigInt(terms.maximumDistributeUsdcRaw)],
    ["gacha.callbackGasLimit", ADDR.gacha, "callbackGasLimit()", BigInt(DEPLOYMENT.entropy.callbackGasLimit)],
    ["treasury.BPS", ADDR.treasury, "BPS()", 10_000n],
    ["treasury.BOUNTY_BPS", ADDR.treasury, "BOUNTY_BPS()", BigInt(terms.workerBountyBps)],
    ["treasury.RESERVE_BPS", ADDR.treasury, "RESERVE_BPS()", BigInt(terms.reserveBps)],
    ["treasury.STAKER_BPS", ADDR.treasury, "STAKER_BPS()", BigInt(terms.stakerBps)],
    ["treasury.MIN_DISTRIBUTE", ADDR.treasury, "MIN_DISTRIBUTE()", BigInt(terms.minimumDistributeUsdcRaw)],
    ["treasury.MAX_DISTRIBUTE", ADDR.treasury, "MAX_DISTRIBUTE()", BigInt(terms.maximumDistributeUsdcRaw)],
    ["usdc.decimals", ADDR.usdc, "decimals()", 6n],
  ];
  const constants = await Promise.all(constantChecks.map(([, address, signature]) => readUint(address, signature, [], [], block)));
  constantChecks.forEach(([name,,, expected], index) => addCheck(checks, name, constants[index], expected));

  const counterNames = [
    "cumulativeProcessedProfitUsdc", "cumulativeProfitBountyUsdc",
    "cumulativeRetainedProfitUsdc", "cumulativeStakerProfitUsdc",
  ];
  for (const counter of counterNames) {
    const [gachaValue, treasuryValue] = await Promise.all([
      readUint(ADDR.gacha, `${counter}()`, [], [], block),
      readUint(ADDR.treasury, `${counter}()`, [], [], block),
    ]);
    addCheck(checks, `accounting.${counter}`, gachaValue, treasuryValue);
  }

  await confirmSnapshot(snapshot);
  const failed = checks.filter((check) => !check.pass);
  return jsonValue({
    ok: failed.length === 0,
    snapshot: { blockNumber: snapshot.number, blockHash: snapshot.hash, timestamp: snapshot.timestamp },
    release: DEPLOYMENT.release,
    checks,
    failed: failed.map((check) => check.name),
  });
}

export async function readTokenMeta(token, block = "latest") {
  const address = normalizeAddress(token);
  const [symbolResult, decimalsResult] = await Promise.allSettled([
    call(address, SIG.symbol, [], [], { block }),
    call(address, SIG.decimals, [], [], { block }),
  ]);
  const fallback = `${address.slice(0, 6)}...${address.slice(-4)}`;
  let symbol = fallback;
  if (symbolResult.status === "fulfilled") {
    try {
      if (symbolResult.value.length === 66) {
        const bytes = decodeBytes32(symbolResult.value).slice(2).replace(/(?:00)+$/, "");
        symbol = new TextDecoder("utf-8", { fatal: true }).decode(
          Uint8Array.from(bytes.match(/.{2}/g)?.map((entry) => Number.parseInt(entry, 16)) ?? []),
        );
      } else {
        symbol = decodeString(symbolResult.value);
      }
      symbol = [...symbol.replace(/[^\x20-\x7e]/g, "?").trim()].slice(0, 32).join("") || fallback;
    } catch { /* bounded fallback */ }
  }
  let decimals = null;
  if (decimalsResult.status === "fulfilled") {
    try { decimals = decodeTokenDecimals(decimalsResult.value); }
    catch { /* bounded fallback */ }
  }
  return { address, symbol, decimals };
}

export function localOfferHash(packIndex, ceilingBps, tokens, routeHashes) {
  return keccak256(`0x${encodeParameters(
    ["uint256", "uint256", "address[]", "bytes32[]"],
    [BigInt(packIndex), BigInt(ceilingBps), tokens, routeHashes],
  )}`);
}

function validateOffer({ packIndex, priceUsdc, ceilingBps, tokens, routeHashes, offerHash, freeReserveUsdc }) {
  if (packIndex < 0 || packIndex >= DEPLOYMENT.productTerms.packCount) throw new Error("pack index is outside the deployed product");
  if (priceUsdc !== BigInt(DEPLOYMENT.productTerms.packPricesUsdcRaw[packIndex])) throw new Error("pack price does not match the reviewed release");
  if (ceilingBps < BigInt(DEPLOYMENT.productTerms.minimumCeilingBps)) throw new Error("offer ceiling is below the product minimum");
  if (tokens.length < 1 || tokens.length > MAX_STOCKS || tokens.length !== routeHashes.length) throw new Error("offer token/route set is malformed");
  const normalized = tokens.map(normalizeAddress);
  if (normalized.some((token) => token === ZERO_ADDRESS || token === ADDR.usdc)) throw new Error("offer contains an invalid token");
  if (new Set(normalized).size !== normalized.length) throw new Error("offer contains duplicate tokens");
  if (routeHashes.some((hash) => /^0x0{64}$/i.test(hash))) throw new Error("offer contains a zero route hash");
  if (new Set(routeHashes.map((hash) => hash.toLowerCase())).size !== routeHashes.length) throw new Error("offer contains duplicate route hashes");
  const computed = localOfferHash(packIndex, ceilingBps, normalized, routeHashes);
  if (computed.toLowerCase() !== offerHash.toLowerCase()) throw new Error("onchain offer hash does not match the ordered local commitment");
  const maxPayoutUsdc = priceUsdc * ceilingBps / BPS;
  if (maxPayoutUsdc <= 0n || maxPayoutUsdc > freeReserveUsdc) throw new Error("offer maximum payout is not covered by free reserve");
  return { tokens: normalized, computedOfferHash: computed, maxPayoutUsdc };
}

export async function readOffer(packIndex, snapshot) {
  const block = snapshot.ref;
  const [priceResult, offerResult, hashResult, feeResult, freeReserveResult] = await Promise.all([
    call(ADDR.gacha, SIG.packPrice, ["uint256"], [BigInt(packIndex)], { block }),
    call(ADDR.gacha, SIG.eligibleOffer, ["uint256"], [BigInt(packIndex)], { block }),
    call(ADDR.gacha, SIG.offerHash, ["uint256"], [BigInt(packIndex)], { block }),
    call(ADDR.gacha, SIG.entropyFee, [], [], { block }),
    call(ADDR.gacha, "freeReserveUsdc()", [], [], { block }),
  ]);
  const priceUsdc = decodeUint(priceResult);
  const [ceilingBps, rawTokens, routeHashes] = decodeParameters(["uint256", "address[]", "bytes32[]"], offerResult);
  const offerHash = decodeBytes32(hashResult);
  const entropyFee = decodeUint(feeResult);
  const freeReserveUsdc = decodeUint(freeReserveResult);
  if (entropyFee <= 0n || /^0x0{64}$/i.test(offerHash)) throw new Error("pack sale has no executable offer or Entropy fee");
  const validated = validateOffer({ packIndex, priceUsdc, ceilingBps, tokens: rawTokens, routeHashes, offerHash, freeReserveUsdc });
  const tokenMeta = await Promise.all(validated.tokens.map((token) => readTokenMeta(token, block)));
  return jsonValue({
    packIndex,
    priceUsdc,
    priceUsdcFormatted: formatUnits(priceUsdc, USDC_DECIMALS),
    ceilingBps,
    offerHash,
    computedOfferHash: validated.computedOfferHash,
    maxPayoutUsdc: validated.maxPayoutUsdc,
    maxPayoutUsdcFormatted: formatUnits(validated.maxPayoutUsdc, USDC_DECIMALS),
    freeReserveUsdc,
    entropyFee,
    eligible: validated.tokens.map((token, index) => ({ token, routeHash: routeHashes[index], ...tokenMeta[index] })),
  });
}

export async function protocolStatus(wallet = null, snapshot = null) {
  const ownSnapshot = snapshot ?? await beginSnapshot();
  const integrity = await verifyDeployment(ownSnapshot);
  if (!integrity.ok) return { ok: false, integrity };
  const block = ownSnapshot.ref;
  const counterSignatures = [
    "salesPaused()", "pendingRequests()", "totalRequests()", "pendingPayoutUsdc()", "readyPayoutUsdc()",
    "refundableUsdc()", "cumulativeRevenueUsdc()", "cumulativeRefundedUsdc()", "cumulativePayoutUsdc()",
    "cumulativeProcessedProfitUsdc()", "cumulativeProfitBountyUsdc()", "cumulativeRetainedProfitUsdc()",
    "cumulativeStakerProfitUsdc()", "cumulativeFundedReserveUsdc()", "lossCarryforwardUsdc()",
    "accountingProfitAvailableUsdc()", "distributableProfitUsdc()", "protectedUsdc()", "freeReserveUsdc()",
  ];
  const results = await Promise.all(counterSignatures.map((signature) => call(ADDR.gacha, signature, [], [], { block })));
  const ledger = Object.fromEntries(counterSignatures.map((signature, index) => [signature.slice(0, -2), signature === "salesPaused()" ? decodeBool(results[index]) : decodeUint(results[index])]));
  const realized = decodeParameters(["uint256", "uint256"], await call(ADDR.gacha, "realizedPnlUsdc()", [], [], { block }));
  const odds = decodeParameters(["uint32[15]", "uint32[15]"], await call(ADDR.gacha, SIG.odds, [], [], { block }));
  const ceilingTiers = decodeParameters(["uint32[4]"], await call(ADDR.gacha, SIG.ceilingTiers, [], [], { block }))[0];
  const offers = [];
  for (let index = 0; index < DEPLOYMENT.productTerms.packCount; index += 1) {
    try {
      offers.push(await readOffer(index, ownSnapshot));
    } catch (error) {
      offers.push({ packIndex: index, available: false, reason: error.message });
    }
  }
  let account = null;
  if (wallet) {
    const normalized = normalizeAddress(wallet);
    const [usdcBalance, wethBalance, allowance, ethBalance, requestCount] = await Promise.all([
      readUint(ADDR.usdc, SIG.balanceOf, ["address"], [normalized], block),
      readUint(ADDR.weth, SIG.balanceOf, ["address"], [normalized], block),
      readUint(ADDR.usdc, SIG.allowance, ["address", "address"], [normalized, ADDR.gacha], block),
      getBalance(normalized, block),
      readUint(ADDR.gacha, SIG.requestCountOf, ["address"], [normalized], block),
    ]);
    account = {
      address: normalized,
      usdcBalance,
      usdcBalanceFormatted: formatUnits(usdcBalance, 6),
      wethBalance,
      wethBalanceFormatted: formatUnits(wethBalance, 18),
      allowance,
      ethBalance,
      requestCount,
    };
  }
  if (!snapshot) await confirmSnapshot(ownSnapshot);
  return jsonValue({
    ok: true,
    snapshot: { blockNumber: ownSnapshot.number, blockHash: ownSnapshot.hash, timestamp: ownSnapshot.timestamp },
    deployment: { sourceCommit: DEPLOYMENT.release.sourceCommit, integrity: true },
    salesPaused: ledger.salesPaused,
    offers,
    odds: { cumulativePpm: odds[0], multiplierBps: odds[1], ceilingTiers },
    ledger: { ...ledger, realizedProfitUsdc: realized[0], realizedLossUsdc: realized[1] },
    account,
  });
}

const STATUS_NAMES = ["None", "Pending", "Ready", "Expired", "Refunded", "Delivered"];

export async function readRequest(requestId, snapshot = null) {
  const ownSnapshot = snapshot ?? await beginSnapshot();
  const block = ownSnapshot.ref;
  const [requestResult, fundingResult, deliveryResult, eligibleResult, hashesResult, refundResult] = await Promise.all([
    call(ADDR.gacha, SIG.requests, ["uint256"], [requestId], { block }),
    call(ADDR.gacha, SIG.requestFunding, ["uint256"], [requestId], { block }),
    call(ADDR.gacha, SIG.requestDelivery, ["uint256"], [requestId], { block }),
    call(ADDR.gacha, SIG.requestEligible, ["uint256"], [requestId], { block }),
    call(ADDR.gacha, SIG.requestEligibleRouteHashes, ["uint256"], [requestId], { block }),
    call(ADDR.gacha, SIG.refundClaimable, ["uint256"], [requestId], { block }),
  ]);
  const [buyer, paidUsdc, openedAt, multiplierBps, ceilingBps, packIndex, statusIndex, token, requestStockOut, randomWord] = decodeParameters(
    ["address", "uint96", "uint64", "uint32", "uint32", "uint8", "uint8", "address", "uint256", "uint256"],
    requestResult,
  );
  const [maxPayoutUsdc, payoutUsdc] = decodeParameters(["uint96", "uint96"], fundingResult);
  const [routeHash, deliveryStockOut] = decodeParameters(["bytes32", "uint256"], deliveryResult);
  const [eligible] = decodeParameters(["address[]"], eligibleResult);
  const [routeHashes] = decodeParameters(["bytes32[]"], hashesResult);
  const refundClaimable = decodeUint(refundResult);
  const status = STATUS_NAMES[Number(statusIndex)];
  if (!status || status === "None" || buyer === ZERO_ADDRESS) throw new Error(`request ${requestId} does not exist`);
  if (Number(packIndex) >= DEPLOYMENT.productTerms.packCount || paidUsdc !== BigInt(DEPLOYMENT.productTerms.packPricesUsdcRaw[Number(packIndex)])) throw new Error("request pack terms are malformed");
  if (eligible.length < 1 || eligible.length > MAX_STOCKS || eligible.length !== routeHashes.length) throw new Error("request offer commitment is malformed");
  const normalizedEligible = eligible.map(normalizeAddress);
  if (normalizedEligible.some((entry) => entry === ZERO_ADDRESS || entry === ADDR.usdc)) throw new Error("request offer contains an invalid token");
  if (new Set(normalizedEligible).size !== normalizedEligible.length) throw new Error("request offer contains duplicate tokens");
  if (routeHashes.some((hash) => /^0x0{64}$/i.test(hash))) throw new Error("request offer contains a zero route hash");
  if (new Set(routeHashes.map((hash) => hash.toLowerCase())).size !== routeHashes.length) throw new Error("request offer contains duplicate route hashes");
  if (maxPayoutUsdc !== paidUsdc * ceilingBps / BPS || requestStockOut !== deliveryStockOut) throw new Error("request funding or delivery record is inconsistent");
  const resolved = status === "Ready" || status === "Delivered";
  if (resolved && (token === ZERO_ADDRESS || /^0x0{64}$/i.test(routeHash) || payoutUsdc <= 0n || payoutUsdc > maxPayoutUsdc || multiplierBps <= 0n)) throw new Error("resolved request outcome is malformed");
  if (resolved && (multiplierBps > ceilingBps || payoutUsdc !== paidUsdc * multiplierBps / BPS)) throw new Error("resolved request payout does not match its pinned multiplier");
  if (resolved) {
    const selectedIndex = normalizedEligible.findIndex((entry, index) => entry === token && routeHashes[index].toLowerCase() === routeHash.toLowerCase());
    if (selectedIndex < 0) throw new Error("resolved request token/route pair was not in its pinned offer");
  }
  if (!resolved && (token !== ZERO_ADDRESS || !/^0x0{64}$/i.test(routeHash) || payoutUsdc !== 0n || multiplierBps !== 0n || randomWord !== 0n)) throw new Error("unresolved request carries an outcome");
  if (status === "Ready" && deliveryStockOut !== 0n) throw new Error("Ready request already carries stock output");
  if (status === "Delivered" && deliveryStockOut === 0n) throw new Error("Delivered request has no stock output");
  if (status === "Expired" && refundClaimable !== paidUsdc) throw new Error("Expired request refund credit is inconsistent");
  if (status !== "Expired" && refundClaimable !== 0n) throw new Error("non-Expired request exposes refund credit");
  const tokenMeta = resolved ? await readTokenMeta(token, block) : null;
  if (!snapshot) await confirmSnapshot(ownSnapshot);
  return jsonValue({
    requestId: BigInt(requestId), buyer, paidUsdc, paidUsdcFormatted: formatUnits(paidUsdc, 6), openedAt,
    refundableAt: openedAt + BigInt(DEPLOYMENT.productTerms.resolveWindowSeconds), packIndex, status,
    multiplierBps, ceilingBps, maxPayoutUsdc, payoutUsdc, payoutUsdcFormatted: formatUnits(payoutUsdc, 6),
    token: resolved ? token : null, tokenMeta, routeHash: resolved ? routeHash : null,
    stockOut: deliveryStockOut, randomWord, refundClaimable,
    eligible: normalizedEligible.map((entry, index) => ({ token: entry, routeHash: routeHashes[index] })),
    snapshot: { blockNumber: ownSnapshot.number, blockHash: ownSnapshot.hash, timestamp: ownSnapshot.timestamp },
  });
}

export async function walletRequests(wallet, cursor = 0n, limit = 20n, snapshot = null) {
  const account = normalizeAddress(wallet);
  if (cursor < 0n || limit < 1n || limit > BigInt(MAX_PAGE)) throw new Error(`request page limit must be 1..${MAX_PAGE}`);
  const ownSnapshot = snapshot ?? await beginSnapshot();
  const [countResult, pageResult] = await Promise.all([
    call(ADDR.gacha, SIG.requestCountOf, ["address"], [account], { block: ownSnapshot.ref }),
    call(ADDR.gacha, SIG.requestsPage, ["address", "uint256", "uint256"], [account, cursor, limit], { block: ownSnapshot.ref }),
  ]);
  const count = decodeUint(countResult);
  const [ids, nextCursor] = decodeParameters(["uint256[]", "uint256"], pageResult);
  const requests = [];
  for (const id of ids) requests.push(await readRequest(id, ownSnapshot));
  if (!snapshot) await confirmSnapshot(ownSnapshot);
  return jsonValue({ account, count, cursor, nextCursor, requests, snapshot: { blockNumber: ownSnapshot.number, blockHash: ownSnapshot.hash, timestamp: ownSnapshot.timestamp } });
}

export async function quotePayout(routeHash, amountIn, snapshot, from = null) {
  const result = await call(ADDR.treasury, SIG.quotePayout, ["bytes32", "uint256"], [routeHash, amountIn], { from, block: snapshot.ref });
  return decodeUint(result);
}

export async function profitStatus(wallet = null, snapshot = null) {
  const ownSnapshot = snapshot ?? await beginSnapshot();
  const block = ownSnapshot.ref;
  const signatures = [
    "cumulativeRevenueUsdc()", "cumulativePayoutUsdc()", "cumulativeProcessedProfitUsdc()",
    "cumulativeProfitBountyUsdc()", "cumulativeRetainedProfitUsdc()", "cumulativeStakerProfitUsdc()",
    "cumulativeFundedReserveUsdc()", "lossCarryforwardUsdc()", "accountingProfitAvailableUsdc()",
    "distributableProfitUsdc()", "freeReserveUsdc()",
  ];
  const values = await Promise.all(signatures.map((signature) => readUint(ADDR.gacha, signature, [], [], block)));
  const state = Object.fromEntries(signatures.map((signature, index) => [signature.slice(0, -2), values[index]]));
  const min = BigInt(DEPLOYMENT.productTerms.minimumDistributeUsdcRaw);
  const max = BigInt(DEPLOYMENT.productTerms.maximumDistributeUsdcRaw);
  const amount = state.distributableProfitUsdc >= min ? (state.distributableProfitUsdc > max ? max : state.distributableProfitUsdc) : 0n;
  let preview = null;
  let quote = null;
  let quoteError = null;
  if (amount > 0n) {
    try {
      preview = decodeParameters(["uint256", "uint256", "uint256"], await call(ADDR.treasury, SIG.previewProfitSplit, ["uint256"], [amount], { block }));
      quote = decodeUint(await call(ADDR.treasury, SIG.quoteProfit, ["uint256"], [amount], { from: wallet ? normalizeAddress(wallet) : null, block }));
    } catch (error) {
      quoteError = error.message;
    }
  }
  if (!snapshot) await confirmSnapshot(ownSnapshot);
  return jsonValue({ ...state, minimumDistributeUsdc: min, maximumDistributeUsdc: max, suggestedAmountUsdc: amount, preview, quoteWeth: quote, quoteError, snapshot: { blockNumber: ownSnapshot.number, blockHash: ownSnapshot.hash, timestamp: ownSnapshot.timestamp } });
}
