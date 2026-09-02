import { normalizeAddress } from "./abi.mjs";

const REQUEST_STATES = new Set(["None", "Pending", "Ready", "Delivered", "Expired", "Refunded"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalRequestId(value, label = "request id") {
  const raw = typeof value === "bigint" ? value.toString() : String(value);
  invariant(/^[1-9][0-9]*$/.test(raw), `${label} must be a canonical nonzero integer`);
  return BigInt(raw);
}

function boundedInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  invariant(Number.isSafeInteger(value) && value >= min && value <= max, `${label} must be an integer between ${min} and ${max}`);
  return value;
}

function observedState(request, expectedRequestId, expectedWallet) {
  invariant(request && typeof request === "object" && !Array.isArray(request), "request observation must be an object");
  invariant(typeof request.status === "string" && REQUEST_STATES.has(request.status), `unsupported request status: ${String(request.status)}`);
  if (request.status === "None") return "None";

  const requestId = canonicalRequestId(request.requestId, "observed request id");
  invariant(requestId === expectedRequestId, "watch observation changed to a different request id");
  invariant(normalizeAddress(request.buyer) === expectedWallet, "watch observation buyer differs from the active wallet");
  return request.status;
}

function chainTimestamp(request) {
  const raw = request?.snapshot?.timestamp;
  invariant(raw !== undefined && /^(0|[1-9][0-9]*)$/.test(String(raw)), "request observation is missing a canonical snapshot timestamp");
  return BigInt(raw);
}

function result(outcome, status, request, metrics, extra = {}) {
  return {
    outcome,
    status,
    requestId: metrics.requestId.toString(),
    request,
    attempts: metrics.attempts,
    observations: metrics.observations,
    transportErrors: metrics.transportErrors,
    consecutiveTransportErrors: metrics.consecutiveTransportErrors,
    elapsedMs: metrics.elapsedMs,
    ...extra,
  };
}

function errorMessage(error) {
  return error?.message ? String(error.message) : String(error);
}

/**
 * Poll one exact onchain request until it reaches a state the CLI can act on.
 *
 * This helper is deliberately transaction-blind: it does not build, sign, or
 * submit anything. The caller may pass a Ready result to the existing claim
 * planner, which must repeat all fresh authorization and quote checks.
 */
export async function watchExactRequest({
  wallet,
  requestId,
  continuationExpiresAt = null,
  timeoutMs,
  pollIntervalMs,
  maxConsecutiveTransportErrors,
  maxTransportBackoffMs = 30_000,
  readRequest,
  isRetryableTransportError = () => false,
  monotonicNow = () => performance.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const expectedWallet = normalizeAddress(wallet);
  const expectedRequestId = canonicalRequestId(requestId);
  const timeout = boundedInteger(timeoutMs, "watch timeoutMs");
  const interval = boundedInteger(pollIntervalMs, "watch pollIntervalMs", { min: 1 });
  const errorCap = boundedInteger(maxConsecutiveTransportErrors, "watch maxConsecutiveTransportErrors");
  const errorBackoffCap = boundedInteger(maxTransportBackoffMs, "watch maxTransportBackoffMs", { min: interval });
  invariant(typeof readRequest === "function", "watch readRequest must be a function");
  invariant(typeof isRetryableTransportError === "function", "watch isRetryableTransportError must be a function");
  invariant(typeof monotonicNow === "function" && typeof sleep === "function", "watch clock dependencies must be functions");
  const continuationExpiry = continuationExpiresAt === null
    ? null
    : canonicalRequestId(continuationExpiresAt, "continuation expiry");

  let lastNow = Number(monotonicNow());
  invariant(Number.isFinite(lastNow) && lastNow >= 0, "watch monotonic clock returned an invalid value");
  const startedAt = lastNow;
  const deadline = startedAt + timeout;
  invariant(Number.isFinite(deadline) && deadline <= Number.MAX_SAFE_INTEGER, "watch deadline exceeds the safe integer range");

  const metrics = {
    requestId: expectedRequestId,
    attempts: 0,
    observations: 0,
    transportErrors: 0,
    consecutiveTransportErrors: 0,
    elapsedMs: 0,
  };
  let lastRequest = null;

  const now = () => {
    const value = Number(monotonicNow());
    invariant(Number.isFinite(value) && value >= lastNow, "watch monotonic clock moved backwards or returned an invalid value");
    lastNow = value;
    metrics.elapsedMs = Math.max(0, Math.floor(value - startedAt));
    return value;
  };

  const timeoutResult = () => result("pending-timeout", lastRequest?.status ?? null, lastRequest, metrics, {
    retryable: true,
    retryAfterMs: interval,
  });

  while (true) {
    if (metrics.attempts > 0 && now() >= deadline) return timeoutResult();

    let request;
    metrics.attempts += 1;
    try {
      request = await readRequest(expectedRequestId);
      metrics.observations += 1;
      metrics.consecutiveTransportErrors = 0;
      lastRequest = request;
    } catch (error) {
      if (!isRetryableTransportError(error)) throw error;
      metrics.transportErrors += 1;
      metrics.consecutiveTransportErrors += 1;
      if (metrics.consecutiveTransportErrors > errorCap) {
        const exhausted = new Error(`exact-request watch exhausted its transport error allowance: ${errorMessage(error)}`);
        exhausted.cause = error;
        throw exhausted;
      }
      const current = now();
      if (current >= deadline) return timeoutResult();
      const backoff = Math.min(errorBackoffCap, interval * (2 ** Math.max(0, metrics.consecutiveTransportErrors - 1)));
      await sleep(Math.min(backoff, Math.max(0, deadline - current)));
      continue;
    }

    const status = observedState(request, expectedRequestId, expectedWallet);
    now();
    if (status === "None") return result("none", status, request, metrics);
    if (status === "Delivered") return result("delivered", status, request, metrics);
    if (status === "Expired") return result("expired", status, request, metrics);
    if (status === "Refunded") return result("refunded", status, request, metrics);

    if (continuationExpiry !== null && chainTimestamp(request) >= continuationExpiry) {
      return result("continuation-expired", status, request, metrics, {
        continuationExpiresAt: continuationExpiry.toString(),
      });
    }
    if (status === "Ready") return result("ready", status, request, metrics);

    const current = now();
    if (current >= deadline) return timeoutResult();
    await sleep(Math.min(interval, Math.max(0, deadline - current)));
  }
}
