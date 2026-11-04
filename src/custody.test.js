import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verify } from "@noble/secp256k1";
import { heldAccounts, heldCount, holds, issue, publicKeyOf, restoreHeld, signDigest, wipe } from "./custody.js";

describe("custody", () => {
  it("derives a fresh cosmes address per hop and drops the key on wipe", () => {
    const first = issue("osmosis");
    const second = issue("osmosis");
    const noble = issue("noble");
    const inj = issue("injective");
    const avalanche = issue("avalanche");
    assert.match(first.address, /^osmo1/);
    assert.match(noble.address, /^noble1/);
    assert.match(inj.address, /^inj1/);
    assert.match(inj.ethereum, /^0x[0-9a-f]{40}$/);
    assert.match(avalanche.address, /^0x[0-9a-f]{40}$/);
    assert.equal(avalanche.ethereum, avalanche.address);
    assert.notEqual(first.address, second.address);
    assert.notEqual(inj.ethereum, avalanche.address);
    assert.equal(heldCount(), 5);
    assert.equal("privateKey" in first, false);
    wipe(first.keyId);
    wipe(first.keyId);
    assert.equal(holds(first.keyId), false);
    assert.equal(heldCount(), 4);
    const digest = new Uint8Array(32).fill(7);
    const signature = signDigest(inj.keyId, digest);
    assert.equal(signature.length, 65);
    assert.equal(signature[64] === 0 || signature[64] === 1, true);
    assert.equal(verify(signature.subarray(0, 64), digest, publicKeyOf(inj.keyId)), true);
    assert.equal("privateKey" in inj, false);
    for (const key of [second, noble, inj, avalanche]) wipe(key.keyId);
    assert.equal(heldCount(), 0);
    assert.throws(() => signDigest(inj.keyId, digest), /cannot hold the Injective key/);
  });

  it("keeps a hop in local storage and signs with it after a restore", () => {
    const memory = new Map();
    globalThis.localStorage = {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => memory.set(key, value),
      removeItem: (key) => memory.delete(key),
    };
    const hop = issue("injective");
    assert.equal(heldAccounts().some((account) => account.keyId === hop.keyId), true);
    assert.equal(JSON.stringify(heldAccounts()).includes("mnemonic"), false);
    const saved = localStorage.getItem("usdc-penumbra.hops");
    wipe(hop.keyId);
    assert.equal(holds(hop.keyId), false);
    localStorage.setItem("usdc-penumbra.hops", saved);
    restoreHeld();
    const digest = new Uint8Array(32).fill(9);
    const signature = signDigest(hop.keyId, digest);
    assert.equal(verify(signature.subarray(0, 64), digest, publicKeyOf(hop.keyId)), true);
    const again = heldAccounts().find((account) => account.keyId === hop.keyId);
    assert.equal(again.address, hop.address);
    assert.equal(again.ethereum, hop.ethereum);
    wipe(hop.keyId);
    delete globalThis.localStorage;
  });
});
