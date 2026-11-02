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
import { wipe } from "./custody.js";
import { closedDoors } from "./route.js";
import { walkMigration } from "./walk.js";
import { connectKeplr, connectZafu, keplrInstalled, zafuInstalled } from "./wallets.js";
import { readPenumbraUsdc } from "./zafu.js";
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
const beginStatus = document.querySelector("#begin-status");
const plan = document.querySelector("#plan");
const slices = document.querySelector("#slices");
const sliceCount = document.querySelector("#slice-count");
const sliceInterval = document.querySelector("#slice-interval");
const sliceBuffer = document.querySelector("#slice-buffer");

let zafu = null;
let keplr = null;
let readGeneration = 0;
let walking = false;
let walkHeld = false;
const picks = {};
const readings = {};
for (const row of ROWS) readings[row.id] = { state: "unread", amount: "0", text: "Not read." };
readings.uosmo = { state: "unread", amount: "0", text: "Not read." };

flowEl.innerHTML = flowSvg;

function paintZafu() {
  const open = Boolean(zafu?.connected);
  zafuStatus.textContent = open
    ? "Connected."
    : zafu?.installed === false
      ? "Not installed."
      : "Not connected.";
}

function paintKeplr() {
  if (!keplr) {
    keplrStatus.textContent = "Not connected.";
    return;
  }
  if (keplr.installed === false) {
    keplrStatus.textContent = "Not installed.";
    return;
  }
  const ready = (keplr.keys || []).filter((key) => key.bech32Address);
  keplrStatus.textContent = ready.length ? "Connected." : "No account enabled.";
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

function fillMax() {
  for (const row of ROWS) {
    if (row.id === "inj") continue;
    const reading = readings[row.id];
    picks[row.id] = reading.state === "ready" && BigInt(reading.amount) > 0n
      ? formatUnits(reading.amount, decimalsFor(row))
      : "";
  }
}

function clampPicks() {
  for (const row of ROWS) {
    if (row.id === "inj") continue;
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
    return { ready: false, reason: picked.error, steps: [], moved: "0" };
  }
  const prep = prepareMigration({ ...snapshot(), chosen: picked.chosen }, timing());
  beginButton.disabled = walking || walkHeld || !prep.ready;
  restartButton.disabled = walking;
  readButton.disabled = walking;
  return prep;
}

function rememberPick(row, value) {
  picks[row.id] = value;
  if (walking) return;
  plan.replaceChildren();
  const prep = syncBegin();
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
      ? `${formatUnits(reading.amount, decimalsFor(row))} ${row.symbol}`
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
    return { state: "ready", amount: result.amount, decimals: result.decimals };
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

async function readBalances(options = {}) {
  const generation = ++readGeneration;
  const hold = options.hold === true || walkHeld;
  if (!hold) {
    beginStatus.textContent = "Reading.";
    plan.replaceChildren();
  }
  const [bank, shield, uosmo] = await Promise.all([
    Promise.all(ROWS.filter((row) => row.chainId).map((row) => readBank(row))),
    readShield(),
    readUosmo(),
  ]);
  if (generation !== readGeneration) return;
  ROWS.filter((row) => row.chainId).forEach((row, index) => {
    readings[row.id] = bank[index];
  });
  readings.penumbra = shield;
  readings.uosmo = uosmo;
  if (options.keepPicks || hold) clampPicks();
  else fillMax();
  const prep = paintBalances();
  if (hold) {
    beginButton.disabled = true;
    return;
  }
  beginStatus.textContent = prep.ready ? "" : prep.reason;
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
    penumbraUsdc() {
      if (!zafu?.view) throw new Error("Zafu is not connected.");
      return readPenumbraUsdc(zafu.view);
    },
    onPenumbra({ amount, before, decimals }) {
      readings.penumbra = { state: "ready", amount: amount.toString(), decimals };
      const item = balanceList.querySelector('[data-place="penumbra"]');
      const shown = item?.querySelector(".amount");
      if (!shown) return;
      shown.textContent = `${formatUnits(amount, decimals)} USDC`;
      item.classList.toggle("arrived", amount > before);
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

document.querySelector("#zafu").addEventListener("click", async () => {
  if (!zafuInstalled()) {
    zafu = { installed: false, connected: false };
    paintZafu();
    return;
  }
  zafuStatus.textContent = "Waiting.";
  const previous = zafu;
  try {
    zafu = await connectZafu();
    previous?.close?.();
  } catch (error) {
    zafu = { installed: true, connected: false };
    paintZafu();
    zafuStatus.textContent = error.message;
    return;
  }
  paintZafu();
  await readBalances();
});

document.querySelector("#keplr").addEventListener("click", async () => {
  if (!keplrInstalled()) {
    keplr = { installed: false, keys: [] };
    paintKeplr();
    return;
  }
  keplrStatus.textContent = "Waiting.";
  try {
    keplr = await connectKeplr();
  } catch (error) {
    keplr = { installed: true, keys: [] };
    paintKeplr();
    keplrStatus.textContent = error.message;
    return;
  }
  paintKeplr();
  await readBalances();
});

readButton.addEventListener("click", () => {
  if (walking) return;
  readBalances({ hold: walkHeld, keepPicks: walkHeld });
});

restartButton.addEventListener("click", () => {
  if (walking) return;
  walkHeld = false;
  plan.replaceChildren();
  beginStatus.textContent = "Reading.";
  readBalances({ keepPicks: true });
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
