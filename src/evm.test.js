import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AVALANCHE_TOKEN_MESSENGER_V2 } from "./circle.js";
import { approveCalldata, bytesToHex, functionSelector, receiveMessageCalldata, rlpEncode } from "./evm.js";

describe("avalanche mint encoding", () => {
  it("approves the messenger before the burn", () => {
    assert.equal(bytesToHex(approveCalldata(AVALANCHE_TOKEN_MESSENGER_V2, 1n)).startsWith("0x095ea7b3"), true);
  });

  it("uses the transfer selector and pads receiveMessage", () => {
    assert.equal(bytesToHex(functionSelector("transfer(address,uint256)")), "0xa9059cbb");
    const data = receiveMessageCalldata("0xabcd", "0x01");
    assert.equal(bytesToHex(data).startsWith(bytesToHex(functionSelector("receiveMessage(bytes,bytes)"))), true);
    assert.equal(data.length > 4 + 64, true);
  });

  it("rlp-encodes the empty list, a short string, and a short integer", () => {
    assert.equal(bytesToHex(rlpEncode([])), "0xc0");
    assert.equal(bytesToHex(rlpEncode(new Uint8Array())), "0x80");
    assert.equal(bytesToHex(rlpEncode(new TextEncoder().encode("dog"))), "0x83646f67");
    assert.equal(bytesToHex(rlpEncode(0n)), "0x80");
    assert.equal(bytesToHex(rlpEncode(15n)), "0x0f");
    assert.equal(bytesToHex(rlpEncode(1024n)), "0x820400");
  });
});
