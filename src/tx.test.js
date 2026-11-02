import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GAS,
  encodeMessage,
  fee,
  pollTx,
  signAndBroadcast,
} from "./tx.js";

const mint = "AAAAAAAAAAAAAAAAga8VDSpX1SZ/mDgerSSO7C9jhW8=";
const caller = "AAAAAAAAAAAAAAAA+XAYmOelQwKNR6ORO8GRyuc3EzQ=";

function textOf(bytes) {
  return new TextDecoder().decode(bytes);
}

describe("fees and messages", () => {
  it("uses the published minimum gas price", () => {
    assert.deepEqual(fee("osmosis-1", GAS.transfer), { denom: "uosmo", amount: "7500", gas: "250000" });
    assert.deepEqual(fee("osmosis-1", GAS.ibc), { denom: "uosmo", amount: "12000", gas: "400000" });
    assert.deepEqual(fee("osmosis-1", GAS.hook), { denom: "uosmo", amount: "18000", gas: "600000" });
    assert.equal(fee("osmosis-1", GAS.swap).amount, "12000");
    assert.deepEqual(fee("noble-1", GAS.burn), { denom: "uusdc", amount: "40000", gas: "400000" });
    assert.equal(fee("injective-1", GAS.deposit).amount, "64000000000000");
    assert.throws(() => fee("penumbra-1", 1), /no published fee/);
  });

  it("encodes a transfer and refuses a short burn recipient", () => {
    const encoded = encodeMessage({
      type: "/ibc.applications.transfer.v1.MsgTransfer",
      value: {
        source_channel: "channel-750",
        token: { denom: "uusdc", amount: "40000000" },
        sender: "osmo1sender",
        receiver: "noble1receiver",
        timeout_timestamp: 5n,
      },
    });
    const text = textOf(encoded.value);
    assert.equal(text.includes("channel-750"), true);
    assert.equal(text.includes("40000000"), true);
    assert.equal(text.includes("osmo1sender"), true);
    const burn = encodeMessage({
      type: "/circle.cctp.v1.MsgDepositForBurnWithCaller",
      value: {
        from: "noble1sender",
        amount: "980000",
        destination_domain: 1,
        mint_recipient: mint,
        burn_token: "uusdc",
        destination_caller: caller,
      },
    });
    assert.equal(burn.value.includes(24), true);
    assert.equal(burn.value[burn.value.indexOf(24) + 1], 1);
    assert.throws(
      () => encodeMessage({
        type: "/circle.cctp.v1.MsgDepositForBurn",
        value: {
          from: "noble1sender",
          amount: "1",
          destination_domain: 1,
          mint_recipient: "aa",
          burn_token: "uusdc",
        },
      }),
      /32 bytes/,
    );
    assert.throws(() => encodeMessage({ type: "/cosmos.bank.v1beta1.MsgMultiSend", value: {} }), /will not sign/);
  });

  it("encodes an exact-out swap", () => {
    const encoded = encodeMessage({
      type: "/osmosis.poolmanager.v1beta1.MsgSwapExactAmountOut",
      value: {
        sender: "osmo1sender",
        routes: [{ pool_id: 9, token_in_denom: "ibc/usdc" }],
        token_in_max_amount: "80",
        token_out: { denom: "ibc/inj", amount: "123456" },
      },
    });
    assert.equal(encoded.typeUrl, "/osmosis.poolmanager.v1beta1.MsgSwapExactAmountOut");
    const text = textOf(encoded.value);
    assert.equal(text.includes("osmo1sender"), true);
    assert.equal(text.includes("ibc/usdc"), true);
    assert.equal(text.includes("ibc/inj"), true);
    assert.equal(text.includes("80"), true);
    assert.equal(text.includes("123456"), true);
    assert.equal(encoded.value.includes(9), true);
  });
});

describe("sign", () => {
  function keplr(overrides = {}) {
    const signed = [];
    return {
      signed,
      async getKey() {
        return { pubKey: new Uint8Array(33).fill(2) };
      },
      async signDirect(_chainId, _signer, doc) {
        signed.push(doc);
        if (overrides.reject) throw new Error("User rejected the request");
        return {
          signature: { signature: new Uint8Array(64).fill(3) },
          signed: { bodyBytes: doc.bodyBytes, authInfoBytes: doc.authInfoBytes },
        };
      },
      async sendTx(_chainId, _bytes, mode) {
        assert.equal(mode, "sync");
        return new Uint8Array(32).fill(4);
      },
    };
  }

  it("signs the built bytes and waits for a checked transaction", async () => {
    const wallet = keplr();
    let now = 0;
    const urls = [];
    const result = await signAndBroadcast({
      keplr: wallet,
      chainId: "osmosis-1",
      signer: "osmo1sender",
      messages: [{
        type: "/ibc.applications.transfer.v1.MsgTransfer",
        value: {
          source_channel: "channel-750",
          token: { denom: "uusdc", amount: "1" },
          sender: "osmo1sender",
          receiver: "noble1receiver",
          timeout_timestamp: 5n,
        },
      }],
      feeAmount: fee("osmosis-1", GAS.transfer),
      lcd: "https://lcd.example",
      wait: { now: () => now, sleep: async (ms) => { now += ms; }, timeoutMs: 1000, intervalMs: 100 },
      fetchImpl: async (url) => {
        urls.push(String(url));
        if (String(url).includes("/accounts/")) {
          return { ok: true, json: async () => ({ account: { base_account: { account_number: "7", sequence: "3" } } }) };
        }
        return { ok: true, json: async () => ({ tx_response: { code: 0, height: "9", raw_log: "" } }) };
      },
    });
    assert.equal(result.hash, "04".repeat(32));
    assert.equal(wallet.signed[0].accountNumber, "7");
    assert.equal(textOf(wallet.signed[0].bodyBytes).includes("channel-750"), true);
    assert.equal(urls.some((url) => url.includes(result.hash)), true);
  });

  it("stops when the signature is declined or the transaction fails", async () => {
    const declined = keplr({ reject: true });
    await assert.rejects(
      () => signAndBroadcast({
        keplr: declined,
        chainId: "noble-1",
        signer: "noble1sender",
        messages: [{
          type: "/cosmos.bank.v1beta1.MsgSend",
          value: { from_address: "noble1sender", to_address: "noble1other", amount: [{ denom: "uusdc", amount: "1" }] },
        }],
        feeAmount: fee("noble-1", GAS.transfer),
        lcd: "https://lcd.example",
        wait: { now: () => 0, sleep: async () => {}, timeoutMs: 1, intervalMs: 1 },
        fetchImpl: async () => ({ ok: true, json: async () => ({ account: { account_number: "1", sequence: "0" } }) }),
      }),
      /signature was declined/,
    );
    let now = 0;
    await assert.rejects(
      () => signAndBroadcast({
        keplr: keplr(),
        chainId: "noble-1",
        signer: "noble1sender",
        messages: [{
          type: "/cosmos.bank.v1beta1.MsgSend",
          value: { from_address: "noble1sender", to_address: "noble1other", amount: [{ denom: "uusdc", amount: "1" }] },
        }],
        feeAmount: fee("noble-1", GAS.transfer),
        lcd: "https://lcd.example",
        wait: { now: () => now, sleep: async (ms) => { now += ms; }, timeoutMs: 10, intervalMs: 10 },
        fetchImpl: async (url) => {
          if (String(url).includes("/accounts/")) {
            return { ok: true, json: async () => ({ account: { account_number: "1", sequence: "0" } }) };
          }
          return { ok: true, json: async () => ({ tx_response: { code: 5, height: "4", raw_log: "insufficient funds" } }) };
        },
      }),
      /insufficient funds/,
    );
    now = 0;
    await assert.rejects(
      () => pollTx(
        async () => ({ ok: true, json: async () => ({ tx_response: { code: null, height: "0" } }) }),
        "https://lcd.example",
        "AA",
        { now: () => now, sleep: async (ms) => { now += ms; }, timeoutMs: 5, intervalMs: 5 },
      ),
      /not found/,
    );
  });
});
