import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha2";
import {
  GAS,
  directSignBytes,
  directSignDigest,
  encodeMessage,
  fee,
  pollTx,
  signAndBroadcast,
  signAndBroadcastLocal,
  transferTimeout,
} from "./tx.js";

const mint = "AAAAAAAAAAAAAAAAga8VDSpX1SZ/mDgerSSO7C9jhW8=";
const caller = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function textOf(bytes) {
  return new TextDecoder().decode(bytes);
}

describe("fees and messages", () => {
  it("uses the published minimum gas price", () => {
    assert.deepEqual(fee("osmosis-1", GAS.transfer), { denom: "uosmo", amount: "7500", gas: "250000" });
    assert.deepEqual(fee("osmosis-1", GAS.ibc), { denom: "uosmo", amount: "18000", gas: "600000" });
    assert.deepEqual(fee("osmosis-1", GAS.hook), { denom: "uosmo", amount: "18000", gas: "600000" });
    assert.equal(fee("osmosis-1", GAS.swap).amount, "18000");
    assert.deepEqual(fee("noble-1", GAS.burn), { denom: "uusdc", amount: "40000", gas: "400000" });
    assert.equal(fee("injective-1", GAS.deposit).amount, "64000000000000");
    assert.equal(transferTimeout(1_700_000_123) % 60_000_000_000n, 0n);
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
    const callerField = new Uint8Array(34);
    callerField[0] = 50;
    callerField[1] = 32;
    let callerAt = -1;
    for (let index = 0; index <= burn.value.length - callerField.length; index += 1) {
      let matched = true;
      for (let offset = 0; offset < callerField.length; offset += 1) {
        if (burn.value[index + offset] !== callerField[offset]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        callerAt = index;
        break;
      }
    }
    assert.equal(callerAt >= 0, true);
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
      async signDirect(_chainId, _signer, doc, options) {
        signed.push(doc);
        signed.options = options;
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
      fetchImpl: async (url, init) => {
        urls.push(String(url));
        if (String(url).includes("/accounts/")) {
          return { ok: true, json: async () => ({ account: { base_account: { account_number: "7", sequence: "3" } } }) };
        }
        if (init?.method === "POST") {
          return { ok: true, json: async () => ({ tx_response: { code: 0, txhash: "04".repeat(32), raw_log: "" } }) };
        }
        return { ok: true, json: async () => ({ tx_response: { code: 0, height: "9", raw_log: "" } }) };
      },
    });
    assert.equal(result.hash, "04".repeat(32));
    assert.deepEqual(wallet.signed.options, { preferNoSetFee: true });
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

  it("reports a rejected broadcast without waiting for a block", async () => {
    const progress = [];
    let polls = 0;
    await assert.rejects(
      () => signAndBroadcast({
        keplr: {
          async getKey() {
            return { pubKey: new Uint8Array(33).fill(2) };
          },
          async signDirect() {
            return { signature: { signature: new Uint8Array(64).fill(3) } };
          },
        },
        chainId: "osmosis-1",
        signer: "osmo1sender",
        messages: [{
          type: "/ibc.applications.transfer.v1.MsgTransfer",
          value: {
            source_channel: "channel-750",
            token: { denom: "uusdc", amount: "1" },
            sender: "osmo1sender",
            receiver: "pfm",
            timeout_timestamp: 5n,
          },
        }],
        feeAmount: fee("osmosis-1", GAS.hook),
        lcd: "https://lcd.example",
        onSubmitted(hash) { progress.push(hash); },
        wait: { now: () => 0, sleep: async () => { polls += 1; }, timeoutMs: 1000, intervalMs: 100 },
        fetchImpl: async (url, init) => {
          if (String(url).includes("/accounts/")) {
            return { ok: true, json: async () => ({ account: { account_number: "1", sequence: "0" } }) };
          }
          if (init?.method === "POST") {
            return {
              ok: true,
              json: async () => ({
                tx_response: { code: 1, raw_log: "error handling packet: see events for details" },
              }),
            };
          }
          polls += 1;
          return { ok: true, json: async () => ({ tx_response: { code: 0, height: "1", raw_log: "" } }) };
        },
      }),
      /The transaction failed \(1\)\. error handling packet: see events for details/,
    );
    assert.equal(polls, 0);
    assert.deepEqual(progress, []);
  });

  it("keeps an event reason from a checked failure", async () => {
    let now = 0;
    const seen = [];
    await assert.rejects(
      () => signAndBroadcast({
        keplr: keplr(),
        chainId: "osmosis-1",
        signer: "osmo1sender",
        messages: [{
          type: "/ibc.applications.transfer.v1.MsgTransfer",
          value: {
            source_channel: "channel-750",
            token: { denom: "uusdc", amount: "1" },
            sender: "osmo1sender",
            receiver: "pfm",
            timeout_timestamp: 5n,
          },
        }],
        feeAmount: fee("osmosis-1", GAS.hook),
        lcd: "https://lcd.example",
        onSubmitted(hash) { seen.push(hash); },
        wait: { now: () => now, sleep: async (ms) => { now += ms; }, timeoutMs: 1000, intervalMs: 100 },
        fetchImpl: async (url, init) => {
          if (String(url).includes("/accounts/")) {
            return { ok: true, json: async () => ({ account: { account_number: "1", sequence: "0" } }) };
          }
          if (init?.method === "POST") {
            return { ok: true, json: async () => ({ tx_response: { code: 0, txhash: "AB".repeat(32), raw_log: "" } }) };
          }
          return {
            ok: true,
            json: async () => ({
              tx_response: {
                code: 1,
                height: "12",
                raw_log: "error handling packet: see events for details",
                events: [{ type: "error", attributes: [{ key: "ZXJyb3I=", value: "aW52YWxpZCByZWNlaXZlcg==" }] }],
              },
            }),
          };
        },
      }),
      /The transaction failed \(1\)\. error handling packet: see events for details invalid receiver/,
    );
    assert.equal(seen.length, 1);
    assert.match(seen[0], /^[0-9A-F]+$/);
  });
});

describe("local injective signature", () => {
  const body = new Uint8Array([1, 2, 3]);
  const auth = new Uint8Array([4, 5]);

  it("hashes the direct sign doc with keccak256", () => {
    const raw = directSignBytes(body, auth, "injective-1", "8");
    const digest = directSignDigest(body, auth, "injective-1", "8");
    assert.equal(Buffer.from(digest).equals(Buffer.from(keccak_256(raw))), true);
    assert.equal(Buffer.from(keccak_256(raw)).equals(Buffer.from(sha256(raw))), false);
  });

  it("broadcasts the signed bytes and stops when the account is missing", async () => {
    let now = 0;
    let posted = null;
    let digest = null;
    const result = await signAndBroadcastLocal({
      chainId: "injective-1",
      signer: "inj1hop",
      messages: [{
        type: "/ibc.applications.transfer.v1.MsgTransfer",
        value: {
          source_channel: "channel-494",
          token: { denom: "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a", amount: "5" },
          sender: "inj1hop",
          receiver: "penumbra1qq",
          timeout_timestamp: 9n,
        },
      }],
      feeAmount: fee("injective-1", GAS.deposit),
      lcd: "https://lcd.injective.network",
      pubKey: new Uint8Array(33).fill(2),
      signDigest: async (value) => {
        digest = value;
        return new Uint8Array(65).fill(6);
      },
      wait: { now: () => now, sleep: async (ms) => { now += ms; }, timeoutMs: 1000, intervalMs: 100 },
      fetchImpl: async (url, init) => {
        if (String(url).includes("/accounts/")) {
          return { ok: true, json: async () => ({ account: { base_account: { account_number: "4", sequence: "1" } } }) };
        }
        if (init?.method === "POST") {
          posted = JSON.parse(init.body);
          return { ok: true, json: async () => ({ tx_response: { code: 0, txhash: "AB".repeat(32), raw_log: "" } }) };
        }
        return { ok: true, json: async () => ({ tx_response: { code: 0, height: "9", raw_log: "" } }) };
      },
    });
    assert.equal(result.hash, "AB".repeat(32));
    assert.equal(digest.length, 32);
    assert.equal(posted.mode, "BROADCAST_MODE_SYNC");
    assert.equal(typeof posted.tx_bytes, "string");
    await assert.rejects(
      () => signAndBroadcastLocal({
        chainId: "injective-1",
        signer: "inj1missing",
        messages: [{
          type: "/cosmos.bank.v1beta1.MsgSend",
          value: { from_address: "inj1missing", to_address: "inj1other", amount: [{ denom: "inj", amount: "1" }] },
        }],
        feeAmount: fee("injective-1", GAS.deposit),
        lcd: "https://lcd.injective.network",
        pubKey: new Uint8Array(33).fill(2),
        signDigest: async () => new Uint8Array(65),
        wait: { now: () => 0, sleep: async () => {}, timeoutMs: 1, intervalMs: 1 },
        fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      }),
      /has not been created/,
    );
  });
});
