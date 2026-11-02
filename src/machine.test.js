import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initRun, keysNeeded, reduce, splitAmount, stepState } from "./machine.js";
import {
  INJ_ON_OSMOSIS,
  INJ_USDC_DENOM,
  OSMOSIS_USDC_DENOM,
  RELEASE_DENOM,
  USER_INJ,
  ZAFU_RECEIVER,
  blockReason,
  closedDoors,
  describeStep,
  keysForStep,
  migrateAmount,
  planFor,
  signingGaps,
  stepsFor,
} from "./route.js";
import { broadcast, query } from "./transport.js";

const exitOnly = {
  penumbra: true,
  noble: false,
  osmosis: false,
  usdcInj: false,
  injGasShort: false,
};

const base = {
  ...exitOnly,
  amountOut: "100000000",
  amountIn: "0",
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

function ids(findings) {
  return stepsFor(findings).map((step) => step.id);
}

describe("splitAmount", () => {
  it("gives the remainder to the last slice", () => {
    assert.deepEqual(splitAmount("100000000", 3), ["33333333", "33333333", "33333334"]);
  });
});

describe("steps", () => {
  it("slices only the exit, and the slice deposits itself", () => {
    const exitRun = initRun(base);
    assert.equal(exitRun.slices, 3);
    assert.equal(exitRun.intervalSec, 60);
    assert.deepEqual(exitRun.steps.map((step) => step.id), ["leave"]);
    assert.deepEqual(exitRun.onceSteps.map((step) => step.id), ["wipe"]);
    const parts = exitRun.amounts.map((part) => BigInt(part));
    assert.equal(parts.reduce((sum, part) => sum + part, 0n), 100000000n);

    const enterRun = initRun({
      penumbra: false,
      noble: true,
      osmosis: false,
      usdcInj: false,
      injGasShort: false,
      amountIn: "50000000",
      slices: 8,
      intervalSec: 90,
      jitterMaxSec: 20,
    });
    assert.equal(enterRun.slices, 1);
    assert.equal(enterRun.intervalSec, 0);
    assert.equal(enterRun.jitterMaxSec, 0);
    assert.equal(enterRun.amountIn, "50000000");
    assert.deepEqual(enterRun.steps.map((step) => step.id), [
      "cctp-noble",
      "cctp-forward",
      "deposit",
      "wipe",
    ]);
  });

  it("keeps an Injective-only balance as one deposit and remembers its amount", () => {
    const findings = { penumbra: false, noble: false, osmosis: false, usdcInj: true, injGasShort: false };
    assert.deepEqual(ids(findings), ["deposit"]);
    const run = initRun({ ...findings, amountIn: "50000000" });
    assert.equal(run.amountIn, "50000000");
    assert.equal(run.phase, "return");
  });

  it("buys the Injective fee before the other return steps", () => {
    const noble = { penumbra: false, noble: true, osmosis: false, usdcInj: false, injGasShort: true };
    assert.deepEqual(ids(noble), ["gas-osmosis", "cctp-noble", "cctp-forward", "deposit", "wipe"]);
    assert.equal(stepsFor(noble).every((step) => step.once), true);

    const osmosis = { penumbra: false, noble: false, osmosis: true, usdcInj: false, injGasShort: true };
    assert.deepEqual(ids(osmosis), [
      "gas-osmosis",
      "gather-osmosis",
      "cctp-noble",
      "cctp-forward",
      "deposit",
      "wipe",
    ]);

    const fromPenumbra = { ...exitOnly, injGasShort: true };
    assert.deepEqual(ids(fromPenumbra), ["leave", "wipe"]);
    assert.equal(ids(fromPenumbra).includes("gas-osmosis"), false);

    const both = { penumbra: true, noble: true, osmosis: true, usdcInj: false, injGasShort: true };
    assert.deepEqual(ids(both), [
      "leave",
      "gas-osmosis",
      "gather-osmosis",
      "cctp-noble",
      "cctp-forward",
      "deposit",
      "wipe",
    ]);
    assert.equal(ids({ ...exitOnly, injGasShort: false }).includes("gas-osmosis"), false);
  });

  it("stops a short Injective wallet when the USDC is already on Injective", () => {
    const short = { penumbra: false, noble: false, osmosis: false, usdcInj: true, injGasShort: true };
    assert.equal(blockReason(short), "INJ is short. This USDC is already on Injective.");
    assert.throws(() => planFor(short), /already on Injective/);
    assert.throws(() => initRun({ ...short, amountIn: "50000000" }), /already on Injective/);
    assert.equal(blockReason({ ...exitOnly, penumbra: false }), "The query found no USDC.");
    assert.equal(blockReason(exitOnly), "");
  });

  it("keeps a small selection when the Injective fee is short", () => {
    const short = { ...exitOnly, injGasShort: true, amountOut: "250000", slices: 1, intervalSec: 0, jitterMaxSec: 0 };
    const run = initRun(short);
    assert.equal(run.onceSteps[0].id, "wipe");
    assert.equal(migrateAmount({ ...exitOnly, injGasShort: true }, "250000", "0", "0"), "250000");
    assert.equal(migrateAmount({ ...exitOnly, injGasShort: true }, "100000", "150000", "0"), "100000");
    assert.equal(migrateAmount({ ...exitOnly, injGasShort: true }, "250001", "0", "0"), "250001");
  });

  it("issues the pile key once", () => {
    assert.deepEqual(keysForStep("cctp-noble"), ["noble", "avalanche"]);
    assert.deepEqual(keysForStep("cctp-noble", exitOnly), ["avalanche"]);
    assert.deepEqual(keysForStep("cctp-forward"), ["injLeave"]);
    assert.deepEqual(keysForStep("leave"), []);
    assert.deepEqual(keysForStep("gather-osmosis", { osmosis: true }), ["noble"]);
    assert.deepEqual(keysForStep("gather-osmosis", { penumbra: true, osmosis: true }), []);
    assert.deepEqual(keysForStep("gas-osmosis"), []);
    assert.deepEqual(keysForStep("deposit"), []);
    assert.deepEqual(keysForStep("wipe"), []);
  });
});

describe("reduce", () => {
  it("acks a slice and waits", () => {
    let run = reduce(initRun(base), { type: "START" });
    assert.deepEqual(keysNeeded(run), []);
    run = reduce(run, { type: "NOTE", role: "exitNoble", address: "noble1abc", keyId: "k1" });
    assert.deepEqual(keysNeeded(run), []);
    run = reduce(run, { type: "ACK" });
    assert.equal(run.status, "waiting");
    assert.equal(run.sliceIndex, 0);
    assert.equal(stepState(run, 0, 0), "acked");
    assert.equal(stepState(run, 1, 0), "pending");
    run = reduce(run, { type: "DRAW_JITTER", seconds: 12 });
    run = reduce(run, { type: "WAIT_ELAPSED" });
    assert.equal(run.sliceIndex, 1);
    assert.equal(run.stepIndex, 0);
    assert.equal(run.status, "running");
    assert.deepEqual(keysNeeded(run), []);
    assert.throws(() => reduce(run, { type: "NOTE", role: "exitNoble", address: "noble1def", keyId: "k2" }));
  });

  it("stops the queue on a failed ack", () => {
    let run = reduce(initRun(base), { type: "START" });
    run = reduce(run, { type: "FAIL", reason: "simulated ack failed" });
    assert.equal(run.status, "halted");
    assert.equal(run.halt.stepId, "leave");
    assert.equal(stepState(run, 0, 0), "failed");
    assert.throws(() => reduce(run, { type: "ACK" }));
  });

  it("runs the return once after the last slice", () => {
    const one = initRun({ ...base, slices: 1, jitterMaxSec: 0 });
    let run = apply(one, [{ type: "START" }, { type: "ACK" }]);
    assert.equal(run.phase, "return");
    assert.equal(run.status, "running");
    assert.equal(run.stepIndex, 0);
    assert.equal(stepState(run, 0, 0), "acked");
    run = apply(run, acks(run.steps.length));
    assert.equal(run.status, "done");
    assert.equal(run.onceSteps.filter((step) => step.id === "gas-osmosis").length, 0);

    const waiting = apply(initRun(base), [{ type: "START" }, { type: "ACK" }]);
    assert.equal(waiting.status, "waiting");
    assert.throws(() => reduce(waiting, { type: "DRAW_JITTER", seconds: 31 }));
  });

  it("runs the gas hop once, not on every slice", () => {
    const penumbraOnly = initRun({ ...base, injGasShort: true });
    assert.equal(penumbraOnly.onceSteps.filter((step) => step.id === "gas-osmosis").length, 0);
    const run = initRun({ ...base, noble: true, amountIn: "10", injGasShort: true });
    assert.equal(run.exitSteps.some((step) => step.id === "gas-osmosis"), false);
    assert.equal(run.onceSteps.filter((step) => step.id === "gas-osmosis").length, 1);
    let state = apply(run, [{ type: "START" }, { type: "ACK" }]);
    assert.equal(state.status, "waiting");
    state = apply(state, [
      { type: "DRAW_JITTER", seconds: 0 },
      { type: "WAIT_ELAPSED" },
      { type: "ACK" },
    ]);
    assert.equal(state.sliceIndex, 1);
    assert.equal(state.phase, "exit");
  });
});

describe("messages", () => {
  const addresses = {
    noble: "noble1q",
    avalanche: "0xabc",
    injLeave: "inj1l",
    injEthereum: "0xdef",
    exitNoble: "noble1out",
  };

  it("burns the remainder and releases that amount as USDC.inj", () => {
    const findings = { penumbra: true, noble: true, osmosis: false, usdcInj: true, injGasShort: true };
    const ctx = {
      amountBase: "33333333",
      amountOut: "100000000",
      amountIn: "50000000",
      amountOsmosis: "0",
      findings,
      addresses,
    };
    assert.equal(migrateAmount(findings, ctx.amountOut, ctx.amountIn, "0"), "150000000");
    const leave = describeStep("leave", ctx);
    assert.equal(leave.messages.length, 2);
    assert.equal(leave.messages[0].type, "penumbra-withdraw");
    assert.equal(leave.messages[0].value.to, "INJ");
    assert.equal(leave.messages[0].value.receiver, "a new Injective account");
    assert.equal(leave.messages[1].value.to, "USDC.inj");
    assert.equal(leave.messages[1].value.amount, "the remainder");
    assert.deepEqual(signingGaps(leave.messages), []);

    const burn = describeStep("cctp-noble", ctx);
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
    assert.equal(forward.messages[2].value.amount, "50000000");
    assert.equal(forward.messages[2].value.released, true);
    assert.equal(forward.messages[2].value.recipient, "0xdef");

    const deposit = describeStep("deposit", ctx);
    assert.equal(deposit.messages[0].value.sender, "inj1l");
    assert.equal(deposit.messages[0].value.token.denom, INJ_USDC_DENOM);
    assert.equal(deposit.messages[0].value.token.amount, "50000000");
    assert.equal(deposit.messages[0].value.receiver, ZAFU_RECEIVER);
    const namedReceiver = describeStep("deposit", {
      ...ctx,
      addresses: { ...addresses, zafu: "penumbra1qqexample" },
    });
    assert.equal(namedReceiver.messages[0].value.receiver, "penumbra1qqexample");
    assert.equal(namedReceiver.messages[1].value.receiver, "penumbra1qqexample");
    assert.equal(signingGaps(namedReceiver.messages).some((gap) => gap.includes("not derived")), false);
    assert.equal(deposit.messages[1].value.token.amount, "already held, unread in this cut");
    assert.equal(signingGaps(deposit.messages).some((gap) => gap.includes("not derived")), true);
    assert.equal(signingGaps(deposit.messages).some((gap) => gap.includes("not pinned")), false);
    assert.equal(deposit.messages[0].value.source_channel, "channel-494");
  });

  it("quotes the Injective fee on Osmosis and bridges that INJ", () => {
    const findings = { penumbra: true, noble: false, osmosis: true, usdcInj: false, injGasShort: true };
    const ctx = {
      amountBase: "100000000",
      amountOut: "100000000",
      amountIn: "0",
      amountOsmosis: "40000000",
      findings,
      addresses,
    };
    assert.equal(migrateAmount(findings, ctx.amountOut, "0", ctx.amountOsmosis), "140000000");
    const gather = describeStep("gather-osmosis", ctx);
    assert.equal(gather.messages[0].type, "cosmos-sdk/MsgTransfer");
    assert.equal(gather.messages[0].value.token.amount, "40000000");
    assert.equal(gather.messages[0].value.token.denom, OSMOSIS_USDC_DENOM);
    assert.equal(gather.messages[0].value.source_channel, "channel-750");
    assert.equal(gather.messages[0].value.receiver, "noble1out");
    assert.equal(gather.messages[0].value.sender.includes("not connected"), true);

    const gas = describeStep("gas-osmosis", ctx);
    assert.equal(gas.messages.length, 2);
    assert.equal(gas.messages[0].type, "osmosis/poolmanager/swap-exact-amount-out");
    assert.equal(gas.messages[0].value.routes[0].pool_id, "not pinned");
    assert.equal(gas.messages[0].value.routes[0].token_in_denom, OSMOSIS_USDC_DENOM);
    assert.equal(gas.messages[0].value.token_in_max_amount, "quoted at signing, not pinned");
    assert.equal(gas.messages[0].value.token_out.denom, INJ_ON_OSMOSIS);
    assert.equal(gas.messages[0].value.token_out.amount, "quoted at signing, not pinned");
    assert.equal(gas.messages[0].value.sender.includes("not connected"), true);
    assert.equal(gas.messages[1].type, "cosmos-sdk/MsgTransfer");
    assert.equal(gas.messages[1].value.source_channel, "channel-122");
    assert.equal(gas.messages[1].value.token.denom, INJ_ON_OSMOSIS);
    assert.equal(gas.messages[1].value.token.amount, "quoted at signing, not pinned");
    assert.equal(gas.messages[1].value.receiver, USER_INJ);
    const open = signingGaps(gas.messages);
    assert.equal(open.some((gap) => gap.includes("not pinned")), true);
    assert.equal(open.some((gap) => gap.includes("quoted at signing")), true);
    assert.equal(open.some((gap) => gap.includes("not connected")), true);

    const named = describeStep("gas-osmosis", {
      ...ctx,
      addresses: { ...addresses, userOsmosis: "osmo1user", userInj: "inj1user" },
    });
    assert.equal(named.messages[0].value.sender, "osmo1user");
    assert.equal(named.messages[1].value.sender, "osmo1user");
    assert.equal(named.messages[1].value.receiver, "inj1user");
    assert.equal(signingGaps(named.messages).some((gap) => gap.includes("not connected")), false);

    const joined = describeStep("gather-exit", {
      ...ctx,
      findings: { ...findings, noble: true },
      amountIn: "50000000",
    });
    assert.equal(joined.messages[0].type, "cosmos-sdk/MsgSend");
    assert.equal(joined.messages[0].value.from_address, "noble1out");
    assert.equal(joined.messages[0].value.to_address, "noble1q");
    assert.equal(joined.messages[0].value.amount[0].amount, "100000000");

    const only = describeStep("deposit", {
      ...ctx,
      findings: { noble: false, osmosis: false, usdcInj: true, injGasShort: false },
      amountIn: "50000000",
    });
    assert.equal(only.messages.length, 1);
    assert.equal(only.messages[0].value.token.amount, "50000000");
    assert.deepEqual(describeStep("wipe", ctx).messages, []);
  });

  it("names the doors the page still will not open", () => {
    assert.deepEqual(closedDoors(), [
      "The mixnet is closed.",
      "Bank balances are read from the chain LCD.",
      "Penumbra balances are read from Zafu.",
      "A swapping route is refused.",
    ]);
  });
});

describe("transport", () => {
  it("refuses chain IO without a direct fallback", () => {
    assert.throws(() => query(), /no direct RPC fallback/);
    assert.throws(() => broadcast(), /no direct RPC fallback/);
  });
});
