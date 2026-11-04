import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ORBITER, bytesToBase64, ethereumBytes32, orbiterMemo } from "./circle.js";
import { RELAY_GAS } from "./evm.js";
import { INJ_ON_OSMOSIS, INJ_USDC_DENOM, OSMOSIS_USDC_DENOM, WAVAX_ON_OSMOSIS } from "./route.js";
import { GAS, fee } from "./tx.js";
import { performStep, returnOsmosisToPenumbra, routesFromExactOut, walkMigration } from "./walk.js";

const INJ_FEE = fee("injective-1", GAS.deposit).amount;


function readVarint(bytes, offset) {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < bytes.length) {
    const byte = bytes[cursor];
    cursor += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset: cursor };
    shift += 7n;
    if (shift > 70n) break;
  }
  throw new Error("A protobuf field was cut off.");
}

function readFields(bytes) {
  const fields = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    offset = key.offset;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (wire === 0) {
      const body = readVarint(bytes, offset);
      offset = body.offset;
      fields.push({ field, wire, value: body.value });
      continue;
    }
    if (wire !== 2) throw new Error(`A protobuf field used wire ${wire}.`);
    const length = readVarint(bytes, offset);
    offset = length.offset;
    const end = offset + Number(length.value);
    fields.push({ field, wire, value: bytes.subarray(offset, end) });
    offset = end;
  }
  return fields;
}

function textField(fields, field) {
  const found = fields.find((item) => item.field === field && item.wire === 2);
  if (!found) throw new Error(`Protobuf field ${field} is missing.`);
  return new TextDecoder().decode(found.value);
}

function transferMessage(body) {
  const packed = readFields(body).filter((item) => item.field === 1);
  assert.equal(packed.length, 1);
  const any = readFields(packed[0].value);
  assert.equal(textField(any, 1), "/ibc.applications.transfer.v1.MsgTransfer");
  const value = any.find((item) => item.field === 2);
  return readFields(value.value);
}

function indexOfBytes(haystack, needle) {
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
}

function key(address, denom) {
  return `${address}|${denom}`;
}

function response(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function harness(seed, options = {}) {
  const balances = new Map(Object.entries(seed));
  const sends = [];
  const bodies = [];
  const sleeps = [];
  const urls = [];
  let now = 1_000_000;
  let penumbra = options.penumbra ?? "0";
  let nobleHeld = options.noble ?? "0";
  let wiped = 0;
  const io = {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    random: options.random || (() => 0),
    intervalMs: 1000,
    ibcTimeoutMs: 5000,
    cctpTimeoutMs: 5000,
    txTimeoutMs: 5000,
    fetch: async (url, init) => {
      const text = String(url);
      urls.push(text);
      if (
        text.includes("api.skip.build")
        || text.includes("/v2/fungible/")
        || text.includes("/v2/tx/track")
      ) {
        throw new Error(`Skip is not used. ${text}`);
      }
      if (text.includes("/cosmos/auth/v1beta1/accounts/")) {
        return response({ account: { account_number: "1", sequence: "0" } });
      }
      if (init?.method === "POST" && text.includes("/cosmos/tx/v1beta1/txs")) {
        const chainId = text.includes("osmosis") ? "osmosis-1"
          : text.includes("noble") ? "noble-1"
          : text.includes("injective") ? "injective-1"
          : "";
        sends.push(chainId);
        io.onSend?.(chainId, balances, sends.length);
        return response({ tx_response: { code: 0, txhash: "AB".repeat(32), raw_log: "" } });
      }
      if (text.includes("/cosmos/tx/v1beta1/txs/")) {
        return response(options.txResult || { tx_response: { code: 0, height: "8", raw_log: "" } });
      }
      if (text.includes("/cosmos/bank/v1beta1/balances/")) {
        const parsed = new URL(text);
        const address = parsed.pathname.split("/")[5];
        const denom = parsed.searchParams.get("denom");
        return response({ balance: { denom, amount: balances.get(key(address, denom)) || "0" } });
      }
      if (text.includes("/router/quote")) return response(options.quote || exactOut("80", "10"));
      if (text.includes("api.avax.network")) {
        let method = "";
        try { method = JSON.parse(init?.body || "{}").method || ""; } catch { method = ""; }
        const result = method === "eth_gasPrice" ? "0x2"
          : method === "eth_getBalance" ? (options.avaxBalance || "0x0")
          : method === "eth_estimateGas" ? "0x10"
          : method === "eth_getTransactionCount" ? "0x0"
          : method === "eth_sendRawTransaction" ? `0x${"cd".repeat(32)}`
          : "0x1";
        return response({ jsonrpc: "2.0", id: 1, result });
      }
      if (text.includes("api.axelarscan.io")) return response("5");
      return response({}, false, 404);
    },
    keplr: {
      async getKey() {
        return { pubKey: new Uint8Array(33).fill(2) };
      },
      async signDirect(_chain, _signer, doc) {
        bodies.push(doc.bodyBytes);
        return {
          signature: { signature: new Uint8Array(64).fill(1) },
          signed: { bodyBytes: doc.bodyBytes, authInfoBytes: doc.authInfoBytes },
        };
      },
      async sendTx(chainId, _bytes, mode) {
        assert.equal(mode, "sync");
        sends.push(chainId);
        options.onSend?.(chainId, balances, sends.length);
        return new Uint8Array(32).fill(9);
      },
    },
    onSend: options.onSend,
    wipeNoted() {
      wiped += 1;
      return options.wipedKeys || 0;
    },
    penumbraUsdc: async () => {
      options.onPenumbraRead?.();
      return { amount: nobleHeld, noble: nobleHeld, inj: penumbra, decimals: 6 };
    },
    quote: options.quoteFn,
    view: options.view,
  };
  return {
    io,
    sends,
    bodies,
    sleeps,
    urls,
    balances,
    wiped: () => wiped,
    setPenumbra(amount) { penumbra = amount; },
    setNoble(amount) { nobleHeld = amount; },
    penumbra: () => penumbra,
  };
}

function assertClientBurn(text, mintRecipient) {
  assert.equal(text.includes(ORBITER), true);
  assert.equal(text.includes("PROTOCOL_CCTP"), true);
  assert.equal(text.includes('"destination_domain":1'), true);
  assert.equal(text.includes("destination_caller"), false);
  assert.equal(text.includes(bytesToBase64(ethereumBytes32(mintRecipient))), true);
  assert.equal(text.includes("pre_actions"), false);
  assert.equal(text.includes("ACTION_FEE"), false);
  assert.equal(text.includes("api.skip.build"), false);
  assert.equal(text.includes("1776"), false);
  assert.equal(text.includes("fc05ad74"), false);
  assert.equal(text.includes("noble1dyw0geqa2cy0ppdjcxfpzusjpwmq85r5a35hqe"), false);
}

function exactOut(amountIn, amountOut, denom = INJ_ON_OSMOSIS) {
  return {
    amount_in: amountIn,
    amount_out: { denom, amount: amountOut },
    route: [{ pools: [{ id: 7, token_in_denom: OSMOSIS_USDC_DENOM }] }],
  };
}

const accounts = {
  userOsmosis: "osmo1user",
  userNoble: "noble1user",
  userInj: "inj1user",
  noble: "noble1user",
  exitNoble: "noble1user",
  injLeave: "inj1user",
  avalanche: "0x1111111111111111111111111111111111111111",
  injEthereum: "0x1111111111111111111111111111111111111111",
  zafu: "penumbravault",
};

function armHeldGas(box) {
  const hop = "inj1hop";
  const avaxOut = (2n * RELAY_GAS * 5n + 5n).toString();
  box.balances.set(key("osmo1user", INJ_ON_OSMOSIS), INJ_FEE);
  box.balances.set(key("osmo1user", WAVAX_ON_OSMOSIS), avaxOut);
  box.io.issueHop = async () => ({
    keyId: "hop",
    address: hop,
    ethereum: "0x2222222222222222222222222222222222222222",
  });
  box.io.wipeKey = () => {};
  const previous = box.io.onSend;
  box.io.onSend = (chain, balances, count) => {
    if (chain === "osmosis-1" && !balances.get(key(hop, "inj"))) {
      balances.set(key(hop, "inj"), INJ_FEE);
    }
    previous?.(chain, balances, count);
  };
  return hop;
}

function osmosisInput(extra = {}) {
  return {
    osmosis: true,
    noble: false,
    penumbra: false,
    usdcInj: false,
    injGasShort: false,
    amountOut: "0",
    amountIn: "0",
    amountOsmosis: "1000000",
    slices: 1,
    intervalSec: 0,
    jitterMaxSec: 0,
    ...extra,
  };
}

describe("quote", () => {
  it("reads an exact-out quote and refuses one that does not pay INJ", () => {
    const parsed = routesFromExactOut(exactOut("80", "10"));
    assert.deepEqual(parsed.routes, [{ pool_id: 7, token_in_denom: OSMOSIS_USDC_DENOM }]);
    assert.equal(parsed.amountIn, "80");
    assert.equal(parsed.amountOut, "10");
    assert.throws(
      () => routesFromExactOut(exactOut("80", "5", "uosmo")),
      /does not pay INJ/,
    );
    assert.throws(
      () => routesFromExactOut({ amount_in: "0", amount_out: { denom: INJ_ON_OSMOSIS, amount: "1" }, route: [] }),
      /did not quote/,
    );
  });

  it("reverses an exact-out quote listed from INJ back to USDC", () => {
    const allUsdc = "factory/osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0/alloyed/allUSDC";
    const parsed = routesFromExactOut({
      amount_in: "465",
      amount_out: { denom: INJ_ON_OSMOSIS, amount: "64000000000000" },
      route: [{
        pools: [
          { id: 11, token_in_denom: allUsdc },
          { id: 9, token_in_denom: OSMOSIS_USDC_DENOM },
        ],
      }],
    });
    assert.deepEqual(parsed.routes, [
      { pool_id: 9, token_in_denom: OSMOSIS_USDC_DENOM },
      { pool_id: 11, token_in_denom: allUsdc },
    ]);
    assert.equal(parsed.amountIn, "465");
    assert.equal(parsed.amountOut, "64000000000000");
    assert.throws(
      () => routesFromExactOut({
        amount_in: "465",
        amount_out: { denom: INJ_ON_OSMOSIS, amount: "64000000000000" },
        route: [{ pools: [
          { id: 11, token_in_denom: allUsdc },
          { id: 9, token_in_denom: "uosmo" },
        ] }],
      }),
      /did not quote the INJ swap/,
    );
  });
});

describe("walk", () => {
  it("sends the Osmosis transfer with the Noble burn in the memo", async () => {
    const box = harness({
      [key("osmo1user", "uosmo")]: "100000",
      [key("osmo1user", OSMOSIS_USDC_DENOM)]: "1000000",
    });
    const ctx = {
      findings: { osmosis: true, noble: false, penumbra: false, usdcInj: false, injGasShort: false },
      amountOsmosis: "1000000",
      amountOut: "0",
      amountIn: "0",
      addresses: accounts,
    };
    const detail = await performStep({ id: "gather-osmosis" }, null, ctx, box.io);
    assert.match(detail, /carries the Noble burn/);
    assert.equal(ctx.bridgedBurn, true);
    assert.deepEqual(box.sends, ["osmosis-1"]);
    const signed = new TextDecoder().decode(box.bodies[0]);
    assert.equal(signed.includes("channel-750"), true);
    assertClientBurn(signed, accounts.avalanche);
    assert.equal(box.urls.some((url) => url.includes("api.skip.build")), false);
    const burn = await performStep({ id: "cctp-noble" }, null, ctx, box.io);
    assert.equal(burn, "The Noble burn is in the Osmosis transfer.");
    assert.deepEqual(box.sends, ["osmosis-1"]);
  });

  it("sends the live USDC balance when the tracked amount is higher", async () => {
    const box = harness({
      [key("osmo1user", "uosmo")]: "100000",
      [key("osmo1user", OSMOSIS_USDC_DENOM)]: "933429",
    });
    await performStep({ id: "gather-osmosis" }, null, {
      findings: { osmosis: true },
      amountOsmosis: "933608",
      addresses: accounts,
    }, box.io);
    const signed = new TextDecoder().decode(box.bodies[0]);
    assert.equal(signed.includes("923429"), true);
    assert.equal(signed.includes("933608"), false);
  });

  it("keeps the USDC.noble fee out of the Noble return", async () => {
    const box = harness({
      [key("osmo1user", "uosmo")]: "1",
      [key("osmo1user", OSMOSIS_USDC_DENOM)]: "933608",
    });
    const fetchImpl = box.io.fetch;
    box.io.fetch = async (url, init) => {
      if (String(url).includes("spot_price_by_denom")) {
        return response({ poolID: "1464", spot_price: "21.002132398102827266" });
      }
      return fetchImpl(url, init);
    };
    await performStep({ id: "gather-osmosis" }, null, {
      findings: { osmosis: true },
      amountOsmosis: "933608",
      addresses: accounts,
    }, box.io);
    const signed = new TextDecoder().decode(box.bodies[0]);
    assert.equal(signed.includes("923608"), true);
    assert.equal(signed.includes("933608"), false);
  });

  it("refuses a transfer whose mint recipient is not an Ethereum address", async () => {
    const box = harness({
      [key("osmo1user", "uosmo")]: "100000",
      [key("osmo1user", OSMOSIS_USDC_DENOM)]: "1000000",
    });
    await assert.rejects(
      () => performStep({ id: "gather-osmosis" }, null, {
        findings: { osmosis: true, noble: false, penumbra: false, usdcInj: false, injGasShort: false },
        amountOsmosis: "1000000",
        addresses: { ...accounts, avalanche: "", injEthereum: "" },
      }, box.io),
      /required account is not connected/,
    );
    assert.deepEqual(box.sends, []);
    assert.throws(() => orbiterMemo("noble1user"), /mint recipient/);
    assert.throws(() => orbiterMemo(""), /mint recipient/);
  });

  it("does not sign the burn when Injective does not receive the USDC", async () => {
    const box = harness({
      [key("osmo1user", "uosmo")]: "100000",
      [key("osmo1user", OSMOSIS_USDC_DENOM)]: "1000000",
    });
    armHeldGas(box);
    let wipedRun = null;
    box.io.wipeNoted = (run) => {
      wipedRun = run;
      return 0;
    };
    const views = [];
    const result = await walkMigration({
      input: osmosisInput(),
      ctx: {
        findings: osmosisInput(),
        amountOsmosis: "1000000",
        amountOut: "0",
        amountIn: "0",
        addresses: accounts,
      },
      io: box.io,
      onUpdate: (view) => views.push(view),
    });
    assert.equal(result.status, "halted");
    assert.match(result.halt.reason, /The Injective balance did not increase/);
    assert.equal(box.urls.some((url) => url.includes("iris-api.circle.com")), false);
    assert.equal(views.some((view) => view.rows.some((row) => /Waiting for the Noble burn/.test(row.detail || ""))), true);
    assert.equal(views.some((view) => view.rows.some((row) => /has not attested/.test(row.detail || ""))), false);
    assert.deepEqual(box.sends, ["osmosis-1", "osmosis-1"]);
    assert.equal(wipedRun.halt, null);
    assert.equal(views.at(-1).rows.find((row) => row.id === "cctp-forward").state, "failed");
    assert.equal(views[0].rows[0].state, "running");
  });

  it("asks Circle about the Noble receive, not the Osmosis send", async () => {
    const osmosisHash = "aa".repeat(32);
    const nobleHash = "bb".repeat(32);
    const box = harness({ [key("inj1user", INJ_USDC_DENOM)]: "0" });
    const fetchImpl = box.io.fetch;
    box.io.fetch = async (url, init) => {
      const text = String(url);
      if (text.includes("/cosmos/tx/v1beta1/txs?")) {
        box.urls.push(text);
        return response({ tx_responses: [{ txhash: nobleHash }] });
      }
      if (text.includes("iris-api.circle.com")) {
        box.urls.push(text);
        box.balances.set(key("inj1user", INJ_USDC_DENOM), "1000000");
        return response({ status: "complete", attestation: "0x01" });
      }
      if (text.endsWith(`/txs/${nobleHash}`)) {
        box.urls.push(text);
        return response({
          tx_response: {
            events: [{
              type: "circle.cctp.v1.MessageSent",
              attributes: [{ key: "message", value: JSON.stringify(btoa("\u00ab\u00cd")) }],
            }],
          },
        });
      }
      if (text.includes("/cosmos/tx/v1beta1/txs/")) {
        box.urls.push(text);
        return response({
          tx_response: {
            code: 0,
            events: [{
              type: "send_packet",
              attributes: [
                { key: "packet_src_channel", value: "channel-750" },
                { key: "packet_sequence", value: "9" },
              ],
            }],
          },
        });
      }
      return fetchImpl(url, init);
    };
    const detail = await performStep({ id: "cctp-forward" }, null, {
      findings: { osmosis: true },
      bridgedBurn: true,
      burnHash: osmosisHash,
      usdcInjBefore: "0",
      addresses: accounts,
    }, box.io);
    assert.equal(detail, "USDC.inj arrived.");
    assert.equal(box.urls.some((url) => url.includes("/v1/attestations/")), true);
    assert.equal(box.urls.some((url) => url.includes("iris-api.circle.com") && url.includes(osmosisHash)), false);
  });

  it("stops when Noble acknowledges the packet with an error", async () => {
    const osmosisHash = "aa".repeat(32);
    const nobleHash = "bb".repeat(32);
    const box = harness({ [key("inj1user", INJ_USDC_DENOM)]: "0" });
    const fetchImpl = box.io.fetch;
    box.io.fetch = async (url, init) => {
      const text = String(url);
      if (text.includes("/cosmos/tx/v1beta1/txs?")) {
        return response({ tx_responses: [{ txhash: nobleHash }] });
      }
      if (text.endsWith(`/txs/${osmosisHash}`)) {
        return response({
          tx_response: {
            events: [{
              type: "send_packet",
              attributes: [
                { key: "packet_src_channel", value: "channel-750" },
                { key: "packet_sequence", value: "4" },
              ],
            }],
          },
        });
      }
      if (text.endsWith(`/txs/${nobleHash}`)) {
        return response({
          tx_response: {
            events: [{
              type: "write_acknowledgement",
              attributes: [{ key: "packet_ack", value: JSON.stringify({ error: "malformed destination caller" }) }],
            }],
          },
        });
      }
      return fetchImpl(url, init);
    };
    await assert.rejects(
      () => performStep({ id: "cctp-forward" }, null, {
        bridgedBurn: true,
        burnHash: osmosisHash,
        usdcInjBefore: "0",
        addresses: accounts,
      }, box.io),
      /Noble did not burn the USDC\. malformed destination caller/,
    );
  });

  it("preflights and submits the Avalanche mint", async () => {
    const hash = "cc".repeat(32);
    const box = harness({
      [key("inj1hop", INJ_USDC_DENOM)]: "0",
    }, { avaxBalance: "0x1000000000000000000" });
    let raw = 0;
    const progress = [];
    const fetchImpl = box.io.fetch;
    box.io.fetch = async (url, init) => {
      const text = String(url);
      if (text.includes(`/txs/${hash}`)) {
        box.urls.push(text);
        return response({
          tx_response: {
            events: [{
              type: "circle.cctp.v1.MessageSent",
              attributes: [{ key: "message", value: JSON.stringify(btoa("\u00ab\u00cd")) }],
            }],
          },
        });
      }
      if (text.includes("iris-api.circle.com")) {
        box.urls.push(text);
        return response({ status: "complete", attestation: "0x01" });
      }
      const payload = init?.body ? JSON.parse(init.body) : null;
      const result = await fetchImpl(url, init);
      if (payload?.method === "eth_sendRawTransaction") {
        raw += 1;
        if (raw === 2) box.balances.set(key("inj1hop", INJ_USDC_DENOM), "1000000");
      }
      return result;
    };
    box.io.signDigest = async () => new Uint8Array(65);
    box.io.onProgress = (line) => progress.push(line);
    const detail = await performStep({ id: "cctp-forward" }, null, {
      findings: { osmosis: true },
      bridgedBurn: false,
      burnHash: hash,
      usdcInjBefore: "0",
      depositHop: {
        keyId: "hop",
        address: "inj1hop",
        ethereum: "0x2222222222222222222222222222222222222222",
      },
      addresses: accounts,
    }, box.io);
    assert.equal(detail, "USDC.inj arrived.");
    assert.equal(raw, 2);
    assert.equal(progress.some((line) => line.startsWith("Submitted the Avalanche mint.")), true);
    assert.equal(progress.some((line) => line.startsWith("Submitted the burn toward Injective.")), true);
    assert.equal(progress.some((line) => /has not attested/.test(line)), false);
    assert.equal(box.urls.some((url) => url.includes("api.avax.network")), true);
    assert.equal(box.urls.some((url) => url.includes("/v1/attestations/")), true);
  });

  it("does not ask the browser wallet before the ephemeral account has AVAX", async () => {
    const hash = "dd".repeat(32);
    const box = harness({ [key("inj1hop", INJ_USDC_DENOM)]: "0" });
    const fetchImpl = box.io.fetch;
    box.io.fetch = async (url, init) => {
      const text = String(url);
      if (text.includes(`/txs/${hash}`)) {
        return response({
          tx_response: {
            events: [{
              type: "circle.cctp.v1.MessageSent",
              attributes: [{ key: "message", value: "0xabcd" }],
            }],
          },
        });
      }
      if (text.includes("iris-api.circle.com")) {
        return response({ status: "complete", attestation: "0x01" });
      }
      return fetchImpl(url, init);
    };
    box.io.signDigest = async () => { throw new Error("The hop signed too early."); };
    box.io.ethereum = { request() { throw new Error("MetaMask was asked."); } };
    box.io.cctpTimeoutMs = 0;
    const progress = [];
    box.io.onProgress = (line) => progress.push(line);
    await assert.rejects(
      () => performStep({ id: "cctp-forward" }, null, {
        bridgedBurn: false,
        burnHash: hash,
        usdcInjBefore: "0",
        depositHop: {
          keyId: "hop",
          address: "inj1hop",
          ethereum: "0x2222222222222222222222222222222222222222",
        },
        addresses: accounts,
      }, box.io),
      /The Injective balance did not increase/,
    );
    assert.equal(progress.some((line) => line.includes("Waiting for AVAX on the ephemeral account.")), true);
  });

  it("burns toward Injective when the Avalanche nonce was already used", async () => {
    const hash = "ee".repeat(32);
    const box = harness({
      [key("inj1hop", INJ_USDC_DENOM)]: "0",
    }, { avaxBalance: "0x1000000000000000000" });
    let raw = 0;
    let allowance = 0n;
    const fetchImpl = box.io.fetch;
    box.io.fetch = async (url, init) => {
      const text = String(url);
      if (text.includes(`/txs/${hash}`)) {
        return response({
          tx_response: {
            events: [{
              type: "circle.cctp.v1.MessageSent",
              attributes: [{ key: "message", value: "0xabcd" }],
            }],
          },
        });
      }
      if (text.includes("iris-api.circle.com")) {
        return response({ status: "complete", attestation: "0x01" });
      }
      const payload = init?.body ? JSON.parse(init.body) : null;
      if (payload?.method === "eth_call") {
        const data = payload.params?.[0]?.data || "";
        if (data.startsWith("0x70a08231")) return response({ jsonrpc: "2.0", id: 1, result: "0x0f4240" });
        if (data.startsWith("0xdd62ed3e")) {
          return response({ jsonrpc: "2.0", id: 1, result: `0x${allowance.toString(16)}` });
        }
        return response({ jsonrpc: "2.0", id: 1, error: { message: "execution reverted: Nonce already used" } });
      }
      const result = await fetchImpl(url, init);
      if (payload?.method === "eth_sendRawTransaction") {
        raw += 1;
        if (raw === 1) allowance = 1000000n;
        if (raw === 2) box.balances.set(key("inj1hop", INJ_USDC_DENOM), "1000000");
      }
      return result;
    };
    box.io.signDigest = async () => new Uint8Array(65);
    const progress = [];
    box.io.onProgress = (line) => progress.push(line);
    const detail = await performStep({ id: "cctp-forward" }, null, {
      bridgedBurn: false,
      burnHash: hash,
      usdcInjBefore: "0",
      depositHop: {
        keyId: "hop",
        address: "inj1hop",
        ethereum: "0x2222222222222222222222222222222222222222",
      },
      addresses: accounts,
    }, box.io);
    assert.equal(detail, "USDC.inj arrived.");
    assert.equal(raw, 2);
    assert.equal(progress.some((line) => line.includes("The Avalanche mint is already in.")), true);
    assert.equal(progress.some((line) => line.startsWith("Submitted the burn toward Injective.")), true);
  });

  it("buys the full fee for a new account and bridges the INJ the swap gained", async () => {
    let osmosisSends = 0;
    const ctx = {
      findings: { osmosis: true, noble: false, penumbra: false, usdcInj: false, injGasShort: true },
      amountOsmosis: "1000000",
      amountOut: "0",
      amountIn: "0",
      addresses: accounts,
    };
    const hop = "inj1hop";
    const box = harness({
      [key("osmo1user", "uosmo")]: "100000",
      [key("osmo1user", OSMOSIS_USDC_DENOM)]: "1000000",
      [key("osmo1user", INJ_ON_OSMOSIS)]: "3",
      [key("inj1user", "inj")]: "1",
    }, {
      onSend(chain, balances) {
        if (chain !== "osmosis-1") return;
        osmosisSends += 1;
        balances.set(key("osmo1user", OSMOSIS_USDC_DENOM), "999600");
        balances.set(key(hop, "inj"), INJ_FEE);
      },
      quoteFn: async (amount, denom) => {
        if (denom === WAVAX_ON_OSMOSIS) {
          assert.equal(amount, (2n * RELAY_GAS * 5n + 5n).toString());
          return exactOut("40", amount, denom);
        }
        assert.equal(amount, INJ_FEE);
        return exactOut("81", amount);
      },
    });
    box.io.issueHop = async () => ({
      keyId: "hop",
      address: hop,
      ethereum: "0x2222222222222222222222222222222222222222",
    });
    box.io.wipeKey = () => {};
    const detail = await performStep({ id: "gas-osmosis" }, null, ctx, box.io);
    assert.match(detail, /INJ arrived/);
    assert.match(detail, /Axelar relays the AVAX/);
    assert.deepEqual(box.sends, ["osmosis-1"]);
    assert.equal(ctx.amountOsmosis, "999600");
    assert.equal(ctx.depositHop.address, hop);
    const body = new TextDecoder().decode(box.bodies[0]);
    assert.equal(body.includes("/osmosis.poolmanager.v1beta1.MsgSwapExactAmountOut"), true);
    assert.equal(body.includes(OSMOSIS_USDC_DENOM), true);
    assert.equal(body.includes("81"), true);
    assert.equal(body.includes(INJ_ON_OSMOSIS), true);
    assert.equal(body.includes("channel-122"), true);
    assert.equal(body.includes(hop), true);
    assert.equal(body.includes("inj1user"), false);
    assert.equal(body.includes(INJ_FEE), true);
    assert.equal(body.includes("channel-208"), true);
    assert.equal(body.includes("avalanche"), true);
    assert.equal(body.includes(WAVAX_ON_OSMOSIS), true);
    assert.equal(body.includes("2222222222222222222222222222222222222222"), false);
  });

  it("moves only the quoted USDC from Noble when Osmosis cannot cover it", async () => {
    let osmosisSends = 0;
    const ctx = {
      findings: { osmosis: true, noble: true, penumbra: false, usdcInj: false, injGasShort: true },
      amountOsmosis: "10",
      amountOut: "0",
      amountIn: "1000000",
      addresses: accounts,
    };
    const box = harness({
      [key("noble1user", "uusdc")]: "1000000",
      [key("osmo1user", "uosmo")]: "100000",
      [key("osmo1user", OSMOSIS_USDC_DENOM)]: "10",
      [key("osmo1user", INJ_ON_OSMOSIS)]: "3",
      [key("inj1user", "inj")]: "0",
    }, {
      onSend(chain, balances) {
        if (chain === "noble-1") balances.set(key("osmo1user", OSMOSIS_USDC_DENOM), "130");
        if (chain === "osmosis-1") {
          osmosisSends += 1;
          balances.set(key("osmo1user", OSMOSIS_USDC_DENOM), "20");
          balances.set(key("inj1hop", "inj"), INJ_FEE);
        }
      },
      quoteFn: async (amount, denom) => {
        if (denom === WAVAX_ON_OSMOSIS) return exactOut("40", amount, denom);
        return exactOut("80", amount);
      },
    });
    const hop = "inj1hop";
    box.io.issueHop = async () => ({
      keyId: "hop",
      address: hop,
      ethereum: "0x2222222222222222222222222222222222222222",
    });
    box.io.wipeKey = () => {};
    const detail = await performStep({ id: "gas-osmosis" }, null, ctx, box.io);
    assert.match(detail, /INJ arrived/);
    assert.deepEqual(box.sends, ["noble-1", "osmosis-1"]);
    assert.equal(ctx.amountIn, "999880");
    assert.equal(ctx.amountOsmosis, "20");
    const moved = new TextDecoder().decode(box.bodies[0]);
    const bridged = new TextDecoder().decode(box.bodies[1]);
    assert.equal(moved.includes("channel-1"), true);
    assert.equal(moved.includes("120"), true);
    assert.equal(bridged.includes(hop), true);
    assert.equal(bridged.includes("channel-122"), true);
    assert.equal(bridged.includes("channel-208"), true);
  });

  it("does not spend unselected Osmosis USDC on the fee", async () => {
    const box = harness({
      [key("osmo1user", "uosmo")]: "100000",
      [key("osmo1user", OSMOSIS_USDC_DENOM)]: "1000000",
      [key("inj1user", "inj")]: "0",
    }, {
      quoteFn: async (shortfall) => exactOut("80", shortfall),
    });
    const ctx = {
      findings: { osmosis: true, noble: false, penumbra: false, usdcInj: false, injGasShort: true },
      amountOsmosis: "10",
      amountOut: "0",
      amountIn: "0",
      addresses: accounts,
    };
    await assert.rejects(() => performStep({ id: "gas-osmosis" }, null, ctx, box.io), /cannot buy the Injective fee/);
    assert.deepEqual(box.sends, []);
    assert.equal(ctx.amountOsmosis, "10");
  });

  it("stops a bad INJ quote before anything is signed", async () => {
    const urls = [];
    const box = harness({
      [key("osmo1user", "uosmo")]: "100000",
      [key("osmo1user", OSMOSIS_USDC_DENOM)]: "1000000",
      [key("inj1user", "inj")]: "0",
    }, {
      quote: exactOut("80", "5", "uosmo"),
    });
    const fetchImpl = box.io.fetch;
    box.io.fetch = async (url, init) => {
      urls.push(String(url));
      return fetchImpl(url, init);
    };
    const ctx = {
      findings: { osmosis: true, noble: true, penumbra: false, usdcInj: false, injGasShort: true },
      amountOsmosis: "1000000",
      amountOut: "0",
      amountIn: "1000000",
      addresses: accounts,
    };
    await assert.rejects(() => performStep({ id: "gas-osmosis" }, null, ctx, box.io), /does not pay INJ/);
    assert.deepEqual(box.sends, []);
    const quoteUrl = urls.find((url) => url.includes("/router/quote"));
    assert.equal(quoteUrl.includes(`tokenOut=${INJ_FEE}${encodeURIComponent(INJ_ON_OSMOSIS)}`) || quoteUrl.includes(`tokenOut=${INJ_FEE}${INJ_ON_OSMOSIS}`), true);
    assert.equal(quoteUrl.includes("tokenInDenom="), true);
    assert.equal(quoteUrl.includes("singleRoute=true"), true);
  });

  it("bridges INJ and AVAX already on Osmosis without swapping", async () => {
    const hop = "inj1hop";
    const avaxOut = (2n * RELAY_GAS * 5n + 5n).toString();
    const box = harness({
      [key("osmo1user", "uosmo")]: "100000",
      [key("osmo1user", OSMOSIS_USDC_DENOM)]: "1000000",
      [key("osmo1user", INJ_ON_OSMOSIS)]: INJ_FEE,
      [key("osmo1user", WAVAX_ON_OSMOSIS)]: avaxOut,
      [key("inj1user", "inj")]: INJ_FEE,
    }, {
      quoteFn: async () => { throw new Error("quoted"); },
      onSend(chain, balances) {
        if (chain === "osmosis-1") balances.set(key(hop, "inj"), INJ_FEE);
      },
    });
    box.io.issueHop = async () => ({
      keyId: "hop",
      address: hop,
      ethereum: "0x2222222222222222222222222222222222222222",
    });
    box.io.wipeKey = () => {};
    const detail = await performStep({ id: "gas-osmosis" }, null, {
      findings: { osmosis: true, noble: false, penumbra: false, usdcInj: false, injGasShort: false },
      amountOsmosis: "1000000",
      addresses: accounts,
    }, box.io);
    assert.match(detail, /INJ arrived/);
    assert.equal(box.sends.length, 1);
    const body = new TextDecoder().decode(box.bodies[0]);
    assert.equal(body.includes("MsgSwap"), false);
    assert.equal(body.includes("channel-122"), true);
    assert.equal(body.includes(hop), true);
    assert.equal(body.includes("channel-208"), true);
  });

  it("stops before a quote when Osmosis cannot pay the swap", async () => {
    let quoted = false;
    const box = harness({
      [key("osmo1user", OSMOSIS_USDC_DENOM)]: "1000000",
      [key("inj1user", "inj")]: "0",
    }, {
      quoteFn: async (shortfall) => {
        quoted = true;
        return exactOut("80", shortfall);
      },
    });
    await assert.rejects(() => performStep({ id: "gas-osmosis" }, null, {
      findings: { osmosis: true, noble: false, penumbra: false, usdcInj: false, injGasShort: true },
      amountOsmosis: "1000000",
      addresses: accounts,
    }, box.io), /Osmosis gas is short/);
    assert.equal(quoted, false);
    assert.deepEqual(box.sends, []);
  });

  it("acknowledges an empty Osmosis return without a signature", async () => {
    const box = harness({});
    const detail = await performStep({ id: "gather-osmosis" }, null, {
      findings: { osmosis: true },
      amountOsmosis: "0",
      addresses: accounts,
    }, box.io);
    assert.equal(detail, "Osmosis USDC was used for the Injective fee.");
    assert.deepEqual(box.sends, []);
  });

  it("joins receipts that are already on the Noble account without a signature", async () => {
    const box = harness({});
    const detail = await performStep({ id: "gather-exit" }, null, {
      findings: { penumbra: true, noble: true },
      amountOut: "5",
      addresses: accounts,
    }, box.io);
    assert.equal(detail, "The receipts are already on the Noble account.");
    assert.deepEqual(box.sends, []);
  });

  it("asks Zafu until the Penumbra balance increases", async () => {
    let reads = 0;
    const seen = [];
    const box = harness({
      [key("inj1user", "inj")]: "100000000000000",
      [key("inj1user", INJ_USDC_DENOM)]: "1500000",
    }, {
      penumbra: "1000000",
      onPenumbraRead() {
        reads += 1;
        if (reads >= 3) box.setPenumbra("2500000");
      },
    });
    box.io.onProgress = (detail) => seen.push(detail);
    const detail = await performStep({ id: "deposit" }, null, {
      findings: { osmosis: true, noble: false, penumbra: false, usdcInj: false, injGasShort: false },
      amountOsmosis: "1500000",
      amountOut: "0",
      amountIn: "0",
      arrivedInj: "1500000",
      addresses: accounts,
    }, box.io);
    assert.deepEqual(box.sends, ["injective-1"]);
    assert.match(seen[0], /Submitted [0-9A-F]+\. Waiting for Injective\./);
    assert.match(seen.find((line) => line.startsWith("Asking Zafu")) || "", /Asking Zafu\. Penumbra USDC\.inj is 1 USDC\.inj\./);
    assert.match(detail, /Penumbra holds 2\.5 USDC\.inj, up from 1 USDC\.inj\./);
  });

  it("walks an Osmosis balance through the burn and one deposit", async () => {
    const box = harness({
      [key("osmo1user", "uosmo")]: "100000",
      [key("osmo1user", OSMOSIS_USDC_DENOM)]: "1000000",
      [key("inj1user", "inj")]: "100000000000000",
    }, {
      onSend(chain, balances, count) {
        if (chain === "osmosis-1" && count === 2) balances.set(key("inj1hop", INJ_USDC_DENOM), "500000");
        if (chain === "injective-1") box.setPenumbra("1");
      },
    });
    armHeldGas(box);
    box.io.signHop = async () => {
      box.sends.push("injective-1");
      box.setPenumbra("1");
      return { hash: "ABCD" };
    };
    const views = [];
    const result = await walkMigration({
      input: osmosisInput(),
      ctx: {
        findings: osmosisInput(),
        amountOsmosis: "1000000",
        amountOut: "0",
        amountIn: "0",
        addresses: accounts,
      },
      io: box.io,
      onUpdate: (view) => views.push(view.status),
    });
    assert.equal(result.status, "done");
    assert.deepEqual(box.sends, ["osmosis-1", "osmosis-1", "injective-1"]);
    const burnBody = box.bodies.map((body) => new TextDecoder().decode(body)).find((text) => text.includes("PROTOCOL_CCTP"));
    assertClientBurn(burnBody, "0x2222222222222222222222222222222222222222");
    assert.equal(box.urls.some((url) => /api\.skip\.build|\/v2\/fungible\/|\/v2\/tx\/track/.test(url)), false);
    assert.equal(box.wiped(), 1);
    assert.equal(views.at(-1), "done");
    assert.equal(result.keys.noble.keyId, null);
  });

  it("burns the Noble balance minus the fee and refuses a fee the account cannot pay", async () => {
    const held = harness({
      [key("noble1user", "uusdc")]: "1000000",
    });
    const burned = await performStep({ id: "cctp-noble" }, null, {
      findings: { noble: true, osmosis: false, penumbra: false, usdcInj: false, injGasShort: false },
      amountIn: "1000000",
      amountOut: "0",
      amountOsmosis: "0",
      addresses: accounts,
    }, held.io);
    assert.match(burned, /Circle burned/);
    const burnedBytes = held.bodies[0];
    const burnedText = new TextDecoder().decode(burnedBytes);
    assert.equal(burnedText.includes("/circle.cctp.v1.MsgDepositForBurn"), true);
    assert.equal(burnedText.includes("WithCaller"), false);
    assert.equal(burnedText.includes("960000"), true);
    assert.equal(indexOfBytes(burnedBytes, ethereumBytes32(accounts.avalanche)) >= 0, true);
    assert.equal(burnedText.includes("pre_actions"), false);
    assert.deepEqual(held.sends, ["noble-1"]);
    assert.equal(held.urls.some((url) => url.includes("api.skip.build")), false);

    const short = harness({ [key("noble1user", "uusdc")]: "40000" });
    await assert.rejects(
      () => performStep({ id: "cctp-noble" }, null, {
        findings: { noble: true, osmosis: false, penumbra: false, usdcInj: false, injGasShort: false },
        amountIn: "40000",
        amountOut: "0",
        amountOsmosis: "0",
        addresses: accounts,
      }, short.io),
      /Noble needs USDC left for the fee/,
    );
    assert.deepEqual(short.sends, []);

    const dry = harness({
      [key("osmo1user", "uosmo")]: "1",
      [key("osmo1user", OSMOSIS_USDC_DENOM)]: "1000000",
    });
    await assert.rejects(
      () => performStep({ id: "gather-osmosis" }, null, {
        findings: { osmosis: true, noble: false, penumbra: false, usdcInj: false, injGasShort: false },
        amountOsmosis: "1000000",
        addresses: accounts,
      }, dry.io),
      /Osmosis gas is short/,
    );
    assert.deepEqual(dry.sends, []);

    const dust = harness({
      [key("inj1user", "inj")]: "1",
      [key("inj1user", INJ_USDC_DENOM)]: "9",
    });
    await assert.rejects(
      () => performStep({ id: "deposit" }, null, {
        findings: { noble: false, osmosis: false, penumbra: false, usdcInj: true, injGasShort: false },
        amountIn: "9",
        amountHeld: "9",
        arrivedInj: "0",
        addresses: accounts,
      }, dust.io),
      /INJ is below the transaction fee/,
    );

    const capped = harness({
      [key("inj1user", "inj")]: "100000000000000",
      [key("inj1user", INJ_USDC_DENOM)]: "5",
    }, { onSend() { capped.setPenumbra("1"); } });
    await performStep({ id: "deposit" }, null, {
      findings: { osmosis: true, noble: false, penumbra: false, usdcInj: false, injGasShort: false },
      amountOsmosis: "9",
      amountOut: "0",
      amountIn: "0",
      arrivedInj: "9",
      addresses: accounts,
    }, capped.io);
    const signed = capped.bodies[0];
    assert.equal(new TextDecoder().decode(signed).includes("channel-494"), true);
    const five = new Uint8Array([0x12, 0x01, 0x35]);
    const nine = new Uint8Array([0x12, 0x01, 0x39]);
    assert.equal(signed.includes(five[0]) && indexOfBytes(signed, five) >= 0, true);
    assert.equal(indexOfBytes(signed, nine), -1);
  });

  it("deposits a held hop after Zafu closes the connection", async () => {
    let reads = 0;
    let reconnected = 0;
    let wiped = "";
    const box = harness({
      [key("inj1hop", "inj")]: INJ_FEE,
      [key("inj1hop", INJ_USDC_DENOM)]: "415240",
    });
    box.io.penumbraUsdc = async () => {
      reads += 1;
      if (reads === 1) throw new Error("[unavailable] Connection closed");
      return { noble: "0", inj: box.penumbra(), decimals: 6 };
    };
    box.io.reconnectZafu = async () => { reconnected += 1; };
    let signedAmount = "";
    box.io.signHop = async (request) => {
      signedAmount = request.messages[0].value.token.amount;
      box.setPenumbra("1");
      return { hash: "ABCD" };
    };
    box.io.wipeKey = (id) => { wiped = id; };
    const detail = await performStep({ id: "deposit" }, null, {
      finishHeld: true,
      findings: { penumbra: true },
      arrivedInj: "0",
      depositHop: {
        keyId: "kept",
        address: "inj1hop",
        ethereum: "0x2222222222222222222222222222222222222222",
      },
      addresses: accounts,
    }, box.io);
    assert.match(detail, /Penumbra holds 0\.000001 USDC\.inj/);
    assert.equal(reconnected, 1);
    assert.equal(wiped, "kept");
    assert.equal(signedAmount, "415240");
  });

  it("leaves on the channel Zafu names, then waits between slices", async () => {
    const plans = [];
    const asset = new Uint8Array([9]);
    const returnAddress = { inner: new Uint8Array([1]) };
    const view = {
      balances: async function* balances() {
        yield {
          balanceView: {
            valueView: {
              case: "knownAssetId",
              value: {
                metadata: {
                  symbol: "USDC",
                  base: "transfer/channel-9/uusdc",
                  penumbraAssetId: { inner: asset },
                },
              },
            },
          },
        };
      },
      async ephemeralAddress() {
        return { address: returnAddress };
      },
      async gasPrices() {
        return {
          gasPrices: { blockSpacePrice: 999999n },
          altGasPrices: [{
            assetId: { inner: asset },
            blockSpacePrice: 0n,
            compactBlockSpacePrice: 0n,
            verificationPrice: 0n,
            executionPrice: 0n,
          }],
        };
      },
      async transactionPlanner(request) {
        plans.push(request);
        return { plan: { ok: true } };
      },
      async *authorizeAndBuild() {
        yield { status: { case: "complete", value: { transaction: { raw: true } } } };
      },
      async *broadcastTransaction() {
        yield { status: { case: "broadcastSuccess", value: {} } };
      },
    };
    const unnamed = harness({}, {
      view: {
        balances: async function* balances() {
          yield {
            balanceView: {
              valueView: { case: "knownAssetId", value: { metadata: { symbol: "USDC", base: "uusdc" } } },
            },
          };
        },
        async transactionPlanner() {
          throw new Error("planner should not run");
        },
      },
    });
    await assert.rejects(
      () => performStep({ id: "leave" }, { amounts: ["1000"], sliceIndex: 0 }, {
        findings: { penumbra: true },
        addresses: accounts,
      }, unnamed.io),
      /did not name a return channel/,
    );

    const quoted = harness({}, { view, quote: exactOut("100", INJ_FEE) });
    const dropped = [];
    quoted.io.issueHop = async () => ({ keyId: "early", address: "inj1early", ethereum: "0x2222222222222222222222222222222222222222" });
    quoted.io.signHop = async () => { throw new Error("deposit should not run"); };
    quoted.io.wipeKey = (id) => dropped.push(id);
    const originalQuote = quoted.io.fetch;
    quoted.io.fetch = async (url, init) => {
      if (String(url).includes("/router/quote")) return response(exactOut("100", "10"));
      return originalQuote(url, init);
    };
    await assert.rejects(
      () => performStep({ id: "leave" }, { amounts: ["1000"], sliceIndex: 0 }, {
        findings: { penumbra: true },
        addresses: accounts,
      }, quoted.io),
      /did not quote the INJ swap/,
    );
    assert.deepEqual(dropped, ["early"]);

    const leaveQuote = async (amount, denom) => exactOut(denom === WAVAX_ON_OSMOSIS ? "40" : "100", amount, denom);
    const untimed = harness({
      [key("osmo1user", "uosmo")]: "100000",
    }, { view, quoteFn: leaveQuote });
    const wipedHeight = [];
    untimed.io.issueHop = async () => ({
      keyId: "noheight",
      address: "inj1early",
      ethereum: "0x2222222222222222222222222222222222222222",
    });
    untimed.io.signHop = async () => { throw new Error("deposit should not run"); };
    untimed.io.wipeKey = (id) => wipedHeight.push(id);
    await assert.rejects(
      () => performStep({ id: "leave" }, { amounts: ["1000"], sliceIndex: 0 }, {
        findings: { penumbra: true },
        addresses: accounts,
      }, untimed.io),
      /did not name a Noble height/,
    );
    assert.deepEqual(wipedHeight, ["noheight"]);

    const partialPlans = [];
    const partialView = {
      ...view,
      async transactionPlanner(request) {
        partialPlans.push(request);
        if (partialPlans.length > 1) throw new Error("second plan failed");
        return { plan: { ok: true } };
      },
    };
    const partial = harness({
      [key("osmo1user", "uosmo")]: "100000",
    }, { view: partialView, quoteFn: leaveQuote });
    const kept = [];
    partial.io.issueHop = async () => ({
      keyId: "partial",
      address: "inj1early",
      ethereum: "0x2222222222222222222222222222222222222222",
    });
    partial.io.signHop = async () => { throw new Error("deposit should not run"); };
    partial.io.wipeKey = (id) => kept.push(id);
    partial.io.channels = {
      async channelClientState() {
        return {
          identifiedClientState: {
            clientId: "07-tendermint-4",
            clientState: {
              unpackTo(target) {
                target.chainId = "noble-1";
                target.latestHeight = { revisionNumber: 4n, revisionHeight: 80n };
                return true;
              },
            },
          },
        };
      },
    };
    partial.io.clients = { clientStatus: async () => ({ status: "Active" }) };
    await assert.rejects(
      () => performStep({ id: "leave" }, { amounts: ["1000"], sliceIndex: 0 }, {
        findings: { penumbra: true },
        addresses: accounts,
      }, partial.io),
      /fee withdrawal was already sent/,
    );
    assert.deepEqual(kept, []);
    assert.equal(partialPlans.length, 2);
    assert.equal(partialPlans[0].ics20Withdrawals.length, 1);

    const box = harness({
      [key("osmo1user", "uosmo")]: "100000",
    }, { view, quoteFn: leaveQuote });
    const issued = [];
    const deposits = [];
    let shielded = 0n;
    box.io.issueHop = async () => {
      const hop = {
        keyId: `k${issued.length}`,
        address: `inj1hop${issued.length}`,
        ethereum: "0x2222222222222222222222222222222222222222",
      };
      issued.push(hop);
      return hop;
    };
    box.io.wipeKey = (id) => dropped.push(id);
    let askedChannel = "";
    box.io.channels = {
      async channelClientState({ channelId }) {
        askedChannel = channelId;
        return {
          identifiedClientState: {
            clientId: "07-tendermint-4",
            clientState: {
              unpackTo(target) {
                target.chainId = "noble-1";
                target.latestHeight = { revisionNumber: 4n, revisionHeight: 80n };
                return true;
              },
            },
          },
        };
      },
    };
    box.io.clients = { clientStatus: async () => ({ status: "Active" }) };
    box.io.signHop = async (request) => {
      deposits.push(request);
      shielded += 900n;
      box.setPenumbra(shielded.toString());
      return { hash: "ABCD" };
    };
    const originalBroadcast = view.broadcastTransaction;
    view.broadcastTransaction = async function* broadcast() {
      const hop = issued.at(-1);
      box.balances.set(key(hop.address, "inj"), INJ_FEE);
      box.balances.set(key(hop.address, INJ_USDC_DENOM), "900");
      yield* originalBroadcast();
    };
    const detail = await performStep({ id: "leave" }, { amounts: ["1000"], sliceIndex: 0 }, {
      findings: { penumbra: true },
      addresses: accounts,
    }, box.io);
    assert.match(detail, /Penumbra holds 0\.0009 USDC\.inj, up from 0 USDC\.inj\. ABCD/);
    assert.equal(plans.length, 2);
    assert.equal(plans[0].ics20Withdrawals.length, 1);
    assert.equal(plans[1].ics20Withdrawals.length, 1);
    assert.equal(askedChannel, "channel-9");
    const feeWithdrawal = plans[0].ics20Withdrawals[0];
    const migration = plans[1].ics20Withdrawals[0];
    assert.equal(feeWithdrawal.sourceChannel, "channel-9");
    assert.equal(feeWithdrawal.destinationChainAddress, "pfm");
    assert.equal(feeWithdrawal.amount.lo, 140n);
    assert.equal(feeWithdrawal.timeoutTime, 1560000000000n);
    assert.deepEqual(feeWithdrawal.timeoutHeight, {
      revisionNumber: 4n,
      revisionHeight: 1080n,
    });
    assert.deepEqual(migration.timeoutHeight, feeWithdrawal.timeoutHeight);
    assert.equal(migration.timeoutTime, 1560000000000n);
    assert.equal(feeWithdrawal.useTransparentAddress, true);
    assert.equal(feeWithdrawal.returnAddress, returnAddress);
    assert.equal(plans[0].feeMode.case, "autoFee");
    assert.equal(plans[0].feeMode.value.feeTier, 1);
    const buy = JSON.parse(feeWithdrawal.ics20Memo);
    assert.equal(buy.forward.channel, "channel-1");
    assert.equal(buy.forward.receiver, "osmo1user");
    assert.equal(buy.forward.next, undefined);
    assert.equal(migration.destinationChainAddress, ORBITER);
    assert.equal(migration.amount.lo, 860n);
    assert.match(migration.ics20Memo, /PROTOCOL_CCTP/);
    const burned = JSON.parse(migration.ics20Memo);
    assert.equal(burned.orbiter.forwarding.attributes.destination_domain, 1);
    assert.equal("destination_caller" in burned.orbiter.forwarding.attributes, false);
    assert.equal(
      burned.orbiter.forwarding.attributes.mint_recipient,
      bytesToBase64(ethereumBytes32("0x2222222222222222222222222222222222222222")),
    );
    assert.equal("pre_actions" in burned.orbiter, false);
    assert.equal(deposits[0].messages[0].value.token.amount, "900");
    assert.equal(deposits[0].messages[0].value.receiver, "penumbravault");
    assert.equal(deposits[0].messages[0].value.source_channel, "channel-494");
    assert.equal(dropped.includes("k0"), true);

    const result = await walkMigration({
      input: {
        penumbra: true,
        noble: false,
        osmosis: false,
        usdcInj: false,
        injGasShort: false,
        amountOut: "2000",
        amountIn: "0",
        amountOsmosis: "0",
        slices: 2,
        intervalSec: 2,
        jitterMaxSec: 0,
      },
      ctx: {
        findings: { penumbra: true, noble: false, osmosis: false, usdcInj: false, injGasShort: false },
        amountOut: "2000",
        amountIn: "0",
        amountOsmosis: "0",
        addresses: accounts,
      },
      io: box.io,
      onUpdate() {},
    });
    assert.equal(result.status, "done");
    assert.equal(box.sleeps.includes(2000), true);
    assert.equal(issued.length, 3);
    assert.notEqual(issued[1].address, issued[2].address);
    assert.equal(deposits.length, 3);
    assert.equal(box.wiped(), 1);
  });

  it("forwards a Penumbra fee slice, bridges INJ and AVAX, then relays the Noble burn", async () => {
    const plans = [];
    const asset = new Uint8Array([9]);
    const nobleHash = "bb".repeat(32);
    const hop = {
      keyId: "slice",
      address: "inj1slice",
      ethereum: "0x2222222222222222222222222222222222222222",
    };
    const view = {
      balances: async function* balances() {
        yield {
          balanceView: {
            valueView: {
              case: "knownAssetId",
              value: {
                metadata: {
                  symbol: "USDC",
                  base: "transfer/channel-9/uusdc",
                  penumbraAssetId: { inner: asset },
                },
              },
            },
          },
        };
      },
      async ephemeralAddress() {
        return { address: { inner: new Uint8Array([1]) } };
      },
      async gasPrices() {
        return {
          altGasPrices: [{
            assetId: { inner: asset },
            blockSpacePrice: 0n,
            compactBlockSpacePrice: 0n,
            verificationPrice: 0n,
            executionPrice: 0n,
          }],
        };
      },
      async transactionPlanner(request) {
        plans.push(request);
        return { plan: { ok: true } };
      },
      async *authorizeAndBuild() {
        yield { status: { case: "complete", value: { transaction: { raw: true } } } };
      },
      async *broadcastTransaction() {
        box.balances.set(key("osmo1user", OSMOSIS_USDC_DENOM), "1000");
        yield { status: { case: "broadcastSuccess", value: {} } };
      },
    };
    let raw = 0;
    const queries = [];
    const box = harness({
      [key("osmo1user", "uosmo")]: "100000",
    }, {
      view,
      avaxBalance: "0x1000000000000000000",
      quoteFn: async (amount, denom) => exactOut(denom === WAVAX_ON_OSMOSIS ? "40" : "100", amount, denom),
      onSend(chain, balances) {
        if (chain === "osmosis-1") balances.set(key(hop.address, "inj"), INJ_FEE);
      },
    });
    const fetchImpl = box.io.fetch;
    box.io.fetch = async (url, init) => {
      const text = String(url);
      if (text.includes("/cosmos/tx/v1beta1/txs?")) {
        queries.push(text);
        return response({ tx_responses: [{ txhash: nobleHash }] });
      }
      if (text.endsWith(`/txs/${nobleHash}`)) {
        return response({
          tx_response: {
            events: [{
              type: "circle.cctp.v1.MessageSent",
              attributes: [{ key: "message", value: JSON.stringify(btoa("\u00ab\u00cd")) }],
            }],
          },
        });
      }
      if (text.includes("iris-api.circle.com")) {
        return response({ status: "complete", attestation: "0x01" });
      }
      const payload = init?.body ? JSON.parse(init.body) : null;
      const result = await fetchImpl(url, init);
      if (payload?.method === "eth_sendRawTransaction") {
        raw += 1;
        if (raw === 2) box.balances.set(key(hop.address, INJ_USDC_DENOM), "860");
      }
      return result;
    };
    box.io.issueHop = async () => hop;
    box.io.wipeKey = () => {};
    box.io.signDigest = async () => new Uint8Array(65);
    box.io.signHop = async () => {
      box.setPenumbra("860");
      return { hash: "ABCD" };
    };
    box.io.channels = {
      async channelClientState() {
        return {
          identifiedClientState: {
            clientId: "07-tendermint-4",
            clientState: {
              unpackTo(target) {
                target.chainId = "noble-1";
                target.latestHeight = { revisionNumber: 4n, revisionHeight: 80n };
                return true;
              },
            },
          },
        };
      },
    };
    box.io.clients = { clientStatus: async () => ({ status: "Active" }) };
    const detail = await performStep({ id: "leave" }, { amounts: ["1000"], sliceIndex: 0 }, {
      findings: { penumbra: true },
      addresses: accounts,
    }, box.io);
    assert.match(detail, /Penumbra holds 0\.00086 USDC\.inj/);
    assert.equal(plans.length, 2);
    assert.equal(plans[0].ics20Withdrawals[0].amount.lo, 140n);
    const memo = JSON.parse(plans[0].ics20Withdrawals[0].ics20Memo);
    assert.equal(memo.forward.receiver, "osmo1user");
    assert.equal(memo.forward.next, undefined);
    assert.equal(box.sends.includes("osmosis-1"), true);
    const body = new TextDecoder().decode(box.bodies[0]);
    assert.equal(body.includes("channel-122"), true);
    assert.equal(body.includes("channel-208"), true);
    assert.equal(body.includes(hop.address), true);
    assert.equal(raw, 2);
    assert.equal(queries.some((url) => url.includes("mint_recipient")), true);
  });

  it("does not sign when the Noble account is missing", async () => {
    const box = harness({ [key("osmo1user", "uosmo")]: "100000" });
    armHeldGas(box);
    const wipedKeys = [];
    box.io.wipeKey = (id) => wipedKeys.push(id);
    const result = await walkMigration({
      input: osmosisInput(),
      ctx: {
        findings: osmosisInput(),
        amountOsmosis: "1000000",
        amountOut: "0",
        amountIn: "0",
        addresses: { ...accounts, noble: "", userNoble: "" },
      },
      io: box.io,
      onUpdate() {},
    });
    assert.equal(result.status, "halted");
    assert.match(result.halt.reason, /not connected/);
    assert.deepEqual(box.sends, ["osmosis-1"]);
    assert.deepEqual(wipedKeys, []);
  });
});

function lightClient(chainId = "noble-1") {
  return {
    view: {
      assets: () => (async function* () {
        yield { denomMetadata: { symbol: "USDC", base: "transfer/channel-4/uusdc" } };
      })(),
    },
    channels: {
      async channel() {
        return { channel: { state: 3, counterparty: { channelId: "channel-12" } } };
      },
      async channelClientState() {
        return {
          identifiedClientState: {
            clientId: "07-tendermint-1",
            clientState: {
              unpackTo(target) {
                target.chainId = chainId;
                return true;
              },
            },
          },
        };
      },
    },
    clients: { clientStatus: async () => ({ status: "Active" }) },
  };
}

describe("dev return", () => {
  it("forwards the selected Osmosis USDC on the light client's channel", async () => {
    const box = harness({
      [key("osmo1user", "uosmo")]: "100000",
      [key("osmo1user", OSMOSIS_USDC_DENOM)]: "1000000",
    }, { onSend() { box.setNoble("1000000"); } });
    const detail = await returnOsmosisToPenumbra({
      amountOsmosis: "1000000",
      addresses: { ...accounts, zafu: "penumbra1vault" },
    }, { ...box.io, ...lightClient() });
    assert.match(detail, /Penumbra holds 1 USDC\.noble, up from 0 USDC\.noble\./);
    assert.deepEqual(box.sends, ["osmosis-1"]);
    const message = transferMessage(box.bodies[0]);
    assert.equal(textField(message, 1), "transfer");
    assert.equal(textField(message, 2), "channel-750");
    const coin = readFields(message.find((item) => item.field === 3).value);
    assert.equal(textField(coin, 1), OSMOSIS_USDC_DENOM);
    assert.equal(textField(coin, 2), "990000");
    assert.equal(textField(message, 4), "osmo1user");
    assert.equal(textField(message, 5), "noble1user");
    assert.equal(message.some((item) => item.field === 6), false);
    const timeout = message.find((item) => item.field === 7);
    assert.equal(timeout.wire, 0);
    assert.equal(timeout.value > 0n, true);
    assert.deepEqual(JSON.parse(textField(message, 8)), {
      forward: {
        receiver: "penumbra1vault",
        port: "transfer",
        channel: "channel-12",
        timeout: "10m",
        retries: 2,
      },
    });
    assert.equal(message.some((item) => item.field > 8), false);
  });

  it("uses the live balance and leaves the USDC.noble fee", async () => {
    const box = harness({
      [key("osmo1user", "uosmo")]: "1",
      [key("osmo1user", OSMOSIS_USDC_DENOM)]: "933429",
    }, { onSend() { box.setNoble("1"); } });
    const fetchImpl = box.io.fetch;
    box.io.fetch = async (url, init) => {
      if (String(url).includes("spot_price_by_denom")) {
        return response({ poolID: "1464", spot_price: "21.002132398102827266" });
      }
      return fetchImpl(url, init);
    };
    await returnOsmosisToPenumbra({
      amountOsmosis: "933608",
      addresses: { ...accounts, zafu: "penumbra1vault" },
    }, { ...box.io, ...lightClient() });
    const coin = readFields(transferMessage(box.bodies[0]).find((item) => item.field === 3).value);
    assert.equal(textField(coin, 2), "923429");
  });

  it("does not sign when the light client names another chain", async () => {
    const box = harness({
      [key("osmo1user", "uosmo")]: "100000",
      [key("osmo1user", OSMOSIS_USDC_DENOM)]: "1000000",
    });
    await assert.rejects(
      () => returnOsmosisToPenumbra({
        amountOsmosis: "1000000",
        addresses: { ...accounts, zafu: "penumbra1vault" },
      }, { ...box.io, ...lightClient("osmosis-1") }),
      /did not name a Noble channel/,
    );
    assert.deepEqual(box.sends, []);
  });

  it("does not ask the light client when Osmosis gas is short", async () => {
    const box = harness({ [key("osmo1user", "uosmo")]: "0" });
    let asked = 0;
    const light = lightClient();
    const channel = light.channels.channel;
    light.channels.channel = async (request) => {
      asked += 1;
      return channel(request);
    };
    await assert.rejects(
      () => returnOsmosisToPenumbra({
        amountOsmosis: "1000000",
        addresses: { ...accounts, zafu: "penumbra1vault" },
      }, { ...box.io, ...light }),
      /Osmosis gas is short/,
    );
    assert.equal(asked, 0);
    assert.deepEqual(box.sends, []);
  });

  it("does not sign when no Noble account is connected", async () => {
    const box = harness({ [key("osmo1user", "uosmo")]: "100000" });
    let asked = 0;
    const light = lightClient();
    const channel = light.channels.channel;
    light.channels.channel = async (request) => {
      asked += 1;
      return channel(request);
    };
    await assert.rejects(
      () => returnOsmosisToPenumbra({
        amountOsmosis: "1000000",
        addresses: { ...accounts, userNoble: "", noble: "", zafu: "penumbra1vault" },
      }, { ...box.io, ...light }),
      /Noble account is not connected/,
    );
    assert.equal(asked, 0);
    assert.deepEqual(box.sends, []);
  });

  it("shows an Osmosis packet failure and does not wait on Zafu", async () => {
    const box = harness({
      [key("osmo1user", "uosmo")]: "100000",
      [key("osmo1user", OSMOSIS_USDC_DENOM)]: "1000000",
    }, {
      txResult: {
        tx_response: {
          code: 1,
          height: "11",
          raw_log: "error handling packet: see events for details",
          events: [{ type: "error", attributes: [{ key: "error", value: "invalid receiver" }] }],
        },
      },
    });
    const progress = [];
    let reads = 0;
    const light = lightClient();
    await assert.rejects(
      () => returnOsmosisToPenumbra({
        amountOsmosis: "1000000",
        addresses: { ...accounts, zafu: "penumbra1vault" },
      }, {
        ...box.io,
        ...light,
        onProgress(text) { progress.push(text); },
        penumbraUsdc: async () => {
          reads += 1;
          return { amount: "0", noble: "0", inj: "0", decimals: 6 };
        },
      }),
      (error) => {
        assert.match(error.message, /The transaction failed \(1\)/);
        assert.match(error.message, /error handling packet: see events for details/);
        assert.match(error.message, /invalid receiver/);
        assert.match(error.message, /transfer\/channel-750 to noble1user/);
        assert.match(error.message, /Osmosis still holds this USDC/);
        return true;
      },
    );
    assert.equal(reads, 1);
    assert.equal(box.sends.length, 1);
    assert.equal(progress.some((line) => /^Submitted [0-9A-F]+/.test(line) && line.includes("Waiting for Osmosis")), true);
  });
});
