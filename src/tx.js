// Protobuf encoding for the transactions Keplr signs directly.
// Fees use the published minimum gas price: Osmosis 0.03 uosmo, Noble 0.1
// uusdc, Injective 160000000 inj. The page does not fetch a chain RPC.
// Keplr broadcasts the signed bytes. A Penumbra slice's Injective account
// signs locally: keccak256 of the direct SignDoc, then the LCD broadcast.

import { keccak_256 } from "@noble/hashes/sha3";

const textEncoder = new TextEncoder();

export const GAS = {
  transfer: 250000,
  // An Osmosis IBC packet for an ibc/ denom used 250937 at a 250000 limit.
  ibc: 400000,
  // That packet plus the Orbiter memo. The memo is about 530 bytes.
  hook: 600000,
  swap: 400000,
  burn: 400000,
  deposit: 400000,
};

export function fee(chainId, gas) {
  if (chainId === "osmosis-1") return coinFee("uosmo", gas, 3n, 100n);
  if (chainId === "noble-1") return coinFee("uusdc", gas, 1n, 10n);
  if (chainId === "injective-1") return coinFee("inj", gas, 160000000n, 1n);
  throw new Error("This chain has no published fee.");
}

function coinFee(denom, gas, numerator, denominator) {
  const limit = BigInt(gas);
  const amount = (limit * numerator + denominator - 1n) / denominator;
  return { denom, amount: amount.toString(), gas: limit.toString() };
}

export function transferTimeout(nowMs) {
  return BigInt(nowMs + 10 * 60 * 1000) * 1000000n;
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

function varint(value) {
  let rest = typeof value === "bigint" ? value : BigInt(value);
  if (rest < 0n) throw new Error("A protobuf field was negative.");
  const out = [];
  while (rest > 127n) {
    out.push(Number((rest & 127n) | 128n));
    rest >>= 7n;
  }
  out.push(Number(rest));
  return Uint8Array.from(out);
}

function key(field, wire) {
  return varint(BigInt(field * 8 + wire));
}

function fieldVarint(field, value) {
  return concat([key(field, 0), varint(value)]);
}

function fieldBytes(field, bytes) {
  return concat([key(field, 2), varint(bytes.length), bytes]);
}

function fieldString(field, value) {
  return fieldBytes(field, textEncoder.encode(String(value)));
}

function coinBytes(denom, amount) {
  return concat([fieldString(1, denom), fieldString(2, String(amount))]);
}

function anyBytes(typeUrl, value) {
  return concat([fieldString(1, typeUrl), fieldBytes(2, value)]);
}

export function bytesToBase64(bytes) {
  let text = "";
  for (let index = 0; index < bytes.length; index += 1) text += String.fromCharCode(bytes[index]);
  return btoa(text);
}

export function base64ToBytes(text) {
  const raw = atob(String(text).replace(/\s/g, ""));
  const out = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) out[index] = raw.charCodeAt(index);
  return out;
}

export function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    const trimmed = value.replace(/^0x/i, "");
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0 && trimmed.length > 64) {
      const out = new Uint8Array(trimmed.length / 2);
      for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(trimmed.slice(index * 2, index * 2 + 2), 16);
      return out;
    }
    return base64ToBytes(value);
  }
  throw new Error("Keplr returned a signature this page cannot read.");
}

function fixedBytes(value, label) {
  const bytes = typeof value === "string"
    ? (value.startsWith("0x") ? asBytes(value) : base64ToBytes(value))
    : value;
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new Error(`${label} is not 32 bytes.`);
  }
  return bytes;
}

export function encodeMessage(message) {
  const { type, value } = message;
  if (type === "/ibc.applications.transfer.v1.MsgTransfer" || type === "cosmos-sdk/MsgTransfer") {
    const body = [
      fieldString(1, value.source_port || value.sourcePort || "transfer"),
      fieldString(2, value.source_channel || value.sourceChannel),
      fieldBytes(3, coinBytes(value.token.denom, value.token.amount)),
      fieldString(4, value.sender),
      fieldString(5, value.receiver),
      fieldVarint(7, value.timeout_timestamp || value.timeoutTimestamp),
    ];
    const memo = value.memo || "";
    if (memo) body.push(fieldString(8, memo));
    return { typeUrl: "/ibc.applications.transfer.v1.MsgTransfer", value: concat(body) };
  }
  if (type === "/cosmos.bank.v1beta1.MsgSend") {
    const coins = (value.amount || []).map((coin) => fieldBytes(3, coinBytes(coin.denom, coin.amount)));
    return {
      typeUrl: type,
      value: concat([
        fieldString(1, value.from_address || value.fromAddress),
        fieldString(2, value.to_address || value.toAddress),
        ...coins,
      ]),
    };
  }
  if (type === "/osmosis.poolmanager.v1beta1.MsgSwapExactAmountOut") {
    const routes = (value.routes || []).map((route) => fieldBytes(2, concat([
      fieldVarint(1, route.pool_id || route.poolId),
      fieldString(2, route.token_in_denom || route.tokenInDenom),
    ])));
    const tokenOut = value.token_out || value.tokenOut;
    return {
      typeUrl: type,
      value: concat([
        fieldString(1, value.sender),
        ...routes,
        fieldString(3, value.token_in_max_amount || value.tokenInMaxAmount),
        fieldBytes(4, coinBytes(tokenOut.denom, tokenOut.amount)),
      ]),
    };
  }
  if (type === "/osmosis.gamm.v1beta1.MsgSwapExactAmountIn") {
    const routes = (value.routes || []).map((route) => fieldBytes(2, concat([
      fieldVarint(1, route.pool_id || route.poolId),
      fieldString(2, route.token_out_denom || route.tokenOutDenom),
    ])));
    const token = value.token_in || value.tokenIn;
    return {
      typeUrl: type,
      value: concat([
        fieldString(1, value.sender),
        ...routes,
        fieldBytes(3, coinBytes(token.denom, token.amount)),
        fieldString(4, value.token_out_min_amount || value.tokenOutMinAmount),
      ]),
    };
  }
  if (type === "/circle.cctp.v1.MsgDepositForBurn" || type === "/circle.cctp.v1.MsgDepositForBurnWithCaller") {
    const body = [
      fieldString(1, value.from),
      fieldString(2, value.amount),
      fieldVarint(3, value.destination_domain ?? value.destinationDomain),
      fieldBytes(4, fixedBytes(value.mint_recipient || value.mintRecipient, "The burn recipient")),
      fieldString(5, value.burn_token || value.burnToken),
    ];
    if (type.endsWith("WithCaller")) {
      body.push(fieldBytes(6, fixedBytes(value.destination_caller || value.destinationCaller, "The burn caller")));
    }
    return { typeUrl: type, value: concat(body) };
  }
  throw new Error("This page will not sign that message.");
}

function txBody(messages, memo) {
  const parts = messages.map((message) => fieldBytes(1, anyBytes(message.typeUrl, message.value)));
  if (memo) parts.push(fieldString(2, memo));
  return concat(parts);
}

function authInfo({ pubKey, pubKeyType, sequence, feeAmount }) {
  const single = fieldBytes(1, fieldVarint(1, 1));
  const signer = concat([
    fieldBytes(1, anyBytes(pubKeyType, fieldBytes(1, pubKey))),
    fieldBytes(2, single),
    fieldVarint(3, sequence),
  ]);
  const feeBytes = concat([
    fieldBytes(1, coinBytes(feeAmount.denom, feeAmount.amount)),
    fieldVarint(2, feeAmount.gas),
  ]);
  return concat([fieldBytes(1, signer), fieldBytes(2, feeBytes)]);
}

function txRaw(bodyBytes, authInfoBytes, signatures) {
  return concat([
    fieldBytes(1, bodyBytes),
    fieldBytes(2, authInfoBytes),
    ...signatures.map((signature) => fieldBytes(3, signature)),
  ]);
}

export function directSignBytes(bodyBytes, authInfoBytes, chainId, accountNumber) {
  return concat([
    fieldBytes(1, bodyBytes),
    fieldBytes(2, authInfoBytes),
    fieldString(3, chainId),
    fieldVarint(4, accountNumber),
  ]);
}

export function directSignDigest(bodyBytes, authInfoBytes, chainId, accountNumber) {
  return keccak_256(directSignBytes(bodyBytes, authInfoBytes, chainId, accountNumber));
}

export function pubKeyType(chainId) {
  if (chainId === "injective-1") return "/injective.crypto.v1beta1.ethsecp256k1.PubKey";
  return "/cosmos.crypto.secp256k1.PubKey";
}

export async function readAccount(fetchImpl, lcd, address, options = {}) {
  const response = await fetchImpl(`${lcd}/cosmos/auth/v1beta1/accounts/${address}`);
  if (!response.ok) {
    if (response.status === 404 && options.missing) throw new Error(options.missing);
    throw new Error(`The account query failed (${response.status}).`);
  }
  const body = await response.json();
  const account = body.account?.base_account || body.account?.baseAccount || body.account || {};
  const accountNumber = account.account_number ?? account.accountNumber;
  if (accountNumber == null) throw new Error("The account number was not in the response.");
  return {
    accountNumber: String(accountNumber),
    sequence: String(account.sequence ?? "0"),
  };
}

function maybeDecode(value) {
  const text = String(value ?? "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0 || text.length < 4) return text;
  try {
    const decoded = atob(text);
    if (/^[\t\n\r\x20-\x7e]+$/.test(decoded)) return decoded;
  } catch {
    // The attribute was already plain text.
  }
  return text;
}

function eventDetails(tx) {
  const found = [];
  for (const event of tx?.events || []) {
    for (const attr of event.attributes || []) {
      const key = maybeDecode(attr.key);
      if (key !== "error" && !key.endsWith(".error")) continue;
      const value = maybeDecode(attr.value).trim();
      if (value) found.push(value);
    }
  }
  return found;
}

export function txFailureMessage(code, log, details = []) {
  const parts = [`The transaction failed (${code}).`];
  for (const item of [log, ...details]) {
    const text = String(item || "").trim();
    if (!text || parts.some((part) => part.includes(text))) continue;
    parts.push(text);
  }
  return parts.join(" ");
}

function broadcastFailure(error) {
  if (error instanceof Error) {
    const message = error.message || "";
    if (/reject/i.test(message)) return "The signature was declined.";
    return message || "The transaction failed.";
  }
  if (error && typeof error === "object") {
    const code = error.code ?? error.tx_response?.code ?? error.txResponse?.code;
    const tx = error.tx_response || error.txResponse || error;
    const log = tx.raw_log || tx.rawLog || tx.log || error.log || error.message || "";
    if (code != null && Number(code) !== 0) return txFailureMessage(Number(code), log, eventDetails(tx));
    if (log) return String(log);
  }
  const text = String(error ?? "");
  if (!text || text === "[object Object]") return "The transaction failed.";
  if (/reject/i.test(text)) return "The signature was declined.";
  return text;
}

// Sync mode can return the hash, or a CheckTx body when the node rejected it.
function broadcastRejection(result) {
  if (!result || typeof result !== "object" || result instanceof Uint8Array) return "";
  const code = result.code ?? result.tx_response?.code ?? result.txResponse?.code;
  if (code == null || Number(code) === 0) return "";
  const tx = result.tx_response || result.txResponse || result;
  return txFailureMessage(Number(code), tx.raw_log || tx.rawLog || tx.log || result.log || "", eventDetails(tx));
}

export async function pollTx(fetchImpl, lcd, hash, wait) {
  const started = wait.now();
  while (wait.now() - started <= wait.timeoutMs) {
    const response = await fetchImpl(`${lcd}/cosmos/tx/v1beta1/txs/${hash}`);
    if (response.ok) {
      const body = await response.json();
      const tx = body.tx_response || body.txResponse || {};
      if (tx.code != null && tx.height && tx.height !== "0") {
        return {
          code: Number(tx.code),
          log: tx.raw_log || tx.rawLog || "",
          details: eventDetails(tx),
        };
      }
    }
    await wait.sleep(wait.intervalMs);
  }
  throw new Error("The transaction was not found.");
}

export async function signAndBroadcast({
  keplr,
  fetchImpl,
  chainId,
  signer,
  messages,
  feeAmount,
  lcd,
  wait,
  memo = "",
  onSubmitted,
}) {
  const key = await keplr.getKey(chainId);
  const pubKey = asBytes(key?.pubKey);
  if (!pubKey?.length) throw new Error("Keplr did not return a public key.");
  const account = await readAccount(fetchImpl, lcd, signer);
  const bodyBytes = txBody(messages.map(encodeMessage), memo);
  const authInfoBytes = authInfo({
    pubKey,
    pubKeyType: pubKeyType(chainId),
    sequence: account.sequence,
    feeAmount,
  });
  let signed;
  try {
    signed = await keplr.signDirect(chainId, signer, {
      bodyBytes,
      authInfoBytes,
      chainId,
      accountNumber: account.accountNumber,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/reject/i.test(message)) throw new Error("The signature was declined.");
    throw new Error(message || "The signature was declined.");
  }
  const signature = asBytes(signed?.signature?.signature);
  const raw = txRaw(
    asBytes(signed?.signed?.bodyBytes || bodyBytes),
    asBytes(signed?.signed?.authInfoBytes || authInfoBytes),
    [signature],
  );
  let broadcast;
  try {
    broadcast = await keplr.sendTx(chainId, raw, "sync");
  } catch (error) {
    throw new Error(broadcastFailure(error));
  }
  const rejected = broadcastRejection(broadcast);
  if (rejected) throw new Error(rejected);
  const hash = txHashOf(broadcast);
  onSubmitted?.(hash);
  const result = await pollTx(fetchImpl, lcd, hash, wait);
  if (result.code !== 0) throw new Error(txFailureMessage(result.code, result.log, result.details));
  return { hash };
}

function txHashOf(result) {
  if (typeof result === "string") return result.replace(/^0x/i, "").toUpperCase();
  return bytesToHex(asBytes(result));
}

export async function signAndBroadcastLocal({
  fetchImpl,
  chainId,
  signer,
  messages,
  feeAmount,
  lcd,
  wait,
  pubKey,
  signDigest,
  memo = "",
}) {
  const account = await readAccount(fetchImpl, lcd, signer, {
    missing: "The Injective account has not been created.",
  });
  const bodyBytes = txBody(messages.map(encodeMessage), memo);
  const authInfoBytes = authInfo({
    pubKey,
    pubKeyType: pubKeyType(chainId),
    sequence: account.sequence,
    feeAmount,
  });
  const signature = await signDigest(directSignDigest(bodyBytes, authInfoBytes, chainId, account.accountNumber));
  if (!(signature instanceof Uint8Array) || signature.length !== 65) {
    throw new Error("The signature was declined.");
  }
  const raw = txRaw(bodyBytes, authInfoBytes, [signature]);
  const response = await fetchImpl(`${lcd}/cosmos/tx/v1beta1/txs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tx_bytes: bytesToBase64(raw), mode: "BROADCAST_MODE_SYNC" }),
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  const tx = body.tx_response || body.txResponse || {};
  if (!response.ok || Number(tx.code) !== 0) {
    throw new Error(txFailureMessage(tx.code ?? response.status, tx.raw_log || tx.rawLog || "", eventDetails(tx)));
  }
  const hash = String(tx.txhash || tx.txHash || "").replace(/^0x/i, "").toUpperCase();
  if (!hash) throw new Error("The transaction was not found.");
  const result = await pollTx(fetchImpl, lcd, hash, wait);
  if (result.code !== 0) throw new Error(txFailureMessage(result.code, result.log, result.details));
  return { hash };
}
