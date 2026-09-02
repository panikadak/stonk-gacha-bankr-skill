import { keccak256 } from "./keccak256.mjs";
import { strip0x } from "./abi.mjs";

const PUBLIC_RPCS = [
  "https://base-rpc.publicnode.com",
  "https://base-mainnet.public.blastapi.io",
  "https://mainnet.base.org",
];
const configuredRpc = process.env.STONK_GACHA_RPC_URL || process.env.BASE_RPC_URL;
const RPCS = configuredRpc ? [configuredRpc] : PUBLIC_RPCS;
const configuredTimeout = Number(process.env.STONK_GACHA_RPC_TIMEOUT_MS || 30_000);
const RPC_TIMEOUT_MS = Number.isSafeInteger(configuredTimeout) && configuredTimeout >= 1_000 && configuredTimeout <= 120_000
  ? configuredTimeout
  : 30_000;
const TRANSIENT_HTTP = new Set([429, 502, 503, 504]);
let pinnedRpcIndex = null;
let requestId = 1;

export class RpcError extends Error {
  constructor(message, data = null, code = null) {
    super(message);
    this.name = "RpcError";
    this.data = data;
    this.code = code;
  }
}

function timeoutSignal(milliseconds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function quantity(value) {
  const bigint = BigInt(value);
  if (bigint < 0n) throw new Error("RPC quantity cannot be negative");
  return `0x${bigint.toString(16)}`;
}

export async function rpc(method, params = []) {
  let lastError = new Error("no RPC endpoint attempted");
  const allIndices = RPCS.map((_, index) => index);
  const candidates = pinnedRpcIndex === null
    ? allIndices
    : [pinnedRpcIndex, ...allIndices.filter((index) => index !== pinnedRpcIndex)];
  for (const index of candidates) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { signal, clear } = timeoutSignal(RPC_TIMEOUT_MS);
      try {
        const response = await fetch(RPCS[index], {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: requestId++, method, params }),
          signal,
        });
        if (!response.ok) {
          if (TRANSIENT_HTTP.has(response.status) && attempt < 3) {
            await delay(500 * 2 ** attempt);
            continue;
          }
          const httpError = new Error(`HTTP ${response.status}`);
          httpError.endpointSpecific = [400, 401, 403, 404, 405].includes(response.status);
          throw httpError;
        }
        const body = await response.json();
        if (body.error) {
          const rpcError = new RpcError(
            `RPC ${body.error.code ?? "error"}: ${body.error.message ?? "unknown error"}`,
            body.error.data ?? null,
            body.error.code ?? null,
          );
          const endpointSpecific = /archive|historical|pruned|missing trie node|state unavailable|unsupported|not supported|block range|personal token/i.test(rpcError.message);
          if (endpointSpecific && candidates.length > 1) {
            lastError = rpcError;
            break;
          }
          throw rpcError;
        }
        pinnedRpcIndex = index;
        return body.result;
      } catch (error) {
        lastError = error;
        if (error instanceof RpcError) throw error;
        if (error?.endpointSpecific) break;
        if (attempt < 3) {
          await delay(500 * 2 ** attempt);
          continue;
        }
      } finally {
        clear();
      }
    }
  }
  const scope = RPCS.length > 1 ? "all configured Base RPCs" : "the configured Base RPC";
  throw new Error(`${scope} failed for ${method}: ${lastError.message}`);
}

export async function chainId() {
  return Number(BigInt(await rpc("eth_chainId")));
}

function decodeBlock(block) {
  if (!block?.hash || !block?.number || !block?.timestamp) throw new Error("Base block was unavailable");
  return {
    number: BigInt(block.number),
    timestamp: BigInt(block.timestamp),
    hash: block.hash.toLowerCase(),
    parentHash: block.parentHash?.toLowerCase() ?? null,
    transactions: block.transactions,
  };
}

export async function latestBlock() {
  return decodeBlock(await rpc("eth_getBlockByNumber", ["latest", false]));
}

export async function getBlockByNumber(blockNumber, fullTransactions = false) {
  const tag = typeof blockNumber === "string" && blockNumber.startsWith("0x") ? blockNumber : quantity(blockNumber);
  const block = await rpc("eth_getBlockByNumber", [tag, fullTransactions]);
  return block ? decodeBlock(block) : null;
}

export async function getBlockByHash(blockHash, fullTransactions = false) {
  return await rpc("eth_getBlockByHash", [blockHash, fullTransactions]);
}

export async function beginSnapshot() {
  const block = await latestBlock();
  return {
    ...block,
    ref: { blockHash: block.hash, requireCanonical: true },
  };
}

export async function confirmSnapshot(snapshot) {
  const canonical = await getBlockByNumber(snapshot.number, false);
  if (!canonical || canonical.hash !== snapshot.hash) throw new Error("the pinned Base snapshot is no longer canonical");
  return snapshot;
}

export async function getCode(address, block = "latest") {
  return await rpc("eth_getCode", [address, block]);
}

export async function getCodeHash(address, block = "latest") {
  const code = await getCode(address, block);
  if (!code || code === "0x") return null;
  return keccak256(code);
}

export async function ethCall(to, data, { from = null, value = null, block = "latest" } = {}) {
  const call = { to, data: data.startsWith("0x") ? data : `0x${data}` };
  if (from) call.from = from;
  if (value !== null) call.value = typeof value === "string" && value.startsWith("0x") ? value : quantity(value);
  return await rpc("eth_call", [call, block]);
}

export async function estimateGas(to, data, from, value = 0n, block = "latest") {
  const call = {
    to,
    data: data.startsWith("0x") ? data : `0x${data}`,
    from,
    value: typeof value === "string" && value.startsWith("0x") ? value : quantity(value),
  };
  return BigInt(await rpc("eth_estimateGas", [call, block]));
}

export async function getBalance(address, block = "latest") {
  return BigInt(await rpc("eth_getBalance", [address, block]));
}

export async function getReceipt(transactionHash) {
  return await rpc("eth_getTransactionReceipt", [transactionHash]);
}

export async function getTransaction(transactionHash) {
  return await rpc("eth_getTransactionByHash", [transactionHash]);
}

export async function getTransactionCount(address, block = "latest") {
  return BigInt(await rpc("eth_getTransactionCount", [address, block]));
}

export async function getStorageAt(address, slot, block = "latest") {
  return await rpc("eth_getStorageAt", [address, slot, block]);
}

export function unsignedTx(to, data, label, { value = 0n, ...extra } = {}) {
  return {
    label,
    to,
    data: data.startsWith("0x") ? data : `0x${data}`,
    value: BigInt(value).toString(),
    chainId: 8453,
    ...extra,
  };
}

export function revertData(error) {
  if (!(error instanceof RpcError)) return null;
  if (typeof error.data === "string" && error.data.startsWith("0x")) return error.data;
  if (error.data && typeof error.data === "object") {
    for (const value of Object.values(error.data)) {
      if (typeof value === "string" && value.startsWith("0x")) return value;
      if (value && typeof value === "object" && typeof value.return === "string") return value.return;
    }
  }
  return null;
}

export function txSelector(data) {
  const hex = strip0x(data || "");
  return hex.length >= 8 ? `0x${hex.slice(0, 8).toLowerCase()}` : null;
}
