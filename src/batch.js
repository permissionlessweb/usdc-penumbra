// One Penumbra slice. Two withdrawals, each its own signature, then a deposit
// from the slice's Injective account. See docs/batch-out.md.

import { osmosisTransfer } from "./circle.js";
import { INJ_ON_OSMOSIS, NOBLE_TO_OSMOSIS } from "./route.js";

// CrossChainSwaps v1.2, code id 37, read from lcd.osmosis.zone on 2026-11-01.
export const CROSSCHAIN_SWAP = "osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs";
// Noble packet receiver. A real account here would be credited if forwarding fails.
export const FORWARD_RECEIVER = "pfm";

// Ceiling for two ICS-20 withdrawals, their memos, the spends, and one change
// note. The planner still prices the real fee. A short reserve makes the
// planner refuse before broadcast. A long reserve stays in Penumbra.
export const SLICE_GAS = {
  blockSpace: 12000n,
  compactBlockSpace: 800n,
  verification: 6000n,
  execution: 80n,
};

function asBig(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (value != null && typeof value.toString === "function") {
    const text = value.toString();
    if (/^-?\d+$/.test(text)) return BigInt(text);
  }
  return 0n;
}

function priceOf(prices, camel, snake) {
  return asBig(prices?.[camel] ?? prices?.[snake] ?? 0);
}

// GasPrices uses an implicit 1,000 denominator.
export function feeAmount(prices, gas = SLICE_GAS) {
  const cost = priceOf(prices, "blockSpacePrice", "block_space_price") * gas.blockSpace
    + priceOf(prices, "compactBlockSpacePrice", "compact_block_space_price") * gas.compactBlockSpace
    + priceOf(prices, "verificationPrice", "verification_price") * gas.verification
    + priceOf(prices, "executionPrice", "execution_price") * gas.execution;
  return cost / 1000n;
}

export function assetIdKey(assetId) {
  const inner = assetId?.inner;
  if (inner instanceof Uint8Array) {
    return [...inner].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  if (typeof inner === "string" && inner) return inner;
  return "";
}

// The staking-token price has no asset id. USDC uses the matching alt price.
export function matchUsdcPrice(response, assetId) {
  const wanted = assetIdKey(assetId);
  if (!wanted) return null;
  const alts = response?.altGasPrices || response?.alt_gas_prices || [];
  for (const price of alts) {
    const id = price?.assetId || price?.asset_id;
    if (assetIdKey(id) === wanted) return price;
  }
  return null;
}

export function splitSlice(slice, buy, feeReserve) {
  const total = BigInt(slice);
  const input = BigInt(buy);
  const reserve = BigInt(feeReserve);
  if (input <= 0n) throw new Error("Osmosis did not quote the INJ swap.");
  if (reserve < 0n) throw new Error("Penumbra did not price a USDC fee.");
  if (total <= input + reserve) throw new Error("This slice cannot buy the Injective fee.");
  return {
    buy: input.toString(),
    migrate: (total - input - reserve).toString(),
    fee: reserve.toString(),
  };
}

const NOBLE_CHANNEL = /^channel-\d+$/;

// Dev-only. The page shows this host set and no other.
export function isDevHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

// One Noble forward. The channel is the light client's counterparty, not a pin.
export function penumbraForwardMemo(receiver, channel) {
  const address = String(receiver || "");
  if (!address.startsWith("penumbra1")) throw new Error("Zafu is not connected.");
  if (!NOBLE_CHANNEL.test(String(channel || ""))) throw new Error("The light client did not name a Noble channel.");
  return JSON.stringify({
    forward: {
      receiver: address,
      port: "transfer",
      channel,
      timeout: "10m",
      retries: 2,
    },
  });
}

export function feeSwapMemo(receiver, minOut) {
  if (!String(receiver).startsWith("inj1")) throw new Error("The fee swap has no Injective receiver.");
  if (BigInt(minOut) <= 0n) throw new Error("Osmosis did not quote the INJ swap.");
  return JSON.stringify({
    forward: {
      receiver: CROSSCHAIN_SWAP,
      port: "transfer",
      channel: NOBLE_TO_OSMOSIS,
      timeout: "10m",
      retries: 2,
      next: {
        wasm: {
          contract: CROSSCHAIN_SWAP,
          msg: {
            osmosis_swap: {
              output_denom: INJ_ON_OSMOSIS,
              slippage: { min_output_amount: String(minOut) },
              receiver,
              on_failed_delivery: "do_nothing",
            },
          },
        },
      },
    },
  });
}

// Skip's Osmosis transfer is checked and not signed. The memo string is copied.
export function migrationMemo(msgs, sender, amount) {
  return osmosisTransfer(msgs, sender, amount).value.memo;
}
