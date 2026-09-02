import { selector } from "./keccak256.mjs";

const WORD_HEX = 64;
const MAX_ARRAY_ITEMS = 1024;

export function strip0x(value) {
  return String(value).startsWith("0x") ? String(value).slice(2) : String(value);
}

export function padWord(value) {
  const hex = strip0x(value);
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length > WORD_HEX) throw new Error("value exceeds one ABI word");
  return hex.padStart(WORD_HEX, "0");
}

export function wordAt(data, index) {
  const hex = strip0x(data);
  return hex.slice(index * WORD_HEX, (index + 1) * WORD_HEX);
}

export function toBigInt(word) {
  const hex = strip0x(word || "");
  return BigInt(`0x${hex || "0"}`);
}

export function normalizeAddress(address) {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`invalid EVM address: ${address}`);
  }
  return address.toLowerCase();
}

export function toAddress(word) {
  const hex = strip0x(word);
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(hex)) throw new Error("non-canonical ABI address word");
  return normalizeAddress(`0x${hex.slice(-40)}`);
}

export function encodeAddress(address) {
  return padWord(strip0x(normalizeAddress(address)));
}

export function encodeUint(value, bits = 256) {
  const bigint = BigInt(value);
  if (bigint < 0n || bigint >= 1n << BigInt(bits)) throw new Error(`uint${bits} out of range`);
  return padWord(bigint.toString(16));
}

export function encodeBool(value) {
  return encodeUint(value ? 1n : 0n);
}

export function encodeBytes32(value) {
  const hex = strip0x(value);
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("bytes32 must be exactly 32 bytes");
  return hex.toLowerCase();
}

function uintBits(type) {
  const match = type.match(/^uint(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?$/);
  return match ? Number(match[1] || 256) : null;
}

function arrayType(type) {
  const match = type.match(/^(.*)\[(\d*)\]$/);
  if (!match) return null;
  return { elementType: match[1], length: match[2] === "" ? null : Number(match[2]) };
}

function isDynamic(type) {
  if (type === "bytes" || type === "string") return true;
  const array = arrayType(type);
  return Boolean(array && (array.length === null || isDynamic(array.elementType)));
}

function staticWords(type) {
  if (isDynamic(type)) return 1;
  const array = arrayType(type);
  return array ? array.length * staticWords(array.elementType) : 1;
}

function encodeStatic(type, value) {
  if (type === "address") return encodeAddress(value);
  if (type === "bool") return encodeBool(value);
  if (type === "bytes32") return encodeBytes32(value);
  const bits = uintBits(type);
  if (bits !== null) return encodeUint(value, bits);
  const array = arrayType(type);
  if (array?.length !== null && !isDynamic(array.elementType)) {
    if (!Array.isArray(value) || value.length !== array.length) throw new Error(`${type} has the wrong length`);
    return value.map((entry) => encodeStatic(array.elementType, entry)).join("");
  }
  throw new Error(`unsupported static ABI type: ${type}`);
}

function encodeDynamic(type, value) {
  if (type === "bytes" || type === "string") {
    let bytes;
    if (type === "string") {
      bytes = new TextEncoder().encode(String(value));
    } else {
      if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
        throw new Error("bytes value must be even-length 0x-prefixed hex");
      }
      bytes = Uint8Array.from((strip0x(value).match(/.{2}/g) ?? []).map((entry) => Number.parseInt(entry, 16)));
    }
    const body = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return encodeUint(bytes.length) + body.padEnd(Math.ceil(body.length / WORD_HEX) * WORD_HEX, "0");
  }
  const array = arrayType(type);
  if (!array || array.length !== null || isDynamic(array.elementType)) throw new Error(`unsupported dynamic ABI type: ${type}`);
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) throw new Error(`${type} value must be a bounded array`);
  return encodeUint(value.length) + value.map((entry) => encodeStatic(array.elementType, entry)).join("");
}

export function encodeParameters(types, values) {
  if (!Array.isArray(types) || !Array.isArray(values) || types.length !== values.length) {
    throw new Error("ABI type/value count mismatch");
  }
  const headWords = types.reduce((sum, type) => sum + staticWords(type), 0);
  const head = [];
  const tails = [];
  let tailBytes = headWords * 32;
  for (let index = 0; index < types.length; index += 1) {
    if (isDynamic(types[index])) {
      const encoded = encodeDynamic(types[index], values[index]);
      head.push(encodeUint(tailBytes));
      tails.push(encoded);
      tailBytes += encoded.length / 2;
    } else {
      head.push(encodeStatic(types[index], values[index]));
    }
  }
  return head.join("") + tails.join("");
}

export function encodeCall(signature, types = [], values = []) {
  return `${selector(signature)}${encodeParameters(types, values)}`;
}

function decodeStaticValue(type, hex, wordIndex) {
  const word = wordAt(hex, wordIndex);
  if (word.length !== WORD_HEX) throw new Error(`truncated ${type}`);
  if (type === "address") return { value: toAddress(word), words: 1 };
  if (type === "bool") {
    const value = toBigInt(word);
    if (value !== 0n && value !== 1n) throw new Error("non-canonical ABI bool word");
    return { value: value === 1n, words: 1 };
  }
  if (type === "bytes32") return { value: `0x${word.toLowerCase()}`, words: 1 };
  const bits = uintBits(type);
  if (bits !== null) {
    const value = toBigInt(word);
    if (value >= 1n << BigInt(bits)) throw new Error(`non-canonical ${type} word`);
    return { value, words: 1 };
  }
  const array = arrayType(type);
  if (array?.length !== null && !isDynamic(array.elementType)) {
    const values = [];
    let cursor = wordIndex;
    for (let index = 0; index < array.length; index += 1) {
      const decoded = decodeStaticValue(array.elementType, hex, cursor);
      values.push(decoded.value);
      cursor += decoded.words;
    }
    return { value: values, words: cursor - wordIndex };
  }
  throw new Error(`unsupported static ABI decode type: ${type}`);
}

function safeOffset(word, label) {
  const offset = toBigInt(word);
  if (offset > BigInt(Number.MAX_SAFE_INTEGER) || offset % 32n !== 0n) throw new Error(`${label} has an unsafe offset`);
  return Number(offset);
}

function decodeDynamicValue(type, hex, byteOffset) {
  const startWord = byteOffset / 32;
  const lengthValue = toBigInt(wordAt(hex, startWord));
  if (lengthValue > BigInt(MAX_ARRAY_ITEMS) && type !== "bytes" && type !== "string") {
    throw new Error(`${type} exceeds the item bound`);
  }
  if (lengthValue > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${type} length exceeds the safe range`);
  const length = Number(lengthValue);
  if (type === "bytes" || type === "string") {
    const start = (startWord + 1) * WORD_HEX;
    const body = hex.slice(start, start + length * 2);
    if (body.length !== length * 2) throw new Error(`${type} is truncated`);
    if (type === "bytes") return `0x${body.toLowerCase()}`;
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(body.match(/.{2}/g)?.map((entry) => Number.parseInt(entry, 16)) ?? []));
  }
  const array = arrayType(type);
  if (!array || array.length !== null || isDynamic(array.elementType)) throw new Error(`unsupported dynamic ABI decode type: ${type}`);
  const values = [];
  let cursor = startWord + 1;
  for (let index = 0; index < length; index += 1) {
    const decoded = decodeStaticValue(array.elementType, hex, cursor);
    values.push(decoded.value);
    cursor += decoded.words;
  }
  return values;
}

export function decodeParameters(types, data) {
  const hex = strip0x(data);
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % WORD_HEX !== 0) throw new Error("ABI data is not whole words");
  const values = [];
  let cursor = 0;
  for (const type of types) {
    if (isDynamic(type)) {
      const offset = safeOffset(wordAt(hex, cursor), type);
      values.push(decodeDynamicValue(type, hex, offset));
      cursor += 1;
    } else {
      const decoded = decodeStaticValue(type, hex, cursor);
      values.push(decoded.value);
      cursor += decoded.words;
    }
  }
  return values;
}

export function decodeCallArguments(types, calldata) {
  const full = strip0x(calldata);
  if (full.length < 8 || (full.length - 8) % WORD_HEX !== 0) throw new Error("calldata is not selector plus whole ABI words");
  const payload = full.slice(8);
  const values = decodeParameters(types, payload);
  if (encodeParameters(types, values).toLowerCase() !== payload.toLowerCase()) {
    throw new Error("calldata does not match canonical ABI re-encoding");
  }
  return values;
}

export function decodeUint(data, index = 0) {
  return toBigInt(wordAt(data, index));
}

export function decodeBool(data, index = 0) {
  const value = decodeUint(data, index);
  if (value !== 0n && value !== 1n) throw new Error("invalid ABI bool");
  return value === 1n;
}

export function decodeAddress(data, index = 0) {
  return toAddress(wordAt(data, index));
}

export function decodeBytes32(data, index = 0) {
  const word = wordAt(data, index);
  if (word.length !== WORD_HEX) throw new Error("short ABI bytes32 result");
  return `0x${word.toLowerCase()}`;
}

export function decodeString(data) {
  return decodeParameters(["string"], data)[0];
}

export function decodePagedUintArray(data) {
  const [values, nextCursor] = decodeParameters(["uint256[]", "uint256"], data);
  return { values, nextCursor };
}

export function parseUnits(value, decimals) {
  const text = String(value).trim();
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text)) throw new Error(`invalid decimal amount: ${value}`);
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw new Error(`amount has more than ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function formatUnits(value, decimals, precision = decimals) {
  const raw = BigInt(value);
  const negative = raw < 0n;
  const absolute = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  let fraction = (absolute % base).toString().padStart(decimals, "0");
  fraction = fraction.slice(0, Math.min(decimals, precision)).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function jsonValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry)]));
  }
  return value;
}

const ERC8021_MARKER = "80218021802180218021802180218021";

export function stripErc8021Suffix(calldata) {
  const full = strip0x(calldata);
  if (!full.toLowerCase().endsWith(ERC8021_MARKER)) {
    return { calldata: calldata.startsWith("0x") ? calldata : `0x${calldata}`, attribution: null };
  }
  const markerStart = full.length - ERC8021_MARKER.length;
  if (markerStart < 4) throw new Error("malformed ERC-8021 suffix");
  const schemaId = full.slice(markerStart - 2, markerStart).toLowerCase();
  const decodeCodes = (codesHex) => {
    let codes;
    try {
      codes = new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(codesHex.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []),
      );
    } catch {
      throw new Error("invalid ERC-8021 builder-code UTF-8");
    }
    if (codes !== "" && (!/^[\x20-\x7e]+$/.test(codes) || codes.split(",").some((code) => code.length === 0))) {
      throw new Error("invalid ERC-8021 builder codes");
    }
    return codes === "" ? [] : codes.split(",");
  };

  if (schemaId === "00" || schemaId === "01") {
    const lengthIndex = markerStart - 4;
    const codesLength = Number.parseInt(full.slice(lengthIndex, lengthIndex + 2), 16);
    const codesStart = lengthIndex - codesLength * 2;
    if (!Number.isInteger(codesLength) || codesStart < 8) throw new Error(`malformed ERC-8021 schema-${Number(schemaId)} length`);
    const codesHex = full.slice(codesStart, lengthIndex);
    if (codesHex.length !== codesLength * 2) throw new Error(`malformed ERC-8021 schema-${Number(schemaId)} codes`);
    const codes = decodeCodes(codesHex);
    if (schemaId === "00") {
      return { calldata: `0x${full.slice(0, codesStart)}`, attribution: { standard: "ERC-8021", schemaId: 0, codes } };
    }
    const chainLengthIndex = codesStart - 2;
    if (chainLengthIndex < 8) throw new Error("malformed ERC-8021 schema-1 registry length");
    const chainIdLength = Number.parseInt(full.slice(chainLengthIndex, chainLengthIndex + 2), 16);
    if (!Number.isInteger(chainIdLength) || chainIdLength < 1) throw new Error("malformed ERC-8021 schema-1 chainId length");
    const chainIdStart = chainLengthIndex - chainIdLength * 2;
    const registryStart = chainIdStart - 40;
    if (registryStart < 8) throw new Error("malformed ERC-8021 schema-1 registry");
    const registryAddress = `0x${full.slice(registryStart, chainIdStart).toLowerCase()}`;
    const chainIdHex = full.slice(chainIdStart, chainLengthIndex);
    if (chainIdHex.length !== chainIdLength * 2 || /^00/.test(chainIdHex)) throw new Error("non-canonical ERC-8021 schema-1 chainId");
    const chainId = Number.parseInt(chainIdHex, 16);
    if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error("invalid ERC-8021 schema-1 chainId");
    return { calldata: `0x${full.slice(0, registryStart)}`, attribution: { standard: "ERC-8021", schemaId: 1, codes, codeRegistry: { address: registryAddress, chainId } } };
  }

  if (schemaId === "02") {
    const lengthStart = markerStart - 6;
    if (lengthStart < 8) throw new Error("malformed ERC-8021 schema-2 length");
    const cborLength = Number.parseInt(full.slice(lengthStart, markerStart - 2), 16);
    const cborStart = lengthStart - cborLength * 2;
    if (!Number.isInteger(cborLength) || cborLength < 1 || cborStart < 8) throw new Error("malformed ERC-8021 schema-2 CBOR length");
    const cborHex = full.slice(cborStart, lengthStart);
    if (cborHex.length !== cborLength * 2) throw new Error("malformed ERC-8021 schema-2 CBOR data");
    return { calldata: `0x${full.slice(0, cborStart)}`, attribution: { standard: "ERC-8021", schemaId: 2, opaque: true, cborBytes: cborLength } };
  }
  throw new Error(`unsupported ERC-8021 schema 0x${schemaId}`);
}
