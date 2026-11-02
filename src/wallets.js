// Zafu injects Symbol.for("penumbra") → origin → provider.
// connect() returns a MessagePort. ViewService.addressByIndex on that port
// returns one diversified address. This page does not fetch the extension
// manifest, because that would be a network request, and it does not hold
// the spend key. Keplr is read for account addresses. Balances are a separate
// read. Chains are enabled if Keplr already has them. This page does not
// suggest a chain, because that would hand Keplr a direct RPC URL.

import { createViewClient, diversifiedAddress } from "./zafu.js";

const PENUMBRA = Symbol.for("penumbra");
const KEPLR_CHAINS = [
  { chainId: "osmosis-1", label: "Osmosis" },
  { chainId: "noble-1", label: "Noble" },
  { chainId: "injective-1", label: "Injective" },
];

export function zafuInstalled() {
  const record = globalThis[PENUMBRA];
  return Boolean(record && typeof record === "object" && Object.keys(record).length);
}

export async function connectZafu() {
  const record = globalThis[PENUMBRA];
  const origins = record && typeof record === "object" ? Object.keys(record) : [];
  if (!origins.length) return { installed: false, connected: false, address: "" };
  const origin = origins[0];
  const provider = record[origin];
  let portPromise;
  const getPort = () => {
    portPromise ??= provider.connect();
    return portPromise;
  };
  const close = () => {
    portPromise?.then((port) => port.close()).catch(() => {});
  };
  try {
    const view = createViewClient(getPort);
    const address = await diversifiedAddress(view);
    return { installed: true, connected: true, origin, address, view, close };
  } catch (error) {
    close();
    throw error;
  }
}

export function keplrInstalled() {
  return Boolean(globalThis.keplr);
}

export async function connectKeplr() {
  const keplr = globalThis.keplr;
  if (!keplr) return { installed: false, keys: [] };
  const keys = [];
  for (const chain of KEPLR_CHAINS) {
    try {
      await keplr.enable(chain.chainId);
      const key = await keplr.getKey(chain.chainId);
      keys.push({
        ...chain,
        bech32Address: key.bech32Address,
        ethereumHexAddress: key.ethereumHexAddress || "",
        name: key.name,
        error: null,
      });
    } catch (error) {
      keys.push({
        ...chain,
        bech32Address: null,
        name: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { installed: true, keys };
}
