import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DIRECT_CLAIM_TTL_SECONDS,
  DIRECT_PULL_TTL_SECONDS,
  DEFAULT_DIRECT_ENTROPY_FEE_CAP_WEI,
  createDirectClaimContinuation,
  createDirectPullIntent,
  directClaimContinuationKey,
  directPullIntentKey,
  directUserRandomNumber,
  encodeDirectClaimContinuation,
  encodeDirectPullIntent,
} from "../scripts/lib/direct.mjs";
import { keccak256 } from "../scripts/lib/keccak256.mjs";
import {
  PULL_STATE_KIND,
  createPullRecord,
  listActivePullRecords,
  loadPullRecord,
  pullRecordMetadata,
  pullStatePath,
  pullStateRoot,
  updatePullRecord,
  validatePullRecord,
  withWalletPullLock,
  walletPullGeneration,
} from "../scripts/lib/pull-state.mjs";
import { ADDR } from "../scripts/lib/protocol.mjs";

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET = "0x2222222222222222222222222222222222222222";
let fixtureSequence = 0;

function withTempRoot(run) {
  const created = mkdtempSync(path.join(tmpdir(), "stonk-gacha-pull-state-"));
  const root = realpathSync(created);
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectedTransaction(action, label = action) {
  return {
    action,
    contextHex: `0x${Buffer.from(JSON.stringify({ action, label }), "utf8").toString("hex")}`,
    inspectionKey: keccak256(`inspection:${label}`),
  };
}

function directFixture({
  wallet = WALLET,
  createdAt = 1_788_345_000n + BigInt(++fixtureSequence),
  allowance = 7_000_000n,
  requestCount = 7n,
} = {}) {
  const secret = `0x${fixtureSequence.toString(16).padStart(64, "0")}`;
  const userRandomNumber = directUserRandomNumber(secret);
  const intent = createDirectPullIntent({
    wallet,
    packIndex: 1,
    authorizedPriceUsdcRaw: 10_000_000n,
    packPriceUsdcRaw: 10_000_000n,
    expectedOfferHash: keccak256(`offer:${fixtureSequence}`),
    acceptedCeilingBps: 100_000n,
    entropyFeeObservedWei: DEFAULT_DIRECT_ENTROPY_FEE_CAP_WEI,
    entropyFeeCapWei: DEFAULT_DIRECT_ENTROPY_FEE_CAP_WEI,
    feeAuthorization: "reviewed-default-cap",
    claimCapabilitySecret: secret,
    userRandomNumber,
    usdcBalance: 40_000_000n,
    ethBalance: 2_000_000_000_000_000n,
    allowance,
    requestCount,
    token: ADDR.usdc,
    spender: ADDR.gacha,
    createdAt,
    expiresAt: createdAt + DIRECT_PULL_TTL_SECONDS,
  });
  const directIntent = encodeDirectPullIntent(intent);
  const directIntentKey = directPullIntentKey(intent);
  return {
    wallet,
    createdAt,
    directIntent,
    directIntentKey,
    pullId: directIntentKey.slice(2),
  };
}

function requestFixture(direct, { requestId = 42n, openedAt = direct.createdAt + 10n } = {}) {
  const openTransactionHash = keccak256(`open:${direct.pullId}:${requestId}`);
  const continuation = createDirectClaimContinuation({
    wallet: direct.wallet,
    requestId,
    sourceAuthorizationKind: "direct-pull-intent",
    sourceAuthorizationKey: direct.directIntentKey,
    openTransactionHash,
    openInspectionKey: keccak256(`open-inspection:${direct.pullId}`),
    openInspectionContextHex: expectedTransaction("open-pack", direct.pullId).contextHex,
    createdAt: openedAt,
    expiresAt: openedAt + DIRECT_CLAIM_TTL_SECONDS,
  });
  return {
    requestId: requestId.toString(),
    openTransactionHash,
    claimContinuation: encodeDirectClaimContinuation(continuation),
    claimContinuationKey: directClaimContinuationKey(continuation),
    claimContinuationExpiresAt: continuation.expiresAt,
    claimTransactionHash: null,
  };
}

function recordFixture({
  direct = directFixture(),
  stage = "allowance-reset-submitting",
  expected,
  request = null,
  revision = 0,
  updatedAt = direct.createdAt,
} = {}) {
  const defaultExpected = stage === "allowance-reset-submitting" || stage === "approval-submitting"
    ? expectedTransaction("approve", `${stage}:${direct.pullId}`)
    : stage === "open-submitting"
      ? expectedTransaction("open-pack", direct.pullId)
    : stage === "claim-submitting" || stage === "delivered"
        ? expectedTransaction("claim-prize", direct.pullId)
        : null;
  return {
    schemaVersion: 2,
    kind: PULL_STATE_KIND,
    chainId: 8453,
    gacha: ADDR.gacha,
    wallet: direct.wallet,
    pullId: direct.pullId,
    revision,
    createdAt: direct.createdAt.toString(),
    updatedAt: BigInt(updatedAt).toString(),
    directIntent: direct.directIntent,
    directIntentKey: direct.directIntentKey,
    provenRevertRetries: {
      "allowance-reset-submitting": 0,
      "approval-submitting": 0,
      "open-submitting": 0,
      "claim-submitting": 0,
    },
    stage,
    expected: expected === undefined ? defaultExpected : expected,
    request,
  };
}

function advance(root, current, stage, { expected, request = current.request, updatedAt } = {}) {
  return updatePullRecord(current.wallet, current.pullId, current.revision, (candidate) => ({
    ...candidate,
    stage,
    expected: expected === undefined
      ? recordFixture({
        direct: {
          wallet: candidate.wallet,
          createdAt: BigInt(candidate.createdAt),
          directIntent: candidate.directIntent,
          directIntentKey: candidate.directIntentKey,
          pullId: candidate.pullId,
        },
        stage,
        request,
      }).expected
      : expected,
    request,
    updatedAt: (updatedAt ?? (BigInt(candidate.updatedAt) + 1n)).toString(),
  }), { root });
}

test("create/load persists a canonical private pull record", () => withTempRoot((root) => {
  const record = recordFixture();
  const recordPath = pullStatePath(record.wallet, record.pullId, { root });

  assert.deepEqual(createPullRecord(record, { root }), record);
  assert.deepEqual(loadPullRecord(record.wallet, record.pullId, { root }), record);
  assert.equal(readFileSync(recordPath, "utf8"), `${JSON.stringify(record, null, 2)}\n`);
  assert.equal(pullRecordMetadata(recordPath).mode, 0o600);
  assert.equal(lstatSync(path.dirname(recordPath)).mode & 0o077, 0);
  assert.throws(() => createPullRecord(record, { root }), /already exists/);

  chmodSync(recordPath, 0o644);
  assert.throws(
    () => loadPullRecord(record.wallet, record.pullId, { root }),
    /permissions expose private authorization data/,
  );
}));

test("record schema binds pull id, direct intent, wallet, and revision zero", () => {
  const record = recordFixture();
  assert.equal(validatePullRecord(record), record);

  assert.throws(() => validatePullRecord({ ...record, unreviewed: true }), /unsupported field unreviewed/);
  assert.throws(() => validatePullRecord({ ...record, chainId: 1 }), /not for Base/);
  assert.throws(() => validatePullRecord({ ...record, wallet: OTHER_WALLET }), /direct intent wallet mismatch/);
  assert.throws(
    () => validatePullRecord({ ...record, pullId: keccak256("other-pull").slice(2) }),
    /pull id must equal the direct intent key/,
  );
  assert.throws(
    () => validatePullRecord({ ...record, directIntentKey: keccak256("other-intent") }),
    /pull id must equal the direct intent key/,
  );
  assert.throws(
    () => validatePullRecord({
      ...record,
      provenRevertRetries: { ...record.provenRevertRetries, "open-submitting": 2 },
    }),
    /retry count is invalid for open-submitting/,
  );

  withTempRoot((root) => {
    assert.throws(() => createPullRecord({ ...record, revision: 1 }, { root }), /revision must be zero/);
  });
});

test("claim continuation is cross-bound to the persisted direct pull authorization", () => {
  const direct = directFixture();
  const request = requestFixture(direct);
  const record = recordFixture({ direct, stage: "awaiting-settlement", expected: null, request });
  assert.equal(validatePullRecord(record), record);

  const unrelatedDirect = directFixture();
  const createdAt = direct.createdAt + 10n;
  const unrelatedContinuation = createDirectClaimContinuation({
    wallet: direct.wallet,
    requestId: BigInt(request.requestId),
    sourceAuthorizationKind: "direct-pull-intent",
    sourceAuthorizationKey: unrelatedDirect.directIntentKey,
    openTransactionHash: request.openTransactionHash,
    openInspectionKey: keccak256(`open-inspection:${direct.pullId}`),
    openInspectionContextHex: expectedTransaction("open-pack", direct.pullId).contextHex,
    createdAt,
    expiresAt: createdAt + DIRECT_CLAIM_TTL_SECONDS,
  });
  assert.throws(
    () => validatePullRecord({
      ...record,
      request: {
        ...request,
        claimContinuation: encodeDirectClaimContinuation(unrelatedContinuation),
        claimContinuationKey: directClaimContinuationKey(unrelatedContinuation),
      },
    }),
    /claim continuation authorization mismatch/,
  );
});

test("revision CAS permits one winner and preserves immutable authorization", () => withTempRoot((root) => {
  const initial = recordFixture();
  createPullRecord(initial, { root });

  const winner = advance(root, initial, "approval-submitting");
  assert.equal(winner.revision, 1);
  assert.equal(winner.stage, "approval-submitting");
  assert.throws(
    () => advance(root, initial, "open-submitting"),
    /revision changed; reconcile before continuing/,
  );
  assert.deepEqual(loadPullRecord(initial.wallet, initial.pullId, { root }), winner);

  for (const [label, mutate, error] of [
    ["intent", (candidate) => { candidate.directIntent = "0x00"; }, /pull authorization cannot change/],
    ["intent key", (candidate) => { candidate.directIntentKey = keccak256("replacement"); }, /pull authorization cannot change/],
    ["creation time", (candidate) => { candidate.createdAt = (BigInt(candidate.createdAt) + 1n).toString(); }, /creation time cannot change/],
    ["identity", (candidate) => { candidate.wallet = OTHER_WALLET; }, /identity cannot change/],
    ["updatedAt", (candidate) => { candidate.updatedAt = (BigInt(candidate.updatedAt) - 1n).toString(); }, /updatedAt cannot move backwards/],
    ["retry decrement", (candidate) => { candidate.provenRevertRetries["open-submitting"] = -1; }, /retry count cannot skip or decrease/],
  ]) {
    assert.throws(() => updatePullRecord(winner.wallet, winner.pullId, winner.revision, (candidate) => {
      mutate(candidate);
      candidate.stage = "open-submitting";
      candidate.expected = expectedTransaction("open-pack", label);
      return candidate;
    }, { root }), error, label);
    assert.deepEqual(loadPullRecord(winner.wallet, winner.pullId, { root }), winner);
  }
}));

test("legal transition path reaches Delivered and rejects shortcuts", () => withTempRoot((root) => {
  const initial = recordFixture();
  const request = requestFixture({
    wallet: initial.wallet,
    createdAt: BigInt(initial.createdAt),
    directIntent: initial.directIntent,
    directIntentKey: initial.directIntentKey,
    pullId: initial.pullId,
  });
  createPullRecord(initial, { root });

  const approval = advance(root, initial, "approval-submitting");
  const open = advance(root, approval, "open-submitting");
  const awaiting = advance(root, open, "awaiting-settlement", { expected: null, request });
  const stillAwaiting = advance(root, awaiting, "awaiting-settlement", { expected: null });
  const claimHash = keccak256(`claim:${initial.pullId}`);
  const claim = advance(root, stillAwaiting, "claim-submitting");
  const delivered = advance(root, claim, "delivered", {
    expected: claim.expected,
    request: { ...request, claimTransactionHash: claimHash },
  });

  assert.equal(delivered.revision, 6);
  assert.equal(delivered.stage, "delivered");
  assert.equal(delivered.request.claimTransactionHash, claimHash);
  assert.equal(validatePullRecord({ ...delivered, expected: null }).stage, "delivered");
  assert.throws(
    () => advance(root, delivered, "stopped", { expected: null }),
    /illegal pull stage transition delivered -> stopped/,
  );

  const shortcut = recordFixture();
  const shortcutRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "stonk-gacha-shortcut-")));
  try {
    createPullRecord(shortcut, { root: shortcutRoot });
    assert.throws(
      () => advance(shortcutRoot, shortcut, "delivered", { expected: expectedTransaction("claim-prize", "shortcut"), request: requestFixture({
        wallet: shortcut.wallet,
        createdAt: BigInt(shortcut.createdAt),
        directIntent: shortcut.directIntent,
        directIntentKey: shortcut.directIntentKey,
        pullId: shortcut.pullId,
      }) }),
      /illegal pull stage transition allowance-reset-submitting -> delivered/,
    );
  } finally {
    rmSync(shortcutRoot, { recursive: true, force: true });
  }
}));

test("proven-revert retry counters advance once and stateless delivery is legal", () => withTempRoot((root) => {
  const approvalInitial = recordFixture({ stage: "approval-submitting" });
  createPullRecord(approvalInitial, { root });
  const approvalRetry = updatePullRecord(
    approvalInitial.wallet,
    approvalInitial.pullId,
    approvalInitial.revision,
    (candidate) => ({
      ...candidate,
      updatedAt: (BigInt(candidate.updatedAt) + 1n).toString(),
      stage: "preopen-reverted",
      expected: null,
      provenRevertRetries: {
        ...candidate.provenRevertRetries,
        "approval-submitting": 1,
      },
    }),
    { root },
  );
  assert.equal(approvalRetry.stage, "preopen-reverted");
  assert.equal(approvalRetry.expected, null);
  assert.equal(approvalRetry.provenRevertRetries["approval-submitting"], 1);
  const resumedOpen = advance(root, approvalRetry, "open-submitting");
  assert.equal(resumedOpen.stage, "open-submitting");
  assert.throws(() => updatePullRecord(
    resumedOpen.wallet,
    resumedOpen.pullId,
    resumedOpen.revision,
    (candidate) => ({
      ...candidate,
      updatedAt: (BigInt(candidate.updatedAt) + 1n).toString(),
      provenRevertRetries: {
        ...candidate.provenRevertRetries,
        "approval-submitting": 2,
      },
    }),
    { root },
  ), /retry count is invalid|cannot skip or decrease/);

  const direct = directFixture();
  const request = requestFixture(direct);
  const awaiting = recordFixture({ direct, stage: "awaiting-settlement", expected: null, request });
  const deliveredRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "stonk-gacha-stateless-delivery-")));
  try {
    createPullRecord(awaiting, { root: deliveredRoot });
    const claimHash = keccak256(`external-claim:${direct.pullId}`);
    const delivered = advance(deliveredRoot, awaiting, "delivered", {
      expected: null,
      request: { ...request, claimTransactionHash: claimHash },
    });
    assert.equal(delivered.stage, "delivered");
    assert.equal(delivered.expected, null);
    assert.equal(delivered.request.claimTransactionHash, claimHash);
  } finally {
    rmSync(deliveredRoot, { recursive: true, force: true });
  }
}));

test("a bound request and claim transaction hash are immutable", () => withTempRoot((root) => {
  const direct = directFixture();
  const request = requestFixture(direct);
  const initial = recordFixture({ direct, stage: "awaiting-settlement", expected: null, request });
  createPullRecord(initial, { root });

  for (const [label, mutate, error] of [
    ["remove", (candidate) => { candidate.request = null; }, /bound pull request cannot be removed/],
    ["request id", (candidate) => { candidate.request.requestId = "43"; }, /field requestId cannot change/],
    ["open hash", (candidate) => { candidate.request.openTransactionHash = keccak256("other-open"); }, /field openTransactionHash cannot change/],
    ["continuation", (candidate) => { candidate.request.claimContinuationKey = keccak256("other-continuation"); }, /field claimContinuationKey cannot change/],
  ]) {
    assert.throws(() => updatePullRecord(initial.wallet, initial.pullId, initial.revision, (candidate) => {
      mutate(candidate);
      candidate.stage = "awaiting-settlement";
      candidate.expected = null;
      candidate.updatedAt = (BigInt(candidate.updatedAt) + 1n).toString();
      return candidate;
    }, { root }), error, label);
  }

  const claimHash = keccak256("first-claim");
  const reconciliation = recordFixture({
    direct,
    stage: "needs-reconciliation",
    expected: null,
    request: { ...request, claimTransactionHash: claimHash },
  });
  const secondRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "stonk-gacha-claim-hash-")));
  try {
    createPullRecord(reconciliation, { root: secondRoot });
    assert.throws(() => updatePullRecord(reconciliation.wallet, reconciliation.pullId, reconciliation.revision, (candidate) => {
    candidate.stage = "stopped";
    candidate.expected = null;
    candidate.request.claimTransactionHash = keccak256("replacement-claim");
    candidate.updatedAt = (BigInt(candidate.updatedAt) + 1n).toString();
    return candidate;
    }, { root: secondRoot }), /claim transaction hash cannot change/);
  } finally {
    rmSync(secondRoot, { recursive: true, force: true });
  }
}));

test("beforeRename failure preserves the prior record and releases temporary state", () => withTempRoot((root) => {
  const initial = recordFixture();
  const recordPath = pullStatePath(initial.wallet, initial.pullId, { root });
  const walletDirectory = path.dirname(recordPath);
  let observedTemporary = null;

  assert.throws(() => createPullRecord(initial, {
    root,
    beforeRename(temporary, target) {
      observedTemporary = temporary;
      assert.equal(target, recordPath);
      assert.equal(path.dirname(temporary), walletDirectory);
      assert.equal(lstatSync(temporary).mode & 0o777, 0o600);
      throw new Error("simulated pre-rename crash");
    },
  }), /simulated pre-rename crash/);
  assert.equal(existsSync(recordPath), false);
  assert.equal(existsSync(observedTemporary), false);
  assert.equal(existsSync(`${recordPath}.lock`), false);

  createPullRecord(initial, { root });
  const priorBytes = readFileSync(recordPath, "utf8");
  assert.throws(() => updatePullRecord(initial.wallet, initial.pullId, initial.revision, (candidate) => {
    candidate.stage = "approval-submitting";
    candidate.expected = expectedTransaction("approve", "crash-update");
    candidate.updatedAt = (BigInt(candidate.updatedAt) + 1n).toString();
    return candidate;
  }, {
    root,
    beforeRename(temporary, target) {
      observedTemporary = temporary;
      assert.equal(target, recordPath);
      assert.equal(path.dirname(temporary), walletDirectory);
      throw new Error("simulated update crash");
    },
  }), /simulated update crash/);

  assert.equal(readFileSync(recordPath, "utf8"), priorBytes);
  assert.deepEqual(loadPullRecord(initial.wallet, initial.pullId, { root }), initial);
  assert.equal(existsSync(observedTemporary), false);
  assert.equal(existsSync(`${recordPath}.lock`), false);
  assert.equal(readdirSync(walletDirectory).some((entry) => entry.endsWith(".tmp") || entry.endsWith(".lock")), false);

  const recovered = advance(root, initial, "approval-submitting");
  assert.equal(recovered.revision, 1);
}));

test("a dead stale lock recovers but a live owner lock stays closed", () => withTempRoot((root) => {
  const initial = recordFixture();
  const recordPath = pullStatePath(initial.wallet, initial.pullId, { root });
  const lockPath = `${recordPath}.lock`;
  createPullRecord(initial, { root });

  const staleTime = new Date(Date.now() - 301_000);
  writeFileSync(lockPath, `${JSON.stringify({ pid: 2_147_483_646, createdAtMs: staleTime.getTime() })}\n`, { mode: 0o600 });
  utimesSync(lockPath, staleTime, staleTime);
  const recovered = advance(root, initial, "approval-submitting");
  assert.equal(recovered.stage, "approval-submitting");
  assert.equal(existsSync(lockPath), false);

  writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, createdAtMs: staleTime.getTime() })}\n`, { mode: 0o600 });
  utimesSync(lockPath, staleTime, staleTime);
  assert.throws(
    () => advance(root, recovered, "open-submitting"),
    /already being advanced by another process/,
  );
  assert.equal(existsSync(lockPath), true);
}));

test("a malformed stale lock fails closed instead of being reaped", () => withTempRoot((root) => {
  const initial = recordFixture();
  const recordPath = pullStatePath(initial.wallet, initial.pullId, { root });
  const lockPath = `${recordPath}.lock`;
  createPullRecord(initial, { root });

  const staleTime = new Date(Date.now() - 301_000);
  writeFileSync(lockPath, "{not-valid-json}\n", { mode: 0o600 });
  utimesSync(lockPath, staleTime, staleTime);
  assert.throws(
    () => advance(root, initial, "approval-submitting"),
    /lock owner metadata is invalid/,
  );
  assert.equal(readFileSync(lockPath, "utf8"), "{not-valid-json}\n");
}));

test("a dead stale reaper lease is itself recoverable", () => withTempRoot((root) => {
  const initial = recordFixture();
  const recordPath = pullStatePath(initial.wallet, initial.pullId, { root });
  const lockPath = `${recordPath}.lock`;
  const reaperPath = `${lockPath}.reaper`;
  createPullRecord(initial, { root });

  const staleTime = new Date(Date.now() - 301_000);
  const deadOwner = `${JSON.stringify({ pid: 2_147_483_646, createdAtMs: staleTime.getTime() })}\n`;
  writeFileSync(lockPath, deadOwner, { mode: 0o600 });
  writeFileSync(reaperPath, deadOwner, { mode: 0o600 });
  utimesSync(lockPath, staleTime, staleTime);
  utimesSync(reaperPath, staleTime, staleTime);

  const recovered = advance(root, initial, "approval-submitting");
  assert.equal(recovered.stage, "approval-submitting");
  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(reaperPath), false);
}));

test("a lock holder never removes a replacement lock it does not own", () => withTempRoot((root) => {
  const walletDirectory = path.join(root, "8453", WALLET);
  const lockPath = path.join(walletDirectory, ".start.lock");
  assert.throws(() => withWalletPullLock(WALLET, () => {
    unlinkSync(lockPath);
    writeFileSync(lockPath, `${JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now(),
      token: "replacement",
    })}\n`, { mode: 0o600 });
  }, { root }), /lock ownership changed while held/);
  assert.equal(existsSync(lockPath), true);
  assert.match(readFileSync(lockPath, "utf8"), /replacement/);
}));

test("wallet start lock serializes active-pull discovery and creation", () => withTempRoot((root) => {
  let entered = false;
  const result = withWalletPullLock(WALLET, () => {
    entered = true;
    assert.throws(
      () => withWalletPullLock(WALLET, () => "duplicate-start", { root }),
      /already being advanced by another process/,
    );
    return "single-start";
  }, { root });

  assert.equal(entered, true);
  assert.equal(result, "single-start");
  assert.equal(withWalletPullLock(WALLET, () => "next-start", { root }), "next-start");
  const walletDirectory = path.join(root, "8453", WALLET);
  assert.equal(existsSync(path.join(walletDirectory, ".start.lock")), false);
}));

test("wallet generation invalidates a stale plan after a concurrent pull reaches terminal state", () => withTempRoot((root) => {
  const slowPlan = recordFixture();
  const discoveredGeneration = withWalletPullLock(
    slowPlan.wallet,
    () => walletPullGeneration(slowPlan.wallet, { root }),
    { root },
  );

  const fastPull = recordFixture();
  withWalletPullLock(fastPull.wallet, () => createPullRecord(fastPull, { root }), { root });
  const fastApproval = advance(root, fastPull, "approval-submitting");
  const fastOpen = advance(root, fastApproval, "open-submitting");
  const fastRequest = requestFixture({
    wallet: fastPull.wallet,
    createdAt: BigInt(fastPull.createdAt),
    directIntent: fastPull.directIntent,
    directIntentKey: fastPull.directIntentKey,
    pullId: fastPull.pullId,
  });
  const fastAwaiting = advance(root, fastOpen, "awaiting-settlement", { expected: null, request: fastRequest });
  const fastClaim = advance(root, fastAwaiting, "claim-submitting");
  advance(root, fastClaim, "delivered", {
    expected: fastClaim.expected,
    request: { ...fastRequest, claimTransactionHash: keccak256(`claim:${fastPull.pullId}`) },
  });

  const decision = withWalletPullLock(slowPlan.wallet, () => {
    if (walletPullGeneration(slowPlan.wallet, { root }) !== discoveredGeneration) return "discard-stale-plan";
    createPullRecord(slowPlan, { root });
    return "created";
  }, { root });

  assert.equal(decision, "discard-stale-plan");
  assert.throws(() => loadPullRecord(slowPlan.wallet, slowPlan.pullId, { root }), /does not exist/);
  assert.equal(listActivePullRecords(slowPlan.wallet, { root }).length, 0);
}));

test("wallet lock admits only one simultaneous process", async () => {
  const created = mkdtempSync(path.join(tmpdir(), "stonk-gacha-process-lock-"));
  const root = realpathSync(created);
  const readyDirectory = path.join(root, "ready");
  const startSignal = path.join(root, "start");
  const entered = path.join(root, "entered");
  mkdirSync(readyDirectory, { mode: 0o700 });
  const moduleUrl = new URL("../scripts/lib/pull-state.mjs", import.meta.url).href;
  const childSource = `
    import { appendFileSync, existsSync, writeFileSync } from "node:fs";
    import path from "node:path";
    import { withWalletPullLock } from ${JSON.stringify(moduleUrl)};
    const [root, readyDirectory, startSignal, entered, wallet] = process.argv.slice(1);
    writeFileSync(path.join(readyDirectory, String(process.pid)), "ready\\n", { mode: 0o600 });
    const waitArray = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(startSignal)) Atomics.wait(waitArray, 0, 0, 10);
    try {
      withWalletPullLock(wallet, () => {
        appendFileSync(entered, String(process.pid) + "\\n", { mode: 0o600 });
        Atomics.wait(waitArray, 0, 0, 500);
      }, { root });
      process.exitCode = 0;
    } catch (error) {
      if (String(error.message).includes("already being advanced")) process.exitCode = 2;
      else { process.stderr.write(String(error.stack || error)); process.exitCode = 3; }
    }
  `;
  const children = Array.from({ length: 8 }, () => spawn(
    process.execPath,
    ["--input-type=module", "--eval", childSource, root, readyDirectory, startSignal, entered, WALLET],
    { stdio: ["ignore", "ignore", "pipe"] },
  ));
  const childOutcomes = children.map((child) => new Promise((resolve) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code, signal) => resolve({ code, signal, stderr }));
  }));
  try {
    const deadline = Date.now() + 10_000;
    while (readdirSync(readyDirectory).length < children.length) {
      assert.ok(Date.now() < deadline, "child processes did not reach the lock barrier");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    writeFileSync(startSignal, "go\n", { mode: 0o600 });
    const outcomes = await Promise.all(childOutcomes);
    assert.equal(outcomes.filter(({ code }) => code === 0).length, 1, JSON.stringify(outcomes));
    assert.equal(outcomes.filter(({ code }) => code === 2).length, children.length - 1, JSON.stringify(outcomes));
    assert.equal(outcomes.some(({ code, signal, stderr }) => code === 3 || signal || stderr), false, JSON.stringify(outcomes));
    assert.equal(readFileSync(entered, "utf8").trim().split("\n").length, 1);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("wallet lock remains held through an asynchronous critical section", async () => {
  const created = mkdtempSync(path.join(tmpdir(), "stonk-gacha-async-lock-"));
  const root = realpathSync(created);
  let release;
  try {
    const held = withWalletPullLock(WALLET, () => new Promise((resolve) => { release = resolve; }), { root });
    assert.equal(typeof held.then, "function");
    assert.throws(
      () => withWalletPullLock(WALLET, () => "overlap", { root }),
      /already being advanced by another process/,
    );
    release("finished");
    assert.equal(await held, "finished");
    assert.equal(withWalletPullLock(WALLET, () => "next", { root }), "next");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("symlinked roots, directories, and records fail closed", () => withTempRoot((root) => {
  const direct = directFixture();
  const record = recordFixture({ direct });
  const realTarget = path.join(root, "real-target");
  const linkedRoot = path.join(root, "linked-root");
  mkdirSync(realTarget, { mode: 0o700 });
  symlinkSync(realTarget, linkedRoot);
  assert.throws(() => pullStateRoot(linkedRoot), /contains a symlink/);

  const chainTarget = path.join(root, "chain-target");
  mkdirSync(chainTarget, { mode: 0o700 });
  symlinkSync(chainTarget, path.join(root, "8453"));
  assert.throws(() => createPullRecord(record, { root }), /contains a symlink/);
  rmSync(path.join(root, "8453"));

  const recordPath = pullStatePath(record.wallet, record.pullId, { root });
  mkdirSync(path.dirname(recordPath), { recursive: true, mode: 0o700 });
  const outsideRecord = path.join(root, "outside-record.json");
  writeFileSync(outsideRecord, "{}\n", { mode: 0o600 });
  symlinkSync(outsideRecord, recordPath);
  assert.throws(() => loadPullRecord(record.wallet, record.pullId, { root }), /regular file, not a symlink/);
}));

test("active listing is wallet-scoped, ordered, and excludes terminal or stray files", () => withTempRoot((root) => {
  const newest = recordFixture({ direct: directFixture({ createdAt: 1_788_345_300n }), stage: "approval-submitting" });
  const oldest = recordFixture({ direct: directFixture({ createdAt: 1_788_345_100n }), stage: "approval-submitting" });
  const middle = recordFixture({ direct: directFixture({ createdAt: 1_788_345_200n }), stage: "needs-reconciliation", expected: null });
  const terminal = recordFixture({ direct: directFixture({ createdAt: 1_788_345_150n }), stage: "stopped", expected: null });
  const anotherWallet = recordFixture({
    direct: directFixture({ wallet: OTHER_WALLET, createdAt: 1_788_345_050n }),
    stage: "approval-submitting",
  });

  for (const record of [newest, oldest, middle, terminal, anotherWallet]) createPullRecord(record, { root });
  const walletDirectory = path.dirname(pullStatePath(oldest.wallet, oldest.pullId, { root }));
  writeFileSync(path.join(walletDirectory, "partial.tmp"), "{", { mode: 0o600 });
  writeFileSync(path.join(walletDirectory, "not-a-pull.json"), "{}\n", { mode: 0o600 });

  assert.deepEqual(
    listActivePullRecords(WALLET, { root }).map(({ pullId }) => pullId),
    [oldest.pullId, middle.pullId, newest.pullId],
  );
  assert.deepEqual(listActivePullRecords("0x3333333333333333333333333333333333333333", { root }), []);
  writeFileSync(path.join(walletDirectory, "42.json"), "{}\n", { mode: 0o600 });
  assert.throws(
    () => listActivePullRecords(WALLET, { root }),
    /legacy request journal requires reconciliation/,
  );
}));
