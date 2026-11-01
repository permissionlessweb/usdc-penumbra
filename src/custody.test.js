import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { heldCount, holds, issue, wipe } from "./custody.js";

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
    for (const key of [second, noble, inj, avalanche]) wipe(key.keyId);
    assert.equal(heldCount(), 0);
  });
});
