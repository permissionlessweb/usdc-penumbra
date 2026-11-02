// Broadcasts have one door: the Nym mixnet client
// (@nymproject/nym-client-wasm, used from @nymproject/sdk). This cut does not
// open that client. query() and broadcast() stay closed.
// Keplr does not return a balance, so the page reads those bank denoms from
// the public LCD. That read is not a broadcast.

export const TRANSPORT_NAME = "nym-mixnet";

const CLOSED =
  "Nym mixnet is the only transport. This cut does not open it, and there is no direct RPC fallback.";

export function query() {
  throw new Error(CLOSED);
}

export function broadcast() {
  throw new Error(CLOSED);
}
