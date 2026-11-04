// Avalanche mint. Noble's message is CCTP V1, so receiveMessage goes to the
// V1 transmitter. depositForBurn toward Injective is CCTP V2. The hop signs
// a type-2 transaction. A caller with AVAX may submit either call.

import { keccak_256 } from "@noble/hashes/sha3";
import {
  AVALANCHE_MESSAGE_TRANSMITTER_V1,
  AVALANCHE_TOKEN_MESSENGER_V2,
  AVALANCHE_USDC,
  ethereumBytes32,
  zeroBytes32,
} from "./circle.js";

export const AVALANCHE_CHAIN_ID = 43114n;
export const AVALANCHE_RPC = "https://api.avax.network/ext/bc/C/rpc";
// Headroom for receiveMessage and the following depositForBurn.
// The paid amount is this limit times the live gas price.
export const RELAY_GAS = 500000n;
// The hop pays for the mint, the USDC approval, and the burn, with room for the gas price.
export const AVAX_GAS_MULTIPLE = 5n;

const textEncoder = new TextEncoder();

export function functionSelector(signature) {
  return keccak_256(textEncoder.encode(signature)).subarray(0, 4);
}

function concat(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function hexToBytes(value) {
  const hex = String(value || "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new Error("The attestation is not hex.");
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes) {
  let hex = "0x";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function word(value) {
  const out = new Uint8Array(32);
  const rest = typeof value === "bigint" ? value : BigInt(value);
  if (rest < 0n || rest >= 1n << 256n) throw new Error("An ABI word does not fit.");
  for (let index = 31; index >= 0; index -= 1) {
    out[index] = Number((rest >> BigInt((31 - index) * 8)) & 0xffn);
  }
  return out;
}

function addressWord(address) {
  const raw = hexToBytes(address);
  if (raw.length !== 20) throw new Error("The mint recipient is not an Ethereum address.");
  const out = new Uint8Array(32);
  out.set(raw, 12);
  return out;
}

function padRight(bytes) {
  const words = Math.ceil(bytes.length / 32) || 0;
  const out = new Uint8Array(words * 32);
  out.set(bytes);
  return out;
}

function encodeBytesTail(bytes) {
  return concat([word(bytes.length), padRight(bytes)]);
}

export function receiveMessageCalldata(message, attestation) {
  const selector = functionSelector("receiveMessage(bytes,bytes)");
  const first = hexToBytes(message);
  const second = hexToBytes(attestation);
  const head = 64;
  const firstTail = encodeBytesTail(first);
  const secondOffset = head + firstTail.length;
  return concat([
    selector,
    word(head),
    word(secondOffset),
    firstTail,
    encodeBytesTail(second),
  ]);
}

export function depositForBurnCalldata({ amount, mintRecipient, destinationDomain = 29, maxFee = 0n, minFinalityThreshold = 2000 }) {
  const selector = functionSelector("depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)");
  return concat([
    selector,
    word(amount),
    word(destinationDomain),
    ethereumBytes32(mintRecipient),
    addressWord(AVALANCHE_USDC),
    zeroBytes32(),
    word(maxFee),
    word(minFinalityThreshold),
  ]);
}

export function balanceOfCalldata(account) {
  return concat([functionSelector("balanceOf(address)"), addressWord(account)]);
}

export function approveCalldata(spender, amount) {
  return concat([
    functionSelector("approve(address,uint256)"),
    addressWord(spender),
    word(amount),
  ]);
}

export function allowanceCalldata(owner, spender) {
  return concat([
    functionSelector("allowance(address,address)"),
    addressWord(owner),
    addressWord(spender),
  ]);
}

// Approve plus the burn. A burn estimate reverts until the approval is mined,
// so that leg uses the relay gas headroom.
export async function relayBudget(fetchImpl, from, calls) {
  const gasPrice = BigInt(await rpc(fetchImpl, "eth_gasPrice", []));
  let gas = 0n;
  for (const call of calls) {
    try {
      gas += BigInt(await rpc(fetchImpl, "eth_estimateGas", [{ from, to: call.to, data: call.data }]));
    } catch {
      gas += RELAY_GAS;
    }
  }
  return { gasPrice, gas, cost: gasPrice * gas };
}

function bigintBytes(value) {
  let rest = BigInt(value);
  if (rest < 0n) throw new Error("A transaction field was negative.");
  if (rest === 0n) return new Uint8Array();
  const out = [];
  while (rest > 0n) {
    out.push(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return Uint8Array.from(out.reverse());
}

function rlpLength(body, offset) {
  if (body.length < 56) {
    const out = new Uint8Array(1 + body.length);
    out[0] = offset + body.length;
    out.set(body, 1);
    return out;
  }
  const length = bigintBytes(BigInt(body.length));
  const out = new Uint8Array(1 + length.length + body.length);
  out[0] = offset + 55 + length.length;
  out.set(length, 1);
  out.set(body, 1 + length.length);
  return out;
}

export function rlpEncode(value) {
  if (typeof value === "bigint" || typeof value === "number") return rlpEncode(bigintBytes(value));
  if (value instanceof Uint8Array) {
    if (value.length === 1 && value[0] < 0x80) return value;
    return rlpLength(value, 0x80);
  }
  if (Array.isArray(value)) return rlpLength(concat(value.map((item) => rlpEncode(item))), 0xc0);
  throw new Error("A transaction field could not be encoded.");
}

export async function signEip1559({
  chainId,
  nonce,
  maxPriorityFeePerGas,
  maxFeePerGas,
  gasLimit,
  to,
  value = 0n,
  data,
  signDigest,
}) {
  const toBytes = hexToBytes(to);
  if (toBytes.length !== 20) throw new Error("The mint contract is not an address.");
  const fields = [
    BigInt(chainId),
    BigInt(nonce),
    BigInt(maxPriorityFeePerGas),
    BigInt(maxFeePerGas),
    BigInt(gasLimit),
    toBytes,
    BigInt(value),
    data,
    [],
  ];
  const hash = keccak_256(concat([Uint8Array.of(0x02), rlpEncode(fields)]));
  const signature = await signDigest(hash);
  if (!(signature instanceof Uint8Array) || signature.length !== 65) {
    throw new Error("The mint signature is not 65 bytes.");
  }
  const raw = concat([
    Uint8Array.of(0x02),
    rlpEncode([
      ...fields,
      BigInt(signature[64]),
      signature.subarray(0, 32),
      signature.subarray(32, 64),
    ]),
  ]);
  return { hash: bytesToHex(hash), raw };
}

async function rpc(fetchImpl, method, params) {
  const response = await fetchImpl(AVALANCHE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`Avalanche rejected the preflight (${response.status}).`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || "Avalanche rejected the preflight.");
  if (body.result == null) throw new Error("Avalanche rejected the preflight.");
  return body.result;
}

export async function preflightReceiveMessage(fetchImpl, { message, attestation }) {
  const data = bytesToHex(receiveMessageCalldata(message, attestation));
  const result = await rpc(fetchImpl, "eth_call", [{
    to: AVALANCHE_MESSAGE_TRANSMITTER_V1,
    data,
  }, "latest"]);
  return { data, result, to: AVALANCHE_MESSAGE_TRANSMITTER_V1 };
}

export async function ethCall(fetchImpl, to, data) {
  return rpc(fetchImpl, "eth_call", [{ to, data }, "latest"]);
}

function hexQuantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

export async function sendContract({ fetchImpl, from, to, data, signDigest, chainId = AVALANCHE_CHAIN_ID }) {
  const balance = BigInt(await rpc(fetchImpl, "eth_getBalance", [from, "latest"]));
  const gasPrice = BigInt(await rpc(fetchImpl, "eth_gasPrice", []));
  let gasLimit;
  try {
    gasLimit = BigInt(await rpc(fetchImpl, "eth_estimateGas", [{ from, to, data }]));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message);
  }
  const cost = gasPrice * gasLimit;
  if (balance < cost) return null;
  const nonce = BigInt(await rpc(fetchImpl, "eth_getTransactionCount", [from, "pending"]));
  const signed = await signEip1559({
    chainId,
    nonce,
    maxPriorityFeePerGas: gasPrice,
    maxFeePerGas: gasPrice,
    gasLimit,
    to,
    data: hexToBytes(data),
    signDigest,
  });
  const hash = await rpc(fetchImpl, "eth_sendRawTransaction", [bytesToHex(signed.raw)]);
  return { hash, gasLimit, gasPrice };
}

export { AVALANCHE_MESSAGE_TRANSMITTER_V1, AVALANCHE_TOKEN_MESSENGER_V2 };
