// The Osmosis transfer carries a Noble Orbiter burn. The memo is built here.
// Noble's Circle module is CCTP V1, local domain 4. A read of
// /circle/cctp/v1/remote_token_messengers on 2026-11-02 listed domains
// 0, 1, 2, 3, 5, 6, 7, 8, 9, and 10. Domain 29, Injective, was not registered.
// This memo burns to Avalanche domain 1. The user relays the mint, then burns
// that USDC toward Injective domain 29 and relays that mint. No fee action.

import { keccak_256 } from "@noble/hashes/sha3";
import { ORBITER, OSMOSIS_TO_NOBLE, OSMOSIS_USDC_DENOM, USDC_NOBLE_DENOM } from "./route.js";

export { ORBITER };
export const NOBLE_DOMAIN = 4;
export const AVALANCHE_DOMAIN = 1;
export const INJECTIVE_DOMAIN = 29;
export const IRIS_MAINNET = "https://iris-api.circle.com";
export const STANDARD_FINALITY = 2000;

// Circle CCTP V1 MessageTransmitter on Avalanche. Noble emits V1 messages.
export const AVALANCHE_MESSAGE_TRANSMITTER_V1 = "0x8186359aF5F57FbB40c6b14A588d2A59C0C29880";
// Circle CCTP V2 TokenMessenger on Avalanche. The second burn starts here.
export const AVALANCHE_TOKEN_MESSENGER_V2 = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
// Circle-issued USDC on Avalanche.
export const AVALANCHE_USDC = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";
// Circle CCTP V2 MessageTransmitter on Injective.
export const INJECTIVE_MESSAGE_TRANSMITTER_V2 = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";

export function ethereumBytes32(address) {
  const hex = String(address || "").replace(/^0x/i, "").toLowerCase();
  if (!/^[\da-f]{40}$/.test(hex)) throw new Error("The mint recipient is not an Ethereum address.");
  const out = new Uint8Array(32);
  for (let index = 0; index < 20; index += 1) {
    out[12 + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

export function zeroBytes32() {
  return new Uint8Array(32);
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function orbiterMemo(mintRecipient) {
  return JSON.stringify({
    orbiter: {
      forwarding: {
        protocol_id: "PROTOCOL_CCTP",
        attributes: {
          "@type": "/noble.orbiter.controller.forwarding.v1.CCTPAttributes",
          destination_domain: AVALANCHE_DOMAIN,
          mint_recipient: bytesToBase64(ethereumBytes32(mintRecipient)),
        },
        passthrough_payload: "",
      },
    },
  });
}

export function nobleBurnMessage(from, amount, mintRecipient) {
  if (!String(from).startsWith("noble1")) throw new Error("The burn is not signed by the Noble account.");
  if (BigInt(amount) <= 0n) throw new Error("Noble needs USDC left for the fee.");
  return {
    type: "/circle.cctp.v1.MsgDepositForBurn",
    value: {
      from,
      amount: String(amount),
      destination_domain: AVALANCHE_DOMAIN,
      mint_recipient: bytesToBase64(ethereumBytes32(mintRecipient)),
      burn_token: USDC_NOBLE_DENOM,
    },
  };
}

function hexOf(bytes) {
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// Noble is CCTP V1. Iris indexes that burn by the keccak256 of MessageSent,
// not by the transaction hash on the V2 messages route.
export function cctpMessageHash(message) {
  const bytes = message instanceof Uint8Array ? message : Uint8Array.from([]);
  if (!bytes.length) throw new Error("The burn hash is not a transaction hash.");
  return hexOf(keccak_256(bytes));
}

export function irisAttestationUrl(messageHash) {
  const hex = String(messageHash || "").replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("The burn hash is not a transaction hash.");
  return `${IRIS_MAINNET}/v1/attestations/0x${hex}`;
}

export async function readIris(fetchImpl, message) {
  const bytes = message instanceof Uint8Array ? message : Uint8Array.from([]);
  const url = irisAttestationUrl(cctpMessageHash(bytes));
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error("Circle has not attested this burn yet.");
  const body = await response.json();
  const attestation = body?.attestation || "";
  if (body?.status !== "complete" || !/^0x[0-9a-fA-F]+$/.test(attestation) || attestation === "0x") {
    throw new Error("Circle has not attested this burn yet.");
  }
  return { url, message: hexOf(bytes), attestation };
}

export function relaySummary() {
  return "The page waits for the Noble burn, asks Circle for the attestation, and preflights receiveMessage on Avalanche.";
}

export function selfRelayLegs(mintRecipient, amount = "1000000") {
  const padded = bytesToBase64(ethereumBytes32(mintRecipient));
  const caller = bytesToBase64(zeroBytes32());
  return [
    {
      title: "Osmosis to Noble",
      signs: "The Osmosis account signs one IBC transfer.",
      relay: "Anyone can deliver the packet. This team relays it.",
      detail: {
        source_channel: OSMOSIS_TO_NOBLE,
        receiver: ORBITER,
        token: { denom: OSMOSIS_USDC_DENOM, amount: String(amount) },
        memo: JSON.parse(orbiterMemo(mintRecipient)),
      },
    },
    {
      title: "Noble burn, when the USDC is already on Noble",
      signs: "The Noble account signs MsgDepositForBurn. There is no fee action.",
      relay: "Noble burns in that transaction.",
      detail: {
        type: "/circle.cctp.v1.MsgDepositForBurn",
        from: "the connected Noble account",
        amount: String(amount),
        destination_domain: AVALANCHE_DOMAIN,
        mint_recipient: padded,
        burn_token: USDC_NOBLE_DENOM,
      },
    },
    {
      title: "Attestation",
      signs: "Nobody signs this request.",
      relay: "Circle's Iris service attests the burn. It is not a solver.",
      detail: {
        method: "GET",
        url: `${IRIS_MAINNET}/v1/attestations/0x{keccak256 of the Noble MessageSent}`,
      },
    },
    {
      title: "Mint on Avalanche",
      signs: "The page preflights receiveMessage, then submits it when the mint account has AVAX.",
      relay: "The destination caller is 32 zero bytes, so anyone may submit it.",
      detail: {
        to: AVALANCHE_MESSAGE_TRANSMITTER_V1,
        method: "receiveMessage(bytes,bytes)",
        message: "Iris messages[0].message",
        attestation: "Iris messages[0].attestation",
      },
    },
    {
      title: "Burn toward Injective",
      signs: "The page submits depositForBurn after the Avalanche mint, from the same account.",
      relay: "Avalanche burns in that transaction.",
      detail: {
        to: AVALANCHE_TOKEN_MESSENGER_V2,
        method: "depositForBurn",
        amount: String(amount),
        destinationDomain: INJECTIVE_DOMAIN,
        mintRecipient: padded,
        burnToken: AVALANCHE_USDC,
        destinationCaller: caller,
        maxFee: "0",
        minFinalityThreshold: STANDARD_FINALITY,
      },
    },
    {
      title: "Mint on Injective",
      signs: "The page waits for USDC.inj. It does not have an Injective EVM endpoint for this call.",
      relay: "The destination caller is 32 zero bytes, so anyone may submit it.",
      detail: {
        to: INJECTIVE_MESSAGE_TRANSMITTER_V2,
        method: "receiveMessage(bytes,bytes)",
        iris: `${IRIS_MAINNET}/v2/messages/${AVALANCHE_DOMAIN}?transactionHash={avalanche burn hash}`,
      },
    },
  ];
}
