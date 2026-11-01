// Chain reads and broadcasts have one door: the Nym mixnet client
// (@nymproject/nym-client-wasm, used from @nymproject/sdk). This cut does not
// open that client. Nothing in this page may call a chain RPC directly.

export const TRANSPORT_NAME = "nym-mixnet";

const CLOSED =
  "Nym mixnet is the only transport. This cut does not open it, and there is no direct RPC fallback.";

export function query() {
  throw new Error(CLOSED);
}

export function broadcast() {
  throw new Error(CLOSED);
}
