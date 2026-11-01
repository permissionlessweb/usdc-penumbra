import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initRun, reduce, splitAmount, stepState } from "./machine.js";
import { RELEASE_DENOM, ZAFU_RECEIVER, blockReason, describeStep, keysForStep, stepsFor } from "./route.js";
import { broadcast, query } from "./transport.js";

const exitOnly = {
  penumbra: true,
  noble: false,
  usdcInj: false,
  injGasShort: false,
  osmosisFunds: true,
};

const base = {
  ...exitOnly,
  amountOut: "100000000",
  amountIn: "100000000",
  slices: 3,
  intervalSec: 60,
  jitterMaxSec: 30,
};

function apply(run, events) {
  return events.reduce((state, event) => reduce(state, event), run);
}

function acks(n) {
  return Array.from({ length: n }, () => ({ type: "ACK" }));
}

describe("splitAmount", () => {
  it("gives the remainder to the last slice", () => {
    assert.deepEqual(splitAmount("100000000", 3), [
      "33333333",
      "33333333",
      "33333334",
    ]);
  });
});

describe("steps", () => {
  it("slices only the exit from Penumbra", () => {
    const exitRun = initRun(base);
    assert.equal(exitRun.slices, 3);
    assert.equal(exitRun.intervalSec, 60);
    assert.deepEqual(
      exitRun.steps.map((step) => step.id),
      ["leave", "wipe"],
    );
    const enterRun = initRun({
      penumbra: false,
      noble: true,
      usdcInj: false,
      injGasShort: false,
      osmosisFunds: true,
      amountOut: "1",
      amountIn: "50000000",
      slices: 8,
      intervalSec: 90,
      jitterMaxSec: 20,
    });
    assert.equal(enterRun.slices, 1);
    assert.equal(enterRun.intervalSec, 0);
    assert.equal(enterRun.jitterMaxSec, 0);
    assert.equal(enterRun.amountIn, "50000000");
    assert.deepEqual(
      enterRun.steps.map((step) => step.id),
      ["cctp-noble", "cctp-forward", "deposit", "wipe"],
    );
  });

  it("enters Penumbra in one move when Injective USDC is the only balance", () => {
    assert.deepEqual(
      stepsFor({ ...exitOnly, penumbra: false, usdcInj: true }).map((step) => step.id),
      ["deposit"],
    );
  });

  it("brings INJ from Osmosis only for the move into Penumbra", () => {
    const enter = {
      penumbra: false,
      noble: true,
      usdcInj: true,
      injGasShort: true,
      osmosisFunds: true,
    };
    assert.deepEqual(
      stepsFor(enter).map((step) => step.id),
      ["cctp-noble", "cctp-forward", "gas-osmosis", "deposit", "wipe"],
    );
    assert.equal(stepsFor(enter).every((step) => step.once), true);
    const both = { ...enter, penumbra: true };
    assert.deepEqual(
      stepsFor(both).map((step) => step.id),
      ["cctp-noble", "cctp-forward", "gas-osmosis", "deposit", "wipe", "leave", "wipe"],
    );
    assert.equal(stepsFor({ ...exitOnly, injGasShort: true, osmosisFunds: false }).some((step) => step.id === "gas-osmosis"), false);
  });

  it("refuses a short INJ balance when Osmosis has nothing to swap", () => {
    assert.equal(
      blockReason({ penumbra: false, noble: true, usdcInj: false, injGasShort: true, osmosisFunds: false }),
      "INJ is short. Osmosis has no funds.",
    );
    assert.equal(
      blockReason({ penumbra: false, noble: false, usdcInj: false, injGasShort: false, osmosisFunds: true }),
      "The query found no USDC.",
    );
    assert.equal(blockReason(exitOnly), "");
  });

  it("issues a fresh key for each hop that holds one", () => {
    assert.deepEqual(keysForStep("cctp-noble"), ["noble", "avalanche"]);
    assert.deepEqual(keysForStep("cctp-forward"), ["injLeave"]);
    assert.deepEqual(keysForStep("leave"), ["exitNoble"]);
    assert.deepEqual(keysForStep("gas-osmosis"), []);
    assert.deepEqual(keysForStep("deposit"), []);
    assert.deepEqual(keysForStep("wipe"), []);
  });
});

describe("reduce", () => {
  it("acks through a slice, waits, then starts the next slice", () => {
    let run = reduce(initRun(base), { type: "START" });
    const last = run.steps.length - 1;
    run = reduce(run, {
      type: "NOTE",
      role: "exitNoble",
      address: "noble1abc",
      keyId: "k1",
    });
    run = apply(run, acks(last));
    assert.equal(run.status, "running");
    assert.equal(run.stepIndex, last);
    run = reduce(run, { type: "ACK" });
    assert.equal(run.status, "waiting");
    assert.equal(stepState(run, 0, last), "acked");
    assert.equal(stepState(run, 1, 0), "pending");
    run = reduce(run, { type: "DRAW_JITTER", seconds: 12 });
    run = reduce(run, { type: "WAIT_ELAPSED" });
    assert.equal(run.sliceIndex, 1);
    assert.equal(run.stepIndex, 0);
    assert.equal(run.status, "running");
  });

  it("stops the queue on a failed ack", () => {
    let run = reduce(initRun(base), { type: "START" });
    run = reduce(run, { type: "FAIL", reason: "simulated ack failed" });
    assert.equal(run.status, "halted");
    assert.equal(run.halt.stepId, "leave");
    assert.equal(stepState(run, 0, 0), "failed");
    assert.throws(() => reduce(run, { type: "ACK" }));
  });

  it("finishes on the last wipe and rejects an oversize jitter draw", () => {
    const one = initRun({ ...base, slices: 1, jitterMaxSec: 0 });
    const done = apply(one, [{ type: "START" }, ...acks(one.steps.length)]);
    assert.equal(done.status, "done");
    const waiting = apply(initRun(base), [
      { type: "START" },
      ...acks(initRun(base).steps.length),
    ]);
    assert.equal(waiting.status, "waiting");
    assert.throws(() => reduce(waiting, { type: "DRAW_JITTER", seconds: 31 }));
  });

  it("rejects a second note for the same hop", () => {
    let run = reduce(initRun(base), { type: "START" });
    run = reduce(run, { type: "NOTE", role: "exitNoble", address: "noble1abc", keyId: "k1" });
    assert.throws(() =>
      reduce(run, { type: "NOTE", role: "exitNoble", address: "noble1def", keyId: "k2" }),
    );
  });
});

describe("messages", () => {
  it("burns USDC.noble and releases that amount as USDC.inj", () => {
    const addresses = {
      noble: "noble1q",
      avalanche: "0xabc",
      injLeave: "inj1l",
      injEthereum: "0xdef",
    };
    const ctx = {
      amountBase: "33333333",
      amountIn: "50000000",
      sliceIndex: 0,
      findings: { penumbra: true, noble: true, usdcInj: true, injGasShort: true, osmosisFunds: true },
      addresses: { ...addresses, exitNoble: "noble1out" },
    };
    const leave = describeStep("leave", ctx);
    assert.equal(leave.messages[0].type, "penumbra-withdraw");
    assert.equal(leave.messages[0].value.amount, "33333333");
    assert.equal(leave.messages[0].value.to, "USDC.noble");
    assert.equal(leave.messages[0].value.receiver, "noble1out");
    const burn = describeStep("cctp-noble", ctx);
    assert.equal(burn.messages.length, 1);
    assert.equal(burn.messages[0].type, "cctpTransfer");
    assert.equal(burn.messages[0].value.burn_token, "uusdc");
    assert.equal(burn.messages[0].value.asset, "USDC.noble");
    assert.equal(burn.messages[0].value.fromChainId, "noble-1");
    assert.equal(burn.messages[0].value.toChainId, "43114");
    assert.equal(burn.messages[0].value.amount, "50000000");
    assert.equal(burn.messages[0].value.signer, "noble1q");
    assert.equal(burn.messages[0].value.mint_recipient, "0xabc");
    const forward = describeStep("cctp-forward", ctx);
    assert.equal(forward.messages[0].type, "cctpTransfer");
    assert.equal(forward.messages[1].type, "cctpTransferV2");
    assert.equal(forward.messages[1].value.toChainId, "1776");
    assert.equal(forward.messages[1].value.same_transaction_as_avalanche_receive, true);
    assert.equal(forward.messages[2].type, "transferAssetRelease");
    assert.equal(forward.messages[2].value.denom, RELEASE_DENOM);
    assert.equal(forward.messages[2].value.asset, "USDC.inj");
    assert.equal(forward.messages[2].value.released, true);
    assert.equal(forward.messages[2].value.recipient, "0xdef");
    const gas = describeStep("gas-osmosis", ctx);
    assert.equal(gas.messages[0].type, "osmosis/gamm/swap-exact-amount-in");
    assert.equal(gas.messages[0].value.routes[0].pool_id, "not pinned");
    assert.equal(gas.messages[1].type, "cosmos-sdk/MsgTransfer");
    assert.equal(gas.messages[1].value.receiver, "inj1l");
    assert.equal(gas.messages[1].value.source_channel, "not pinned");
    assert.equal(gas.messages[2].value.receiver.includes("Injective account"), true);
    const deposit = describeStep("deposit", ctx);
    assert.equal(deposit.messages[0].value.sender, "inj1l");
    assert.equal(deposit.messages[0].value.token.denom, RELEASE_DENOM);
    assert.equal(deposit.messages[0].value.token.amount, "50000000");
    assert.equal(deposit.messages[0].value.receiver, ZAFU_RECEIVER);
    assert.equal(deposit.messages[1].value.token.amount, "already held, unread in this cut");
    const only = describeStep("deposit", {
      ...ctx,
      sliceIndex: 1,
      findings: { noble: false, usdcInj: true, injGasShort: false, osmosisFunds: false },
    });
    assert.equal(only.messages.length, 1);
    assert.equal(only.messages[0].value.token.amount, "50000000");
    assert.deepEqual(describeStep("wipe", ctx).messages, []);
  });
});

describe("transport", () => {
  it("refuses chain IO without a direct fallback", () => {
    assert.throws(() => query(), /no direct RPC fallback/);
    assert.throws(() => broadcast(), /no direct RPC fallback/);
  });
});
