import {
  INJ_DENOM,
  INJ_USDC_DENOM,
  LCD,
  OSMOSIS_USDC_DENOM,
  USDC_NOBLE_DENOM,
  formatUnits,
  parseUnits,
  prepareMigration,
  readDenom,
} from "./balances.js";
import { issue, publicKeyOf, signDigest, wipe } from "./custody.js";
import { closedDoors } from "./route.js";
import { isDevHost } from "./batch.js";
import { GAS, fee, signAndBroadcastLocal } from "./tx.js";
import { returnOsmosisToPenumbra, walkMigration } from "./walk.js";
import { connectKeplr, connectZafu, keplrFingerprint, keplrInstalled, readKeplrKeys, walletToggle, zafuInstalled } from "./wallets.js";
import { readPenumbraUsdc, zafuAccountId } from "./zafu.js";
import flowSvg from "../figures/flow.svg";

const ROWS = [
  { id: "osmosis", place: "Osmosis", symbol: "USDC.noble", decimals: 6, chainId: "osmosis-1", denom: OSMOSIS_USDC_DENOM },
  { id: "noble", place: "Noble", symbol: "USDC.noble", decimals: 6, chainId: "noble-1", denom: USDC_NOBLE_DENOM },
  { id: "usdcInj", place: "Injective", symbol: "USDC.inj", decimals: 6, chainId: "injective-1", denom: INJ_USDC_DENOM },
  { id: "inj", place: "Injective gas", symbol: "INJ", decimals: 18, chainId: "injective-1", denom: INJ_DENOM },
  { id: "penumbra", place: "Penumbra", symbol: "USDC", decimals: 6 },
];

const flowEl = document.querySelector("#flow");
const zafuStatus = document.querySelector("#zafu-status");
const keplrStatus = document.querySelector("#keplr-status");
const balanceList = document.querySelector("#balances");
const beginButton = document.querySelector("#begin");
const restartButton = document.querySelector("#restart");
const readButton = document.querySelector("#read");
const devActions = document.querySelector("#dev-actions");
const devReturn = document.querySelector("#dev-return");
const beginStatus = document.querySelector("#begin-status");
const plan = document.querySelector("#plan");
const slices = document.querySelector("#slices");
const sliceCount = document.querySelector("#slice-count");
const sliceInterval = document.querySelector("#slice-interval");
const sliceBuffer = document.querySelector("#slice-buffer");

let zafu = null;
let keplr = null;
let readGeneration = 0;
let zafuGeneration = 0;
let walking = false;
let walkHeld = false;
let accountsDirty = false;
let accountTick = false;
let connecting = false;
const PENUMBRA = Symbol.for("penumbra");
const KEPLR_PICKS = ["osmosis", "noble", "usdcInj"];
const picks = {};
const readings = {};
for (const row of ROWS) readings[row.id] = { state: "unread", amount: "0", text: "Not read." };
readings.uosmo = { state: "unread", amount: "0", text: "Not read." };

flowEl.innerHTML = flowSvg;

function paintConnection(button, status, name, connection) {
  const view = walletToggle(name, connection);
  button.textContent = view.label;
  button.disabled = walking || view.disabled;
  button.title = connection?.error || view.title;
  const detail = connection?.error || view.detail;
  status.hidden = !detail;
  status.textContent = detail;
}

function paintZafu() {
  const button = document.querySelector("#zafu");
  if (!zafu) {
    paintConnection(button, zafuStatus, "Zafu", { installed: true, connected: false });
    return;
  }
  if (zafu.installed === false) {
    paintConnection(button, zafuStatus, "Zafu", { installed: false, connected: false });
    return;
  }
  paintConnection(button, zafuStatus, "Zafu", {
    installed: true,
    connected: Boolean(zafu.connected),
    error: zafu.connected ? "" : zafu.error || "",
  });
}

function paintKeplr() {
  const button = document.querySelector("#keplr");
  if (!keplr) {
    paintConnection(button, keplrStatus, "Keplr", { installed: true, connected: false });
    return;
  }
  if (keplr.installed === false) {
    paintConnection(button, keplrStatus, "Keplr", { installed: false, connected: false });
    return;
  }
  const ready = (keplr.keys || []).some((key) => key.bech32Address);
  const failed = (keplr.keys || []).find((key) => key.error);
  paintConnection(button, keplrStatus, "Keplr", {
    installed: true,
    connected: ready,
    error: ready ? "" : (keplr.error || failed?.error || (keplr.keys?.length ? "No account enabled." : "")),
  });
}

function abbreviate(address) {
  const text = String(address || "");
  if (text.length <= 18) return text;
  return `${text.slice(0, 10)}…${text.slice(-6)}`;
}

function addressFor(row) {
  if (row.id === "penumbra") return zafu?.connected ? zafu.address || "" : "";
  if (row.id === "osmosis") return chainAddress("osmosis-1");
  if (row.id === "noble") return chainAddress("noble-1");
  if (row.id === "usdcInj" || row.id === "inj") return chainAddress("injective-1");
  return "";
}

function timing() {
  return {
    slices: Number(sliceCount.value),
    intervalSec: Number(sliceInterval.value),
    jitterMaxSec: Number(sliceBuffer.value),
  };
}

function snapshot() {
  const key = (chainId) => keplr?.keys?.find((item) => item.chainId === chainId);
  const noble = key("noble-1")?.bech32Address || "";
  const inj = key("injective-1")?.bech32Address || "";
  const ethereum = key("injective-1")?.ethereumHexAddress || "";
  return {
    ...readings,
    addresses: {
      zafu: zafu?.connected ? zafu.address : "",
      userOsmosis: key("osmosis-1")?.bech32Address || "",
      userNoble: noble,
      userInj: inj,
      injEthereum: ethereum,
      noble,
      exitNoble: noble,
      injLeave: inj,
      avalanche: ethereum,
    },
  };
}

function decimalsFor(row) {
  return readings[row.id].decimals ?? row.decimals;
}

function penumbraAmountText(reading) {
  const decimals = reading.decimals ?? 6;
  const noble = formatUnits(reading.amount || "0", decimals);
  const inj = formatUnits(reading.inj || "0", decimals);
  return `${noble} USDC.noble · ${inj} USDC.inj`;
}

function fillMax() {
  for (const row of ROWS) {
    if (row.id === "inj") continue;
    const reading = readings[row.id];
    picks[row.id] = reading.state === "ready" && BigInt(reading.amount) > 0n
      ? formatUnits(reading.amount, decimalsFor(row))
      : "";
  }
}

function clampPicks(ids) {
  for (const row of ROWS) {
    if (row.id === "inj") continue;
    if (ids && !ids.includes(row.id)) continue;
    const reading = readings[row.id];
    if (reading.state !== "ready") continue;
    const current = picks[row.id];
    if (current == null || current.trim() === "") {
      picks[row.id] = BigInt(reading.amount) > 0n ? formatUnits(reading.amount, decimalsFor(row)) : "";
      continue;
    }
    try {
      if (BigInt(parseUnits(current, decimalsFor(row))) > BigInt(reading.amount)) {
        picks[row.id] = formatUnits(reading.amount, decimalsFor(row));
      }
    } catch {
      // The field keeps the text. Begin explains it.
    }
  }
}

function writePick(row, replace) {
  const reading = readings[row.id];
  const next = reading.state === "ready" && BigInt(reading.amount) > 0n
    ? formatUnits(reading.amount, decimalsFor(row))
    : "";
  if (!replace && picks[row.id] != null && String(picks[row.id]).trim() !== "") return;
  picks[row.id] = next;
}

function chosenBase() {
  const chosen = {};
  for (const row of ROWS) {
    if (row.id === "inj" || readings[row.id].state !== "ready") continue;
    const text = (picks[row.id] ?? "").trim();
    if (text === "") {
      chosen[row.id] = "0";
      continue;
    }
    let amount;
    try {
      amount = parseUnits(text, decimalsFor(row));
    } catch (error) {
      return { error: error.message };
    }
    if (BigInt(amount) > BigInt(readings[row.id].amount)) {
      return { error: `${row.place} is larger than the balance.` };
    }
    chosen[row.id] = amount;
  }
  return { chosen };
}

function syncBegin() {
  const penumbra = readings.penumbra;
  slices.hidden = !(penumbra.state === "ready" && BigInt(penumbra.amount) > 0n);
  const picked = chosenBase();
  if (picked.error) {
    beginButton.disabled = true;
    restartButton.disabled = walking;
    readButton.disabled = walking;
    syncDev(picked);
    return { ready: false, reason: picked.error, steps: [], moved: "0" };
  }
  const prep = prepareMigration({ ...snapshot(), chosen: picked.chosen }, timing());
  beginButton.disabled = walking || walkHeld || !prep.ready;
  restartButton.disabled = walking;
  readButton.disabled = walking;
  paintZafu();
  paintKeplr();
  syncDev(picked);
  return prep;
}

function syncDev(picked) {
  if (!devActions || !devReturn) return;
  if (!isDevHost(location.hostname)) {
    devActions.hidden = true;
    devReturn.disabled = true;
    return;
  }
  devActions.hidden = false;
  const amount = picked?.chosen?.osmosis;
  const osmosisReady = readings.osmosis.state === "ready" && amount && BigInt(amount) > 0n;
  const gasReady = readings.uosmo.state === "ready"
    && BigInt(readings.uosmo.amount) >= BigInt(fee("osmosis-1", GAS.hook).amount);
  devReturn.disabled = walking || Boolean(picked?.error) || !zafu?.connected || !osmosisReady || !gasReady;
}

function rememberPick(row, value) {
  picks[row.id] = value;
  if (walking) return;
  plan.replaceChildren();
  const prep = syncBegin();
  beginStatus.classList.remove("error");
  beginStatus.textContent = prep.ready ? "" : prep.reason;
}

function paintBalances() {
  balanceList.replaceChildren();
  for (const row of ROWS) {
    const reading = readings[row.id];
    const item = document.createElement("li");
    item.dataset.place = row.id;
    const place = document.createElement("span");
    place.className = "place";
    const label = document.createElement("span");
    label.textContent = row.place;
    place.append(label);
    const account = addressFor(row);
    if (account) {
      const addr = document.createElement("span");
      addr.className = "addr";
      addr.textContent = abbreviate(account);
      addr.title = account;
      place.append(addr);
    }
    const amount = document.createElement("span");
    amount.className = "amount";
    const ready = reading.state === "ready";
    amount.textContent = ready
      ? (row.id === "penumbra" ? penumbraAmountText(reading) : `${formatUnits(reading.amount, decimalsFor(row))} ${row.symbol}`)
      : reading.text || "Not read.";
    item.append(place, amount);
    if (ready && row.id !== "inj" && BigInt(reading.amount) > 0n) {
      const pick = document.createElement("span");
      pick.className = "pick";
      const field = document.createElement("input");
      field.type = "text";
      field.inputMode = "decimal";
      field.autocomplete = "off";
      field.spellcheck = false;
      field.setAttribute("aria-label", `${row.place} amount`);
      field.value = picks[row.id] ?? "";
      field.addEventListener("input", () => rememberPick(row, field.value));
      const max = document.createElement("button");
      max.type = "button";
      max.className = "ghost";
      max.textContent = "Max";
      max.addEventListener("click", () => {
        field.value = formatUnits(reading.amount, decimalsFor(row));
        rememberPick(row, field.value);
      });
      pick.append(field, max);
      item.append(pick);
    }
    balanceList.append(item);
  }
  return syncBegin();
}

function chainAddress(chainId) {
  return keplr?.keys?.find((key) => key.chainId === chainId)?.bech32Address || "";
}

async function readBank(row) {
  const address = chainAddress(row.chainId);
  if (!address) {
    return { state: "unread", amount: "0", text: keplr?.keys ? "Not enabled." : "Not read." };
  }
  try {
    const amount = await readDenom(globalThis.fetch.bind(globalThis), LCD[row.chainId], address, row.denom);
    return { state: "ready", amount };
  } catch (error) {
    return { state: "unread", amount: "0", text: error.message };
  }
}

async function readShield() {
  if (!zafu?.connected || !zafu.view) return { state: "unread", amount: "0", text: "Not read." };
  try {
    const result = await readPenumbraUsdc(zafu.view);
    return { state: "ready", amount: result.noble, inj: result.inj, decimals: result.decimals };
  } catch (error) {
    return { state: "unread", amount: "0", text: error.message };
  }
}

async function readUosmo() {
  const address = chainAddress("osmosis-1");
  if (!address) return { state: "unread", amount: "0", text: keplr?.keys ? "Not enabled." : "Not read." };
  try {
    const amount = await readDenom(globalThis.fetch.bind(globalThis), LCD["osmosis-1"], address, "uosmo");
    return { state: "ready", amount };
  } catch (error) {
    return { state: "unread", amount: "0", text: error.message };
  }
}

function unread(text = "Not read.") {
  return { state: "unread", amount: "0", text };
}

async function readBalances(options = {}) {
  const generation = ++readGeneration;
  const hold = options.hold === true || walkHeld;
  const scope = options.scope === "penumbra" || options.scope === "keplr" ? options.scope : "";
  if (!hold && !scope) {
    beginStatus.textContent = "Reading.";
    plan.replaceChildren();
  }
  const keplrRows = ROWS.filter((row) => row.chainId);
  const [bank, shield, uosmo] = await Promise.all([
    scope === "penumbra" ? null : Promise.all(keplrRows.map((row) => readBank(row))),
    scope === "keplr" ? null : readShield(),
    scope === "penumbra" ? null : readUosmo(),
  ]);
  if (generation !== readGeneration) return;
  if (bank) keplrRows.forEach((row, index) => { readings[row.id] = bank[index]; });
  if (shield) readings.penumbra = shield;
  if (uosmo) readings.uosmo = uosmo;
  if (!scope) {
    if (options.keepPicks || hold) clampPicks();
    else fillMax();
  } else {
    const ids = scope === "penumbra" ? ["penumbra"] : KEPLR_PICKS;
    if (options.replacePicks) {
      for (const row of ROWS) {
        if (ids.includes(row.id)) writePick(row, true);
      }
    } else if (options.keepPicks || hold) clampPicks(ids);
    else {
      for (const row of ROWS) {
        if (ids.includes(row.id)) writePick(row, false);
      }
    }
  }
  const prep = paintBalances();
  if (hold) {
    beginButton.disabled = true;
    return;
  }
  if ((!scope || options.announce) && !walking) {
    beginStatus.classList.remove("error");
    beginStatus.textContent = prep.ready ? "" : prep.reason;
  }
}

function paintPlan(rows) {
  plan.replaceChildren();
  for (const row of rows) {
    const item = document.createElement("li");
    item.className = `step ${row.state}`;
    const dot = document.createElement("span");
    dot.className = "dot";
    const body = document.createElement("div");
    body.className = "body";
    const title = document.createElement("h4");
    title.textContent = row.title;
    const detail = document.createElement("p");
    detail.className = "detail";
    detail.textContent = row.detail;
    body.append(title, detail);
    item.append(dot, body);
    plan.append(item);
  }
}

function liveIo() {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    keplr: globalThis.keplr,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: Math.random,
    view: zafu?.view || null,
    channels: zafu?.channels || null,
    clients: zafu?.clients || null,
    penumbraUsdc() {
      if (!zafu?.view) throw new Error("Zafu is not connected.");
      return readPenumbraUsdc(zafu.view);
    },
    onPenumbra({ noble, inj, before, decimals, watch }) {
      const nobleAmount = noble ?? 0n;
      const injAmount = inj ?? 0n;
      readings.penumbra = {
        state: "ready",
        amount: nobleAmount.toString(),
        inj: injAmount.toString(),
        decimals,
      };
      const item = balanceList.querySelector('[data-place="penumbra"]');
      const shown = item?.querySelector(".amount");
      if (!shown) return;
      shown.textContent = penumbraAmountText(readings.penumbra);
      const current = watch === "noble" ? nobleAmount : injAmount;
      item.classList.toggle("arrived", current > before);
    },
    issueHop(chain) {
      return issue(chain);
    },
    async signHop({ keyId, chainId, signer, messages, gas }) {
      return signAndBroadcastLocal({
        fetchImpl: globalThis.fetch.bind(globalThis),
        chainId,
        signer,
        messages,
        feeAmount: fee(chainId, gas),
        lcd: LCD[chainId],
        wait: {
          now: () => Date.now(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          timeoutMs: 90_000,
          intervalMs: 4000,
        },
        pubKey: publicKeyOf(keyId),
        signDigest: (digest) => signDigest(keyId, digest),
      });
    },
    wipeKey(keyId) {
      wipe(keyId);
    },
    wipeNoted(run) {
      let count = 0;
      for (const noted of Object.values(run.keys || {})) {
        if (!noted?.keyId) continue;
        wipe(noted.keyId);
        count += 1;
      }
      return count;
    },
  };
}

function paintWalk(view) {
  paintPlan(view.rows);
  if (view.status === "halted") beginStatus.textContent = view.halt?.reason || "Stopped.";
  else if (view.status === "done") beginStatus.textContent = "Done.";
  else if (view.status === "waiting") beginStatus.textContent = "Waiting.";
  else {
    const current = view.rows.find((row) => row.state === "running");
    beginStatus.textContent = current?.title || "Signing.";
  }
}

function clearSide(ids) {
  for (const id of ids) {
    readings[id] = unread();
    delete picks[id];
  }
}

function disconnectZafu() {
  zafuGeneration += 1;
  zafu?.close?.();
  zafu = { installed: zafu?.installed !== false, connected: false, address: "" };
  clearSide(["penumbra"]);
  paintZafu();
  paintBalances();
}

function disconnectKeplr() {
  keplr = { installed: keplr?.installed !== false, keys: [] };
  clearSide(["osmosis", "noble", "usdcInj", "inj"]);
  readings.uosmo = unread();
  paintKeplr();
  paintBalances();
}

function penumbraProvider() {
  const record = globalThis[PENUMBRA];
  const origin = zafu?.origin;
  return origin && record ? record[origin] : null;
}

function providerApproved(provider) {
  if (!provider || typeof provider.isConnected !== "function") return false;
  try {
    return provider.isConnected() === true;
  } catch {
    return false;
  }
}

async function watchKeplrAccounts() {
  if (!keplr?.keys?.some((key) => key.bech32Address)) return;
  if (walking) {
    accountsDirty = true;
    return;
  }
  const keys = await readKeplrKeys();
  if (walking) {
    accountsDirty = true;
    return;
  }
  if (!keys || keplrFingerprint(keys) === keplrFingerprint(keplr?.keys)) return;
  keplr = { installed: true, keys };
  paintKeplr();
  await readBalances({ scope: "keplr", replacePicks: true });
}

async function watchOpenZafu() {
  if (!zafu?.connected || !zafu.view) return;
  if (walking) {
    accountsDirty = true;
    return;
  }
  const generation = zafuGeneration;
  let id = "";
  try {
    id = await zafuAccountId(zafu.view);
  } catch {
    if (generation !== zafuGeneration || walking) {
      accountsDirty = walking;
      return;
    }
    if (providerApproved(penumbraProvider())) await refreshZafuFromExtension();
    return;
  }
  if (generation !== zafuGeneration || !zafu?.connected || walking) {
    if (walking) accountsDirty = true;
    return;
  }
  const address = id.slice(id.indexOf(":") + 1);
  if (!id || id === zafu.accountId || (zafu.address && address === zafu.address && !zafu.accountId)) {
    if (id && !zafu.accountId) zafu.accountId = id;
    return;
  }
  zafu.accountId = id;
  zafu.address = id.slice(id.indexOf(":") + 1);
  paintZafu();
  await readBalances({ scope: "penumbra", replacePicks: true });
}

async function refreshZafuFromExtension() {
  if (!zafu?.connected) return;
  if (walking) {
    accountsDirty = true;
    return;
  }
  const provider = penumbraProvider();
  if (!providerApproved(provider)) {
    await watchOpenZafu();
    return;
  }
  const generation = zafuGeneration;
  const previousId = zafu.accountId;
  let next;
  try {
    next = await connectZafu();
  } catch {
    return;
  }
  if (generation !== zafuGeneration || walking || !zafu?.connected) {
    next.close?.();
    if (walking) accountsDirty = true;
    return;
  }
  let nextId = "";
  try {
    nextId = await zafuAccountId(next.view);
  } catch {
    next.close?.();
    return;
  }
  const sameAccount = nextId === previousId
    || (next.address && next.address === zafu.address && (!previousId || !nextId || nextId === previousId));
  if (sameAccount) {
    if (nextId) zafu.accountId = nextId;
    next.close?.();
    return;
  }
  next.accountId = nextId;
  const previous = zafu;
  zafu = next;
  previous?.close?.();
  paintZafu();
  await readBalances({ scope: "penumbra", replacePicks: true });
}

async function tickAccounts(forcePort) {
  if (walking || connecting) {
    if (walking) accountsDirty = true;
    return;
  }
  if (accountTick) return;
  accountTick = true;
  try {
    await watchKeplrAccounts();
    if (forcePort) await refreshZafuFromExtension();
    else await watchOpenZafu();
  } finally {
    accountTick = false;
  }
}

document.querySelector("#zafu").addEventListener("click", async () => {
  if (walking) return;
  if (!zafuInstalled()) {
    zafu = { installed: false, connected: false };
    paintZafu();
    return;
  }
  if (zafu?.connected) {
    disconnectZafu();
    return;
  }
  const button = document.querySelector("#zafu");
  button.disabled = true;
  button.textContent = "Connecting Zafu";
  zafuStatus.hidden = true;
  zafuStatus.textContent = "";
  connecting = true;
  zafuGeneration += 1;
  const generation = zafuGeneration;
  const previous = zafu;
  try {
    let next;
    try {
      next = await connectZafu();
      if (generation !== zafuGeneration) {
        next.close?.();
        return;
      }
      next.accountId = "";
      try {
        next.accountId = await zafuAccountId(next.view);
      } catch {
        // The port is open. The balance read reports an address failure.
      }
    } catch (error) {
      if (generation !== zafuGeneration) return;
      zafu = { installed: true, connected: false, error: error instanceof Error ? error.message : String(error) };
      paintZafu();
      return;
    }
    zafu = next;
    previous?.close?.();
    paintZafu();
    await readBalances({ scope: "penumbra", announce: true });
  } finally {
    connecting = false;
  }
});

document.querySelector("#keplr").addEventListener("click", async () => {
  if (walking) return;
  if (!keplrInstalled()) {
    keplr = { installed: false, keys: [] };
    paintKeplr();
    return;
  }
  if (keplr?.keys?.some((key) => key.bech32Address)) {
    disconnectKeplr();
    return;
  }
  const button = document.querySelector("#keplr");
  button.disabled = true;
  button.textContent = "Connecting Keplr";
  keplrStatus.hidden = true;
  keplrStatus.textContent = "";
  connecting = true;
  try {
    try {
      keplr = await connectKeplr();
    } catch (error) {
      keplr = { installed: true, keys: [], error: error instanceof Error ? error.message : String(error) };
      paintKeplr();
      return;
    }
    paintKeplr();
    await readBalances({ scope: "keplr", announce: true });
  } finally {
    connecting = false;
  }
});

window.addEventListener("keplr_keystorechange", () => { tickAccounts(false); });
window.addEventListener("penumbra_keystorechange", () => { tickAccounts(true); });
window.addEventListener("focus", () => { tickAccounts(true); });
setInterval(() => { tickAccounts(true); }, 4000);

readButton.addEventListener("click", () => {
  if (walking) return;
  beginStatus.classList.remove("error");
  readBalances({ hold: walkHeld, keepPicks: walkHeld });
});

restartButton.addEventListener("click", () => {
  if (walking) return;
  walkHeld = false;
  plan.replaceChildren();
  beginStatus.classList.remove("error");
  beginStatus.textContent = "Reading.";
  readBalances({ keepPicks: true });
});

devReturn?.addEventListener("click", async () => {
  if (walking || !isDevHost(location.hostname)) return;
  const picked = chosenBase();
  if (picked.error) {
    beginStatus.textContent = picked.error;
    beginStatus.classList.add("error");
    return;
  }
  walking = true;
  syncBegin();
  beginStatus.classList.remove("error");
  beginStatus.textContent = "Asking the light client.";
  let detail = "";
  let failed = false;
  try {
    detail = await returnOsmosisToPenumbra({
      amountOsmosis: picked.chosen.osmosis || "0",
      addresses: snapshot().addresses,
    }, {
      ...liveIo(),
      onProgress(text) {
        beginStatus.classList.remove("error");
        beginStatus.textContent = text;
      },
    });
    beginStatus.textContent = detail;
  } catch (error) {
    failed = true;
    detail = error instanceof Error ? error.message : String(error);
    beginStatus.textContent = detail;
    beginStatus.classList.add("error");
  } finally {
    walking = false;
    try {
      await readBalances({ hold: true, keepPicks: true });
    } finally {
      beginStatus.textContent = detail;
      beginStatus.classList.toggle("error", failed);
      if (walkHeld) beginButton.disabled = true;
      else syncBegin();
      if (accountsDirty) {
        accountsDirty = false;
        tickAccounts(true);
      }
    }
  }
});

beginButton.addEventListener("click", async () => {
  if (walking || walkHeld) return;
  const prep = syncBegin();
  if (!prep.ready) {
    beginStatus.textContent = prep.reason;
    return;
  }
  walking = true;
  walkHeld = false;
  syncBegin();
  beginStatus.classList.remove("error");
  beginStatus.textContent = "Signing.";
  try {
    await walkMigration({
      input: prep.input,
      ctx: prep.ctx,
      io: liveIo(),
      onUpdate: paintWalk,
    });
  } catch (error) {
    beginStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    walkHeld = true;
    walking = false;
    beginButton.disabled = true;
    restartButton.disabled = false;
    readButton.disabled = false;
    try {
      await readBalances({ hold: true, keepPicks: true });
    } finally {
      beginButton.disabled = true;
      if (accountsDirty) {
        accountsDirty = false;
        tickAccounts(true);
      }
    }
  }
});

for (const input of [sliceCount, sliceInterval, sliceBuffer]) {
  input.addEventListener("input", () => {
    plan.replaceChildren();
    const prep = syncBegin();
    if (!walking && readings.penumbra.state === "ready") beginStatus.textContent = prep.ready ? "" : prep.reason;
  });
}

document.querySelector("#notes-open").addEventListener("click", () => {
  document.querySelector("#notes").showModal();
});
document.querySelector("#notes-close").addEventListener("click", () => {
  document.querySelector("#notes").close();
});

const cut = document.querySelector("#cut");
for (const line of closedDoors()) {
  const item = document.createElement("li");
  item.textContent = line;
  cut.append(item);
}

paintZafu();
paintKeplr();
paintBalances();
