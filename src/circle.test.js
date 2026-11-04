import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OSMOSIS_USDC_DENOM } from "./route.js";
import { encodeMessage } from "./tx.js";
import {
  AVALANCHE_DOMAIN,
  AVALANCHE_MESSAGE_TRANSMITTER_V1,
  AVALANCHE_TOKEN_MESSENGER_V2,
  INJECTIVE_DOMAIN,
  INJECTIVE_MESSAGE_TRANSMITTER_V2,
  ORBITER,
  bytesToBase64,
  cctpMessageHash,
  irisAttestationUrl,
  nobleBurnMessage,
  orbiterMemo,
  readIris,
  selfRelayLegs,
  zeroBytes32,
} from "./circle.js";

const mint = "0x1111111111111111111111111111111111111111";

describe("orbiter memo", () => {
  it("burns to Avalanche with a zero caller and no fee action", () => {
    const memo = JSON.parse(orbiterMemo(mint));
    assert.equal("pre_actions" in memo.orbiter, false);
    const forwarding = memo.orbiter.forwarding;
    assert.equal(forwarding.protocol_id, "PROTOCOL_CCTP");
    assert.equal(forwarding.passthrough_payload, "");
    assert.equal(forwarding.attributes["@type"], "/noble.orbiter.controller.forwarding.v1.CCTPAttributes");
    assert.equal(forwarding.attributes.destination_domain, AVALANCHE_DOMAIN);
    assert.equal(forwarding.attributes.destination_domain === INJECTIVE_DOMAIN, false);
    assert.equal("destination_caller" in forwarding.attributes, false);
    assert.equal(forwarding.attributes.mint_recipient.length > 0, true);
    assert.throws(() => orbiterMemo("not-an-address"), /mint recipient/);
  });

  it("signs one Noble burn and leaves the gas fee", () => {
    const message = nobleBurnMessage("noble1user", "960000", mint);
    assert.equal(message.type, "/circle.cctp.v1.MsgDepositForBurn");
    assert.equal(message.value.destination_domain, AVALANCHE_DOMAIN);
    assert.equal("destination_caller" in message.value, false);
    const encoded = encodeMessage(message);
    const text = new TextDecoder().decode(encoded.value);
    assert.equal(text.includes("noble1user"), true);
    assert.equal(text.includes("960000"), true);
    assert.equal(text.includes("uusdc"), true);
    assert.throws(() => nobleBurnMessage("osmo1user", "1", mint), /not signed by the Noble account/);
  });

  it("names each self-relayed leg and does not send it", () => {
    const legs = selfRelayLegs(mint, "1000000");
    assert.equal(legs.length, 6);
    assert.equal(legs[0].detail.receiver, ORBITER);
    assert.equal(legs[0].detail.source_channel, "channel-750");
    assert.equal(legs[0].detail.token.denom, OSMOSIS_USDC_DENOM);
    assert.equal(JSON.stringify(legs[0].detail).includes("pre_actions"), false);
    assert.equal(legs[3].detail.to, AVALANCHE_MESSAGE_TRANSMITTER_V1);
    assert.equal(legs[4].detail.to, AVALANCHE_TOKEN_MESSENGER_V2);
    assert.equal(legs[4].detail.destinationDomain, INJECTIVE_DOMAIN);
    assert.equal(legs[4].detail.destinationCaller, bytesToBase64(zeroBytes32()));
    assert.equal(legs[4].detail.maxFee, "0");
    assert.equal(legs[4].detail.minFinalityThreshold, 2000);
    assert.equal(legs[5].detail.to, INJECTIVE_MESSAGE_TRANSMITTER_V2);
    const flat = JSON.stringify(legs);
    assert.equal(flat.includes("api.skip.build"), false);
    assert.equal(flat.includes("1776"), false);
    assert.equal(flat.includes("ACTION_FEE"), false);
  });

  it("reads an Iris attestation and refuses one that is not ready", async () => {
    const message = Uint8Array.of(0xab, 0xcd);
    const hash = cctpMessageHash(message);
    assert.equal(irisAttestationUrl(hash), `https://iris-api.circle.com/v1/attestations/${hash}`);
    const ready = await readIris(async () => ({
      ok: true,
      json: async () => ({ status: "complete", attestation: "0x02" }),
    }), message);
    assert.equal(ready.message, "0xabcd");
    assert.equal(ready.attestation, "0x02");
    await assert.rejects(
      () => readIris(async () => ({ ok: false, json: async () => ({}) }), message),
      /not attested/,
    );
    await assert.rejects(
      () => readIris(async () => ({
        ok: true,
        json: async () => ({ status: "pending_confirmations", attestation: "PENDING" }),
      }), message),
      /not attested/,
    );
  });
});
