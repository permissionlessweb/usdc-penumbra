import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bech32mAddress } from "@penumbra-zone/bech32m/penumbra";
import {
  diversifiedAddress,
  formatDiversifiedAddress,
  penumbraUsdcFromResponses,
  readPenumbraUsdc,
} from "./zafu.js";

const inner = new Uint8Array(80);
inner[0] = 7;
const text = bech32mAddress({ inner });

describe("diversified address", () => {
  it("encodes the bytes Zafu returns", () => {
    assert.equal(formatDiversifiedAddress({ inner }), text);
    assert.equal(text.startsWith("penumbra1"), true);
    assert.equal(text.length, 143);
  });

  it("asks addressByIndex for the default index", async () => {
    let request;
    const view = {
      addressByIndex: async (req) => {
        request = req;
        return { address: { inner } };
      },
    };
    assert.equal(await diversifiedAddress(view), text);
    assert.deepEqual(request, {});
  });

  it("accepts an address string when the bytes are absent", () => {
    assert.equal(formatDiversifiedAddress({ altBech32m: text }), text);
  });

  it("refuses an empty reply", async () => {
    await assert.rejects(
      () => diversifiedAddress({ addressByIndex: async () => ({}) }),
      /did not return an address/,
    );
  });
});

function usdcView(lo, symbol = "USDC") {
  return {
    balanceView: {
      valueView: {
        case: "knownAssetId",
        value: {
          amount: { lo, hi: 0n },
          metadata: {
            symbol,
            display: "usdc",
            denomUnits: [{ denom: "usdc", exponent: 6 }],
          },
        },
      },
    },
  };
}

describe("penumbra USDC", () => {
  it("sums USDC and ignores other assets", async () => {
    assert.deepEqual(penumbraUsdcFromResponses([usdcView(4n), usdcView(1n, "OSMO")]), {
      amount: "4",
      decimals: 6,
    });
    const view = {
      balances() {
        return (async function* () {
          yield usdcView(1000000n);
          yield usdcView(1n, "OSMO");
        })();
      },
    };
    assert.deepEqual(await readPenumbraUsdc(view), { amount: "1000000", decimals: 6 });
  });

  it("treats an empty stream as zero USDC", async () => {
    const view = { balances: () => (async function* () {})() };
    assert.deepEqual(await readPenumbraUsdc(view), { amount: "0", decimals: 6 });
  });
});
