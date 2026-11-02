import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Any } from "@bufbuild/protobuf";
import { bech32mAddress } from "@penumbra-zone/bech32m/penumbra";
import { State } from "@penumbra-zone/protobuf/ibc/core/channel/v1/channel_pb";
import { ClientState } from "@penumbra-zone/protobuf/ibc/lightclients/tendermint/v1/tendermint_pb";
import {
  diversifiedAddress,
  formatDiversifiedAddress,
  NOBLE_HEIGHT_HEADROOM,
  nobleForwardChannel,
  nobleTimeoutHeight,
  nobleWithdrawalHeight,
  penumbraUsdcFromResponses,
  readNobleForward,
  readPenumbraUsdc,
  zafuAccountId,
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

const INJ_BASE = "transfer/channel-18/erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";

function usdcView(lo, symbol = "USDC", base = "transfer/channel-9/uusdc") {
  return {
    balanceView: {
      valueView: {
        case: "knownAssetId",
        value: {
          amount: { lo, hi: 0n },
          metadata: {
            symbol,
            base,
            display: "usdc",
            denomUnits: [{ denom: "usdc", exponent: 6 }],
          },
        },
      },
    },
  };
}

describe("penumbra USDC", () => {
  it("keeps USDC.noble and USDC.inj apart", async () => {
    assert.deepEqual(penumbraUsdcFromResponses([
      usdcView(4n),
      usdcView(1n, "OSMO"),
      usdcView(9n, "USDC", "transfer/channel-4/uusd"),
      usdcView(7n, "", INJ_BASE),
    ]), {
      noble: "4",
      inj: "7",
      amount: "4",
      decimals: 6,
    });
    const view = {
      balances() {
        return (async function* () {
          yield usdcView(1000000n);
          yield usdcView(2n, "USDC", INJ_BASE);
        })();
      },
    };
    assert.deepEqual(await readPenumbraUsdc(view), {
      noble: "1000000",
      inj: "2",
      amount: "1000000",
      decimals: 6,
    });
  });

  it("treats an empty stream as zero USDC", async () => {
    const view = { balances: () => (async function* () {})() };
    assert.deepEqual(await readPenumbraUsdc(view), {
      noble: "0",
      inj: "0",
      amount: "0",
      decimals: 6,
    });
  });
});

function packed(chainId, height) {
  return Any.pack(new ClientState({ chainId, latestHeight: height }));
}

function channelEnd(channelId, state = State.OPEN) {
  return { state, counterparty: { channelId } };
}

describe("noble forward channel", () => {
  it("reads the open Noble counterparty", () => {
    assert.deepEqual(
      readNobleForward(channelEnd("channel-12"), packed("noble-1")),
      { channel: "channel-12", chainId: "noble-1" },
    );
    assert.equal(readNobleForward(channelEnd("channel-12"), packed("osmosis-1")), null);
    assert.equal(readNobleForward(channelEnd("channel-12", State.CLOSED), packed("noble-1")), null);
    assert.equal(readNobleForward(channelEnd(""), packed("noble-1")), null);
  });

  it("keeps one active Noble channel and refuses the rest", async () => {
    const assets = [
      { denomMetadata: { symbol: "USDC", base: "transfer/channel-4/uusdc" } },
      { denomMetadata: { symbol: "USDC", base: "transfer/channel-9/uusd" } },
    ];
    const view = {
      assets: () => (async function* () {
        for (const item of assets) yield item;
      })(),
    };
    const channels = {
      async channel({ channelId }) {
        return { channel: channelEnd(channelId === "channel-4" ? "channel-12" : "channel-8") };
      },
      async channelClientState({ channelId }) {
        return {
          identifiedClientState: {
            clientId: "07-tendermint-1",
            clientState: packed(channelId === "channel-4" ? "noble-1" : "osmosis-1"),
          },
        };
      },
    };
    const clients = { clientStatus: async () => ({ status: "Active" }) };
    assert.deepEqual(await nobleForwardChannel(view, channels, clients), {
      channel: "channel-12",
      chainId: "noble-1",
    });

    const inactive = {
      clientStatus: async () => ({ status: "Expired" }),
    };
    await assert.rejects(
      () => nobleForwardChannel(view, channels, inactive),
      /did not name a Noble channel/,
    );

    const both = {
      assets: () => (async function* () {
        yield { denomMetadata: { symbol: "USDC", base: "transfer/channel-4/uusdc" } };
        yield { denomMetadata: { symbol: "USDC", base: "transfer/channel-5/uusdc" } };
      })(),
    };
    const bothChannels = {
      async channel() {
        return { channel: channelEnd("channel-12") };
      },
      async channelClientState() {
        return {
          identifiedClientState: { clientId: "07-tendermint-1", clientState: packed("noble-1") },
        };
      },
    };
    await assert.rejects(
      () => nobleForwardChannel(both, bothChannels, clients),
      /more than one Noble channel/,
    );
  });
});

describe("noble withdrawal height", () => {
  const height = { revisionNumber: 4n, revisionHeight: 80n };

  it("copies the client revision and adds headroom", () => {
    assert.deepEqual(
      nobleTimeoutHeight(packed("noble-1", height), "Active"),
      { revisionNumber: 4n, revisionHeight: 80n + NOBLE_HEIGHT_HEADROOM },
    );
    assert.equal(nobleTimeoutHeight(packed("osmosis-1", height), "Active"), null);
    assert.equal(nobleTimeoutHeight(packed("noble-1", height), "Expired"), null);
    assert.equal(nobleTimeoutHeight(packed("noble-1"), "Active"), null);
  });

  it("asks the client for the source channel and refuses a missing height", async () => {
    let asked = "";
    const channels = {
      async channelClientState({ portId, channelId }) {
        asked = `${portId}/${channelId}`;
        return {
          identifiedClientState: {
            clientId: "07-tendermint-4",
            clientState: packed("noble-1", height),
          },
        };
      },
    };
    const clients = { clientStatus: async () => ({ status: "Active" }) };
    assert.deepEqual(
      await nobleWithdrawalHeight(channels, clients, "channel-9"),
      { revisionNumber: 4n, revisionHeight: 80n + NOBLE_HEIGHT_HEADROOM },
    );
    assert.equal(asked, "transfer/channel-9");
    await assert.rejects(
      () => nobleWithdrawalHeight(channels, { clientStatus: async () => ({ status: "Expired" }) }, "channel-9"),
      /did not name a Noble height/,
    );
  });
});

describe("zafu account id", () => {
  it("joins the wallet id and the diversified address", async () => {
    const view = {
      async addressByIndex() {
        return { address: { inner } };
      },
      async walletId() {
        return { walletId: { inner: Uint8Array.from([1, 15]) } };
      },
    };
    assert.equal(await zafuAccountId(view), `010f:${text}`);
  });
});
