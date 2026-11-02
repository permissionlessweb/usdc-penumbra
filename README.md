# USDC withdraw and Penumbra deposit

Keplr and Zafu connect together. Keplr identifies USDC.noble, including a balance that sits on Osmosis. The withdrawal migrates that USDC into USDC.inj. The deposit arrives at a diversified address held by the connected Zafu account.

This repository is the product. It is a static page plus a tested state machine. Begin signs each step with the connected wallet and advances only after that step's balance changes. The author signed the Osmosis path through the Injective deposit. A Penumbra slice has been shown to Zafu and has not been broadcast. The open work is the labeled matrix in [MATRIX.md](MATRIX.md).

## This cut

The page can connect Zafu and connect Keplr, and both can stay connected. The figure is the transfer. A connected Zafu account is asked for one diversified address. The page does not hold the Penumbra spend key. The page reads Penumbra balances from Zafu. The page reads Keplr balances from the chain LCD. Begin asks Keplr to sign the running step, and asks Zafu to sign a Penumbra withdrawal. A missing wallet stays "Not installed."

The person chooses the amount of each balance, up to the amount that was read. Max uses the full balance. A Penumbra slice signs the fee withdrawal, then signs the migration, and that Injective account deposits to one diversified address. The next slice uses a new account. [docs/batch-out.md](docs/batch-out.md) is that flow. A balance on Osmosis returns to Noble in that transfer, and the memo burns it on arrival. The Noble account does not pay a fee for that burn. USDC.noble that is already on Noble is burned in its own transaction, which leaves the fee in the account. Circle issues USDC.inj in the same Avalanche transaction. That balance is not sold into an Osmosis pool. When the user's Injective wallet cannot pay the deposit fee, and the USDC is already outside Penumbra, the page quotes the shortfall on Osmosis first, swaps only that amount, and bridges the INJ that the swap gained. A quote that does not pay INJ is not signed.

The mixnet stays closed. Keplr broadcasts the signed cosmos transaction. A Penumbra slice's Injective account signs locally and the page broadcasts that transaction to the Injective LCD. The page does not fetch a chain RPC. The content security policy allows the LCD hosts, the Osmosis quote, and the Circle quote. Each Penumbra slice holds one Injective key until its deposit is acknowledged. The key is not the user's Keplr key. Connecting a wallet is not a signature.

## Run

```sh
npm install
npm test
npm run build
python3 -m http.server 8765
```

Open `http://127.0.0.1:8765/`. `npm test` rebuilds `dist/app.js`. Built files under `dist/` are not committed.

## Help

Read [MATRIX.md](MATRIX.md). Each row is ordered. A row is done only when its Sound, Usable, and Complete cells are all met. Open a pull request against one issue. Say what you ran, and say what you could not run.
