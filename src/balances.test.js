import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  coinAmount,
  formatUnits,
  parseUnits,
  prepareMigration,
  readDenom,
} from "./balances.js";
import { describeStep } from "./route.js";
import { GAS, fee } from "./tx.js";

const INJ_FEE = fee("injective-1", GAS.deposit).amount;

const empty = (amount = "0") => ({ state: "ready", amount });

function ready(overrides = {}) {
  return {
    osmosis: empty(),
    noble: empty(),
    penumbra: empty(),
    usdcInj: empty(),
    inj: empty("1"),
    uosmo: empty("100000"),
    addresses: { zafu: "penumbra1qqexample", userOsmosis: "osmo1q", userInj: "inj1q" },
    ...overrides,
  };
}

describe("balance amounts", () => {
  it("formats base units and picks one denom", () => {
    assert.equal(formatUnits("0", 6), "0");
    assert.equal(formatUnits("1", 6), "0.000001");
    assert.equal(formatUnits("250000", 6), "0.25");
    assert.equal(formatUnits("1000000", 6), "1");
    assert.equal(formatUnits("1500000", 6), "1.5");
    assert.equal(parseUnits("1.5", 6), "1500000");
    assert.equal(parseUnits("0.25", 6), "250000");
    assert.equal(parseUnits(formatUnits("1500001", 6), 6), "1500001");
    assert.throws(() => parseUnits("1.0000001", 6), /6 decimals/);
    assert.throws(() => parseUnits("nope", 6), /USDC amount/);
    assert.equal(coinAmount([{ denom: "uusdc", amount: "5" }], "uusdc"), 5n);
    assert.equal(coinAmount([], "uusdc"), 0n);
    assert.throws(() => coinAmount([{ denom: "uusdc", amount: "1.2" }], "uusdc"), /whole number/);
  });

  it("reads one bank denom", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ balance: { denom: "uusdc", amount: "5" } }),
      };
    };
    assert.equal(await readDenom(fetchImpl, "https://lcd.example", "noble1abc", "uusdc"), "5");
    assert.match(calls[0], /\/cosmos\/bank\/v1beta1\/balances\/noble1abc\/by_denom\?denom=uusdc$/);
    await assert.rejects(
      () => readDenom(async () => ({ ok: false, status: 503, json: async () => ({}) }), "https://lcd.example", "noble1abc", "uusdc"),
      /503/,
    );
  });
});

describe("prepare", () => {
  it("plans an Osmosis balance and buys the fee when INJ is short", () => {
    const prep = prepareMigration(ready({
      osmosis: empty("1000000"),
      inj: empty("0"),
    }));
    assert.equal(prep.ready, true);
    assert.equal(prep.moved, "1000000");
    assert.deepEqual(prep.steps.map((step) => step.title), [
      "Buy INJ for the Injective fee",
      "Return Osmosis USDC to Noble",
      "Burn USDC.noble",
      "Issue USDC.inj",
      "Enter Penumbra",
      "Wipe the inbound keys",
    ]);
    assert.match(prep.steps[0].detail, /buys the INJ the Injective fee still needs/);
    assert.match(prep.steps[1].detail, /burns it on arrival/);
    assert.match(prep.steps[2].detail, /Circle burns/);
    assert.match(prep.steps[3].detail, /same Avalanche transaction/);
    assert.equal(prep.steps.some((step) => step.gaps.length > 0), true);
  });

  it("skips the hop when the Injective wallet can pay the fee", () => {
    const prep = prepareMigration(ready({ osmosis: empty("1000000"), inj: empty(INJ_FEE) }));
    assert.equal(prep.steps.some((step) => step.title === "Buy INJ for the Injective fee"), false);
    assert.equal(prep.moved, "1000000");
  });

  it("stops when the Osmosis wallet cannot pay gas", () => {
    const prep = prepareMigration(ready({
      osmosis: empty("1000000"),
      inj: empty(INJ_FEE),
      uosmo: empty("0"),
    }));
    assert.equal(prep.ready, false);
    assert.equal(prep.reason, "Osmosis gas is short.");
    const unread = prepareMigration(ready({
      noble: empty("1000000"),
      inj: empty("0"),
      uosmo: { state: "unread", amount: "0", text: "Not read." },
    }));
    assert.equal(unread.reason, "Osmosis gas is not read.");
  });

  it("does not ask for Osmosis gas when Osmosis does not move", () => {
    const prep = prepareMigration(ready({
      noble: empty("1000000"),
      inj: empty(INJ_FEE),
      uosmo: { state: "unread", amount: "0", text: "Not read." },
    }));
    assert.equal(prep.ready, true);
    assert.equal(prep.steps.some((step) => step.id === "gas-osmosis" || step.id === "gather-osmosis"), false);
  });

  it("includes the hop when INJ is below the fee", () => {
    const prep = prepareMigration(ready({ osmosis: empty("1000000"), inj: empty("1") }));
    assert.equal(prep.ready, true);
    assert.equal(prep.steps[0].title, "Buy INJ for the Injective fee");
    assert.equal(prep.moved, "1000000");
  });

  it("plans a selection that is smaller than the old gas peel", () => {
    const prep = prepareMigration(ready({ osmosis: empty("250000"), inj: empty("0") }));
    assert.equal(prep.ready, true);
    assert.equal(prep.moved, "250000");
    assert.equal(prep.steps[0].id, "gas-osmosis");
  });

  it("refuses to plan while a balance is unread", () => {
    const prep = prepareMigration(ready({
      osmosis: { state: "unread", amount: "0", text: "Balance query failed (503)." },
    }));
    assert.equal(prep.ready, false);
    assert.equal(prep.reason, "Osmosis is not read.");
  });

  it("says when the query found no USDC", () => {
    const prep = prepareMigration(ready());
    assert.equal(prep.reason, "The query found no USDC.");
  });

  it("splits a Penumbra balance into the requested slices", () => {
    const prep = prepareMigration(
      ready({ penumbra: empty("5"), inj: empty("1") }),
      { slices: 2, intervalSec: 0, jitterMaxSec: 0 },
    );
    assert.deepEqual(
      prep.steps.filter((step) => step.title.startsWith("Leave")).map((step) => step.title),
      ["Leave Penumbra, 1 of 2", "Leave Penumbra, 2 of 2"],
    );
    assert.deepEqual(prep.steps.map((step) => step.id), ["leave", "leave", "wipe"]);
  });

  it("moves the selected amount and leaves the rest", () => {
    const prep = prepareMigration(ready({
      osmosis: empty("5000000"),
      inj: empty("0"),
      chosen: { osmosis: "1000000" },
    }));
    assert.equal(prep.ready, true);
    assert.equal(prep.moved, "1000000");
    assert.equal(prep.input.amountOsmosis, "1000000");
    assert.equal(prep.ctx.moved, "1000000");
  });

  it("plans the selected amount when the fee is short", () => {
    const prep = prepareMigration(ready({
      osmosis: empty("5000000"),
      inj: empty("0"),
      chosen: { osmosis: "200000" },
    }));
    assert.equal(prep.ready, true);
    assert.equal(prep.moved, "200000");
    assert.equal(prep.steps[0].id, "gas-osmosis");
  });

  it("rejects a selection above the balance and an empty selection", () => {
    const over = prepareMigration(ready({
      osmosis: empty("5"),
      chosen: { osmosis: "6" },
    }));
    assert.equal(over.reason, "Osmosis is larger than the balance.");
    const none = prepareMigration(ready({
      osmosis: empty("5"),
      chosen: { osmosis: "0", noble: "0", penumbra: "0", usdcInj: "0" },
    }));
    assert.equal(none.reason, "Choose an amount.");
  });

  it("uses the USDC.inj amount that was read", () => {
    const described = describeStep("deposit", {
      findings: { noble: true, osmosis: false, penumbra: false, usdcInj: true, injGasShort: false },
      amountIn: "10",
      amountOut: "0",
      amountOsmosis: "0",
      amountHeld: "7",
      addresses: { injLeave: "inj1leave", userInj: "inj1q", zafu: "penumbra1qqexample" },
    });
    assert.equal(described.messages[1].value.token.amount, "7");
    assert.equal(described.messages[1].value.token.denom.startsWith("erc20:0xa00C59"), true);
  });
});
