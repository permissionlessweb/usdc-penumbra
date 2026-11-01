import { connectKeplr, connectZafu, keplrInstalled, zafuInstalled } from "./wallets.js";
import flowSvg from "../figures/flow.svg";

const flowEl = document.querySelector("#flow");
const zafuStatus = document.querySelector("#zafu-status");
const zafuDetail = document.querySelector("#zafu-detail");
const keplrStatus = document.querySelector("#keplr-status");
const keplrAccounts = document.querySelector("#keplr-accounts");

let zafu = null;
let keplr = null;

flowEl.innerHTML = flowSvg;

function paintZafu() {
  const open = Boolean(zafu?.connected);
  zafuStatus.textContent = open
    ? "Connected."
    : zafu?.installed === false
      ? "Not installed."
      : "Not connected.";
  zafuDetail.textContent = open
    ? "Diversified address not derived in this cut."
    : "";
}

function paintKeplr() {
  keplrAccounts.replaceChildren();
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
  for (const key of keplr.keys || []) {
    const item = document.createElement("li");
    item.textContent = key.bech32Address
      ? `${key.label} ${key.bech32Address}`
      : `${key.label} not enabled`;
    keplrAccounts.append(item);
  }
}

document.querySelector("#zafu").addEventListener("click", async () => {
  if (!zafuInstalled()) {
    zafu = { installed: false, connected: false };
    paintZafu();
    return;
  }
  zafuStatus.textContent = "Waiting.";
  try {
    zafu = await connectZafu();
    zafu.port?.close?.();
  } catch (error) {
    zafu = { installed: true, connected: false };
    paintZafu();
    zafuStatus.textContent = error.message;
    return;
  }
  paintZafu();
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
});

document.querySelector("#notes-open").addEventListener("click", () => {
  document.querySelector("#notes").showModal();
});
document.querySelector("#notes-close").addEventListener("click", () => {
  document.querySelector("#notes").close();
});

paintZafu();
paintKeplr();
