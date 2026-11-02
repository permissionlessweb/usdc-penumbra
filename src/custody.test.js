import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verify } from "@noble/secp256k1";
import { heldCount, holds, issue, publicKeyOf, signDigest, wipe } from "./custody.js";

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
});
