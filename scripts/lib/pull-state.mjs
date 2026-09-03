import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { normalizeAddress } from "./abi.mjs";
import {
  decodeDirectClaimContinuation,
  decodeDirectPullIntent,
  directClaimContinuationKey,
  directPullIntentKey,
} from "./direct.mjs";

const BANKR_POLICY = JSON.parse(
  readFileSync(new URL("../../references/bankr-execution.json", import.meta.url), "utf8"),
);
const DEPLOYMENT_POLICY = JSON.parse(
  readFileSync(new URL("../../references/deployment.json", import.meta.url), "utf8"),
);

export const PULL_STATE_KIND = "stonk-gacha-pull-state/v2";
export const PULL_STATE_STAGES = Object.freeze([
  "allowance-reset-submitting",
  "approval-submitting",
  "open-submitting",
  "preopen-reverted",
  "awaiting-settlement",
  "claim-submitting",
  "needs-reconciliation",
  "delivered",
  "expired",
  "refunded",
  "stopped",
]);
export const TERMINAL_PULL_STAGES = Object.freeze(["delivered", "expired", "refunded", "stopped"]);

const READY_ACTIONS = Object.freeze({
  "allowance-reset-submitting": "approve",
  "approval-submitting": "approve",
  "open-submitting": "open-pack",
  "claim-submitting": "claim-prize",
});
const LEGAL_TRANSITIONS = Object.freeze({
  "allowance-reset-submitting": ["allowance-reset-submitting", "approval-submitting", "open-submitting", "preopen-reverted", "needs-reconciliation", "stopped"],
  "approval-submitting": ["allowance-reset-submitting", "approval-submitting", "open-submitting", "preopen-reverted", "needs-reconciliation", "stopped"],
  "open-submitting": ["allowance-reset-submitting", "approval-submitting", "open-submitting", "preopen-reverted", "awaiting-settlement", "claim-submitting", "expired", "refunded", "needs-reconciliation", "stopped"],
  "preopen-reverted": ["allowance-reset-submitting", "approval-submitting", "open-submitting", "stopped"],
  "awaiting-settlement": ["awaiting-settlement", "claim-submitting", "delivered", "expired", "refunded", "needs-reconciliation", "stopped"],
  "claim-submitting": ["awaiting-settlement", "delivered", "needs-reconciliation", "stopped"],
  "needs-reconciliation": ["stopped"],
  delivered: [],
  expired: [],
  refunded: [],
  stopped: [],
});
const EXPECTED_FIELDS = Object.freeze(["action", "contextHex", "inspectionKey"]);
const REQUEST_FIELDS = Object.freeze([
  "requestId",
  "openTransactionHash",
  "claimContinuation",
  "claimContinuationKey",
  "claimContinuationExpiresAt",
  "claimTransactionHash",
]);
const RECORD_FIELDS = Object.freeze([
  "schemaVersion",
  "kind",
  "chainId",
  "gacha",
  "wallet",
  "pullId",
  "revision",
  "createdAt",
  "updatedAt",
  "directIntent",
  "directIntentKey",
  "provenRevertRetries",
  "stage",
  "expected",
  "request",
]);
const PROVEN_REVERT_RETRY_FIELDS = Object.freeze([
  "allowance-reset-submitting",
  "approval-submitting",
  "open-submitting",
  "claim-submitting",
]);
const BYTES32 = /^0x[0-9a-f]{64}$/;
const OPAQUE_HEX = /^0x(?:[0-9a-f]{2})+$/;
const PULL_ID = /^[0-9a-f]{64}$/;
const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;
const COMPACT_HOME_DIRECTORY = String(BANKR_POLICY.directPull.compactStateHomeDirectory);
invariant(
  /^(?:\.?[a-z0-9-]+)(?:\/[a-z0-9.-]+)*$/.test(COMPACT_HOME_DIRECTORY)
    && !COMPACT_HOME_DIRECTORY.split("/").includes(".."),
  "compact pull state home directory is invalid",
);
const DEFAULT_ROOT = path.join(homedir(), COMPACT_HOME_DIRECTORY);
const LOCK_STALE_MS = Number(BANKR_POLICY.directPull.compactStateLockStaleSeconds) * 1_000;
invariant(Number.isSafeInteger(LOCK_STALE_MS) && LOCK_STALE_MS >= 60_000, "compact pull lock lease is invalid");
const GACHA = normalizeAddress(DEPLOYMENT_POLICY.contracts.stonkGacha.address);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function rejectUnknownKeys(value, allowed, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  invariant(unknown.length === 0, `${label} contains unsupported field ${unknown[0]}`);
}

function canonicalUint(value, label) {
  invariant(typeof value === "string" && CANONICAL_UINT.test(value), `${label} must be a canonical uint string`);
  return BigInt(value);
}

function canonicalBytes32(value, label) {
  invariant(typeof value === "string" && BYTES32.test(value), `${label} must be canonical lowercase bytes32`);
  return value;
}

function canonicalOpaque(value, label) {
  invariant(typeof value === "string" && OPAQUE_HEX.test(value), `${label} must be canonical lowercase even-length hex`);
  invariant(value.length <= 2 + 65_536 * 2, `${label} exceeds 64 KiB`);
  return value;
}

export function validatePullId(value) {
  invariant(typeof value === "string" && PULL_ID.test(value), "pull id must be 32 bytes of lowercase hex");
  return value;
}

export function pullStateRoot(override = null) {
  const selected = override ?? process.env.STONK_GACHA_PULLS_ROOT ?? DEFAULT_ROOT;
  invariant(typeof selected === "string" && path.isAbsolute(selected), "pull state root must be an absolute path");
  const resolved = path.resolve(selected);
  invariant(resolved === selected && resolved !== path.parse(resolved).root, "pull state root must be canonical and cannot be the filesystem root");
  rejectSymlinkAncestors(resolved);
  return resolved;
}

function rejectSymlinkAncestors(target) {
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const component of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!existsSync(current)) continue;
    invariant(!lstatSync(current).isSymbolicLink(), `pull state path contains a symlink: ${current}`);
  }
}

export function pullStatePath(wallet, pullId, options = {}) {
  const root = pullStateRoot(options.root);
  const canonicalWallet = normalizeAddress(wallet);
  const canonicalPullId = validatePullId(pullId);
  const walletDirectory = path.join(root, "8453", canonicalWallet);
  const recordPath = path.join(walletDirectory, `${canonicalPullId}.json`);
  invariant(recordPath.startsWith(`${walletDirectory}${path.sep}`), "pull state path escaped its wallet directory");
  return recordPath;
}

export function validatePullRecord(record) {
  rejectUnknownKeys(record, RECORD_FIELDS, "pull record");
  invariant(record.schemaVersion === 2 && record.kind === PULL_STATE_KIND, "unsupported pull record schema");
  invariant(record.chainId === 8453, "pull record is not for Base");
  invariant(record.gacha === GACHA, "pull record does not pin the reviewed StonkGacha deployment");
  invariant(record.wallet === normalizeAddress(record.wallet), "pull record wallet must be canonical lowercase");
  validatePullId(record.pullId);
  invariant(Number.isSafeInteger(record.revision) && record.revision >= 0, "pull record revision is invalid");
  const createdAt = canonicalUint(record.createdAt, "pull record createdAt");
  const updatedAt = canonicalUint(record.updatedAt, "pull record updatedAt");
  invariant(updatedAt >= createdAt, "pull record updatedAt predates creation");
  canonicalOpaque(record.directIntent, "pull record direct intent");
  canonicalBytes32(record.directIntentKey, "pull record direct intent key");
  invariant(record.directIntentKey === `0x${record.pullId}`, "pull id must equal the direct intent key");
  let directIntent;
  try {
    directIntent = decodeDirectPullIntent(record.directIntent);
  } catch (error) {
    throw new Error(`pull record direct intent is invalid: ${error.message}`);
  }
  invariant(directPullIntentKey(directIntent) === record.directIntentKey, "pull record direct intent key mismatch");
  invariant(directIntent.wallet === record.wallet, "pull record direct intent wallet mismatch");
  invariant(BigInt(directIntent.createdAt) === createdAt, "pull record creation time differs from its direct intent");
  rejectUnknownKeys(record.provenRevertRetries, PROVEN_REVERT_RETRY_FIELDS, "pull record proven revert retries");
  for (const phase of PROVEN_REVERT_RETRY_FIELDS) {
    invariant(
      Number.isSafeInteger(record.provenRevertRetries[phase])
        && record.provenRevertRetries[phase] >= 0
        && record.provenRevertRetries[phase] <= Number(BANKR_POLICY.directPull.maximumAutomaticProvenRevertRetriesPerPhase),
      `pull record proven revert retry count is invalid for ${phase}`,
    );
  }
  invariant(PULL_STATE_STAGES.includes(record.stage), "pull record stage is unsupported");

  const expectedAction = READY_ACTIONS[record.stage] ?? null;
  if (expectedAction) {
    rejectUnknownKeys(record.expected, EXPECTED_FIELDS, "pull record expected transaction");
    invariant(record.expected.action === expectedAction, "pull record expected action does not match its stage");
    canonicalOpaque(record.expected.contextHex, "pull record inspection context");
    canonicalBytes32(record.expected.inspectionKey, "pull record inspection key");
  } else if (record.stage === "needs-reconciliation" && record.expected !== null) {
    rejectUnknownKeys(record.expected, EXPECTED_FIELDS, "pull record expected transaction");
    invariant(["approve", "open-pack", "claim-prize"].includes(record.expected.action), "reconciliation action is unsupported");
    canonicalOpaque(record.expected.contextHex, "pull record inspection context");
    canonicalBytes32(record.expected.inspectionKey, "pull record inspection key");
  } else if (record.stage === "delivered" && record.expected !== null) {
    rejectUnknownKeys(record.expected, EXPECTED_FIELDS, "pull record delivered transaction");
    invariant(record.expected.action === "claim-prize", "delivered pull can retain only its claim transaction proof");
    canonicalOpaque(record.expected.contextHex, "pull record inspection context");
    canonicalBytes32(record.expected.inspectionKey, "pull record inspection key");
  } else {
    invariant(record.expected === null, "non-ready pull stage cannot retain a pending transaction");
  }

  const needsRequest = ["awaiting-settlement", "claim-submitting", "delivered", "expired", "refunded"].includes(record.stage);
  const allowsRequest = [
    "awaiting-settlement", "claim-submitting", "needs-reconciliation",
    "delivered", "expired", "refunded", "stopped",
  ].includes(record.stage);
  if (record.request === null) {
    invariant(!needsRequest, "pull stage requires an exact request record");
  } else {
    invariant(allowsRequest, "pre-open pull stage cannot contain a request record");
    rejectUnknownKeys(record.request, REQUEST_FIELDS, "pull request record");
    invariant(canonicalUint(record.request.requestId, "pull request id") > 0n, "pull request id must be nonzero");
    canonicalBytes32(record.request.openTransactionHash, "pull open transaction hash");
    canonicalOpaque(record.request.claimContinuation, "pull claim continuation");
    canonicalBytes32(record.request.claimContinuationKey, "pull claim continuation key");
    invariant(canonicalUint(record.request.claimContinuationExpiresAt, "pull claim continuation expiry") > 0n, "pull claim continuation expiry must be nonzero");
    if (record.request.claimTransactionHash !== null) {
      canonicalBytes32(record.request.claimTransactionHash, "pull claim transaction hash");
    }
    if (record.stage === "delivered") {
      invariant(record.request.claimTransactionHash !== null, "delivered pull requires its exact claim transaction hash");
    } else if (record.stage !== "needs-reconciliation") {
      invariant(record.request.claimTransactionHash === null, "unproved pull stage cannot retain a claim transaction hash");
    }
    let continuation;
    try {
      continuation = decodeDirectClaimContinuation(record.request.claimContinuation);
    } catch (error) {
      throw new Error(`pull record claim continuation is invalid: ${error.message}`);
    }
    invariant(directClaimContinuationKey(continuation) === record.request.claimContinuationKey, "pull record claim continuation key mismatch");
    invariant(continuation.wallet === record.wallet, "pull record claim continuation wallet mismatch");
    invariant(String(continuation.requestId) === record.request.requestId, "pull record claim continuation request mismatch");
    invariant(continuation.sourceOpenProof.authorizationKind === "direct-pull-intent", "pull record claim continuation is not bound to a direct pull intent");
    invariant(continuation.sourceOpenProof.authorizationKey === record.directIntentKey, "pull record claim continuation authorization mismatch");
    invariant(continuation.sourceOpenProof.transactionHash === record.request.openTransactionHash, "pull record open transaction mismatch");
    invariant(String(continuation.expiresAt) === record.request.claimContinuationExpiresAt, "pull record claim continuation expiry mismatch");
  }
  return record;
}

function ensureDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  rejectSymlinkAncestors(directory);
  const metadata = lstatSync(directory);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), `pull state directory is not a private directory: ${directory}`);
  chmodSync(directory, 0o700);
}

function readRecordFile(recordPath) {
  const metadata = lstatSync(recordPath);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), "pull record must be a regular file, not a symlink");
  invariant((metadata.mode & 0o077) === 0, "pull record permissions expose private authorization data");
  invariant(metadata.size > 0 && metadata.size <= 262_144, "pull record size is invalid");
  const raw = readFileSync(recordPath, "utf8");
  const parsed = JSON.parse(raw);
  invariant(JSON.stringify(parsed, null, 2) + "\n" === raw, "pull record JSON is not in canonical file form");
  return validatePullRecord(parsed);
}

function atomicReplace(recordPath, record, options = {}) {
  const body = JSON.stringify(validatePullRecord(record), null, 2) + "\n";
  const temporary = `${recordPath}.${process.pid}.${Date.now()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(descriptor, body, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (options.beforeRename) options.beforeRename(temporary, recordPath);
    renameSync(temporary, recordPath);
    let directoryDescriptor;
    try {
      directoryDescriptor = openSync(path.dirname(recordPath), constants.O_RDONLY);
      fsyncSync(directoryDescriptor);
    } catch (error) {
      if (!["EINVAL", "EBADF", "ENOTSUP"].includes(error?.code)) throw error;
    } finally {
      if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function withExclusiveLock(lockPath, operation, depth = 0) {
  invariant(depth <= 16, "pull record lock recovery depth exceeded");
  const token = randomBytes(16).toString("hex");
  const candidatePath = `${lockPath}.${process.pid}.${token}.candidate`;
  const owner = { version: 1, pid: process.pid, createdAtMs: Date.now(), token };
  let descriptor;
  let ownedIdentity;
  let candidateIdentity;
  let deferredRelease = false;
  let released = false;

  const identityOf = (target) => {
    const metadata = lstatSync(target, { bigint: true });
    return { dev: metadata.dev, ino: metadata.ino };
  };
  const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
  const busy = () => new Error("pull record is already being advanced by another process");
  const lockStatus = (target, observed) => {
    invariant(observed.isFile() && !observed.isSymbolicLink(), "pull record lock must be a regular file");
    invariant((observed.mode & 0o077n) === 0n, "pull record lock permissions are unsafe");
    let priorOwner;
    try { priorOwner = JSON.parse(readFileSync(target, "utf8")); }
    catch { throw new Error("pull record lock owner metadata is invalid"); }
    let current;
    try { current = lstatSync(target, { bigint: true }); } catch (error) {
      if (error?.code === "ENOENT") throw busy();
      throw error;
    }
    if (!sameIdentity(current, observed)) throw busy();
    invariant(priorOwner && typeof priorOwner === "object" && !Array.isArray(priorOwner), "pull record lock owner metadata is invalid");
    const ownerKeys = Object.keys(priorOwner).sort();
    invariant(
      JSON.stringify(ownerKeys) === JSON.stringify(["createdAtMs", "pid"])
        || JSON.stringify(ownerKeys) === JSON.stringify(["createdAtMs", "pid", "token", "version"]),
      "pull record lock owner metadata is invalid",
    );
    const createdAtMs = Number(priorOwner.createdAtMs);
    invariant(Number.isSafeInteger(createdAtMs) && createdAtMs > 0, "pull record lock owner metadata is invalid");
    const pid = Number(priorOwner.pid);
    invariant(Number.isSafeInteger(pid) && pid > 0, "pull record lock owner metadata is invalid");
    invariant(
      priorOwner.token === undefined
        || (priorOwner.version === 1 && /^[0-9a-f]{32}$/.test(priorOwner.token)),
      "pull record lock owner metadata is invalid",
    );
    let ownerAlive = false;
    try { process.kill(pid, 0); ownerAlive = true; }
    catch (probeError) { ownerAlive = probeError?.code === "EPERM"; }
    return {
      ownerAlive,
      stale: BigInt(Date.now()) - (BigInt(createdAtMs) > observed.mtimeMs ? BigInt(createdAtMs) : observed.mtimeMs) >= BigInt(LOCK_STALE_MS),
    };
  };
  const unlinkIfSameIdentity = (target, identity) => {
    let metadata;
    try { metadata = lstatSync(target, { bigint: true }); } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (!sameIdentity(metadata, identity)) return false;
    unlinkSync(target);
    return true;
  };
  const releaseOwnedLock = () => {
    if (released || !ownedIdentity) return;
    invariant(
      unlinkIfSameIdentity(lockPath, ownedIdentity),
      "pull record lock ownership changed while held",
    );
    released = true;
  };

  try {
    descriptor = openSync(candidatePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    candidateIdentity = identityOf(candidatePath);

    try {
      linkSync(candidatePath, lockPath);
      ownedIdentity = candidateIdentity;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let observed;
      try { observed = lstatSync(lockPath, { bigint: true }); } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
        try {
          linkSync(candidatePath, lockPath);
          ownedIdentity = candidateIdentity;
        } catch (retryError) {
          if (retryError?.code === "EEXIST") throw busy();
          throw retryError;
        }
      }
      if (!ownedIdentity) {
        const initialStatus = lockStatus(lockPath, observed);
        invariant(initialStatus.stale && !initialStatus.ownerAlive, "pull record is already being advanced by another process");

        withExclusiveLock(`${lockPath}.reaper`, () => {
          const confirmedStatus = lockStatus(lockPath, observed);
          invariant(confirmedStatus.stale && !confirmedStatus.ownerAlive, "pull record is already being advanced by another process");
          renameSync(candidatePath, lockPath);
          ownedIdentity = candidateIdentity;
        }, depth + 1);
      }
    }

    unlinkIfSameIdentity(candidatePath, candidateIdentity);
    const result = operation();
    if (result && typeof result.then === "function") {
      deferredRelease = true;
      return Promise.resolve(result).finally(releaseOwnedLock);
    }
    return result;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (candidateIdentity) unlinkIfSameIdentity(candidatePath, candidateIdentity);
    if (!deferredRelease) releaseOwnedLock();
  }
}

function withRecordLock(recordPath, operation) {
  return withExclusiveLock(`${recordPath}.lock`, operation);
}

export function withWalletPullLock(wallet, operation, options = {}) {
  invariant(typeof operation === "function", "wallet pull lock operation must be a function");
  const root = pullStateRoot(options.root);
  const canonicalWallet = normalizeAddress(wallet);
  const walletDirectory = path.join(root, "8453", canonicalWallet);
  ensureDirectory(walletDirectory);
  return withExclusiveLock(path.join(walletDirectory, ".start.lock"), operation);
}

export function createPullRecord(record, options = {}) {
  const validated = validatePullRecord(record);
  invariant(validated.revision === 0, "new pull record revision must be zero");
  const recordPath = pullStatePath(validated.wallet, validated.pullId, options);
  ensureDirectory(path.dirname(recordPath));
  return withRecordLock(recordPath, () => {
    invariant(!existsSync(recordPath), "pull record already exists");
    atomicReplace(recordPath, validated, options);
    return validated;
  });
}

export function loadPullRecord(wallet, pullId, options = {}) {
  const recordPath = pullStatePath(wallet, pullId, options);
  invariant(existsSync(recordPath), "pull record does not exist");
  const record = readRecordFile(recordPath);
  invariant(record.wallet === normalizeAddress(wallet) && record.pullId === validatePullId(pullId), "pull record path identity mismatch");
  return record;
}

export function updatePullRecord(wallet, pullId, expectedRevision, update, options = {}) {
  invariant(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, "expected pull revision is invalid");
  invariant(typeof update === "function", "pull record update must be a function");
  const recordPath = pullStatePath(wallet, pullId, options);
  return withRecordLock(recordPath, () => {
    const current = readRecordFile(recordPath);
    invariant(current.revision === expectedRevision, "pull record revision changed; reconcile before continuing");
    const candidate = update(structuredClone(current));
    invariant(candidate && typeof candidate === "object", "pull record update returned no record");
    candidate.revision = current.revision + 1;
    invariant(
      candidate.schemaVersion === current.schemaVersion
        && candidate.kind === current.kind
        && candidate.chainId === current.chainId
        && candidate.gacha === current.gacha
        && candidate.wallet === current.wallet
        && candidate.pullId === current.pullId,
      "pull record identity cannot change",
    );
    invariant(candidate.createdAt === current.createdAt, "pull record creation time cannot change");
    invariant(candidate.directIntent === current.directIntent && candidate.directIntentKey === current.directIntentKey, "pull authorization cannot change");
    for (const phase of PROVEN_REVERT_RETRY_FIELDS) {
      invariant(
        candidate.provenRevertRetries[phase] === current.provenRevertRetries[phase]
          || candidate.provenRevertRetries[phase] === current.provenRevertRetries[phase] + 1,
        `proven revert retry count cannot skip or decrease for ${phase}`,
      );
    }
    invariant(BigInt(candidate.updatedAt) >= BigInt(current.updatedAt), "pull record updatedAt cannot move backwards");
    invariant(LEGAL_TRANSITIONS[current.stage].includes(candidate.stage), `illegal pull stage transition ${current.stage} -> ${candidate.stage}`);
    if (current.request !== null) {
      invariant(candidate.request !== null, "bound pull request cannot be removed");
      for (const field of REQUEST_FIELDS.filter((field) => field !== "claimTransactionHash")) {
        invariant(candidate.request[field] === current.request[field], `bound pull request field ${field} cannot change`);
      }
      if (current.request.claimTransactionHash !== null) {
        invariant(candidate.request.claimTransactionHash === current.request.claimTransactionHash, "pull claim transaction hash cannot change");
      }
    } else if (candidate.request !== null) {
      invariant(
        current.stage === "open-submitting" && ["awaiting-settlement", "needs-reconciliation"].includes(candidate.stage),
        "a pull request can only bind after its open receipt",
      );
    }
    atomicReplace(recordPath, candidate, options);
    return validatePullRecord(candidate);
  });
}

function listPullRecords(wallet, options = {}) {
  const root = pullStateRoot(options.root);
  const canonicalWallet = normalizeAddress(wallet);
  const walletDirectory = path.join(root, "8453", canonicalWallet);
  if (!existsSync(walletDirectory)) return [];
  const metadata = lstatSync(walletDirectory);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "pull wallet directory must not be a symlink");
  if ((metadata.mode & 0o077) !== 0) chmodSync(walletDirectory, 0o700);
  const records = [];
  for (const entry of readdirSync(walletDirectory, { withFileTypes: true })) {
    if (!entry.name.endsWith(".json")) continue;
    invariant(entry.isFile() && !entry.isSymbolicLink(), "pull wallet directory contains a non-file record");
    const pullId = entry.name.slice(0, -5);
    invariant(!/^(0|[1-9][0-9]*)$/.test(pullId), "legacy request journal requires reconciliation before a compact pull");
    if (!PULL_ID.test(pullId)) continue;
    const record = readRecordFile(path.join(walletDirectory, entry.name));
    invariant(record.wallet === canonicalWallet && record.pullId === pullId, "pull record filename identity mismatch");
    records.push(record);
  }
  return records.sort((left, right) => {
    const leftCreatedAt = BigInt(left.createdAt);
    const rightCreatedAt = BigInt(right.createdAt);
    if (leftCreatedAt < rightCreatedAt) return -1;
    if (leftCreatedAt > rightCreatedAt) return 1;
    return left.pullId.localeCompare(right.pullId);
  });
}

export function walletPullGeneration(wallet, options = {}) {
  const records = listPullRecords(wallet, options);
  const canonical = records.map((record) => [
    record.pullId,
    record.revision,
    record.stage,
    record.updatedAt,
  ]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function listActivePullRecords(wallet, options = {}) {
  return listPullRecords(wallet, options).filter((record) => !TERMINAL_PULL_STAGES.includes(record.stage));
}

export function pullRecordMetadata(recordPath) {
  const metadata = statSync(recordPath);
  return { mode: metadata.mode & 0o777, size: metadata.size };
}
