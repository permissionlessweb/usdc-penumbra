import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { avaxBudget, axelarNativeMemo, axelarNativePayload } from "./axelar.js";

const recipient = "0x2222222222222222222222222222222222222222";

describe("avalanche gas bridge", () => {
  it("puts the recipient in the unwrap payload and prices the Axelar fee on top", () => {
    const payload = axelarNativePayload(recipient);
    const raw = recipient.slice(2);
    const hex = [...payload].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    assert.equal(hex.includes(raw), true);
    assert.equal(hex.split(raw).length - 1, 2);
    const memo = JSON.parse(axelarNativeMemo(recipient, "1000"));
    assert.equal(memo.destination_chain, "avalanche");
    assert.equal(memo.type, 2);
    assert.equal(memo.fee.amount, "1000");
    assert.equal(memo.fee.recipient.startsWith("axelar1"), true);
    assert.equal(memo.payload.length, payload.length);
    assert.equal(avaxBudget(25n, 4n, 7n), 107n);
    assert.throws(() => axelarNativeMemo("inj1hop", "1000"), /not an address/);
    assert.throws(() => axelarNativeMemo(recipient, "0"), /did not price/);
  });
});
