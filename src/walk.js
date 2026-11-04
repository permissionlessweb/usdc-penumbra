// Begin walks the plan. Each step signs with the connected Keplr account, or
// asks Zafu to broadcast a withdrawal. A step is acknowledged only after the
// balance it should change has changed. A failure stops the queue.

import {
  FORWARD_RECEIVER,
  osmosisUsdcMemo,
  feeAmount,
  matchUsdcPrice,
  migrationMemo,
  penumbraForwardMemo,
  splitSlice,
} from "./batch.js";
import { LCD, formatUnits, readDenom } from "./balances.js";
import {
  AXELAR_GMP_ACCOUNT,
  OSMOSIS_TO_AXELAR,
  avaxBudget,
  axelarNativeMemo,
  estimateUrl,
} from "./axelar.js";
import {
  AVALANCHE_TOKEN_MESSENGER_V2,
  AVALANCHE_USDC,
  ORBITER,
  bytesToBase64,
  ethereumBytes32,
  nobleBurnMessage,
  orbiterMemo,
  readIris,
} from "./circle.js";
import {
  AVALANCHE_MESSAGE_TRANSMITTER_V1,
  AVALANCHE_RPC,
  AVAX_GAS_MULTIPLE,
  RELAY_GAS,
  allowanceCalldata,
  approveCalldata,
  balanceOfCalldata,
  bytesToHex,
  depositForBurnCalldata,
  ethCall,
  relayBudget,
  hexToBytes,
  preflightReceiveMessage,
  sendContract,
} from "./evm.js";
import { USDC_FEE_BUFFER, feeTokenAmount, preferredFeeDenom, readSpot } from "./fees.js";
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
  WAVAX_ON_OSMOSIS,
  describeStep,
  migrateAmount,
  pileRole,
} from "./route.js";
import { GAS, fee, signAndBroadcast, transferTimeout } from "./tx.js";
import { nobleForwardChannel, nobleWithdrawalHeight } from "./zafu.js";

const IBC_TIMEOUT_MS = 6 * 60 * 1000;
const CCTP_TIMEOUT_MS = 8 * 60 * 1000;
const POLL_MS = 4000;
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

async function sign(io, { chainId, signer, messages, gas, feeAmount, onSubmitted }) {
  const sent = await signAndBroadcast({
    keplr: io.keplr,
    fetchImpl: io.fetch,
    chainId,
    signer,
    messages,
    feeAmount: feeAmount || fee(chainId, gas),
    lcd: LCD[chainId],
    wait: clock(io, io.txTimeoutMs ?? 90_000),
    onSubmitted(hash) {
      onSubmitted?.(hash);
      io.onProgress?.(`Submitted ${hash}. Waiting for ${chainPlace(chainId)}.`);
    },
  });
  try {
    await io.onAccount?.();
  } catch {
    // A balance refresh is not the transfer.
  }
  return sent;
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

export function routesFromExactOut(quote, outDenom = INJ_ON_OSMOSIS) {
  const label = outDenom === WAVAX_ON_OSMOSIS ? "AVAX" : "INJ";
  const reject = () => {
    throw new Error(label === "AVAX" ? "Osmosis did not quote the AVAX swap." : "Osmosis did not quote the INJ swap.");
  };
  const groups = Array.isArray(quote?.route) ? quote.route : [];
  if (groups.length !== 1) reject();
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
  if (!routes.length || !/^\d+$/.test(amountIn) || !/^\d+$/.test(outAmount)) reject();
  if (BigInt(amountIn) <= 0n || BigInt(outAmount) <= 0n) reject();
  if (out?.denom !== outDenom) {
    throw new Error(label === "AVAX" ? "The quote does not pay AVAX." : "The quote does not pay INJ.");
  }
  if (routes[0].token_in_denom !== OSMOSIS_USDC_DENOM) reject();
  return { routes, amountIn, amountOut: outAmount };
}

async function quoteExactOut(io, amount, outDenom) {
  const asked = amount.toString();
  if (io.quote) return routesFromExactOut(await io.quote(asked, outDenom), outDenom);
  const url = new URL(`${SQS}/router/quote`);
  url.searchParams.set("tokenOut", `${asked}${outDenom}`);
  url.searchParams.set("tokenInDenom", OSMOSIS_USDC_DENOM);
  url.searchParams.set("singleRoute", "true");
  const response = await io.fetch(url);
  if (!response.ok) {
    const label = outDenom === WAVAX_ON_OSMOSIS ? "AVAX" : "INJ";
    throw new Error(`The ${label} quote failed (${response.status}).`);
  }
  return routesFromExactOut(await response.json(), outDenom);
}

async function quoteFee(io, shortfall) {
  return quoteExactOut(io, shortfall, INJ_ON_OSMOSIS);
}

function mintRecipientOf(ctx) {
  if (ctx.depositHop?.ethereum) return ctx.depositHop.ethereum;
  return addressOf(ctx, "avalanche");
}

function depositAccount(ctx) {
  return ctx.depositHop?.address || ctx.addresses?.userInj || "";
}

async function listedBalances(io, sender) {
  const fallback = async () => [
    { denom: OSMOSIS_USDC_DENOM, amount: (await bank(io, "osmosis-1", sender, OSMOSIS_USDC_DENOM)).toString() },
    { denom: "uosmo", amount: (await bank(io, "osmosis-1", sender, "uosmo")).toString() },
  ];
  try {
    const url = new URL(`${LCD["osmosis-1"]}/cosmos/bank/v1beta1/balances/${sender}`);
    url.searchParams.set("pagination.limit", "1000");
    const response = await io.fetch(url);
    if (!response.ok) return fallback();
    const body = await response.json();
    if (!Array.isArray(body.balances)) return fallback();
    return body.balances;
  } catch {
    return fallback();
  }
}

async function osmosisFeeCoin(io, sender, gas) {
  const base = fee("osmosis-1", gas);
  const coins = await listedBalances(io, sender);
  if (preferredFeeDenom(coins) === OSMOSIS_USDC_DENOM) {
    try {
      const spot = await readSpot(io.fetch, OSMOSIS_USDC_DENOM);
      const amount = feeTokenAmount(base.amount, spot);
      const held = coins.find((coin) => coin.denom === OSMOSIS_USDC_DENOM);
      if (held && BigInt(held.amount) >= amount) {
        return { denom: OSMOSIS_USDC_DENOM, amount: amount.toString(), gas: base.gas };
      }
    } catch {
      // A missing spot price leaves the base denom as the fee.
    }
  }
  const held = coins.find((coin) => coin.denom === "uosmo");
  if (held && BigInt(held.amount) >= BigInt(base.amount)) return base;
  throw new Error("Osmosis gas is short.");
}

function sendable(requested, held, priced, denom) {
  const feePaid = priced?.denom === denom ? BigInt(priced.amount) : 0n;
  // One cent stays. The priced USDC fee is taken from that cent.
  let reserve = feePaid;
  if (denom === OSMOSIS_USDC_DENOM && held > USDC_FEE_BUFFER && reserve < USDC_FEE_BUFFER) {
    reserve = USDC_FEE_BUFFER;
  }
  if (held <= reserve) return 0n;
  const room = held - reserve;
  return requested < room ? requested : room;
}

function noteUsdcSpent(ctx, before, after, fromOsmosis, input) {
  const spent = before > after ? before - after : 0n;
  const selected = BigInt(ctx.amountOsmosis || "0");
  if (fromOsmosis) {
    const take = spent > selected ? selected : spent;
    ctx.amountOsmosis = (selected - take).toString();
  } else if (spent < input) {
    ctx.amountOsmosis = (selected + (input - spent)).toString();
  }
  return spent;
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

async function gatherOsmosis(ctx, io) {
  const amount = BigInt(ctx.amountOsmosis || "0");
  if (amount <= 0n) return "Osmosis USDC was used for the Injective fee.";
  const sender = ctx.addresses?.userOsmosis || "";
  const avalanche = mintRecipientOf(ctx);
  const inj = depositAccount(ctx);
  if (!sender || !avalanche || !inj) throw new Error("A required account is not connected.");
  const priced = await osmosisFeeCoin(io, sender, GAS.hook);
  const held = await bank(io, "osmosis-1", sender, OSMOSIS_USDC_DENOM);
  const sendAmount = sendable(amount, held, priced, OSMOSIS_USDC_DENOM);
  if (sendAmount <= 0n) throw new Error("Osmosis gas is short.");
  const message = transfer(
    sender,
    OSMOSIS_TO_NOBLE,
    OSMOSIS_USDC_DENOM,
    sendAmount,
    ORBITER,
    io.now(),
    orbiterMemo(avalanche),
  );
  ctx.usdcInjBefore = (await bank(io, "injective-1", inj, INJ_USDC_DENOM)).toString();
  const sent = await sign(io, {
    chainId: "osmosis-1",
    signer: sender,
    gas: GAS.hook,
    feeAmount: priced,
    messages: [message],
  });
  ctx.bridgedBurn = true;
  ctx.burnHash = sent.hash;
  ctx.burnAmount = sendAmount.toString();
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

function exactOutSwap(sender, quote, outDenom) {
  return {
    type: "/osmosis.poolmanager.v1beta1.MsgSwapExactAmountOut",
    value: {
      sender,
      routes: quote.routes,
      token_in_max_amount: quote.amountIn,
      token_out: { denom: outDenom, amount: quote.amountOut },
    },
  };
}

async function rpcQuantity(io, url, method) {
  const response = await io.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
  });
  if (!response.ok) throw new Error("Avalanche gas price was not read.");
  const body = await response.json();
  const result = body?.result;
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]+$/.test(result)) {
    throw new Error("Avalanche gas price was not read.");
  }
  return BigInt(result);
}

async function axelarFee(io) {
  const response = await io.fetch(estimateUrl());
  if (!response.ok) throw new Error("Axelar did not price the Avalanche relay.");
  const text = String(await response.text()).trim().replace(/^"|"$/g, "");
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) throw new Error("Axelar did not price the Avalanche relay.");
  return text;
}

async function avaxTarget(io) {
  const price = await rpcQuantity(io, "https://api.avax.network/ext/bc/C/rpc", "eth_gasPrice");
  const relayFee = await axelarFee(io);
  const out = avaxBudget(price, RELAY_GAS * AVAX_GAS_MULTIPLE, relayFee);
  return { relayFee, out };
}

async function quotedAvax(io) {
  const target = await avaxTarget(io);
  const quote = await quoteExactOut(io, target.out, WAVAX_ON_OSMOSIS);
  if (BigInt(quote.amountOut) !== target.out) throw new Error("Osmosis did not quote the AVAX swap.");
  return { ...target, quote };
}

async function holdHop(ctx, io) {
  if (!io.issueHop || !io.wipeKey) throw new Error("The page cannot hold the Injective key.");
  const hop = await io.issueHop("injective");
  if (!hop?.keyId || !String(hop.address || "").startsWith("inj1") || !hop.ethereum) {
    if (hop?.keyId) await io.wipeKey(hop.keyId);
    throw new Error("The page cannot hold the Injective key.");
  }
  ctx.depositHop = hop;
  io.onHop?.({ address: hop.address, ethereum: hop.ethereum, inj: 0n, usdc: 0n, avax: null });
  return hop;
}

async function injLeg(io, osmosis) {
  const needed = BigInt(fee("injective-1", GAS.deposit).amount);
  const held = await bank(io, "osmosis-1", osmosis, INJ_ON_OSMOSIS);
  const injQuote = held >= needed ? null : await quoteFee(io, needed);
  if (injQuote && BigInt(injQuote.amountOut) !== needed) throw new Error("Osmosis did not quote the INJ swap.");
  return { needed, injQuote, injInput: injQuote ? BigInt(injQuote.amountIn) : 0n };
}

async function avaxLeg(io, osmosis) {
  const avax = await avaxTarget(io);
  const held = await bank(io, "osmosis-1", osmosis, WAVAX_ON_OSMOSIS);
  const avaxQuote = held >= avax.out ? null : await quoteExactOut(io, avax.out, WAVAX_ON_OSMOSIS);
  if (avaxQuote && BigInt(avaxQuote.amountOut) !== avax.out) throw new Error("Osmosis did not quote the AVAX swap.");
  return { avax, avaxQuote, avaxInput: avaxQuote ? BigInt(avaxQuote.amountIn) : 0n };
}

function legGas(legs) {
  const messages = (legs.injQuote ? 1 : 0) + 1 + (legs.avaxQuote ? 1 : 0) + 1;
  return GAS.ibc * messages;
}

// USDC the Penumbra slice must forward when Osmosis cannot pay this gas in uosmo.
async function sliceGasUsdc(io, osmosis, gas) {
  const base = fee("osmosis-1", gas);
  const uosmo = await bank(io, "osmosis-1", osmosis, "uosmo");
  if (uosmo >= BigInt(base.amount)) return 0n;
  try {
    const spot = await readSpot(io.fetch, OSMOSIS_USDC_DENOM);
    return feeTokenAmount(base.amount, spot);
  } catch {
    throw new Error("Osmosis gas is short.");
  }
}

// One Osmosis transaction. A denom already held is bridged and not swapped.
// trackSelection is false when the USDC was forwarded from Penumbra.
async function bridgeGas(ctx, io, hop, legs, trackSelection) {
  const osmosis = ctx.addresses?.userOsmosis || "";
  const { needed, injQuote, injInput, avax, avaxQuote, avaxInput } = legs;
  let total = injInput + avaxInput;
  const messages = [];
  if (injQuote) messages.push(exactOutSwap(osmosis, injQuote, INJ_ON_OSMOSIS));
  messages.push(transfer(
    osmosis,
    OSMOSIS_TO_INJECTIVE,
    INJ_ON_OSMOSIS,
    injQuote ? injQuote.amountOut : needed,
    hop.address,
    io.now(),
  ));
  if (avaxQuote) messages.push(exactOutSwap(osmosis, avaxQuote, WAVAX_ON_OSMOSIS));
  messages.push(transfer(
    osmosis,
    OSMOSIS_TO_AXELAR,
    WAVAX_ON_OSMOSIS,
    avaxQuote ? avaxQuote.amountOut : avax.out,
    AXELAR_GMP_ACCOUNT,
    io.now(),
    axelarNativeMemo(hop.ethereum, avax.relayFee),
  ));
  const buyGas = GAS.ibc * messages.length;
  const swapFee = await osmosisFeeCoin(io, osmosis, buyGas);
  if (swapFee.denom === OSMOSIS_USDC_DENOM) total += BigInt(swapFee.amount);
  const selected = BigInt(ctx.amountOsmosis || "0");
  const live = await bank(io, "osmosis-1", osmosis, OSMOSIS_USDC_DENOM);
  const covered = selected < live ? selected : live;
  // A Penumbra forward is not the selected Osmosis amount. The live balance pays it.
  const fromOsmosis = (trackSelection ? covered : live) >= total;
  let usdcBefore = live;
  if (!fromOsmosis && total > 0n) {
    if (!trackSelection) throw new Error("Osmosis did not receive the fee slice.");
    usdcBefore = await fundFeeFromNoble(ctx, io, osmosis, total);
  }
  const bought = await sign(io, {
    chainId: "osmosis-1",
    signer: osmosis,
    gas: buyGas,
    feeAmount: swapFee,
    onSubmitted() { ctx.hopBroadcast = true; },
    messages,
  });
  if (trackSelection) {
    noteUsdcSpent(
      ctx,
      usdcBefore,
      await bank(io, "osmosis-1", osmosis, OSMOSIS_USDC_DENOM),
      fromOsmosis,
      injInput + avaxInput,
    );
  }
  const arrived = await untilAtLeast(io, io.ibcTimeoutMs ?? IBC_TIMEOUT_MS, needed, () =>
    bank(io, "injective-1", hop.address, "inj"),
  );
  if (arrived == null) throw new Error(`The Injective balance did not increase. ${bought.hash}`);
  return `INJ arrived. Axelar relays the AVAX. ${bought.hash}`;
}

async function gasOsmosis(ctx, io) {
  const osmosis = ctx.addresses?.userOsmosis || "";
  const userInj = ctx.addresses?.userInj || "";
  if (!osmosis || !userInj) throw new Error("A required account is not connected.");
  // Upper bound: two swaps and two bridges. A token already on Osmosis skips its swap.
  await osmosisFeeCoin(io, osmosis, GAS.swap + GAS.swap + GAS.ibc + GAS.ibc);

  const bought = await injLeg(io, osmosis);
  const selected = BigInt(ctx.amountOsmosis || "0");
  const live = await bank(io, "osmosis-1", osmosis, OSMOSIS_USDC_DENOM);
  const covered = selected < live ? selected : live;
  if (bought.injInput > 0n && covered < bought.injInput && nobleBudget(ctx) < bought.injInput) {
    throw new Error("The selected USDC cannot buy the Injective fee.");
  }
  const priced = await avaxLeg(io, osmosis);
  const hop = await holdHop(ctx, io);
  return bridgeGas(ctx, io, hop, { ...bought, ...priced }, true);
}

async function burnNoble(ctx, io) {
  const holder = holderOf(ctx);
  const avalanche = mintRecipientOf(ctx);
  const inj = depositAccount(ctx);
  if (!holder || !avalanche || !inj) throw new Error("A required account is not connected.");
  const findings = ctx.bridgedBurn ? { ...ctx.findings, osmosis: false } : ctx.findings;
  const planned = BigInt(migrateAmount(findings, ctx.amountOut, ctx.amountIn, ctx.amountOsmosis));
  if (planned <= 0n) return "The Noble burn is in the Osmosis transfer.";
  const priced = fee("noble-1", GAS.burn);
  const gasFee = BigInt(priced.amount);
  const held = await bank(io, "noble-1", holder, USDC_NOBLE_DENOM);
  if (held <= gasFee) throw new Error("Noble needs USDC left for the fee.");
  const room = held - gasFee;
  const ask = room < planned ? room : planned;
  if (ask <= 0n) throw new Error("Noble needs USDC left for the fee.");
  if (ctx.usdcInjBefore == null) {
    ctx.usdcInjBefore = (await bank(io, "injective-1", inj, INJ_USDC_DENOM)).toString();
  }
  const sent = await sign(io, {
    chainId: "noble-1",
    signer: holder,
    gas: GAS.burn,
    messages: [nobleBurnMessage(holder, ask.toString(), avalanche)],
  });
  ctx.burnHash = sent.hash;
  return `Circle burned the USDC. ${sent.hash}`;
}

function decodeAttr(value) {
  const text = String(value ?? "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0 || text.length < 4) return text;
  try {
    const decoded = atob(text);
    if (/^[\t\n\r\x20-\x7e]+$/.test(decoded)) return decoded;
  } catch {
    // The attribute was already plain text.
  }
  return text;
}

function txEvents(body) {
  const tx = body?.tx_response || body?.txResponse || body;
  return tx?.events || [];
}

async function packetSequence(io, hash) {
  const response = await io.fetch(`${LCD["osmosis-1"]}/cosmos/tx/v1beta1/txs/${hash}`);
  if (!response.ok) return "";
  const body = await response.json();
  for (const event of txEvents(body)) {
    if (event.type !== "send_packet") continue;
    const attrs = {};
    for (const attr of event.attributes || []) attrs[decodeAttr(attr.key)] = decodeAttr(attr.value);
    if (attrs.packet_src_channel === OSMOSIS_TO_NOBLE && /^\d+$/.test(attrs.packet_sequence || "")) {
      return attrs.packet_sequence;
    }
  }
  return "";
}

async function nobleRecvHash(io, sequence) {
  const url = new URL(`${LCD["noble-1"]}/cosmos/tx/v1beta1/txs`);
  url.searchParams.set("query", `recv_packet.packet_dst_channel='${NOBLE_TO_OSMOSIS}' AND recv_packet.packet_sequence='${sequence}'`);
  url.searchParams.set("limit", "1");
  const response = await io.fetch(url);
  if (!response.ok) return "";
  const body = await response.json();
  const txs = body.tx_responses || body.txResponses || [];
  const hash = String(txs[0]?.txhash || txs[0]?.tx_hash || "");
  return /^(0x)?[0-9a-fA-F]{64}$/.test(hash) ? hash : "";
}

function messageSent(body) {
  for (const event of txEvents(body)) {
    if (event.type !== "circle.cctp.v1.MessageSent") continue;
    for (const attr of event.attributes || []) {
      if (decodeAttr(attr.key) !== "message") continue;
      let value = String(attr.value || "").trim();
      if (value.startsWith('"')) {
        try { value = JSON.parse(value); } catch { /* The value was already plain. */ }
      }
      if (typeof value !== "string") continue;
      if (/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) return hexToBytes(value);
      try {
        const raw = atob(value);
        const out = new Uint8Array(raw.length);
        for (let index = 0; index < raw.length; index += 1) out[index] = raw.charCodeAt(index);
        if (out.length) return out;
      } catch {
        // The attribute was not the message bytes.
      }
    }
  }
  return null;
}

function ackError(body) {
  for (const event of txEvents(body)) {
    if (event.type !== "write_acknowledgement") continue;
    const attrs = {};
    for (const attr of event.attributes || []) attrs[decodeAttr(attr.key)] = decodeAttr(attr.value);
    const ack = attrs.packet_ack || "";
    if (!ack.includes("error")) continue;
    try {
      const parsed = JSON.parse(ack);
      if (parsed.error) return String(parsed.error);
    } catch {
      return ack;
    }
  }
  return "";
}

async function rememberNobleBurn(ctx, io, hash) {
  const response = await io.fetch(`${LCD["noble-1"]}/cosmos/tx/v1beta1/txs/${hash}`);
  if (response.ok) {
    const body = await response.json();
    const reason = ackError(body);
    if (reason) throw new Error(`Noble did not burn the USDC. ${reason}`);
    const message = messageSent(body);
    if (message) ctx.cctpMessage = message;
  }
  ctx.nobleBurnHash = hash;
}

// The Penumbra migration burns on Noble receive. The mint recipient is this hop.
async function nobleBurnByMintRecipient(io, ethereum) {
  const recipient = bytesToBase64(ethereumBytes32(ethereum));
  const url = new URL(`${LCD["noble-1"]}/cosmos/tx/v1beta1/txs`);
  url.searchParams.set("query", `circle.cctp.v1.DepositForBurn.mint_recipient='${recipient}'`);
  url.searchParams.set("limit", "1");
  url.searchParams.set("order_by", "ORDER_BY_DESC");
  const response = await io.fetch(url);
  if (!response.ok) return "";
  const body = await response.json();
  const txs = body.tx_responses || body.txResponses || [];
  const hash = String(txs[0]?.txhash || txs[0]?.tx_hash || "");
  return /^(0x)?[0-9a-fA-F]{64}$/.test(hash) ? hash : "";
}

async function nobleBurnHash(ctx, io) {
  if (ctx.nobleBurnHash) return ctx.nobleBurnHash;
  if (ctx.burnLookup === "recipient") {
    const ethereum = ctx.depositHop?.ethereum || "";
    if (!ethereum) return "";
    const hash = await nobleBurnByMintRecipient(io, ethereum);
    if (!hash) return "";
    await rememberNobleBurn(ctx, io, hash);
    return ctx.nobleBurnHash;
  }
  if (!ctx.bridgedBurn) {
    ctx.nobleBurnHash = ctx.burnHash || "";
    return ctx.nobleBurnHash;
  }
  if (!ctx.burnHash) return "";
  const sequence = await packetSequence(io, ctx.burnHash);
  if (!sequence) return "";
  const hash = await nobleRecvHash(io, sequence);
  if (!hash) return "";
  await rememberNobleBurn(ctx, io, hash);
  return ctx.nobleBurnHash;
}

async function cctpMessage(ctx, io, hash) {
  if (ctx.cctpMessage) return ctx.cctpMessage;
  const response = await io.fetch(`${LCD["noble-1"]}/cosmos/tx/v1beta1/txs/${hash}`);
  if (!response.ok) return null;
  const message = messageSent(await response.json());
  if (message) ctx.cctpMessage = message;
  return message;
}

async function hopBalances(io, hop) {
  if (!hop?.address) return null;
  const inj = await bank(io, "injective-1", hop.address, "inj");
  const usdc = await bank(io, "injective-1", hop.address, INJ_USDC_DENOM);
  let avax = null;
  if (hop.ethereum) {
    try {
      const response = await io.fetch(AVALANCHE_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [hop.ethereum, "latest"] }),
      });
      const body = await response.json();
      if (typeof body?.result === "string" && /^0x[0-9a-fA-F]+$/.test(body.result)) avax = BigInt(body.result);
    } catch {
      avax = null;
    }
  }
  return { address: hop.address, ethereum: hop.ethereum || "", inj, usdc, avax };
}

async function submitAvalanche(ctx, io, to, data) {
  const hop = ctx.depositHop;
  if (hop) {
    if (!hop.ethereum || !hop.keyId || !io.signDigest) return null;
    const balances = await hopBalances(io, hop);
    if (!balances?.avax) return null;
    return sendContract({
      fetchImpl: io.fetch,
      from: hop.ethereum,
      to,
      data,
      signDigest: (digest) => io.signDigest(hop.keyId, digest),
    });
  }
  const ethereum = io.ethereum;
  if (!ethereum?.request) return null;
  const accounts = await ethereum.request({ method: "eth_requestAccounts" });
  const from = Array.isArray(accounts) ? accounts[0] : "";
  if (!from) return null;
  const hash = await ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from, to, data, chainId: "0xa86a" }],
  });
  return hash ? { hash: String(hash) } : null;
}

async function mintedUsdc(io, account) {
  const data = bytesToHex(balanceOfCalldata(account));
  const result = await ethCall(io.fetch, AVALANCHE_USDC, data);
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]+$/.test(result)) return 0n;
  return BigInt(result);
}

async function usdcAllowance(io, owner) {
  const data = bytesToHex(allowanceCalldata(owner, AVALANCHE_TOKEN_MESSENGER_V2));
  const result = await ethCall(io.fetch, AVALANCHE_USDC, data);
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]+$/.test(result)) return 0n;
  return BigInt(result);
}

async function issueInj(ctx, io) {
  const inj = depositAccount(ctx);
  if (!inj) throw new Error("A required account is not connected.");
  const before = BigInt(ctx.usdcInjBefore ?? "0");
  const timeout = io.cctpTimeoutMs ?? CCTP_TIMEOUT_MS;
  const start = io.now();
  let attempt = 0;
  while (io.now() - start <= timeout) {
    attempt += 1;
    const held = await bank(io, "injective-1", inj, INJ_USDC_DENOM);
    const hop = await hopBalances(io, ctx.depositHop);
    if (hop) io.onHop?.(hop);
    if (held >= before + 1n) {
      ctx.arrivedInj = (held - before).toString();
      return "USDC.inj arrived.";
    }
    const hash = await nobleBurnHash(ctx, io);
    const hopText = hop
      ? ` INJ ${formatUnits(hop.inj, 18)}. AVAX ${hop.avax == null ? "not read" : formatUnits(hop.avax, 18)}. USDC.inj ${formatUnits(hop.usdc, 6)}.`
      : "";
    const message = hash ? await cctpMessage(ctx, io, hash) : null;
    if (!hash || !message) {
      io.onProgress?.(`Checking the mint, attempt ${attempt}. Waiting for the Noble burn.${hopText}`);
    } else {
      try {
        const attested = await readIris(io.fetch, message);
        ctx.attestation = attested;
        if (!ctx.avalancheMintSent) {
          try {
            const preflight = await preflightReceiveMessage(io.fetch, attested);
            const sent = await submitAvalanche(ctx, io, preflight.to || AVALANCHE_MESSAGE_TRANSMITTER_V1, preflight.data);
            if (sent) {
              ctx.avalancheMintSent = true;
              io.onProgress?.(`Submitted the Avalanche mint. ${sent.hash}`);
            } else {
              io.onProgress?.(`Waiting for AVAX on the ephemeral account.${hopText}`);
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (/nonce already used/i.test(reason)) {
              ctx.avalancheMintSent = true;
              io.onProgress?.(`The Avalanche mint is already in.${hopText}`);
            } else {
              io.onProgress?.(`Checking the mint, attempt ${attempt}. ${reason}`);
            }
          }
        }
        if (ctx.avalancheMintSent && !ctx.avalancheBurnSent) {
          try {
            const recipient = mintRecipientOf(ctx);
            const minted = await mintedUsdc(io, recipient);
            if (minted <= 0n) {
              io.onProgress?.(`Waiting for the minted USDC on the ephemeral account.${hopText}`);
            } else {
              const allowance = await usdcAllowance(io, recipient);
              const burnData = bytesToHex(depositForBurnCalldata({
                amount: minted,
                mintRecipient: recipient,
              }));
              const approveData = bytesToHex(approveCalldata(AVALANCHE_TOKEN_MESSENGER_V2, minted));
              const funded = hop?.avax;
              const calls = allowance < minted
                ? [{ to: AVALANCHE_USDC, data: approveData }, { to: AVALANCHE_TOKEN_MESSENGER_V2, data: burnData }]
                : [{ to: AVALANCHE_TOKEN_MESSENGER_V2, data: burnData }];
              const budget = await relayBudget(io.fetch, recipient, calls);
              if (funded != null && funded < budget.cost) {
                io.onProgress?.(`Waiting for AVAX on the ephemeral account. The next steps need ${formatUnits(budget.cost, 18)} AVAX.${hopText}`);
              } else if (allowance < minted) {
                const approved = await submitAvalanche(ctx, io, AVALANCHE_USDC, approveData);
                if (approved) io.onProgress?.(`Submitted the USDC approval. ${approved.hash}`);
                else io.onProgress?.(`Waiting for AVAX on the ephemeral account.${hopText}`);
              } else {
                const burned = await submitAvalanche(ctx, io, AVALANCHE_TOKEN_MESSENGER_V2, burnData);
                if (burned) {
                  ctx.avalancheBurnSent = true;
                  io.onProgress?.(`Submitted the burn toward Injective. ${burned.hash}`);
                } else {
                  io.onProgress?.(`Waiting for AVAX on the ephemeral account.${hopText}`);
                }
              }
            }
          } catch (error) {
            io.onProgress?.(error instanceof Error ? error.message : String(error));
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        io.onProgress?.(
          /not attested/.test(message)
            ? `Checking Circle, attempt ${attempt}. Waiting for Circle to attest the Noble burn.${hopText}`
            : message,
        );
      }
    }
    await io.sleep(io.intervalMs ?? POLL_MS);
  }
  const shown = ctx.nobleBurnHash || (!ctx.bridgedBurn ? ctx.burnHash : "");
  const named = shown ? ` The Noble burn was ${shown}.` : "";
  throw new Error(`The Injective balance did not increase.${named}`);
}

function closedConnection(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /connection closed/i.test(message);
}

async function penumbraBalance(io) {
  let last = new Error("Zafu is not connected.");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (!io.penumbraUsdc) throw new Error("Zafu is not connected.");
      const read = await io.penumbraUsdc();
      return {
        noble: BigInt(read.noble ?? read.amount ?? "0"),
        inj: BigInt(read.inj ?? "0"),
        decimals: Number(read.decimals ?? 6),
      };
    } catch (error) {
      last = error;
      if (!closedConnection(error) || attempt === 2) break;
      io.onProgress?.("Zafu closed the connection. Asking again.");
      try {
        await io.reconnectZafu?.();
      } catch {
        // The next read reports the closed connection.
      }
      await io.sleep(io.intervalMs ?? POLL_MS);
    }
  }
  throw last;
}

function penumbraText(amount, decimals) {
  return `${formatUnits(amount, decimals)} USDC.inj`;
}

export async function deposit(ctx, io) {
  const hop = ctx.depositHop;
  const sender = hop?.address || ctx.addresses?.userInj || addressOf(ctx, "injLeave");
  const receiver = ctx.addresses?.zafu || "";
  if (!sender) throw new Error("A required account is not connected.");
  if (!receiver) throw new Error("Zafu is not connected.");
  const pays = ctx.findings.penumbra || ctx.findings.noble || ctx.findings.osmosis;
  const balance = await bank(io, "injective-1", sender, INJ_USDC_DENOM);
  let want = 0n;
  if (ctx.finishHeld) want = balance;
  else {
    if (pays) want += BigInt(ctx.arrivedInj || "0");
    if (ctx.findings.usdcInj) want += BigInt(ctx.amountHeld || "0");
  }
  const send = want > balance ? balance : want;
  if (send <= 0n) throw new Error("USDC.inj has not arrived.");
  await requireFee(io, "injective-1", sender, GAS.deposit, "INJ is below the transaction fee.");
  const before = await penumbraBalance(io);
  const messages = [transfer(sender, INJECTIVE_TO_PENUMBRA, INJ_USDC_DENOM, send, receiver, io.now())];
  const sent = hop?.keyId
    ? await io.signHop({
      keyId: hop.keyId,
      chainId: "injective-1",
      signer: sender,
      gas: GAS.deposit,
      messages,
    })
    : await sign(io, {
      chainId: "injective-1",
      signer: sender,
      gas: GAS.deposit,
      messages,
    });
  let latest = before;
  const target = before.inj + 1n;
  const after = await untilAtLeast(io, io.ibcTimeoutMs ?? IBC_TIMEOUT_MS, target, async () => {
    try {
      latest = await penumbraBalance(io);
    } catch (error) {
      if (!closedConnection(error)) throw error;
      io.onProgress?.("Zafu closed the connection. The Injective transfer stays signed.");
      return latest.inj;
    }
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
  if (hop?.keyId && io.wipeKey) {
    await io.wipeKey(hop.keyId);
    ctx.depositHop = null;
  }
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
  let buy = 0n;
  let legs = null;
  let usdcBefore = 0n;
  const osmosis = ctx.addresses?.userOsmosis || "";
  try {
    if (!osmosis.startsWith("osmo1")) throw new Error("The Osmosis account is not connected.");
    const bought = await injLeg(io, osmosis);
    const pricedAvax = await avaxLeg(io, osmosis);
    legs = { ...bought, ...pricedAvax };
    if (!view.gasPrices) throw new Error("Penumbra did not price a USDC fee.");
    const priced = matchUsdcPrice(await view.gasPrices({}), named.assetId);
    if (!priced) throw new Error("Penumbra did not price a USDC fee.");
    const usdcFee = await sliceGasUsdc(io, osmosis, legGas(legs));
    buy = legs.injInput + legs.avaxInput + usdcFee;
    const slice = run.amounts[run.sliceIndex];
    const penumbraFee = feeAmount(priced);
    const parts = buy > 0n
      ? splitSlice(slice, buy, penumbraFee * 2n)
      : (() => {
        const total = BigInt(slice);
        if (total <= penumbraFee) throw new Error("This slice cannot buy the Injective fee.");
        return { buy: "0", migrate: (total - penumbraFee).toString() };
      })();
    const migrateMemo = migrationMemo(hop.ethereum);
    usdcBefore = await bank(io, "osmosis-1", osmosis, OSMOSIS_USDC_DENOM);
    if (buy > 0n) {
      io.onProgress?.("Asking Zafu to sign the fee withdrawal.");
      await broadcastWithdrawal(view, io, named, ephemeral.address, {
        amount: amountParts(parts.buy),
        destinationChainAddress: FORWARD_RECEIVER,
        ics20Memo: osmosisUsdcMemo(osmosis),
      }, () => { broadcast = true; });
    }
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

  ctx.depositHop = hop;
  ctx.hopBroadcast = true;
  io.onHop?.({ address: hop.address, ethereum: hop.ethereum, inj: 0n, usdc: 0n, avax: null });
  try {
    const injFee = BigInt(fee("injective-1", GAS.deposit).amount);
    let injHeld = await bank(io, "injective-1", hop.address, "inj");
    let usdcHeld = await bank(io, "injective-1", hop.address, INJ_USDC_DENOM);
    if (injHeld < injFee || usdcHeld < 1n) {
      if (buy > 0n) {
        io.onProgress?.(`Waiting for ${formatUnits(buy, 6)} USDC on Osmosis.`);
        const landed = await untilAtLeast(
          io,
          io.ibcTimeoutMs ?? IBC_TIMEOUT_MS,
          usdcBefore + buy,
          () => bank(io, "osmosis-1", osmosis, OSMOSIS_USDC_DENOM),
        );
        if (landed == null) throw new Error("Osmosis did not receive the fee slice.");
      }
      io.onProgress?.("Buying INJ and AVAX for the ephemeral account.");
      await bridgeGas(ctx, io, hop, legs, false);
      ctx.burnLookup = "recipient";
      ctx.usdcInjBefore = (await bank(io, "injective-1", hop.address, INJ_USDC_DENOM)).toString();
      await issueInj(ctx, io);
      injHeld = await bank(io, "injective-1", hop.address, "inj");
      usdcHeld = await bank(io, "injective-1", hop.address, INJ_USDC_DENOM);
    }
    if (injHeld < injFee || usdcHeld < 1n) {
      throw new Error(`The Injective account did not receive the fee and the USDC. INJ is ${formatUnits(injHeld, 18)}. USDC.inj is ${formatUnits(usdcHeld, 6)}.`);
    }
    ctx.arrivedInj = usdcHeld.toString();
    const detail = await deposit(ctx, io);
    return detail;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("still held")) throw error;
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
  const priced = await osmosisFeeCoin(io, sender, GAS.hook);
  const held = await bank(io, "osmosis-1", sender, OSMOSIS_USDC_DENOM);
  const sendAmount = sendable(amount, held, priced, OSMOSIS_USDC_DENOM);
  if (sendAmount <= 0n) throw new Error("Osmosis gas is short.");
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
      feeAmount: priced,
      messages: [transfer(sender, OSMOSIS_TO_NOBLE, OSMOSIS_USDC_DENOM, sendAmount, noble, io.now(), memo)],
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
    let message = error instanceof Error ? error.message : String(error);
    if (run.status === "running") {
      const key = run.phase === "exit" ? `leave:${run.sliceIndex}` : currentStep(run).id;
      details[key] = message;
    }
    try {
      if (io.wipeNoted) await io.wipeNoted(run);
    } catch {
      // The step error is the one the page shows.
    }
    if (ctx.depositHop?.keyId && io.wipeKey) {
      if (ctx.hopBroadcast) {
        message = `${message} The Injective account ${ctx.depositHop.address} is still held for this page session.`;
      } else {
        try {
          await io.wipeKey(ctx.depositHop.keyId);
        } catch {
          // The step error is the one the page shows.
        }
      }
    }
    if (run.status === "running") {
      const key = run.phase === "exit" ? `leave:${run.sliceIndex}` : currentStep(run).id;
      details[key] = message;
      run = reduce(run, { type: "FAIL", reason: message });
    }
    publish();
    return run;
  }
}
