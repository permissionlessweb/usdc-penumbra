# USDC withdraw and Penumbra deposit

Keplr and Zafu connect together. Keplr identifies USDC.noble, including a balance that sits on Osmosis. The withdrawal migrates that USDC into USDC.inj. The deposit arrives at a diversified address held by the connected Zafu account.

This repository is the product. It is a static page plus a tested state machine. The author has not run it against a wallet yet. The open work is the labeled matrix in [MATRIX.md](MATRIX.md). Take the next open issue. Do not skip ahead of a soundness gate to make the page look finished.

## This cut

The page can connect Zafu and connect Keplr, and both can stay connected. The figure is the transfer. The page does not send a balance query. The page does not derive the diversified address. The page does not sign. The page does not broadcast. A missing wallet stays "Not installed." A connected Zafu account does not yield an address in this cut.

Chain reads and broadcasts have one door, the Nym mixnet. This cut does not open that door. There is no direct RPC fallback. The page content security policy keeps `connect-src 'none'`.

Hop keys are ephemeral. The Penumbra spend key is not held by the page. Connecting a wallet is not a signature.

## Run

```sh
npm install
npm test
npm run build
python3 -m http.server 8765
```

Open `http://127.0.0.1:8765/`. `npm test` rebuilds `dist/app.js`. The custody bundle under `dist/` is a test artifact and is not committed.

## Help

Read [MATRIX.md](MATRIX.md). Each row is ordered. A row is done only when its Sound, Usable, and Complete cells are all met. Open a pull request against one issue. Say what you ran, and say what you could not run.
