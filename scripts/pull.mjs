#!/usr/bin/env node
// Compact direct-pull orchestrator for Bankr. It wraps the existing deterministic
// planner and receipt verifier so the model only relays one unsigned transaction
// per phase. It never signs or submits.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { formatUnits, jsonValue, normalizeAddress, parseUnits } from "./lib/abi.mjs";
import { decodeDirectPullIntent, directPullIntentKey } from "./lib/direct.mjs";
import { ADDR, BANKR_EXECUTION, DEPLOYMENT, USDC_DECIMALS } from "./lib/protocol.mjs";
import {
  createPullRecord,
  listActivePullRecords,
  loadPullRecord,
  updatePullRecord,
  validatePullId,
  withWalletPullLock,
  walletPullGeneration,
} from "./lib/pull-state.mjs";

const CORE = fileURLToPath(new URL("./stonk-gacha.mjs", import.meta.url));
const [, , command, ...argv] = process.argv;
const COMMAND_FLAGS = Object.freeze({
  start: ["wallet", "amount-usdc", "authorized-entropy-fee-wei", "max-wait-seconds", "poll-interval-seconds"],
  advance: ["wallet", "pull-id", "tx", "max-wait-seconds", "poll-interval-seconds"],
  finish: ["wallet", "pull-id", "tx"],
});
const SUBMITTING_STAGES = new Set([
  "allowance-reset-submitting",
  "approval-submitting",
  "open-submitting",
  "claim-submitting",
]);
const MAX_AUTOMATIC_REVERT_RETRIES = Number(
  BANKR_EXECUTION.directPull.maximumAutomaticProvenRevertRetriesPerPhase,
);

class PullError extends Error {
  constructor(gate, message, extra = {}) {
    super(message);
    this.gate = gate;
    this.extra = extra;
  }
}

function requireThat(condition, gate, message, extra = {}) {
  if (!condition) throw new PullError(gate, message, extra);
}

requireThat(
  Number.isSafeInteger(MAX_AUTOMATIC_REVERT_RETRIES) && MAX_AUTOMATIC_REVERT_RETRIES >= 0,
  "policy",
  "automatic proven-revert retry policy is invalid",
);

function parseFlags() {
  const allowed = COMMAND_FLAGS[command];
  requireThat(allowed, "args", "usage: node scripts/pull.mjs start|advance|finish [flags]");
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    requireThat(token.startsWith("--") && token.length > 2, "args", `unexpected argument ${token}`);
    const name = token.slice(2);
    requireThat(allowed.includes(name), "args", `unsupported flag for ${command}: --${name}`);
    requireThat(!Object.hasOwn(parsed, name), "args", `duplicate flag: --${name}`);
    const value = argv[index + 1];
    requireThat(value !== undefined && !value.startsWith("--"), "args", `--${name} requires a value`);
    parsed[name] = value;
    index += 1;
  }
  return parsed;
}

function need(flags, name) {
  requireThat(flags[name] !== undefined, "args", `--${name} is required`);
  return flags[name];
}

function canonicalWallet(value) {
  let wallet;
  try { wallet = normalizeAddress(value); } catch (error) { throw new PullError("wallet", error.message); }
  requireThat(wallet !== "0x0000000000000000000000000000000000000000", "wallet", "active Bankr wallet cannot be zero");
  return wallet;
}

function canonicalHash(value, name) {
  requireThat(/^0x[0-9a-fA-F]{64}$/.test(value ?? ""), "args", `--${name} must be exactly 32 bytes of hex`);
  return value.toLowerCase();
}

function optionalDuration(flags, name, maximum) {
  if (flags[name] === undefined) return null;
  requireThat(/^[1-9][0-9]*$/.test(flags[name]), "args", `--${name} must be a positive integer`);
  const value = BigInt(flags[name]);
  requireThat(value <= BigInt(maximum), "args", `--${name} exceeds ${maximum}`);
  return value.toString();
}

function selectedPack(amount) {
  let raw;
  try { raw = parseUnits(amount, USDC_DECIMALS); } catch (error) { throw new PullError("pack", error.message); }
  const prices = DEPLOYMENT.productTerms.packPricesUsdcRaw.map((value) => BigInt(value));
  const packIndex = prices.findIndex((value) => value === raw);
  requireThat(packIndex >= 0, "pack", `Stonk Gacha packs are ${prices.map((value) => `$${formatUnits(value, USDC_DECIMALS)}`).join(", ")}`);
  return { packIndex, raw, formatted: formatUnits(raw, USDC_DECIMALS) };
}

function output(value, exitCode = 0) {
  console.log(JSON.stringify(jsonValue(value), null, 2));
  process.exitCode = exitCode;
}

function runCore(coreArgs) {
  const result = spawnSync(process.execPath, [CORE, ...coreArgs], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  requireThat(!result.error, "core", "Stonk Gacha verifier could not start");
  requireThat(!result.signal, "core", "Stonk Gacha verifier was interrupted");
  let payload;
  try { payload = JSON.parse(result.stdout); } catch {
    throw new PullError("core", "Stonk Gacha verifier returned malformed output");
  }
  requireThat(payload && typeof payload === "object" && !Array.isArray(payload), "core", "Stonk Gacha verifier returned no result");
  return { payload, exitCode: result.status ?? 1 };
}

function coreFailure(result, fallback = "Stonk Gacha could not safely continue this pull") {
  const payload = result.payload;
  throw new PullError(payload.gate ?? "core", payload.error ?? fallback);
}

function plannerArgs(record) {
  let intent;
  try { intent = decodeDirectPullIntent(record.directIntent); } catch (error) {
    throw new PullError("state", `stored pull authorization is invalid: ${error.message}`);
  }
  requireThat(directPullIntentKey(intent) === record.directIntentKey, "state", "stored pull authorization key mismatch");
  const result = [
    "plan-open-pack",
    "--wallet", record.wallet,
    "--pack-index", String(intent.pack.packIndex),
    "--authorized-price-usdc", formatUnits(BigInt(intent.authorization.authorizedPriceUsdcRaw), USDC_DECIMALS),
  ];
  if (intent.authorization.feeAuthorization === "explicit-user-cap") {
    result.push("--authorized-entropy-fee-wei", String(intent.pack.entropyFeeCapWei));
  }
  result.push("--direct-intent", record.directIntent, "--direct-intent-key", record.directIntentKey);
  return result;
}

function inspectPlan(wallet, plan) {
  requireThat(plan.ok === true && plan.phase && Array.isArray(plan.txs) && plan.txs.length === 1, "planner", "planner did not produce exactly one transaction");
  requireThat(typeof plan.inspectionContextHex === "string" && typeof plan.inspectionKey === "string", "planner", "planner omitted its transaction binding");
  const tx = plan.txs[0];
  const inspected = runCore([
    "inspect-calldata",
    "--wallet", wallet,
    "--chain-id", String(tx.chainId),
    "--to", tx.to,
    "--data", tx.data,
    "--value", String(tx.value),
    "--context", plan.inspectionContextHex,
    "--plan-key", plan.inspectionKey,
  ]);
  if (inspected.exitCode !== 0 || inspected.payload.ok !== true) coreFailure(inspected, "planned transaction failed its final safety inspection");
  const action = inspected.payload.action?.name;
  let stage;
  if (action === "approve") {
    const rawAmount = inspected.payload.values?.[1];
    requireThat(/^(0|[1-9][0-9]*)$/.test(String(rawAmount)), "planner", "approval inspection omitted its canonical amount");
    const amount = BigInt(rawAmount);
    stage = amount === 0n ? "allowance-reset-submitting" : "approval-submitting";
  } else if (action === "open-pack") {
    stage = "open-submitting";
  } else if (action === "claim-prize") {
    stage = "claim-submitting";
  } else {
    throw new PullError("allowlist", `compact pull cannot submit ${action ?? "an unknown action"}`);
  }
  return {
    stage,
    expected: {
      action,
      contextHex: plan.inspectionContextHex.toLowerCase(),
      inspectionKey: plan.inspectionKey.toLowerCase(),
    },
    tx: {
      chainId: Number(tx.chainId),
      to: normalizeAddress(tx.to),
      data: String(tx.data).toLowerCase(),
      value: BigInt(tx.value).toString(),
    },
  };
}

function timestamp(record, candidate = null) {
  const wallClock = BigInt(Math.floor(Date.now() / 1000));
  const requested = candidate === null ? wallClock : BigInt(candidate);
  const current = record ? BigInt(record.updatedAt) : 0n;
  return (requested > current ? requested : current).toString();
}

function nextCommand(record, withTransactionHash = true) {
  const phase = record.stage === "claim-submitting" ? "finish" : "advance";
  const suffix = withTransactionHash ? " --tx TRANSACTION_HASH" : "";
  return `node scripts/pull.mjs ${phase} --wallet ${record.wallet} --pull-id ${record.pullId}${suffix}`;
}

function submittingOutput(record, tx) {
  return {
    ok: true,
    phase: record.stage,
    pullId: record.pullId,
    txs: [tx],
    next: nextCommand(record),
    presentation: {
      mode: "silent-direct-execution",
      rule: "Do not reply yet. Submit txs[0] unmodified exactly once with waitForConfirmation=true, then run next with its transaction hash. The transaction was marked consumed before this output; never obtain a second copy by rerunning start.",
    },
  };
}

function waitingOutput(record) {
  return {
    ok: true,
    phase: "awaiting-settlement",
    pullId: record.pullId,
    txs: [],
    next: nextCommand(record, false),
    presentation: {
      mode: "silent-continue",
      rule: "Do not post progress. Run next immediately while this job can continue; otherwise the private pull record will resume the same request on the next invocation.",
    },
  };
}

function reconciliationOutput(record, detail = null, explicitNext = null) {
  const resumable = SUBMITTING_STAGES.has(record.stage);
  return {
    ok: false,
    phase: "needs-reconciliation",
    resumePhase: record.stage,
    pullId: record.pullId,
    txs: [],
    ...(explicitNext ? { next: explicitNext } : resumable ? { next: nextCommand(record) } : {}),
    presentation: {
      mode: "minimal-blocker",
      userPrompt: detail ?? `I need the exact ${record.expected?.action ?? "pull"} transaction hash from Bankr Activity to safely continue this pull.`,
    },
  };
}

function persistPlan(record, prepared) {
  return updatePullRecord(record.wallet, record.pullId, record.revision, (candidate) => ({
    ...candidate,
    updatedAt: timestamp(candidate),
    stage: prepared.stage,
    expected: prepared.expected,
  }));
}

function initialRecord(wallet, plan, prepared) {
  const directIntent = plan.terms?.directPullIntent;
  const directIntentKeyValue = String(plan.terms?.directPullIntentKey ?? "").toLowerCase();
  let intent;
  try { intent = decodeDirectPullIntent(directIntent); } catch (error) {
    throw new PullError("planner", `planner emitted an invalid pull authorization: ${error.message}`);
  }
  requireThat(directPullIntentKey(intent) === directIntentKeyValue, "planner", "planner pull authorization key mismatch");
  requireThat(intent.wallet === wallet, "planner", "planner pull authorization wallet mismatch");
  return {
    schemaVersion: 2,
    kind: "stonk-gacha-pull-state/v2",
    chainId: 8453,
    gacha: ADDR.gacha,
    wallet,
    pullId: directIntentKeyValue.slice(2),
    revision: 0,
    createdAt: String(intent.createdAt),
    updatedAt: timestamp(null, intent.createdAt),
    directIntent,
    directIntentKey: directIntentKeyValue,
    provenRevertRetries: {
      "allowance-reset-submitting": 0,
      "approval-submitting": 0,
      "open-submitting": 0,
      "claim-submitting": 0,
    },
    stage: prepared.stage,
    expected: prepared.expected,
    request: null,
  };
}

function freshPlan(record) {
  const planned = runCore(plannerArgs(record));
  if (planned.exitCode !== 0 || planned.payload.ok !== true) coreFailure(planned, "stored pull authorization no longer matches fresh Base state");
  return { plan: planned.payload, prepared: inspectPlan(record.wallet, planned.payload) };
}

function recoverApprovalStage(record) {
  requireThat(
    ["allowance-reset-submitting", "approval-submitting"].includes(record.stage),
    "state",
    `pull cannot recover approval state from ${record.stage}`,
  );
  const { prepared } = freshPlan(record);
  const allowed = record.stage === "allowance-reset-submitting"
    ? ["approval-submitting", "open-submitting"]
    : ["open-submitting"];
  if (!allowed.includes(prepared.stage)) return reconciliationOutput(record);
  const updated = persistPlan(record, prepared);
  return submittingOutput(updated, prepared.tx);
}

function directIntentExpired(record) {
  const intent = decodeDirectPullIntent(record.directIntent);
  return BigInt(Math.floor(Date.now() / 1000)) >= BigInt(intent.expiresAt);
}

function stopPreOpenRecord(record) {
  requireThat(record.request === null, "state", "a request-bound pull cannot be retired as pre-open");
  return updatePullRecord(record.wallet, record.pullId, record.revision, (candidate) => ({
    ...candidate,
    updatedAt: timestamp(candidate),
    stage: "stopped",
    expected: null,
  }));
}

function expiredRevertOutput(record) {
  return {
    ok: false,
    phase: "authorization-expired",
    pullId: record.pullId,
    txs: [],
    presentation: {
      mode: "minimal-blocker",
      userPrompt: "That exact pull authorization expired after its transaction reverted. Send a new pull command.",
    },
  };
}

function resumeProvenRevertedPreOpen(record) {
  requireThat(record.stage === "preopen-reverted", "state", "persisted pre-open revert recovery stage is invalid");
  if (directIntentExpired(record)) {
    stopPreOpenRecord(record);
    return expiredRevertOutput(record);
  }
  let prepared;
  try {
    ({ prepared } = freshPlan(record));
  } catch (error) {
    stopPreOpenRecord(record);
    throw error;
  }
  requireThat(
    ["allowance-reset-submitting", "approval-submitting", "open-submitting"].includes(prepared.stage),
    "state",
    "a reverted pre-open transaction did not return to a safe fresh pre-open phase",
  );
  const updated = persistPlan(record, prepared);
  return submittingOutput(updated, prepared.tx);
}

function recoverProvenRevertedPreOpen(record) {
  if (directIntentExpired(record)) {
    stopPreOpenRecord(record);
    return expiredRevertOutput(record);
  }
  if (record.provenRevertRetries[record.stage] >= MAX_AUTOMATIC_REVERT_RETRIES) {
    stopPreOpenRecord(record);
    return {
      ok: false,
      phase: "proven-revert-retry-exhausted",
      pullId: record.pullId,
      txs: [],
      presentation: {
        mode: "minimal-blocker",
        userPrompt: "That pull transaction reverted again. Send a new pull command if you want to retry.",
      },
    };
  }
  const revertedPhase = record.stage;
  const persisted = updatePullRecord(record.wallet, record.pullId, record.revision, (candidate) => ({
    ...candidate,
    updatedAt: timestamp(candidate),
    stage: "preopen-reverted",
    expected: null,
    provenRevertRetries: {
      ...candidate.provenRevertRetries,
      [revertedPhase]: candidate.provenRevertRetries[revertedPhase] + 1,
    },
  }));
  return resumeProvenRevertedPreOpen(persisted);
}

function watchArgs(record, flags) {
  const result = [
    "await-claim-prize",
    "--wallet", record.wallet,
    "--request-id", record.request.requestId,
    "--claim-continuation", record.request.claimContinuation,
    "--claim-continuation-key", record.request.claimContinuationKey,
  ];
  const maxWait = optionalDuration(flags, "max-wait-seconds", BANKR_EXECUTION.directPull.maximumActiveWatchSeconds)
    ?? String(BANKR_EXECUTION.directPull.maximumActiveWatchSeconds);
  const poll = optionalDuration(flags, "poll-interval-seconds", 30);
  result.push("--max-wait-seconds", maxWait);
  if (poll) result.push("--poll-interval-seconds", poll);
  return result;
}

function watch(record, flags) {
  const watched = runCore(watchArgs(record, flags));
  const payload = watched.payload;
  if (payload.ok === true && payload.phase === "action") {
    const prepared = inspectPlan(record.wallet, payload);
    requireThat(prepared.stage === "claim-submitting", "claim", "ready request did not produce the exact same-wallet claim");
    const updated = persistPlan(record, prepared);
    return submittingOutput(updated, prepared.tx);
  }
  if (payload.ok === true && payload.phase === "awaiting-settlement") {
    const updated = updatePullRecord(record.wallet, record.pullId, record.revision, (candidate) => ({
      ...candidate,
      updatedAt: timestamp(candidate),
      stage: "awaiting-settlement",
      expected: null,
    }));
    return waitingOutput(updated);
  }
  if (payload.phase === "delivered-needs-receipt-proof") {
    return reconciliationOutput(
      record,
      "This pull was delivered outside the current session. I need its exact successful claim transaction hash from Bankr Activity to report the result.",
      `node scripts/pull.mjs finish --wallet ${record.wallet} --pull-id ${record.pullId} --tx TRANSACTION_HASH`,
    );
  }
  if (payload.phase === "expired" || payload.phase === "refunded") {
    const updated = updatePullRecord(record.wallet, record.pullId, record.revision, (candidate) => ({
      ...candidate,
      updatedAt: timestamp(candidate),
      stage: payload.phase,
      expected: null,
    }));
    return {
      ok: payload.phase === "refunded",
      phase: payload.phase,
      pullId: updated.pullId,
      txs: [],
      presentation: payload.presentation ?? { mode: "minimal-blocker", userPrompt: "This pull expired and needs refund handling." },
    };
  }
  if (payload.phase === "settlement-window-ended" || payload.phase === "claim-authorization-expired") {
    return {
      ok: false,
      phase: payload.phase,
      pullId: record.pullId,
      txs: [],
      presentation: payload.presentation,
    };
  }
  coreFailure(watched, "exact request watcher could not safely continue");
}

function inspectReceipt(record, transactionHash, options = {}) {
  const inspected = runCore([
    "inspect-tx",
    "--wallet", record.wallet,
    "--tx", transactionHash,
    "--context", record.expected.contextHex,
    "--plan-key", record.expected.inspectionKey,
  ]);
  if (inspected.exitCode !== 0 || inspected.payload.ok !== true) {
    if (options.allowDeliveredFallback === true) return inspectDeliveredReceipt(record, transactionHash);
    coreFailure(inspected, "transaction receipt could not be proven");
  }
  requireThat(inspected.payload.inspection?.action?.name === record.expected.action, "receipt", "receipt action differs from the persisted pull phase");
  return inspected.payload;
}

function inspectDeliveredReceipt(record, transactionHash) {
  const inspected = runCore([
    "inspect-delivered-tx",
    "--wallet", record.wallet,
    "--tx", transactionHash,
    "--request-id", record.request.requestId,
  ]);
  if (inspected.exitCode !== 0 || inspected.payload.ok !== true) {
    coreFailure(inspected, "delivery transaction receipt could not be proven");
  }
  requireThat(
    inspected.payload.action?.name === "claim-prize"
      && String(inspected.payload.postStateProof?.requestId) === record.request.requestId,
    "receipt",
    "delivery transaction does not prove this exact pull",
  );
  return inspected.payload;
}

function finalOutput(proof) {
  requireThat(
    proof?.currentStatus === "Delivered"
      && typeof proof.finalMessage === "string"
      && /^You pulled \$[^\n]+ of [^\n]+\.$/.test(proof.finalMessage),
    "receipt",
    "claim receipt did not prove a delivered Stonk Gacha result",
  );
  return {
    ok: true,
    phase: "delivered",
    presentation: {
      mode: "final-only",
      finalMessage: proof.finalMessage,
      rule: "Reply with finalMessage verbatim and nothing else.",
    },
  };
}

function start(flags) {
  const wallet = canonicalWallet(need(flags, "wallet"));
  const pack = selectedPack(need(flags, "amount-usdc"));
  const discovery = withWalletPullLock(wallet, () => {
    const existing = activePullForStart(wallet);
    return { existing, generation: walletPullGeneration(wallet) };
  });
  if (discovery.existing) return resumeExistingPull(discovery.existing, pack, flags);
  return planAndCreatePull(wallet, pack, flags, discovery.generation);
}

function activePullForStart(wallet) {
  const existing = listActivePullRecords(wallet);
  requireThat(existing.length <= 1, "state", "multiple unfinished pulls require reconciliation before opening another");
  if (existing.length === 0) return null;
  const record = existing[0];
  const preApproval = ["allowance-reset-submitting", "approval-submitting"].includes(record.stage);
  if (preApproval && directIntentExpired(record)) {
    stopPreOpenRecord(record);
    return null;
  }
  return record;
}

function resumeExistingPull(record, pack, flags) {
  const existingIntent = decodeDirectPullIntent(record.directIntent);
  const preApproval = ["allowance-reset-submitting", "approval-submitting"].includes(record.stage);
  if (BigInt(existingIntent.authorization.authorizedPriceUsdcRaw) !== pack.raw) {
    return reconciliationOutput(
      record,
      `An earlier $${formatUnits(BigInt(existingIntent.authorization.authorizedPriceUsdcRaw), USDC_DECIMALS)} pull is unfinished. Complete it before starting this $${pack.formatted} pull.`,
    );
  }
  if (record.stage === "awaiting-settlement") return watch(record, flags);
  if (record.stage === "preopen-reverted") return resumeProvenRevertedPreOpen(record);
  if (preApproval) return recoverApprovalStage(record);
  if (SUBMITTING_STAGES.has(record.stage)) return reconciliationOutput(record);
  return reconciliationOutput(record, "An unfinished Stonk Gacha pull needs reconciliation before another can start.");
}

function planAndCreatePull(wallet, pack, flags, discoveredGeneration) {
  const planner = [
    "plan-open-pack",
    "--wallet", wallet,
    "--pack-index", String(pack.packIndex),
    "--authorized-price-usdc", pack.formatted,
  ];
  if (flags["authorized-entropy-fee-wei"] !== undefined) {
    requireThat(/^[1-9][0-9]*$/.test(flags["authorized-entropy-fee-wei"]), "args", "--authorized-entropy-fee-wei must be a positive integer");
    planner.push("--authorized-entropy-fee-wei", flags["authorized-entropy-fee-wei"]);
  }
  const planned = runCore(planner);
  if (planned.payload.phase === "choose-funding-source") {
    const eligibleSources = planned.payload.funding?.choices
      ?.filter((choice) => choice.eligible)
      .map((choice) => choice.sourceToken) ?? [];
    const fundingPrompt = eligibleSources.length === 1
      ? `Use ${eligibleSources[0]} on Base to fund the exact USDC deficit for this $${pack.formatted} pull?`
      : eligibleSources.length > 1
        ? `Choose ${eligibleSources.join(" or ")} on Base to fund the exact USDC deficit for this $${pack.formatted} pull.`
        : `This wallet needs more Base ETH or WETH before it can fund the exact USDC deficit for this $${pack.formatted} pull.`;
    return {
      ok: true,
      phase: "funding-required",
      txs: [],
      presentation: {
        mode: "minimal-blocker",
        userPrompt: fundingPrompt,
      },
      funding: {
        exactDeficitUsdc: planned.payload.funding?.exactDeficitUsdc,
        eligibleSources,
      },
    };
  }
  if (planned.exitCode !== 0 || planned.payload.ok !== true) coreFailure(planned);
  const prepared = inspectPlan(wallet, planned.payload);
  const record = initialRecord(wallet, planned.payload, prepared);
  const winner = withWalletPullLock(wallet, () => {
    const current = activePullForStart(wallet);
    if (current) return { existing: current };
    if (walletPullGeneration(wallet) !== discoveredGeneration) return { superseded: true };
    createPullRecord(record);
    return { created: record };
  });
  if (winner.existing) return resumeExistingPull(winner.existing, pack, flags);
  if (winner.superseded) {
    return {
      ok: false,
      phase: "superseded",
      txs: [],
      presentation: {
        mode: "minimal-blocker",
        userPrompt: "Another Stonk Gacha pull changed this wallet while this command was preparing. The stale transaction was discarded; ask again only if you want another pull.",
      },
    };
  }
  return submittingOutput(winner.created, prepared.tx);
}

function advance(flags) {
  const wallet = canonicalWallet(need(flags, "wallet"));
  const pullId = validatePullId(need(flags, "pull-id"));
  let record = loadPullRecord(wallet, pullId);
  if (record.stage === "awaiting-settlement") {
    requireThat(flags.tx === undefined, "args", "awaiting-settlement does not accept a transaction hash");
    return watch(record, flags);
  }
  requireThat(["allowance-reset-submitting", "approval-submitting", "open-submitting"].includes(record.stage), "state", `pull cannot advance from ${record.stage}`);
  if (flags.tx === undefined) {
    if (record.stage === "open-submitting") return reconciliationOutput(record);
    return recoverApprovalStage(record);
  }
  const receipt = inspectReceipt(record, canonicalHash(flags.tx, "tx"));
  if (receipt.phase === "proven-reverted") return recoverProvenRevertedPreOpen(record);
  if (record.stage !== "open-submitting") {
    const { prepared } = freshPlan(record);
    const allowed = record.stage === "allowance-reset-submitting"
      ? ["approval-submitting", "open-submitting"]
      : ["open-submitting"];
    requireThat(allowed.includes(prepared.stage), "state", "fresh allowance state did not advance the persisted pull phase");
    record = persistPlan(record, prepared);
    return submittingOutput(record, prepared.tx);
  }
  const proof = receipt.postStateProof;
  requireThat(
    proof?.requestId && proof.openTransactionHash === flags.tx.toLowerCase()
      && proof.claimContinuation && proof.claimContinuationKey && proof.claimContinuationExpiresAt,
    "receipt",
    "open receipt did not produce an exact request-bound claim continuation",
  );
  record = updatePullRecord(record.wallet, record.pullId, record.revision, (candidate) => ({
    ...candidate,
    updatedAt: timestamp(candidate),
    stage: "awaiting-settlement",
    expected: null,
    request: {
      requestId: String(proof.requestId),
      openTransactionHash: proof.openTransactionHash.toLowerCase(),
      claimContinuation: proof.claimContinuation,
      claimContinuationKey: proof.claimContinuationKey.toLowerCase(),
      claimContinuationExpiresAt: String(proof.claimContinuationExpiresAt),
      claimTransactionHash: null,
    },
  }));
  return watch(record, flags);
}

function finish(flags) {
  const wallet = canonicalWallet(need(flags, "wallet"));
  const pullId = validatePullId(need(flags, "pull-id"));
  const transactionHash = canonicalHash(need(flags, "tx"), "tx");
  let record = loadPullRecord(wallet, pullId);
  requireThat(["awaiting-settlement", "claim-submitting", "delivered"].includes(record.stage), "state", `pull cannot finish from ${record.stage}`);
  if (record.stage === "delivered") {
    requireThat(record.request.claimTransactionHash === transactionHash, "state", "claim transaction hash differs from the delivered pull record");
  }
  const receipt = record.stage === "awaiting-settlement" || record.expected === null
    ? inspectDeliveredReceipt(record, transactionHash)
    : inspectReceipt(record, transactionHash, { allowDeliveredFallback: record.stage === "claim-submitting" });
  if (receipt.phase === "proven-reverted") {
    requireThat(record.stage === "claim-submitting", "receipt", "only a pending compact claim can recover from a proven revert");
    if (record.provenRevertRetries[record.stage] >= MAX_AUTOMATIC_REVERT_RETRIES) {
      return {
        ok: false,
        phase: "proven-revert-retry-exhausted",
        pullId: record.pullId,
        txs: [],
        presentation: {
          mode: "minimal-blocker",
          userPrompt: "That prize claim reverted again. Tell me to retry this exact prize if you want another attempt.",
        },
      };
    }
    record = updatePullRecord(record.wallet, record.pullId, record.revision, (candidate) => ({
      ...candidate,
      updatedAt: timestamp(candidate),
      stage: "awaiting-settlement",
      expected: null,
      provenRevertRetries: {
        ...candidate.provenRevertRetries,
        [candidate.stage]: candidate.provenRevertRetries[candidate.stage] + 1,
      },
    }));
    return watch(record, {});
  }
  const proof = receipt.postStateProof;
  requireThat(
    proof?.currentStatus === "Delivered" && String(proof.requestId) === record.request.requestId
      && typeof proof.finalMessage === "string" && /^You pulled \$[^\n]+ of [^\n]+\.$/.test(proof.finalMessage),
    "receipt",
    "claim receipt did not prove the exact pull was delivered to this wallet",
  );
  if (record.stage !== "delivered") {
    updatePullRecord(record.wallet, record.pullId, record.revision, (candidate) => ({
      ...candidate,
      updatedAt: timestamp(candidate),
      stage: "delivered",
      expected: candidate.stage === "claim-submitting" && receipt.command === "inspect-tx"
        ? candidate.expected
        : null,
      request: { ...candidate.request, claimTransactionHash: transactionHash },
    }));
  }
  return finalOutput(proof);
}

try {
  const flags = parseFlags();
  const result = command === "start" ? start(flags) : command === "advance" ? advance(flags) : finish(flags);
  output(result, result.ok === false ? 2 : 0);
} catch (error) {
  if (error instanceof PullError) {
    output({
      ok: false,
      phase: "blocked",
      gate: error.gate,
      error: error.message,
      ...error.extra,
      txs: [],
      presentation: { mode: "minimal-blocker", userPrompt: error.message },
    }, 1);
  } else {
    output({
      ok: false,
      phase: "blocked",
      gate: "unexpected",
      error: error?.message ?? String(error),
      txs: [],
      presentation: { mode: "minimal-blocker", userPrompt: "Stonk Gacha could not safely continue this pull." },
    }, 1);
  }
}
