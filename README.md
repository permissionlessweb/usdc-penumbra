# USDC withdraw and Penumbra deposit

Keplr and Zafu connect together. Keplr identifies USDC.noble, including a balance that sits on Osmosis. The withdrawal migrates that USDC into USDC.inj. The deposit arrives at a diversified address held by the connected Zafu account.

This repository is the product. It is a static page plus a tested state machine. Begin signs each step with the connected wallet and advances only after that step's balance changes. The author has not completed a signed run. The open work is the labeled matrix in [MATRIX.md](MATRIX.md).

## This cut

The page can connect Zafu and connect Keplr, and both can stay connected. The figure is the transfer. A connected Zafu account is asked for one diversified address. The page does not hold the Penumbra spend key. The page reads Penumbra balances from Zafu. The page reads Keplr balances from the chain LCD. Begin asks Keplr to sign the running step, and asks Zafu to sign a Penumbra withdrawal. A missing wallet stays "Not installed."

The person chooses the amount of each balance, up to the amount that was read. Max uses the full balance. Penumbra slices share one Noble address. The deposit uses one diversified address. A balance on Osmosis returns to Noble in that transfer, and the memo burns it on arrival. The Noble account does not pay a fee for that burn. USDC.noble that is already on Noble is burned in its own transaction, which leaves the fee in the account. Circle issues USDC.inj in the same Avalanche transaction. That balance is not sold into an Osmosis pool. When the Injective wallet cannot pay the deposit fee, the page quotes the shortfall on Osmosis first, swaps only that amount, and bridges the INJ that the swap gained. A quote that does not pay INJ is not signed.

The mixnet stays closed. Keplr broadcasts the signed cosmos transaction. The page does not fetch a chain RPC. The content security policy allows the LCD hosts, the Osmosis quote, and the Circle quote. No hop key is issued. Connecting a wallet is not a signature.

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
