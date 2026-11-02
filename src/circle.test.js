import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OSMOSIS_USDC_DENOM, RELEASE_DENOM } from "./route.js";
import { ORBITER, assertCircleRoute, assertOsmosisCircleRoute, circleMessages, osmosisTransfer } from "./circle.js";

const mint = "AAAAAAAAAAAAAAAAga8VDSpX1SZ/mDgerSSO7C9jhW8=";
const caller = "AAAAAAAAAAAAAAAA+XAYmOelQwKNR6ORO8GRyuc3EzQ=";
const signer = "noble1dyw0geqa2cy0ppdjcxfpzusjpwmq85r5a35hqe";

function route(overrides = {}) {
  return {
    does_swap: false,
    swap_venues: [],
    txs_required: 1,
    operations: [
      { cctp_transfer: { from_chain_id: "noble-1", burn_token: "uusdc" } },
      { cctp_transfer_v2: { to_chain_id: "1776", denom_out: RELEASE_DENOM } },
    ],
    ...overrides,
  };
}

function body(type = "/circle.cctp.v1.MsgDepositForBurnWithCaller") {
  return {
    txs: [{
      cosmos_tx: {
        chain_id: "noble-1",
        signer_address: signer,
        msgs: [
          {
            msg_type_url: type,
            msg: JSON.stringify({
              from: signer,
              amount: "980000",
              destination_domain: 1,
              mint_recipient: mint,
              burn_token: "uusdc",
              destination_caller: caller,
            }),
          },
          {
            msg_type_url: "/cosmos.bank.v1beta1.MsgSend",
            msg: JSON.stringify({
              from_address: signer,
              to_address: signer,
              amount: [{ denom: "uusdc", amount: "20000" }],
            }),
          },
        ],
      },
    }],
  };
}

describe("circle", () => {
  it("accepts a burn that does not swap and returns the noble messages", () => {
    assert.equal(assertCircleRoute(route()).txs_required, 1);
    const tx = circleMessages(body());
    assert.equal(tx.chainId, "noble-1");
    assert.equal(tx.signer, signer);
    assert.equal(tx.messages.length, 2);
    assert.equal(tx.messages[0].type, "/circle.cctp.v1.MsgDepositForBurnWithCaller");
    assert.equal(tx.messages[0].value.mint_recipient, mint);
    assert.equal(tx.messages[0].value.amount, "980000");
    assert.equal(tx.messages[1].value.amount[0].denom, "uusdc");
  });

  it("refuses a swap, an unknown message, and a second signature", () => {
    assert.throws(() => assertCircleRoute(route({ does_swap: true })), /route swaps/);
    assert.throws(() => assertCircleRoute(route({ swap_venues: [{ name: "osmosis" }] })), /route swaps/);
    assert.throws(
      () => assertCircleRoute(route({ operations: [{ swap: { pool: "1" } }] })),
      /not a Circle burn/,
    );
    assert.throws(() => assertCircleRoute(route({ txs_required: 2 })), /more than one signature/);
    assert.throws(
      () => assertCircleRoute(route({
        operations: [
          { cctp_transfer: { from_chain_id: "noble-1", burn_token: "uusdc" } },
          { cctp_transfer_v2: { to_chain_id: "1776", denom_out: "0xother" } },
        ],
      })),
      /does not issue USDC/,
    );
    const osmosis = route({
      operations: [
        {
          transfer: {
            from_chain_id: "osmosis-1",
            to_chain_id: "noble-1",
            channel: "channel-750",
            denom_in: OSMOSIS_USDC_DENOM,
            denom_out: "uusdc",
          },
        },
        ...route().operations,
      ],
    });
    assert.equal(assertOsmosisCircleRoute(osmosis).txs_required, 1);
    const memo = JSON.stringify({
      orbiter: { forwarding: { protocol_id: "PROTOCOL_CCTP", attributes: { destination_domain: 1 } } },
    });
    const transfer = {
      txs: [{
        cosmos_tx: {
          chain_id: "osmosis-1",
          signer_address: "osmo1user",
          msgs: [{
            msg_type_url: "/ibc.applications.transfer.v1.MsgTransfer",
            msg: JSON.stringify({
              source_channel: "channel-750",
              token: { denom: OSMOSIS_USDC_DENOM, amount: "1000000" },
              sender: "osmo1user",
              receiver: ORBITER,
              memo,
            }),
          }],
        },
      }],
    };
    assert.equal(osmosisTransfer(transfer, "osmo1user", "1000000").value.receiver, ORBITER);
    transfer.txs[0].cosmos_tx.msgs[0].msg = JSON.stringify({
      source_channel: "channel-750",
      token: { denom: OSMOSIS_USDC_DENOM, amount: "1000000" },
      sender: "osmo1user",
      receiver: "noble1user",
      memo,
    });
    assert.throws(() => osmosisTransfer(transfer, "osmo1user", "1000000"), /does not burn on arrival/);
    const unknown = body("/cosmos.bank.v1beta1.MsgMultiSend");
    assert.throws(() => circleMessages(unknown), /will not sign/);
    const paid = body();
    paid.txs[0].cosmos_tx.msgs[1].msg = JSON.stringify({
      from_address: signer,
      to_address: signer,
      amount: [{ denom: "uosmo", amount: "1" }],
    });
    assert.throws(() => circleMessages(paid), /burn fee is not USDC/);
    assert.throws(() => circleMessages({ txs: [] }), /not one Noble transaction/);
  });
});
