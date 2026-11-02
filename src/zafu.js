// ViewService over the Zafu MessagePort, as documented for extension dapps.
// addressByIndex({}) asks for the account's default diversified address.
// The page does not hold the spend key. Choosing this index is not a signature.

import { createClient } from "@connectrpc/connect";
import { bech32mAddress, isAddress } from "@penumbra-zone/bech32m/penumbra";
import { jsonOptions } from "@penumbra-zone/protobuf/registry";
import { ViewService } from "@penumbra-zone/protobuf/penumbra/view/v1/view_connect";
import { createChannelTransport } from "@penumbra-zone/transport-dom/create";

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

export async function diversifiedAddress(viewClient) {
  const { address } = await viewClient.addressByIndex({});
  return formatDiversifiedAddress(address);
}

export function amountFromParts(amount) {
  const lo = BigInt(amount?.lo ?? 0);
  const hi = BigInt(amount?.hi ?? 0);
  return (hi << 64n) + lo;
}

export function usdcFromBalanceView(balanceView) {
  const view = balanceView?.valueView;
  if (!view || view.case !== "knownAssetId") return null;
  const known = view.value;
  if (known?.metadata?.symbol !== "USDC") return null;
  const unit = known.metadata.denomUnits?.find((item) => item.denom === known.metadata.display);
  return {
    amount: amountFromParts(known.amount),
    decimals: unit ? unit.exponent : 6,
  };
}

export function penumbraUsdcFromResponses(responses) {
  let total = 0n;
  let decimals = 6;
  for (const response of responses) {
    const picked = usdcFromBalanceView(response?.balanceView);
    if (!picked) continue;
    total += picked.amount;
    decimals = picked.decimals;
  }
  return { amount: total.toString(), decimals };
}

export async function readPenumbraUsdc(viewClient) {
  const responses = [];
  for await (const response of viewClient.balances({})) responses.push(response);
  return penumbraUsdcFromResponses(responses);
}
