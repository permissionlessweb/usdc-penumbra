import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orbiterMemo } from "./circle.js";
import { INJ_ON_OSMOSIS, NOBLE_TO_OSMOSIS } from "./route.js";
import {
  CROSSCHAIN_SWAP,
  SLICE_GAS,
  feeAmount,
  feeSwapMemo,
  isDevHost,
  matchUsdcPrice,
  migrationMemo,
  penumbraForwardMemo,
  splitSlice,
} from "./batch.js";

const asset = new Uint8Array([9, 8, 7]);

describe("slice split", () => {
  it("reserves the Penumbra fee and the quoted input", () => {
    const prices = {
      blockSpacePrice: 1000n,
      compactBlockSpacePrice: 0n,
      verificationPrice: 0n,
      executionPrice: 0n,
    };
    assert.equal(feeAmount(prices), (SLICE_GAS.blockSpace * 1000n) / 1000n);
    const parts = splitSlice("20000", "1000", feeAmount(prices));
    assert.equal(parts.buy, "1000");
    assert.equal(parts.fee, "12000");
    assert.equal(parts.migrate, "7000");
  });

  it("stops when the slice cannot cover the quote and the fee", () => {
    assert.throws(() => splitSlice("100", "0", "1"), /did not quote the INJ swap/);
    assert.throws(() => splitSlice("100", "80", "-1"), /did not price a USDC fee/);
    assert.throws(() => splitSlice("100", "80", "20"), /cannot buy the Injective fee/);
  });

  it("uses the USDC alt price and ignores the staking price", () => {
    const response = {
      gasPrices: { blockSpacePrice: 9n },
      altGasPrices: [
        { assetId: { inner: new Uint8Array([1]) }, blockSpacePrice: 5000n },
        { assetId: { inner: asset }, executionPrice: 1000n },
      ],
    };
    const matched = matchUsdcPrice(response, { inner: asset });
    assert.equal(feeAmount(matched), (SLICE_GAS.execution * 1000n) / 1000n);
    assert.equal(matchUsdcPrice(response, { inner: new Uint8Array([3]) }), null);
    assert.equal(matchUsdcPrice(response, null), null);
  });
});

describe("slice memos", () => {
  it("forwards the quoted input into the swap contract", () => {
    const memo = JSON.parse(feeSwapMemo("inj1hop", "64000000000000"));
    assert.equal(memo.forward.receiver, CROSSCHAIN_SWAP);
    assert.equal(memo.forward.channel, NOBLE_TO_OSMOSIS);
    assert.equal(memo.forward.timeout, "10m");
    assert.equal(memo.forward.retries, 2);
    const swap = memo.forward.next.wasm;
    assert.equal(swap.contract, CROSSCHAIN_SWAP);
    assert.equal(swap.msg.osmosis_swap.output_denom, INJ_ON_OSMOSIS);
    assert.equal(swap.msg.osmosis_swap.slippage.min_output_amount, "64000000000000");
    assert.equal(swap.msg.osmosis_swap.receiver, "inj1hop");
    assert.equal(swap.msg.osmosis_swap.on_failed_delivery, "do_nothing");
    assert.equal("route" in swap.msg.osmosis_swap, false);
    assert.throws(() => feeSwapMemo("noble1x", "1"), /no Injective receiver/);
    assert.throws(() => feeSwapMemo("inj1hop", "0"), /did not quote the INJ swap/);
  });

  it("builds the burn memo for the hop address", () => {
    const hop = "0x2222222222222222222222222222222222222222";
    const memo = JSON.parse(migrationMemo(hop));
    assert.deepEqual(memo, JSON.parse(orbiterMemo(hop)));
    assert.equal(memo.orbiter.forwarding.attributes.destination_domain, 1);
    assert.equal("pre_actions" in memo.orbiter, false);
    assert.throws(() => migrationMemo("inj1hop"), /mint recipient/);
  });
});

describe("dev return", () => {
  it("stays on a local host", () => {
    assert.equal(isDevHost("127.0.0.1"), true);
    assert.equal(isDevHost("localhost"), true);
    assert.equal(isDevHost("::1"), true);
    assert.equal(isDevHost("[::1]"), true);
    assert.equal(isDevHost("usdc.example"), false);
    assert.equal(isDevHost(""), false);
  });

  it("forwards to the channel it was given", () => {
    const memo = JSON.parse(penumbraForwardMemo("penumbra1vault", "channel-12"));
    assert.equal(memo.forward.receiver, "penumbra1vault");
    assert.equal(memo.forward.port, "transfer");
    assert.equal(memo.forward.channel, "channel-12");
    assert.equal(memo.forward.timeout, "10m");
    assert.equal("next" in memo.forward, false);
    assert.equal(JSON.stringify(memo).includes(CROSSCHAIN_SWAP), false);
    assert.throws(() => penumbraForwardMemo("osmo1user", "channel-12"), /Zafu is not connected/);
    assert.throws(() => penumbraForwardMemo("penumbra1vault", "12"), /did not name a Noble channel/);
  });
});
