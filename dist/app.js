// src/wallets.js
var PENUMBRA = Symbol.for("penumbra");
var KEPLR_CHAINS = [
  { chainId: "osmosis-1", label: "Osmosis" },
  { chainId: "noble-1", label: "Noble" },
  { chainId: "injective-1", label: "Injective" }
];
function zafuInstalled() {
  const record = globalThis[PENUMBRA];
  return Boolean(record && typeof record === "object" && Object.keys(record).length);
}
async function connectZafu() {
  const record = globalThis[PENUMBRA];
  const origins = record && typeof record === "object" ? Object.keys(record) : [];
  if (!origins.length) return { installed: false, connected: false };
  const origin = origins[0];
  const provider = record[origin];
  const port = await provider.connect();
  return {
    installed: true,
    connected: Boolean(provider.isConnected?.()),
    origin,
    manifest: String(provider.manifest || ""),
    port
  };
}
function keplrInstalled() {
  return Boolean(globalThis.keplr);
}
async function connectKeplr() {
  const keplr2 = globalThis.keplr;
  if (!keplr2) return { installed: false, keys: [] };
  const keys = [];
  for (const chain of KEPLR_CHAINS) {
    try {
      await keplr2.enable(chain.chainId);
      const key = await keplr2.getKey(chain.chainId);
      keys.push({
        ...chain,
        bech32Address: key.bech32Address,
        name: key.name,
        error: null
      });
    } catch (error) {
      keys.push({
        ...chain,
        bech32Address: null,
        name: null,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { installed: true, keys };
}

// figures/flow.svg
var flow_default = `<svg id="flow-plate" xmlns="http://www.w3.org/2000/svg" width="720" height="400" viewBox="0 0 720 400" role="img" aria-labelledby="flow-title flow-desc" fill="none" font-family="Iowan Old Style, Palatino, 'Palatino Linotype', Georgia, serif">
  <title id="flow-title">USDC.noble moves to a diversified address of the Zafu account</title>
  <desc id="flow-desc">Keplr and Zafu connect together. Keplr identifies USDC.noble, including a balance on Osmosis. That USDC migrates into USDC.inj. The transfer arrives at a diversified address held by the connected Zafu account.</desc>
  <defs>
    <clipPath id="clip-noble"><circle cx="168" cy="168" r="33"/></clipPath>
    <clipPath id="clip-inj"><circle cx="360" cy="168" r="33"/></clipPath>
  </defs>
  <g class="mesh" stroke="#cfc8bc" stroke-width=".6">
    <line x1="64" y1="44" x2="656" y2="44"/>
    <line x1="64" y1="332" x2="656" y2="332"/>
  </g>
  <text x="656" y="32" text-anchor="end" fill="currentColor" opacity=".58" font-family="ui-monospace, 'SF Mono', Menlo, Consolas, monospace" font-size="11" letter-spacing="1.4">USDC</text>
  <g id="flow-sink" fill="none" stroke="currentColor">
    <circle cx="552" cy="168" r="28" fill="#f3efe4" stroke-width=".9" stroke-opacity=".6"/>
    <circle cx="552" cy="168" r="22" stroke-width=".5" stroke-opacity=".18"/>
    <text x="552" y="112" text-anchor="middle" fill="currentColor" stroke="none" font-size="16">Zafu</text>
    <text x="552" y="222" text-anchor="middle" fill="currentColor" stroke="none" font-size="12.5" font-style="italic" opacity=".62">diversified address</text>
    <text x="360" y="364" text-anchor="middle" fill="currentColor" stroke="none" font-size="12.5" font-style="italic" opacity=".62">USDC.noble becomes USDC.inj, then a diversified address of the Zafu account.</text>
  </g>
  <g class="branch" id="branch-noble-in" fill="none" stroke="currentColor" stroke-width=".9">
    <circle cx="168" cy="168" r="36" fill="#f3efe4" stroke-width=".9" stroke-opacity=".6"/>
    <g clip-path="url(#clip-noble)" stroke="currentColor" stroke-opacity=".28" stroke-width=".6">
      <line x1="140" y1="196" x2="170" y2="140"/>
      <line x1="150" y1="200" x2="180" y2="144"/>
      <line x1="160" y1="202" x2="190" y2="146"/>
      <line x1="170" y1="202" x2="200" y2="146"/>
      <line x1="180" y1="200" x2="210" y2="144"/>
      <line x1="190" y1="196" x2="220" y2="140"/>
    </g>
    <circle cx="168" cy="168" r="30" stroke-width=".5" stroke-opacity=".18"/>
    <text x="168" y="112" text-anchor="middle" fill="currentColor" stroke="none" font-size="16">USDC.noble</text>
    <text x="168" y="226" text-anchor="middle" fill="currentColor" stroke="none" font-size="12.5" font-style="italic" opacity=".62">including Osmosis</text>
    <line x1="210" y1="168" x2="308" y2="168" stroke="#1a46c3" stroke-width="1.15"/>
    <polygon points="324,168 308,163 308,173" fill="#1a46c3" stroke="none"/>
    <text x="264" y="152" text-anchor="middle" fill="currentColor" stroke="none" font-size="12.5" font-style="italic" opacity=".62">the migration</text>
  </g>
  <g class="branch" id="branch-inj-in" fill="none" stroke="currentColor" stroke-width=".9">
    <circle cx="360" cy="168" r="36" fill="#f3efe4" stroke-width=".9" stroke-opacity=".6"/>
    <g clip-path="url(#clip-inj)" fill="currentColor" stroke="none">
      <circle cx="348" cy="158" r="1.15" opacity=".4"/>
      <circle cx="364" cy="154" r=".75" opacity=".28"/>
      <circle cx="376" cy="164" r="1" opacity=".34"/>
      <circle cx="356" cy="170" r=".6" opacity=".24"/>
      <circle cx="370" cy="176" r=".9" opacity=".32"/>
      <circle cx="342" cy="174" r=".7" opacity=".26"/>
      <circle cx="382" cy="174" r=".55" opacity=".22"/>
    </g>
    <circle cx="360" cy="168" r="30" stroke-width=".5" stroke-opacity=".18"/>
    <text x="360" y="112" text-anchor="middle" fill="currentColor" stroke="none" font-size="16">USDC.inj</text>
    <line x1="402" y1="168" x2="512" y2="168"/>
    <polygon points="524,168 512,163.5 512,172.5" fill="currentColor" stroke="none"/>
  </g>
</svg>
`;

// src/main.js
var flowEl = document.querySelector("#flow");
var zafuStatus = document.querySelector("#zafu-status");
var zafuDetail = document.querySelector("#zafu-detail");
var keplrStatus = document.querySelector("#keplr-status");
var keplrAccounts = document.querySelector("#keplr-accounts");
var zafu = null;
var keplr = null;
flowEl.innerHTML = flow_default;
function paintZafu() {
  const open = Boolean(zafu?.connected);
  zafuStatus.textContent = open ? "Connected." : zafu?.installed === false ? "Not installed." : "Not connected.";
  zafuDetail.textContent = open ? "Diversified address not derived in this cut." : "";
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
    item.textContent = key.bech32Address ? `${key.label} ${key.bech32Address}` : `${key.label} not enabled`;
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
