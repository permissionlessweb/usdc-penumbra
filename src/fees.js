// Osmosis accepts a whitelisted fee token. The allow-list is embedded.
// The spot price is read when a fee is chosen. USDC.noble is preferred
// over the base denom. The chain converts that fee by rounding
// spotPrice * amount into uosmo, and that result must cover the base fee.

import { LCD } from "./balances.js";
import { FEE_TOKEN_POOLS } from "./fee-tokens.js";
import { OSMOSIS_USDC_DENOM } from "./route.js";

const SCALE = 10n ** 18n;
// 0.01 USDC left in the account. The normal fee is taken from that cent.
export const USDC_FEE_BUFFER = 10_000n;

export function parseSpot(price) {
  const text = String(price);
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("Osmosis did not price this fee token.");
  const [whole, frac = ""] = text.split(".");
  const padded = `${frac}${"0".repeat(18)}`.slice(0, 18);
  const num = BigInt(whole) * SCALE + BigInt(padded);
  if (num <= 0n) throw new Error("Osmosis did not price this fee token.");
  return num;
}

// Smallest fee-token amount whose rounded base value covers baseAmount.
export function feeTokenAmount(baseAmount, spotPrice) {
  const spot = parseSpot(spotPrice);
  const base = BigInt(baseAmount);
  if (base <= 0n) throw new Error("Osmosis did not price this fee token.");
  let amount = (base * SCALE + spot - 1n) / spot;
  if (amount < 1n) amount = 1n;
  const converts = (value) => (spot * value + SCALE / 2n) / SCALE;
  while (converts(amount) < base) amount += 1n;
  return amount;
}

export function holdsFeeToken(coins, denom) {
  return (coins || []).some((coin) => coin.denom === denom && BigInt(coin.amount || "0") > 0n);
}

// USDC.noble when the wallet holds it and the embedded list still names it.
// Otherwise the base denom, when the wallet holds that.
export function preferredFeeDenom(coins) {
  if (FEE_TOKEN_POOLS[OSMOSIS_USDC_DENOM] && holdsFeeToken(coins, OSMOSIS_USDC_DENOM)) {
    return OSMOSIS_USDC_DENOM;
  }
  if (holdsFeeToken(coins, "uosmo")) return "uosmo";
  return "";
}

export async function readSpot(fetchImpl, denom) {
  const pool = FEE_TOKEN_POOLS[denom];
  if (!pool) throw new Error("Osmosis does not accept this fee token.");
  const url = new URL(`${LCD["osmosis-1"]}/osmosis/txfees/v1beta1/spot_price_by_denom`);
  url.searchParams.set("denom", denom);
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error("Osmosis did not price this fee token.");
  const body = await response.json();
  const found = String(body.poolID ?? body.pool_id ?? "");
  if (found !== pool) throw new Error("Osmosis did not price this fee token.");
  parseSpot(body.spot_price);
  return String(body.spot_price);
}
