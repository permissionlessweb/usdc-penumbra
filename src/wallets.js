// Zafu injects Symbol.for("penumbra") → origin → provider, from
// @penumbra-zone/client. connect() returns a MessagePort. Speaking ViewService
// on that port needs the Penumbra protobuf client, which this cut does not bundle.
// Keplr is read for account addresses only. Chains are enabled if Keplr already
// has them. This page does not suggest a chain, because that would hand Keplr
// a direct RPC URL.

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
  if (!origins.length) return { installed: false, connected: false };
  const origin = origins[0];
  const provider = record[origin];
  const port = await provider.connect();
  return {
    installed: true,
    connected: Boolean(provider.isConnected?.()),
    origin,
    manifest: String(provider.manifest || ""),
    port,
  };
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
