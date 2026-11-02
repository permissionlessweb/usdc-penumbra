// Balances decide the plan. Keplr returns an address and no amount, and the
// mixnet client is still closed, so a Keplr balance is read from that chain's
// public LCD. Penumbra amounts come from Zafu. A zero is a real empty result.
// A failed read stays unread. The page does not invent a number.

import { initRun } from "./machine.js";
import {
  INJ_USDC_DENOM,
  OSMOSIS_USDC_DENOM,
  USDC_NOBLE_DENOM,
  describeStep,
  migrateAmount,
  signingGaps,
} from "./route.js";
import { GAS, fee } from "./tx.js";

export { INJ_USDC_DENOM, OSMOSIS_USDC_DENOM, USDC_NOBLE_DENOM };
export const INJ_DENOM = "inj";

export const LCD = {
  "osmosis-1": "https://lcd.osmosis.zone",
  "noble-1": "https://noble-api.polkachu.com",
  "injective-1": "https://lcd.injective.network",
};

const PLACES = [
  ["osmosis", "Osmosis"],
  ["noble", "Noble"],
  ["penumbra", "Penumbra"],
  ["usdcInj", "Injective USDC"],
  ["inj", "INJ"],
];

const USDC_PLACES = PLACES.filter(([place]) => place !== "inj");

function selectedAmount(readings, place, label) {
  const available = readings[place].amount;
  if (readings.chosen == null || readings.chosen[place] == null) return { amount: available };
  const amount = String(readings.chosen[place]);
  if (!/^\d+$/.test(amount)) return { error: `Enter a ${label} amount.` };
  if (BigInt(amount) > BigInt(available)) return { error: `${label} is larger than the balance.` };
  return { amount };
}

export function parseUnits(text, decimals) {
  const trimmed = String(text ?? "").trim();
  if (!/^\d+(\.\d*)?$/.test(trimmed)) throw new Error("Enter a USDC amount.");
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) throw new Error(`Use at most ${decimals} decimals.`);
  const scale = 10n ** BigInt(decimals);
  return (BigInt(whole) * scale + BigInt(frac.padEnd(decimals, "0") || "0")).toString();
}

export function formatUnits(amount, decimals) {
  const value = BigInt(amount);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = (value % scale).toString().padStart(Number(decimals), "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function coinAmount(coins, denom) {
  const coin = (coins || []).find((item) => item?.denom === denom);
  const amount = coin?.amount ?? "0";
  if (!/^\d+$/.test(String(amount))) throw new Error("Balance amount is not a whole number.");
  return BigInt(amount);
}

export async function readDenom(fetchImpl, base, address, denom) {
  const url = new URL(`${base}/cosmos/bank/v1beta1/balances/${address}/by_denom`);
  url.searchParams.set("denom", denom);
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Balance query failed (${response.status}).`);
  const body = await response.json();
  return coinAmount(body.balance ? [body.balance] : [], denom).toString();
}

// A balance below the deposit fee still needs the hop. The page does not invent a price.
export function prepareMigration(readings, timing = {}) {
  for (const [place, label] of PLACES) {
    if (readings[place]?.state !== "ready") {
      return { ready: false, reason: `${label} is not read.`, steps: [], moved: "0" };
    }
  }
  const selected = {};
  for (const [place, label] of USDC_PLACES) {
    const result = selectedAmount(readings, place, label);
    if (result.error) return { ready: false, reason: result.error, steps: [], moved: "0" };
    selected[place] = result.amount;
  }
  const findings = {
    osmosis: BigInt(selected.osmosis) > 0n,
    noble: BigInt(selected.noble) > 0n,
    penumbra: BigInt(selected.penumbra) > 0n,
    usdcInj: BigInt(selected.usdcInj) > 0n,
    injGasShort: BigInt(readings.inj.amount) < BigInt(fee("injective-1", GAS.deposit).amount),
  };
  const pays = findings.penumbra || findings.noble || findings.osmosis;
  const anyAvailable = USDC_PLACES.some(([place]) => BigInt(readings[place].amount) > 0n);
  if (!pays && !findings.usdcInj) {
    return {
      ready: false,
      reason: anyAvailable ? "Choose an amount." : "The query found no USDC.",
      steps: [],
      moved: "0",
    };
  }
  const input = {
    ...findings,
    amountOut: selected.penumbra,
    amountIn: findings.noble ? selected.noble : selected.usdcInj,
    amountOsmosis: selected.osmosis,
    slices: findings.penumbra ? timing.slices : 1,
    intervalSec: findings.penumbra ? timing.intervalSec : 0,
    jitterMaxSec: findings.penumbra ? timing.jitterMaxSec : 0,
  };
  let run;
  try {
    run = initRun(input);
  } catch (error) {
    return { ready: false, reason: error.message, steps: [], moved: "0" };
  }
  const moved = pays
    ? migrateAmount(run.findings, run.amountOut, run.amountIn, run.amountOsmosis)
    : run.amountIn;
  const ctx = {
    findings: run.findings,
    amountOut: run.amountOut,
    amountIn: run.amountIn,
    amountOsmosis: run.amountOsmosis,
    amountHeld: findings.usdcInj ? selected.usdcInj : undefined,
    moved,
    addresses: readings.addresses || {},
  };
  const steps = [];
  if (run.findings.penumbra) {
    run.amounts.forEach((amount, index) => {
      const described = describeStep("leave", { ...ctx, amountBase: amount });
      steps.push({
        id: "leave",
        title: run.slices > 1 ? `Leave Penumbra, ${index + 1} of ${run.slices}` : "Leave Penumbra",
        detail: described.detail,
        gaps: signingGaps(described.messages),
      });
    });
  }
  for (const step of run.onceSteps) {
    const described = describeStep(step.id, ctx);
    steps.push({
      id: step.id,
      title: step.title,
      detail: described.detail,
      gaps: signingGaps(described.messages),
    });
  }
  const gasNeed = osmosisGasRequired(steps);
  if (gasNeed > 0n) {
    if (readings.uosmo?.state !== "ready") {
      return { ready: false, reason: "Osmosis gas is not read.", steps: [], moved: "0" };
    }
    if (BigInt(readings.uosmo.amount) < gasNeed) {
      return { ready: false, reason: "Osmosis gas is short.", steps, moved };
    }
  }
  return { ready: true, reason: "", steps, moved, input, ctx };
}

export function osmosisGasRequired(steps) {
  const swap = BigInt(fee("osmosis-1", GAS.swap).amount);
  const ibc = BigInt(fee("osmosis-1", GAS.ibc).amount);
  const hook = BigInt(fee("osmosis-1", GAS.hook).amount);
  let need = 0n;
  for (const step of steps) {
    if (step.id === "gas-osmosis") need += swap + ibc;
    if (step.id === "gather-osmosis") need += hook;
  }
  return need;
}
