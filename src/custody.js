import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { etc, getPublicKey, sign } from "@noble/secp256k1";
import { bech32 } from "@scure/base";

// Sync secp256k1 signing needs an HMAC. The library does not ship one.
etc.hmacSha256Sync = (key, ...msgs) => hmac(sha256, key, etc.concatBytes(...msgs));
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { resolveBech32Address } from "../vendor/cosmes/address.ts";
import { ethhex } from "../vendor/cosmes/ethhex.ts";
import { resolveKeyPair } from "../vendor/cosmes/key.ts";

// Ephemeral hop keys. Derivation is cosmes resolveKeyPair / resolveBech32Address
// (@scure/bip32, @scure/bip39, @noble/hashes, @noble/secp256k1). Injective uses
// coin type 60 and ethsecp256k1, matching cosmes MnemonicWallet. Private keys
// stay in this module. Callers receive an address and an id.

const CHAINS = {
  osmosis: { prefix: "osmo", coinType: 118, keyType: "secp256k1" },
  noble: { prefix: "noble", coinType: 118, keyType: "secp256k1" },
  // Prefix "inj" is only so cosmes can hash the ethsecp256k1 key. Callers
  // receive the 0x address, which is the CCTP mint recipient on chain 43114.
  avalanche: { prefix: "inj", coinType: 60, keyType: "ethsecp256k1" },
  injective: { prefix: "inj", coinType: 60, keyType: "ethsecp256k1" },
};

function ethereumAddress(injBech32) {
  const decoded = bech32.decode(injBech32);
  return ethhex.encode(bech32.fromWords(decoded.words));
}

const STORE = "usdc-penumbra.hops";
const keys = new Map();
const accounts = new Map();

function browserStorage() {
  try {
    if (typeof localStorage === "undefined") return null;
    localStorage.setItem(STORE, localStorage.getItem(STORE) || "[]");
    return localStorage;
  } catch {
    return null;
  }
}

function readStore() {
  const store = browserStorage();
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(STORE) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(rows) {
  const store = browserStorage();
  if (!store) return;
  if (!rows.length) store.removeItem(STORE);
  else store.setItem(STORE, JSON.stringify(rows));
}

function openAccount(row) {
  const spec = CHAINS[row.chain];
  const { publicKey, privateKey } = resolveKeyPair(row.mnemonic, { coinType: spec.coinType });
  const encoded = resolveBech32Address(publicKey, spec.prefix, spec.keyType);
  const ethereum = spec.keyType === "ethsecp256k1" ? ethereumAddress(encoded) : null;
  const address = row.chain === "avalanche" ? ethereum : encoded;
  keys.set(row.keyId, privateKey);
  const account = { keyId: row.keyId, address, ethereum, chain: row.chain };
  accounts.set(row.keyId, account);
  return account;
}

function remember(row) {
  const rows = readStore().filter((item) => item.keyId !== row.keyId);
  rows.push({ keyId: row.keyId, chain: row.chain, mnemonic: row.mnemonic });
  writeStore(rows);
}

export function restoreHeld() {
  for (const row of readStore()) {
    if (!row?.mnemonic || !row.keyId || !CHAINS[row.chain] || keys.has(row.keyId)) continue;
    try {
      openAccount(row);
    } catch {
      // A damaged record stays stored and cannot sign.
    }
  }
}

restoreHeld();

export function heldAccounts() {
  return [...accounts.values()];
}

export function issue(chain) {
  const spec = CHAINS[chain];
  if (!spec) throw new Error(`unsupported chain ${chain}`);
  const mnemonic = generateMnemonic(wordlist, 128);
  const keyId = crypto.randomUUID();
  const account = openAccount({ keyId, chain, mnemonic });
  remember({ keyId, chain, mnemonic });
  return account;
}

export function publicKeyOf(keyId) {
  const key = keys.get(keyId);
  if (!key) throw new Error("The page cannot hold the Injective key.");
  return getPublicKey(key, true);
}

// Injective ethsecp256k1: keccak256 of the SignDoc, then R || S || V.
// V is the recovery id 0 or 1. The private key stays in this module.
export function signDigest(keyId, digest) {
  const key = keys.get(keyId);
  if (!key) throw new Error("The page cannot hold the Injective key.");
  const signed = sign(digest, key, { lowS: true });
  const compact = signed.toCompactRawBytes();
  const out = new Uint8Array(65);
  out.set(compact, 0);
  out[64] = signed.recovery;
  return out;
}

export function wipe(keyId) {
  const key = keys.get(keyId);
  if (key) key.fill(0);
  keys.delete(keyId);
  accounts.delete(keyId);
  writeStore(readStore().filter((item) => item.keyId !== keyId));
}

export function heldCount() {
  return keys.size;
}

export function holds(keyId) {
  return keys.has(keyId);
}
