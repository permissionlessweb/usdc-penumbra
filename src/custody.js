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

const keys = new Map();

export function issue(chain) {
  const spec = CHAINS[chain];
  if (!spec) throw new Error(`unsupported chain ${chain}`);
  const mnemonic = generateMnemonic(wordlist, 128);
  const { publicKey, privateKey } = resolveKeyPair(mnemonic, {
    coinType: spec.coinType,
  });
  const encoded = resolveBech32Address(publicKey, spec.prefix, spec.keyType);
  const ethereum = spec.keyType === "ethsecp256k1" ? ethereumAddress(encoded) : null;
  const address = chain === "avalanche" ? ethereum : encoded;
  const keyId = crypto.randomUUID();
  keys.set(keyId, privateKey);
  return { keyId, address, ethereum, chain };
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
}

export function heldCount() {
  return keys.size;
}

export function holds(keyId) {
  return keys.has(keyId);
}
