// Circle burns USDC.noble and the Avalanche transaction issues USDC.inj.
// The burn transaction is the one Skip returns for that route. A route that
// swaps is refused before anything is signed.

import { OSMOSIS_TO_NOBLE, OSMOSIS_USDC_DENOM, RELEASE_DENOM } from "./route.js";

// Noble runs the burn while it receives the Osmosis transfer. The receiver is
// the Orbiter module account. The memo names the Avalanche domain.
export const ORBITER = "noble15xt7kx5mles58vkkfxvf0lq78sw04jajvfgd4d";
const AVALANCHE_DOMAIN = 1;

const ALLOWED = new Set([
  "/circle.cctp.v1.MsgDepositForBurn",
  "/circle.cctp.v1.MsgDepositForBurnWithCaller",
  "/cosmos.bank.v1beta1.MsgSend",
]);

export function assertCircleRoute(route) {
  if (!route || typeof route !== "object") throw new Error("Circle did not return a burn.");
  if (route.does_swap) throw new Error("The route swaps. This page did not sign it.");
  if (Array.isArray(route.swap_venues) && route.swap_venues.length) {
    throw new Error("The route swaps. This page did not sign it.");
  }
  const operations = route.operations;
  if (!Array.isArray(operations) || !operations.length) throw new Error("Circle did not return a burn.");
  for (const operation of operations) {
    if (!operation.cctp_transfer && !operation.cctp_transfer_v2) {
      throw new Error("The route is not a Circle burn. This page did not sign it.");
    }
  }
  const burn = operations[0].cctp_transfer;
  if (!burn || burn.from_chain_id !== "noble-1" || burn.burn_token !== "uusdc") {
    throw new Error("The burn does not start from Noble USDC.");
  }
  const forward = operations.find((operation) => operation.cctp_transfer_v2)?.cctp_transfer_v2;
  if (!forward || forward.to_chain_id !== "1776") {
    throw new Error("The route does not issue USDC on Injective.");
  }
  if (String(forward.denom_out).toLowerCase() !== RELEASE_DENOM.toLowerCase()) {
    throw new Error("The route does not issue USDC on Injective.");
  }
  if (Number(route.txs_required) !== 1) throw new Error("The route needs more than one signature.");
  return route;
}

export function assertOsmosisCircleRoute(route) {
  const transfer = route?.operations?.[0]?.transfer;
  if (!transfer || transfer.from_chain_id !== "osmosis-1" || transfer.to_chain_id !== "noble-1") {
    throw new Error("The route does not return the USDC to Noble.");
  }
  if (transfer.channel !== OSMOSIS_TO_NOBLE) throw new Error("The route does not return the USDC to Noble.");
  if (transfer.denom_in !== OSMOSIS_USDC_DENOM || transfer.denom_out !== "uusdc") {
    throw new Error("The route does not return the USDC to Noble.");
  }
  assertCircleRoute({ ...route, operations: route.operations.slice(1) });
  return route;
}

export function osmosisTransfer(body, sender, amount) {
  const txs = body?.txs;
  if (!Array.isArray(txs) || txs.length !== 1 || !txs[0].cosmos_tx) {
    throw new Error("The transfer is not one Osmosis transaction.");
  }
  const tx = txs[0].cosmos_tx;
  if (tx.chain_id !== "osmosis-1" || tx.signer_address !== sender) {
    throw new Error("The transfer is not one Osmosis transaction.");
  }
  const msgs = tx.msgs || [];
  if (msgs.length !== 1 || msgs[0].msg_type_url !== "/ibc.applications.transfer.v1.MsgTransfer") {
    throw new Error("The transfer includes a message this page will not sign.");
  }
  const value = JSON.parse(msgs[0].msg);
  if (value.source_channel !== OSMOSIS_TO_NOBLE || value.token?.denom !== OSMOSIS_USDC_DENOM) {
    throw new Error("The transfer does not return the USDC to Noble.");
  }
  if (value.sender !== sender) throw new Error("The transfer is not signed by the Osmosis account.");
  if (value.receiver !== ORBITER || value.token.amount !== amount) {
    throw new Error("The transfer does not burn on arrival.");
  }
  let memo;
  try {
    memo = JSON.parse(value.memo);
  } catch {
    throw new Error("The transfer does not burn on arrival.");
  }
  const forwarding = memo?.orbiter?.forwarding;
  if (forwarding?.protocol_id !== "PROTOCOL_CCTP" || Number(forwarding.attributes?.destination_domain) !== AVALANCHE_DOMAIN) {
    throw new Error("The transfer does not burn on arrival.");
  }
  return { type: msgs[0].msg_type_url, value };
}

export function uusdcDebit(messages, signer) {
  let total = 0n;
  for (const message of messages) {
    if (message.type.startsWith("/circle.cctp.v1.MsgDepositForBurn")) {
      if (message.value.from !== signer) throw new Error("The burn is not signed by the Noble account.");
      total += BigInt(message.value.amount);
    } else if (message.type === "/cosmos.bank.v1beta1.MsgSend") {
      const from = message.value.from_address || message.value.fromAddress;
      if (from !== signer) throw new Error("The burn is not signed by the Noble account.");
      for (const coin of message.value.amount || []) {
        if (coin.denom !== "uusdc") throw new Error("The burn fee is not USDC.");
        total += BigInt(coin.amount);
      }
    }
  }
  return total;
}

export function circleMessages(body) {
  const txs = body?.txs;
  if (!Array.isArray(txs) || txs.length !== 1 || !txs[0].cosmos_tx) {
    throw new Error("The burn is not one Noble transaction.");
  }
  const tx = txs[0].cosmos_tx;
  if (tx.chain_id !== "noble-1") throw new Error("The burn is not one Noble transaction.");
  const messages = (tx.msgs || []).map((item) => {
    if (!ALLOWED.has(item.msg_type_url)) throw new Error("The burn includes a message this page will not sign.");
    const value = JSON.parse(item.msg);
    if (item.msg_type_url === "/cosmos.bank.v1beta1.MsgSend") {
      const coins = value.amount || [];
      if (!coins.length || coins.some((coin) => coin.denom !== "uusdc")) {
        throw new Error("The burn fee is not USDC.");
      }
    }
    return { type: item.msg_type_url, value };
  });
  if (!messages.some((message) => message.type.startsWith("/circle.cctp.v1.MsgDepositForBurn"))) {
    throw new Error("The burn transaction has no Circle burn.");
  }
  return { chainId: tx.chain_id, signer: tx.signer_address, messages };
}
