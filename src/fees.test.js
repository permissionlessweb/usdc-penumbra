import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { USDC_FEE_BUFFER, feeTokenAmount, parseSpot, preferredFeeDenom } from "./fees.js";
import { FEE_TOKEN_POOLS } from "./fee-tokens.js";
import { OSMOSIS_USDC_DENOM } from "./route.js";

describe("osmosis fee tokens", () => {
  it("prices USDC.noble above the rounded base fee", () => {
    const spot = "21.002132398102827266";
    assert.equal(parseSpot(spot), 21002132398102827266n);
    assert.equal(feeTokenAmount(18000, spot), 858n);
    assert.equal(USDC_FEE_BUFFER, 10_000n);
    assert.equal(feeTokenAmount(18000, spot) < USDC_FEE_BUFFER, true);
    assert.equal(feeTokenAmount("1", "2"), 1n);
    assert.throws(() => feeTokenAmount(1, "0"), /did not price/);
  });

  it("prefers USDC.noble when that fee token is held", () => {
    assert.equal(FEE_TOKEN_POOLS[OSMOSIS_USDC_DENOM], "1464");
    const coins = [
      { denom: "uosmo", amount: "100" },
      { denom: OSMOSIS_USDC_DENOM, amount: "5" },
      { denom: "uatom", amount: "9" },
    ];
    assert.equal(preferredFeeDenom(coins), OSMOSIS_USDC_DENOM);
    assert.equal(preferredFeeDenom([{ denom: "uosmo", amount: "3" }]), "uosmo");
    assert.equal(preferredFeeDenom([{ denom: OSMOSIS_USDC_DENOM, amount: "0" }, { denom: "uosmo", amount: "0" }]), "");
  });
});
