// ViewService over the Zafu MessagePort, as documented for extension dapps.
// addressByIndex({}) asks for the account's default diversified address.
// The page does not hold the spend key. Choosing this index is not a signature.

import { createClient } from "@connectrpc/connect";
import { bech32mAddress, isAddress } from "@penumbra-zone/bech32m/penumbra";
import { IbcChannelService, IbcClientService } from "@penumbra-zone/protobuf";
import { State } from "@penumbra-zone/protobuf/ibc/core/channel/v1/channel_pb";
import { ClientState as TendermintClientState } from "@penumbra-zone/protobuf/ibc/lightclients/tendermint/v1/tendermint_pb";
import { jsonOptions } from "@penumbra-zone/protobuf/registry";
import { ViewService } from "@penumbra-zone/protobuf/penumbra/view/v1/view_connect";
import { createChannelTransport } from "@penumbra-zone/transport-dom/create";
import { RELEASE_DENOM } from "./route.js";

const NOBLE_BASE = /^transfer\/(channel-\d+)\/uusdc$/;
const INJ_BASE = new RegExp(`^transfer/channel-\\d+/erc20:${RELEASE_DENOM}$`, "i");

export function formatDiversifiedAddress(address) {
  if (address?.inner?.length) {
    const text = bech32mAddress(address);
    if (!isAddress(text)) throw new Error("Zafu returned an address this page cannot read.");
    return text;
  }
  if (typeof address?.altBech32m === "string" && isAddress(address.altBech32m)) {
    return address.altBech32m;
  }
  throw new Error("Zafu did not return an address.");
}

export function createViewClient(getPort) {
  return createClient(
    ViewService,
    createChannelTransport({ getPort, jsonOptions }),
  );
}

// One MessagePort, three clients. Zafu proxies the IBC queries to the node it syncs.
export function createPenumbraClients(getPort) {
  const transport = createChannelTransport({ getPort, jsonOptions });
  return {
    view: createClient(ViewService, transport),
    channels: createClient(IbcChannelService, transport),
    clients: createClient(IbcClientService, transport),
  };
}

const COUNTERPARTY = /^channel-\d+$/;

// Blocks past the light client's latest counterparty height. The withdrawal
// also carries a ten-minute timestamp. This headroom keeps the height in the
// future when the client lags, so the timestamp is the timeout that arrives
// first. It is not a Noble parameter and it is not a pinned block.
export const NOBLE_HEIGHT_HEADROOM = 1000n;

// A channel the light client can forward on: open, Noble, and a named counterparty.
export function readNobleForward(channel, clientState) {
  if (channel?.state !== State.OPEN) return null;
  const id = channel?.counterparty?.channelId || "";
  if (!COUNTERPARTY.test(id)) return null;
  if (!clientState || typeof clientState.unpackTo !== "function") return null;
  const parsed = new TendermintClientState();
  if (!clientState.unpackTo(parsed)) return null;
  const chainId = String(parsed.chainId || "");
  if (!chainId.startsWith("noble")) return null;
  return { channel: id, chainId };
}

// Counterparty height for an Ics20Withdrawal. Penumbra rejects the action
// when timeout_height is absent. The revision is the client's. The height is
// strictly above the client's latest height.
export function nobleTimeoutHeight(clientState, status) {
  if (status !== "Active") return null;
  if (!clientState || typeof clientState.unpackTo !== "function") return null;
  const parsed = new TendermintClientState();
  if (!clientState.unpackTo(parsed)) return null;
  if (!String(parsed.chainId || "").startsWith("noble")) return null;
  const latest = parsed.latestHeight;
  if (!latest) return null;
  const revisionHeight = BigInt(latest.revisionHeight ?? 0);
  if (revisionHeight <= 0n) return null;
  return {
    revisionNumber: BigInt(latest.revisionNumber ?? 0),
    revisionHeight: revisionHeight + NOBLE_HEIGHT_HEADROOM,
  };
}

export async function nobleWithdrawalHeight(channels, clients, channelId) {
  if (!channelId || !channels?.channelClientState || !clients?.clientStatus) {
    throw new Error("The light client did not name a Noble height.");
  }
  const client = await channels.channelClientState({ portId: "transfer", channelId });
  const identified = client?.identifiedClientState;
  const status = await clients.clientStatus({ clientId: identified?.clientId || "" });
  const height = nobleTimeoutHeight(identified?.clientState, status?.status);
  if (!height) throw new Error("The light client did not name a Noble height.");
  return height;
}

export async function nobleForwardChannel(view, channels, clients) {
  if (!view?.assets || !channels?.channel || !channels?.channelClientState || !clients?.clientStatus) {
    throw new Error("The light client did not name a Noble channel.");
  }
  const local = [];
  const seen = new Set();
  for await (const response of view.assets({})) {
    const metadata = response?.denomMetadata;
    if (metadata?.symbol !== "USDC") continue;
    const match = NOBLE_BASE.exec(metadata.base || "");
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    local.push(match[1]);
  }
  const named = [];
  for (const channelId of local) {
    const found = await channels.channel({ portId: "transfer", channelId });
    const client = await channels.channelClientState({ portId: "transfer", channelId });
    const forward = readNobleForward(found?.channel, client?.identifiedClientState?.clientState);
    if (!forward) continue;
    const status = await clients.clientStatus({
      clientId: client?.identifiedClientState?.clientId || "",
    });
    if (status?.status !== "Active") continue;
    named.push(forward);
  }
  if (named.length === 0) throw new Error("The light client did not name a Noble channel.");
  if (named.length > 1) throw new Error("Penumbra named more than one Noble channel.");
  return named[0];
}

export async function diversifiedAddress(viewClient) {
  const { address } = await viewClient.addressByIndex({});
  return formatDiversifiedAddress(address);
}

function bytesKey(bytes) {
  if (!bytes?.length) return "";
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Wallet id plus the diversified address. An account switch changes at least one.
export async function zafuAccountId(view) {
  const address = await diversifiedAddress(view);
  let wallet = "";
  if (typeof view?.walletId === "function") {
    try {
      const reply = await view.walletId({});
      wallet = bytesKey(reply?.walletId?.inner);
    } catch {
      wallet = "";
    }
  }
  return `${wallet}:${address}`;
}

export function amountFromParts(amount) {
  const lo = BigInt(amount?.lo ?? 0);
  const hi = BigInt(amount?.hi ?? 0);
  return (hi << 64n) + lo;
}

function knownUsdc(balanceView) {
  const view = balanceView?.valueView;
  if (!view || view.case !== "knownAssetId") return null;
  const known = view.value;
  const metadata = known?.metadata;
  const base = metadata?.base || "";
  let kind = "";
  if (INJ_BASE.test(base)) kind = "inj";
  else if (metadata?.symbol === "USDC" && NOBLE_BASE.test(base)) kind = "noble";
  if (!kind) return null;
  const unit = metadata.denomUnits?.find((item) => item.denom === metadata.display);
  return {
    kind,
    amount: amountFromParts(known.amount),
    decimals: unit ? unit.exponent : 6,
  };
}

export function penumbraUsdcFromResponses(responses) {
  let noble = 0n;
  let inj = 0n;
  let decimals = 6;
  for (const response of responses) {
    const picked = knownUsdc(response?.balanceView);
    if (!picked) continue;
    if (picked.kind === "inj") inj += picked.amount;
    else noble += picked.amount;
    decimals = picked.decimals;
  }
  return { noble: noble.toString(), inj: inj.toString(), amount: noble.toString(), decimals };
}

export async function readPenumbraUsdc(viewClient) {
  const responses = [];
  for await (const response of viewClient.balances({})) responses.push(response);
  return penumbraUsdcFromResponses(responses);
}
