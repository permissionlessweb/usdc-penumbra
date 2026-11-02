// Begin walks the plan. Each step signs with the connected Keplr account, or
// asks Zafu to broadcast a withdrawal. A step is acknowledged only after the
// balance it should change has changed. A failure stops the queue.

import {
  FORWARD_RECEIVER,
  feeAmount,
  feeSwapMemo,
  matchUsdcPrice,
  migrationMemo,
  penumbraForwardMemo,
  splitSlice,
} from "./batch.js";
import { LCD, formatUnits, readDenom } from "./balances.js";
import {
  ORBITER,
  assertCircleRoute,
  assertOsmosisCircleRoute,
  circleMessages,
  osmosisTransfer,
  uusdcDebit,
} from "./circle.js";
import { currentStep, initRun, keysNeeded, reduce, stepState } from "./machine.js";
import {
  INJ_ON_OSMOSIS,
  INJ_USDC_DENOM,
  INJECTIVE_TO_PENUMBRA,
  NOBLE_TO_OSMOSIS,
  OSMOSIS_TO_INJECTIVE,
  OSMOSIS_TO_NOBLE,
  OSMOSIS_USDC_DENOM,
  USDC_NOBLE_DENOM,
  describeStep,
  migrateAmount,
  pileRole,
} from "./route.js";
import { GAS, fee, signAndBroadcast, transferTimeout } from "./tx.js";
import { nobleForwardChannel, nobleWithdrawalHeight } from "./zafu.js";

const IBC_TIMEOUT_MS = 6 * 60 * 1000;
const CCTP_TIMEOUT_MS = 8 * 60 * 1000;
const POLL_MS = 4000;
const SKIP = "https://api.skip.build";
const SQS = "https://sqs.osmosis.zone";
const RETURN_CHANNEL = /^transfer\/(channel-\d+)\/uusdc$/;

function addressOf(ctx, role) {
  const addresses = ctx.addresses || {};
  if (role === "noble") return addresses.noble || addresses.userNoble || "";
  if (role === "exitNoble") return addresses.exitNoble || addresses.userNoble || "";
  if (role === "avalanche") {
    const raw = addresses.avalanche || addresses.injEthereum || "";
    if (!raw) return "";
    return /^0x/i.test(raw) ? raw : `0x${raw}`;
  }
  if (role === "injLeave") return addresses.injLeave || addresses.userInj || "";
  return "";
}

function holderOf(ctx) {
  return addressOf(ctx, pileRole(ctx.findings));
}

function noteRoles(run, ctx) {
  let next = run;
  for (const role of keysNeeded(run)) {
    const address = addressOf(ctx, role);
    if (!address) throw new Error("A required account is not connected.");
    next = reduce(next, {
      type: "NOTE",
      role,
      address,
      ethereum: role === "avalanche" ? address : null,
      keyId: null,
    });
  }
  return next;
}

function drawJitter(random, max) {
  if (!max) return 0;
  const draw = Math.floor((random || Math.random)() * (max + 1));
  if (draw < 0 || draw > max) return 0;
  return draw;
}

function clock(io, timeoutMs) {
  return {
    now: io.now,
    sleep: io.sleep,
    timeoutMs,
    intervalMs: io.intervalMs ?? POLL_MS,
  };
}

async function untilAtLeast(io, timeoutMs, target, read) {
  const start = io.now();
  while (io.now() - start <= timeoutMs) {
    const amount = BigInt(await read());
    if (amount >= target) return amount;
    await io.sleep(io.intervalMs ?? POLL_MS);
  }
  return null;
}

function chainPlace(chainId) {
  if (chainId === "osmosis-1") return "Osmosis";
  if (chainId === "noble-1") return "Noble";
  if (chainId === "injective-1") return "Injective";
  return chainId;
}

async function sign(io, { chainId, signer, messages, gas }) {
  return signAndBroadcast({
    keplr: io.keplr,
    fetchImpl: io.fetch,
    chainId,
    signer,
    messages,
    feeAmount: fee(chainId, gas),
    lcd: LCD[chainId],
    wait: clock(io, io.txTimeoutMs ?? 90_000),
    onSubmitted(hash) {
      io.onProgress?.(`Submitted ${hash}. Waiting for ${chainPlace(chainId)}.`);
    },
  });
}

function transfer(sender, channel, denom, amount, receiver, nowMs, memo = "") {
  const value = {
    source_port: "transfer",
    source_channel: channel,
    token: { denom, amount: String(amount) },
    sender,
    receiver,
    timeout_timestamp: transferTimeout(nowMs),
  };
  if (memo) value.memo = memo;
  return {
    type: "/ibc.applications.transfer.v1.MsgTransfer",
    value,
  };
}

async function bank(io, chainId, address, denom) {
  return BigInt(await readDenom(io.fetch, LCD[chainId], address, denom));
}

async function requireFee(io, chainId, address, gas, emptyMessage) {
  const priced = fee(chainId, gas);
  const held = await bank(io, chainId, address, priced.denom);
  if (held < BigInt(priced.amount)) throw new Error(emptyMessage);
}

export function routesFromExactOut(quote) {
  const groups = Array.isArray(quote?.route) ? quote.route : [];
  if (groups.length !== 1) throw new Error("Osmosis did not quote the INJ swap.");
  const routes = [];
  // SQS lists an exact-out route from the output token back to the input.
  // The chain executes those pools from the input toward the output.
  const pools = [...(groups[0].pools || [])].reverse();
  for (const pool of pools) {
    const denom = pool?.token_in_denom || pool?.tokenInDenom;
    if (pool?.id == null || !denom) continue;
    routes.push({ pool_id: pool.id, token_in_denom: denom });
  }
  const rawIn = quote?.amount_in;
  const amountIn = String(rawIn?.amount ?? rawIn ?? "");
  const out = quote?.amount_out;
  const outAmount = String(out?.amount ?? "");
  if (!routes.length || !/^\d+$/.test(amountIn) || !/^\d+$/.test(outAmount)) {
    throw new Error("Osmosis did not quote the INJ swap.");
  }
  if (BigInt(amountIn) <= 0n || BigInt(outAmount) <= 0n) {
    throw new Error("Osmosis did not quote the INJ swap.");
  }
  if (out?.denom !== INJ_ON_OSMOSIS) throw new Error("The quote does not pay INJ.");
  if (routes[0].token_in_denom !== OSMOSIS_USDC_DENOM) {
    throw new Error("Osmosis did not quote the INJ swap.");
  }
  return { routes, amountIn, amountOut: outAmount };
}

async function quoteFee(io, shortfall) {
  const asked = shortfall.toString();
  if (io.quote) return routesFromExactOut(await io.quote(asked));
  const url = new URL(`${SQS}/router/quote`);
  url.searchParams.set("tokenOut", `${asked}${INJ_ON_OSMOSIS}`);
  url.searchParams.set("tokenInDenom", OSMOSIS_USDC_DENOM);
  url.searchParams.set("singleRoute", "true");
  const response = await io.fetch(url);
  if (!response.ok) throw new Error(`The INJ quote failed (${response.status}).`);
  return routesFromExactOut(await response.json());
}

function nobleBudget(ctx) {
  if (ctx.findings.noble) return BigInt(ctx.amountIn || "0");
  if (ctx.findings.penumbra) return BigInt(ctx.amountOut || "0");
  return 0n;
}

function takeNobleBudget(ctx, input) {
  if (ctx.findings.noble) {
    ctx.amountIn = (BigInt(ctx.amountIn || "0") - input).toString();
    return;
  }
  ctx.amountOut = (BigInt(ctx.amountOut || "0") - input).toString();
}

async function fundFeeFromNoble(ctx, io, osmosis, input) {
  const noble = holderOf(ctx);
  if (!noble) throw new Error("A required account is not connected.");
  if (nobleBudget(ctx) < input) throw new Error("The selected USDC cannot buy the Injective fee.");
  const nobleFee = BigInt(fee("noble-1", GAS.transfer).amount);
  const held = await bank(io, "noble-1", noble, USDC_NOBLE_DENOM);
  if (held < input + nobleFee) throw new Error("Noble needs USDC left for the fee.");
  const before = await bank(io, "osmosis-1", osmosis, OSMOSIS_USDC_DENOM);
  const sent = await sign(io, {
    chainId: "noble-1",
    signer: noble,
    gas: GAS.transfer,
    messages: [transfer(noble, NOBLE_TO_OSMOSIS, USDC_NOBLE_DENOM, input, osmosis, io.now())],
  });
  const after = await untilAtLeast(
    io,
    io.ibcTimeoutMs ?? IBC_TIMEOUT_MS,
    before + input,
    () => bank(io, "osmosis-1", osmosis, OSMOSIS_USDC_DENOM),
  );
  if (after == null) throw new Error(`The Osmosis balance did not increase. ${sent.hash}`);
  takeNobleBudget(ctx, input);
  return after;
}

async function postJson(io, url, body) {
  const response = await io.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    throw new Error("Circle did not return a burn.");
  }
  if (!response.ok) throw new Error(parsed?.message || "Circle did not return a burn.");
  return parsed;
}

async function circleQuote(io, amount, sourceDenom, sourceChain, addresses) {
  const route = await postJson(io, `${SKIP}/v2/fungible/route`, {
    amount_in: amount,
    source_asset_denom: sourceDenom,
    source_asset_chain_id: sourceChain,
    dest_asset_denom: INJ_USDC_DENOM,
    dest_asset_chain_id: "injective-1",
    allow_multi_tx: true,
    allow_swaps: false,
    smart_relay: true,
  });
  const msgs = await postJson(io, `${SKIP}/v2/fungible/msgs`, {
    source_asset_denom: route.source_asset_denom,
    source_asset_chain_id: route.source_asset_chain_id,
    dest_asset_denom: route.dest_asset_denom,
    dest_asset_chain_id: route.dest_asset_chain_id,
    amount_in: route.amount_in,
    amount_out: route.amount_out,
    address_list: addresses,
    operations: route.operations,
    slippage_tolerance_percent: "0",
  });
  return { route, msgs };
}

async function gatherOsmosis(ctx, io) {
  const amount = BigInt(ctx.amountOsmosis || "0");
  if (amount <= 0n) return "Osmosis USDC was used for the Injective fee.";
  const sender = ctx.addresses?.userOsmosis || "";
  const noble = holderOf(ctx);
  const avalanche = addressOf(ctx, "avalanche");
  const inj = ctx.addresses?.userInj || "";
  if (!sender || !noble || !avalanche || !inj) throw new Error("A required account is not connected.");
  await requireFee(io, "osmosis-1", sender, GAS.hook, "Osmosis gas is short.");
  const { route, msgs } = await circleQuote(io, amount.toString(), OSMOSIS_USDC_DENOM, "osmosis-1", [
    sender,
    noble,
    avalanche,
    inj,
  ]);
  assertOsmosisCircleRoute(route);
  if (route.amount_in !== amount.toString()) throw new Error("The transfer does not burn on arrival.");
  const message = osmosisTransfer(msgs, sender, amount.toString());
  ctx.usdcInjBefore = (await bank(io, "injective-1", inj, INJ_USDC_DENOM)).toString();
  const sent = await sign(io, {
    chainId: "osmosis-1",
    signer: sender,
    gas: GAS.hook,
    messages: [message],
  });
  ctx.bridgedBurn = true;
  ctx.burnHash = sent.hash;
  return `The transfer carries the Noble burn. ${sent.hash}`;
}

async function gatherExit(ctx, io) {
  const from = addressOf(ctx, "exitNoble");
  const to = addressOf(ctx, "noble");
  if (!from || !to) throw new Error("A required account is not connected.");
  if (from === to) return "The receipts are already on the Noble account.";
  const amount = BigInt(ctx.amountOut);
  const priced = fee("noble-1", GAS.transfer);
  const held = await bank(io, "noble-1", from, USDC_NOBLE_DENOM);
  if (held < amount + BigInt(priced.amount)) throw new Error("Noble needs USDC left for the fee.");
  const sent = await sign(io, {
    chainId: "noble-1",
    signer: from,
    gas: GAS.transfer,
    messages: [{
      type: "/cosmos.bank.v1beta1.MsgSend",
      value: {
        from_address: from,
        to_address: to,
        amount: [{ denom: USDC_NOBLE_DENOM, amount: amount.toString() }],
      },
    }],
  });
  return `The receipts joined the Noble account. ${sent.hash}`;
}

async function gasOsmosis(ctx, io) {
  const osmosis = ctx.addresses?.userOsmosis || "";
  const inj = ctx.addresses?.userInj || "";
  if (!osmosis || !inj) throw new Error("A required account is not connected.");
  const needed = BigInt(fee("injective-1", GAS.deposit).amount);
  const heldInj = await bank(io, "injective-1", inj, "inj");
  if (heldInj >= needed) return "The Injective wallet can pay the fee.";

  const shortfall = needed - heldInj;
  const priced = BigInt(fee("osmosis-1", GAS.swap).amount) + BigInt(fee("osmosis-1", GAS.ibc).amount);
  if (await bank(io, "osmosis-1", osmosis, "uosmo") < priced) throw new Error("Osmosis gas is short.");
  const quote = await quoteFee(io, shortfall);
  if (BigInt(quote.amountOut) !== shortfall) throw new Error("Osmosis did not quote the INJ swap.");
  const input = BigInt(quote.amountIn);

  const selected = BigInt(ctx.amountOsmosis || "0");
  const live = await bank(io, "osmosis-1", osmosis, OSMOSIS_USDC_DENOM);
  const covered = selected < live ? selected : live;
  const fromOsmosis = covered >= input;
  let usdcBefore = live;
  if (!fromOsmosis) usdcBefore = await fundFeeFromNoble(ctx, io, osmosis, input);

  const injBefore = await bank(io, "osmosis-1", osmosis, INJ_ON_OSMOSIS);
  const swapped = await sign(io, {
    chainId: "osmosis-1",
    signer: osmosis,
    gas: GAS.swap,
    messages: [{
      type: "/osmosis.poolmanager.v1beta1.MsgSwapExactAmountOut",
      value: {
        sender: osmosis,
        routes: quote.routes,
        token_in_max_amount: quote.amountIn,
        token_out: { denom: INJ_ON_OSMOSIS, amount: quote.amountOut },
      },
    }],
  });
  const usdcAfter = await bank(io, "osmosis-1", osmosis, OSMOSIS_USDC_DENOM);
  const spent = usdcBefore > usdcAfter ? usdcBefore - usdcAfter : 0n;
  const gained = (await bank(io, "osmosis-1", osmosis, INJ_ON_OSMOSIS)) - injBefore;
  if (gained <= 0n) throw new Error(`The Osmosis balance did not increase. ${swapped.hash}`);
  if (fromOsmosis) {
    const take = spent > selected ? selected : spent;
    ctx.amountOsmosis = (selected - take).toString();
  } else if (spent < input) {
    ctx.amountOsmosis = (selected + (input - spent)).toString();
  }

  const bridged = await sign(io, {
    chainId: "osmosis-1",
    signer: osmosis,
    gas: GAS.ibc,
    messages: [transfer(osmosis, OSMOSIS_TO_INJECTIVE, INJ_ON_OSMOSIS, gained, inj, io.now())],
  });
  const arrived = await untilAtLeast(io, io.ibcTimeoutMs ?? IBC_TIMEOUT_MS, needed, () =>
    bank(io, "injective-1", inj, "inj"),
  );
  if (arrived == null) throw new Error(`The Injective balance did not increase. ${bridged.hash}`);
  return `INJ arrived. ${bridged.hash}`;
}

async function nobleBurnQuote(io, holder, avalanche, inj, amount) {
  const { route, msgs } = await circleQuote(io, amount, USDC_NOBLE_DENOM, "noble-1", [holder, avalanche, inj]);
  assertCircleRoute(route);
  const tx = circleMessages(msgs);
  if (tx.signer !== holder) throw new Error("The burn is not signed by the Noble account.");
  return tx;
}

async function burnNoble(ctx, io) {
  const holder = holderOf(ctx);
  const avalanche = addressOf(ctx, "avalanche");
  const inj = ctx.addresses?.userInj || "";
  if (!holder || !avalanche || !inj) throw new Error("A required account is not connected.");
  const findings = ctx.bridgedBurn ? { ...ctx.findings, osmosis: false } : ctx.findings;
  const planned = BigInt(migrateAmount(findings, ctx.amountOut, ctx.amountIn, ctx.amountOsmosis));
  if (planned <= 0n) return "The Noble burn is in the Osmosis transfer.";
  const priced = fee("noble-1", GAS.burn);
  const gasFee = BigInt(priced.amount);
  const held = await bank(io, "noble-1", holder, USDC_NOBLE_DENOM);
  if (held <= gasFee) throw new Error("Noble needs USDC left for the fee.");
  const room = held - gasFee;
  let ask = room < planned ? room : planned;
  if (ask <= 0n) throw new Error("Noble needs USDC left for the fee.");
  let tx = await nobleBurnQuote(io, holder, avalanche, inj, ask.toString());
  let debit = uusdcDebit(tx.messages, holder);
  if (debit + gasFee > held) {
    const next = held - gasFee - (debit - ask);
    if (next <= 0n || next >= ask) throw new Error("Noble needs USDC left for the fee.");
    ask = next;
    tx = await nobleBurnQuote(io, holder, avalanche, inj, ask.toString());
    debit = uusdcDebit(tx.messages, holder);
    if (debit + gasFee > held) throw new Error("Noble needs USDC left for the fee.");
  }
  if (ctx.usdcInjBefore == null) {
    ctx.usdcInjBefore = (await bank(io, "injective-1", inj, INJ_USDC_DENOM)).toString();
  }
  const sent = await sign(io, {
    chainId: "noble-1",
    signer: holder,
    gas: GAS.burn,
    messages: tx.messages,
  });
  ctx.burnHash = sent.hash;
  try {
    await io.fetch(`${SKIP}/v2/tx/track`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx_hash: sent.hash, chain_id: "noble-1" }),
    });
  } catch {
    // Arrival is the Injective balance. A missed track is not a failed burn.
  }
  return `Circle burned the USDC. ${sent.hash}`;
}

async function issueInj(ctx, io) {
  const inj = ctx.addresses?.userInj || "";
  if (!inj) throw new Error("A required account is not connected.");
  const before = BigInt(ctx.usdcInjBefore ?? "0");
  const after = await untilAtLeast(io, io.cctpTimeoutMs ?? CCTP_TIMEOUT_MS, before + 1n, () =>
    bank(io, "injective-1", inj, INJ_USDC_DENOM),
  );
  if (after == null) {
    const hash = ctx.burnHash ? ` The Noble burn was ${ctx.burnHash}.` : "";
    throw new Error(`The Injective balance did not increase.${hash}`);
  }
  ctx.arrivedInj = (after - before).toString();
  return "USDC.inj arrived.";
}

async function penumbraBalance(io) {
  if (!io.penumbraUsdc) throw new Error("Zafu is not connected.");
  const read = await io.penumbraUsdc();
  return {
    noble: BigInt(read.noble ?? read.amount ?? "0"),
    inj: BigInt(read.inj ?? "0"),
    decimals: Number(read.decimals ?? 6),
  };
}

function penumbraText(amount, decimals) {
  return `${formatUnits(amount, decimals)} USDC.inj`;
}

async function deposit(ctx, io) {
  const sender = ctx.addresses?.userInj || addressOf(ctx, "injLeave");
  const receiver = ctx.addresses?.zafu || "";
  if (!sender) throw new Error("A required account is not connected.");
  if (!receiver) throw new Error("Zafu is not connected.");
  const pays = ctx.findings.penumbra || ctx.findings.noble || ctx.findings.osmosis;
  let want = 0n;
  if (pays) want += BigInt(ctx.arrivedInj || "0");
  if (ctx.findings.usdcInj) want += BigInt(ctx.amountHeld || "0");
  const balance = await bank(io, "injective-1", sender, INJ_USDC_DENOM);
  const send = want > balance ? balance : want;
  if (send <= 0n) throw new Error("USDC.inj has not arrived.");
  await requireFee(io, "injective-1", sender, GAS.deposit, "INJ is below the transaction fee.");
  const before = await penumbraBalance(io);
  const sent = await sign(io, {
    chainId: "injective-1",
    signer: sender,
    gas: GAS.deposit,
    messages: [transfer(sender, INJECTIVE_TO_PENUMBRA, INJ_USDC_DENOM, send, receiver, io.now())],
  });
  let latest = before;
  const target = before.inj + 1n;
  const after = await untilAtLeast(io, io.ibcTimeoutMs ?? IBC_TIMEOUT_MS, target, async () => {
    latest = await penumbraBalance(io);
    io.onPenumbra?.({ noble: latest.noble, inj: latest.inj, before: before.inj, decimals: latest.decimals });
    if (latest.inj < target) {
      io.onProgress?.(`Asking Zafu. Penumbra USDC.inj is ${penumbraText(latest.inj, latest.decimals)}.`);
    }
    return latest.inj;
  });
  if (after == null) {
    throw new Error(`The packet has not arrived. Zafu still shows ${penumbraText(latest.inj, latest.decimals)}. ${sent.hash}`);
  }
  io.onPenumbra?.({ noble: latest.noble, inj: after, before: before.inj, decimals: latest.decimals });
  return `Penumbra holds ${penumbraText(after, latest.decimals)}, up from ${penumbraText(before.inj, before.decimals)}. ${sent.hash}`;
}

function amountParts(value) {
  const mask = (1n << 64n) - 1n;
  const amount = BigInt(value);
  return { lo: amount & mask, hi: amount >> 64n };
}

// Unix nanoseconds, ten minutes ahead, rounded down to one minute.
// Penumbra rejects a timestamp that is not a multiple of 60_000_000_000.
function withdrawalTimeout(nowMs) {
  const minute = 60_000_000_000n;
  const nanos = BigInt(Math.floor(nowMs)) * 1_000_000n + 600n * 1_000_000_000n;
  return (nanos / minute) * minute;
}

async function usdcReturn(view) {
  const responses = [];
  for await (const response of view.balances({})) responses.push(response);
  for (const response of responses) {
    const viewValue = response?.balanceView?.valueView;
    if (viewValue?.case !== "knownAssetId") continue;
    const metadata = viewValue.value?.metadata;
    if (metadata?.symbol !== "USDC") continue;
    const match = RETURN_CHANNEL.exec(metadata.base || "");
    if (match) {
      return {
        base: metadata.base,
        channel: match[1],
        assetId: metadata.penumbraAssetId || viewValue.value?.assetId || null,
      };
    }
  }
  throw new Error("Penumbra did not name a return channel for this USDC.");
}

function heldKey(error, address) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message} The Injective account ${address} is still held for this page session.`);
}

async function broadcastWithdrawal(view, io, named, returnAddress, withdrawal, onSent) {
  const timeoutHeight = await nobleWithdrawalHeight(io.channels, io.clients, named.channel);
  const planned = await view.transactionPlanner({
    source: { account: 0 },
    // FeeTier LOW. The reserve above is what the note must still contain.
    feeMode: { case: "autoFee", value: { feeTier: 1 } },
    ics20Withdrawals: [{
      denom: { denom: named.base },
      returnAddress,
      timeoutTime: withdrawalTimeout(io.now()),
      timeoutHeight,
      sourceChannel: named.channel,
      useTransparentAddress: true,
      ...withdrawal,
    }],
  });
  if (!planned?.plan) throw new Error("Zafu did not return a plan.");
  let transaction;
  for await (const update of view.authorizeAndBuild({ transactionPlan: planned.plan })) {
    if (update?.status?.case === "complete") transaction = update.status.value?.transaction;
  }
  if (!transaction) throw new Error("Zafu did not build the withdrawal.");
  let sent = false;
  for await (const update of view.broadcastTransaction({ transaction, awaitDetection: true })) {
    const name = update?.status?.case;
    if (name === "broadcastSuccess" || name === "confirmed") {
      sent = true;
      onSent();
    }
  }
  if (!sent) throw new Error("Zafu did not broadcast the withdrawal.");
}

async function leave(run, ctx, io) {
  const view = io.view;
  if (!view) throw new Error("Zafu is not connected.");
  const osmosis = ctx.addresses?.userOsmosis || "";
  if (!osmosis) throw new Error("A required account is not connected.");
  const receiver = ctx.addresses?.zafu || "";
  if (!receiver) throw new Error("Zafu is not connected.");
  const named = await usdcReturn(view);
  const ephemeral = await view.ephemeralAddress({ addressIndex: { account: 0 } });
  if (!ephemeral?.address) throw new Error("Zafu did not return an address.");
  if (!named.assetId) throw new Error("Penumbra did not price a USDC fee.");
  if (!io.issueHop || !io.signHop || !io.wipeKey) throw new Error("The page cannot hold the Injective key.");
  const hop = await io.issueHop("injective");
  if (!hop?.keyId || !String(hop.address || "").startsWith("inj1") || !hop.ethereum) {
    if (hop?.keyId) await io.wipeKey(hop.keyId);
    throw new Error("The page cannot hold the Injective key.");
  }

  let broadcast = false;
  try {
    const injFee = fee("injective-1", GAS.deposit).amount;
    const quoted = await quoteFee(io, injFee);
    if (quoted.amountOut !== injFee) throw new Error("Osmosis did not quote the INJ swap.");
    if (!view.gasPrices) throw new Error("Penumbra did not price a USDC fee.");
    const priced = matchUsdcPrice(await view.gasPrices({}), named.assetId);
    if (!priced) throw new Error("Penumbra did not price a USDC fee.");
    // Two signatures. Each pays its own fee, so the note keeps two ceilings.
    const parts = splitSlice(run.amounts[run.sliceIndex], quoted.amountIn, feeAmount(priced) * 2n);
    const noble = addressOf(ctx, "noble") || ORBITER;
    const { route, msgs } = await circleQuote(io, parts.migrate, OSMOSIS_USDC_DENOM, "osmosis-1", [
      osmosis,
      noble,
      hop.ethereum,
      hop.address,
    ]);
    assertOsmosisCircleRoute(route);
    if (route.amount_in !== parts.migrate) throw new Error("The transfer does not burn on arrival.");
    const buyMemo = feeSwapMemo(hop.address, injFee);
    const migrateMemo = migrationMemo(msgs, osmosis, parts.migrate);
    io.onProgress?.("Asking Zafu to sign the fee withdrawal.");
    await broadcastWithdrawal(view, io, named, ephemeral.address, {
      amount: amountParts(parts.buy),
      destinationChainAddress: FORWARD_RECEIVER,
      ics20Memo: buyMemo,
    }, () => { broadcast = true; });
    io.onProgress?.("Asking Zafu to sign the migration.");
    await broadcastWithdrawal(view, io, named, ephemeral.address, {
      amount: amountParts(parts.migrate),
      destinationChainAddress: ORBITER,
      ics20Memo: migrateMemo,
    }, () => { broadcast = true; });
  } catch (error) {
    if (!broadcast) {
      await io.wipeKey(hop.keyId);
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} The fee withdrawal was already sent. The Injective account ${hop.address} is still held for this page session.`);
  }

  try {
    const injFee = BigInt(fee("injective-1", GAS.deposit).amount);
    const deadline = io.now() + (io.cctpTimeoutMs ?? CCTP_TIMEOUT_MS);
    let injHeld = 0n;
    let usdcHeld = 0n;
    while (io.now() <= deadline) {
      injHeld = await bank(io, "injective-1", hop.address, "inj");
      usdcHeld = await bank(io, "injective-1", hop.address, INJ_USDC_DENOM);
      if (injHeld >= injFee && usdcHeld >= 1n) break;
      io.onProgress?.(`Waiting for the Injective account. INJ is ${formatUnits(injHeld, 18)}. USDC.inj is ${formatUnits(usdcHeld, 6)}.`);
      await io.sleep(io.intervalMs ?? POLL_MS);
    }
    if (injHeld < injFee || usdcHeld < 1n) {
      throw new Error(`The Injective account did not receive the fee and the USDC. INJ is ${formatUnits(injHeld, 18)}. USDC.inj is ${formatUnits(usdcHeld, 6)}.`);
    }
    const before = await penumbraBalance(io);
    const sent = await io.signHop({
      keyId: hop.keyId,
      chainId: "injective-1",
      signer: hop.address,
      gas: GAS.deposit,
      messages: [transfer(hop.address, INJECTIVE_TO_PENUMBRA, INJ_USDC_DENOM, usdcHeld, receiver, io.now())],
    });
    let latest = before;
    const target = before.inj + 1n;
    const after = await untilAtLeast(io, io.ibcTimeoutMs ?? IBC_TIMEOUT_MS, target, async () => {
      latest = await penumbraBalance(io);
      io.onPenumbra?.({ noble: latest.noble, inj: latest.inj, before: before.inj, decimals: latest.decimals });
      if (latest.inj < target) {
        io.onProgress?.(`Asking Zafu. Penumbra USDC.inj is ${penumbraText(latest.inj, latest.decimals)}.`);
      }
      return latest.inj;
    });
    if (after == null) {
      throw new Error(`The packet has not arrived. Zafu still shows ${penumbraText(latest.inj, latest.decimals)}. ${sent.hash}`);
    }
    await io.wipeKey(hop.keyId);
    return `Penumbra holds ${penumbraText(after, latest.decimals)}, up from ${penumbraText(before.inj, before.decimals)}. ${sent.hash}`;
  } catch (error) {
    throw heldKey(error, hop.address);
  }
}

function nobleText(amount, decimals) {
  return `${formatUnits(amount, decimals)} USDC.noble`;
}

// Dev return. One Osmosis transfer of the denom the page already reads.
// Noble checks the packet receiver before it reads the forward memo. A
// receiver that is not a bech32 address stops the packet there. This packet
// names the connected Noble account. The memo sends that USDC on to the Zafu
// address, on the channel the light client names. Nothing is signed until
// that channel is the only open, active one. If the forward does not run,
// the USDC credits that Noble account.
export async function returnOsmosisToPenumbra(ctx, io) {
  const view = io.view;
  if (!view) throw new Error("Zafu is not connected.");
  const sender = ctx.addresses?.userOsmosis || "";
  if (!sender) throw new Error("A required account is not connected.");
  const receiver = ctx.addresses?.zafu || "";
  if (!receiver.startsWith("penumbra1")) throw new Error("Zafu is not connected.");
  const noble = ctx.addresses?.userNoble || ctx.addresses?.noble || "";
  if (!noble.startsWith("noble1")) throw new Error("A Noble account is not connected.");
  const amount = BigInt(ctx.amountOsmosis || "0");
  if (amount <= 0n) throw new Error("Choose an Osmosis amount.");
  await requireFee(io, "osmosis-1", sender, GAS.hook, "Osmosis gas is short.");
  io.onProgress?.("Asking the light client.");
  const forward = await nobleForwardChannel(view, io.channels, io.clients);
  const before = await penumbraBalance(io);
  const memo = penumbraForwardMemo(receiver, forward.channel);
  io.onProgress?.("Asking Keplr.");
  let sent;
  try {
    sent = await sign(io, {
      chainId: "osmosis-1",
      signer: sender,
      gas: GAS.hook,
      messages: [transfer(sender, OSMOSIS_TO_NOBLE, OSMOSIS_USDC_DENOM, amount, noble, io.now(), memo)],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} The packet was transfer/${OSMOSIS_TO_NOBLE} to ${noble}. Osmosis still holds this USDC.`);
  }
  let latest = before;
  const target = before.noble + 1n;
  const after = await untilAtLeast(io, io.ibcTimeoutMs ?? IBC_TIMEOUT_MS, target, async () => {
    latest = await penumbraBalance(io);
    io.onPenumbra?.({
      noble: latest.noble,
      inj: latest.inj,
      before: before.noble,
      decimals: latest.decimals,
      watch: "noble",
    });
    if (latest.noble < target) {
      io.onProgress?.(`Asking Zafu. Penumbra USDC.noble is ${nobleText(latest.noble, latest.decimals)}.`);
    }
    return latest.noble;
  });
  if (after == null) {
    throw new Error(`The packet has not arrived. Zafu still shows ${nobleText(latest.noble, latest.decimals)}. If Noble did not forward, ${noble} holds the USDC. ${sent.hash}`);
  }
  return `Penumbra holds ${nobleText(after, latest.decimals)}, up from ${nobleText(before.noble, before.decimals)}. ${sent.hash}`;
}

async function wipe(run, io) {
  const count = io.wipeNoted ? await io.wipeNoted(run) : 0;
  if (!count) return "No hop key was issued.";
  return "The page dropped the hop keys.";
}

export async function performStep(step, run, ctx, io) {
  if (step.id === "gather-osmosis") return gatherOsmosis(ctx, io);
  if (step.id === "gather-exit") return gatherExit(ctx, io);
  if (step.id === "gas-osmosis") return gasOsmosis(ctx, io);
  if (step.id === "cctp-noble") return burnNoble(ctx, io);
  if (step.id === "cctp-forward") return issueInj(ctx, io);
  if (step.id === "deposit") return deposit(ctx, io);
  if (step.id === "leave") return leave(run, ctx, io);
  if (step.id === "wipe") return wipe(run, io);
  throw new Error("This page will not sign that message.");
}

function onceState(run, index) {
  if (run.phase === "exit" || run.status === "idle") return "pending";
  if (run.status === "done") return "acked";
  if (run.status === "waiting") return "pending";
  if (run.status === "halted") {
    if (index < run.stepIndex) return "acked";
    if (index === run.stepIndex) return "failed";
    return "pending";
  }
  if (index < run.stepIndex) return "acked";
  if (index === run.stepIndex) return "running";
  return "pending";
}

function leaveState(run, sliceIndex) {
  if (run.status === "waiting" && sliceIndex === run.sliceIndex + 1) return "waiting";
  return stepState(run, sliceIndex, 0);
}

export function present(run, details, ctx) {
  const rows = [];
  if (run.findings.penumbra) {
    for (let index = 0; index < run.slices; index += 1) {
      const described = describeStep("leave", { ...ctx, amountBase: run.amounts[index] });
      rows.push({
        id: "leave",
        title: run.slices > 1 ? `Leave Penumbra, ${index + 1} of ${run.slices}` : "Leave Penumbra",
        state: leaveState(run, index),
        detail: details[`leave:${index}`] || described.detail,
      });
    }
  }
  run.onceSteps.forEach((step, index) => {
    rows.push({
      id: step.id,
      title: step.title,
      state: onceState(run, index),
      detail: details[step.id] || describeStep(step.id, ctx).detail,
    });
  });
  return { status: run.status, halt: run.halt, rows };
}

export async function walkMigration({ input, ctx, io, onUpdate }) {
  let run = reduce(initRun(input), { type: "START" });
  const details = {};
  const publish = () => onUpdate?.(present(run, details, ctx));
  publish();
  try {
    while (run.status === "running" || run.status === "waiting") {
      if (run.status === "waiting") {
        const seconds = drawJitter(io.random, run.jitterMaxSec);
        run = reduce(run, { type: "DRAW_JITTER", seconds });
        publish();
        await io.sleep((run.intervalSec + run.drawnJitterSec) * 1000);
        run = reduce(run, { type: "WAIT_ELAPSED" });
        publish();
        continue;
      }
      run = noteRoles(run, ctx);
      const step = currentStep(run);
      const key = run.phase === "exit" ? `leave:${run.sliceIndex}` : step.id;
      io.onProgress = (detail) => {
        details[key] = detail;
        publish();
      };
      details[key] = await performStep(step, run, ctx, io);
      run = reduce(run, { type: "ACK" });
      publish();
    }
    return run;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (run.status === "running") {
      const key = run.phase === "exit" ? `leave:${run.sliceIndex}` : currentStep(run).id;
      details[key] = message;
    }
    try {
      if (io.wipeNoted) await io.wipeNoted(run);
    } catch {
      // The step error is the one the page shows.
    }
    if (run.status === "running") run = reduce(run, { type: "FAIL", reason: message });
    publish();
    return run;
  }
}
