# Batch out

A Penumbra slice is two Zafu signatures. Each signature carries one `Ics20Withdrawal`. The fee withdrawal is signed first. After Zafu detects that transaction, the migration is a second signature. The second spends the change from the first, so the two are not parallel and they are not one plan. One plan with both withdrawals was shown to Zafu 29.5.3 and the approval QR threw "The amount of data is too big to be stored in a QR Code". Nothing was broadcast. The deposit back into Penumbra is a later signature from the slice's Injective account. The next slice waits out its interval and uses a new Injective account.

The return address on both withdrawals is the Zafu ephemeral address for account 0. The deposit receiver is the one diversified address of the connected Zafu account. Slices do not fan out.

Each withdrawal carries a timeout height and a timeout time. The height comes from the light client on the USDC.noble source channel: the client's revision number, and its latest height plus 1000 blocks. That headroom keeps the height in the future when the client lags. The page does not pin a Noble block. The time is ten minutes ahead, in unix nanoseconds, rounded down to one minute. Penumbra refuses the withdrawal when the height is missing. A signed attempt stopped in the planner with that error, before broadcast, so no packet was sent. A missing, inactive, or non-Noble client still sends nothing.

USDC that is already on Osmosis or Noble keeps the existing path. A Penumbra slice does not land on the user's Noble account, and it is not burned again by the shared steps.

## Action A, the fee

The ephemeral account starts with no INJ and no AVAX. The page quotes two Osmosis exact-outs. One is the full Injective deposit fee (`fee("injective-1", GAS.deposit)`, 64000000000000 inj). The other is five times `RELAY_GAS` at the live Avalanche gas price, plus the live Axelar fee. Each quote is `GET https://sqs.osmosis.zone/router/quote` with `tokenOut` set to that amount and `tokenInDenom` set to Osmosis USDC. The pool id and the USDC input are not pinned. SQS lists the pools from the output token back toward USDC. The page reverses that list, then requires the first pool to take Osmosis USDC. A denom Osmosis already holds for the full amount is not quoted. That amount is bridged later.

Action A withdraws the sum of those inputs, plus a USDC fee when the Osmosis account cannot pay the bundle in `uosmo`. The fee is the spot conversion of `600000` gas per swap or bridge message. Penumbra sends it to Noble. The packet receiver is the string `pfm`. The memo forwards on Noble channel-1 to the connected `osmo1` account. There is no wasm swap in that memo.

```json
{
  "forward": {
    "receiver": "<connected osmo1 account>",
    "port": "transfer",
    "channel": "channel-1",
    "timeout": "10m",
    "retries": 2
  }
}
```

When that USDC is on Osmosis, the page signs one Osmosis transaction: the exact-out swaps that are still needed, a channel-122 transfer of the deposit fee in INJ to the new account, and a channel-208 transfer of the AVAX budget to the Axelar GMP account. Axelar relays the AVAX. Each message uses a 600000 gas limit. The page waits until the new account's `inj` covers the deposit fee. It does not wait for AVAX in that transaction.

## Action B, the burn

Action B is the rest of the slice, after action A and after a Penumbra fee reserve. The receiver is the Noble Orbiter module account `noble15xt7kx5mles58vkkfxvf0lq78sw04jajvfgd4d`. The memo is built on this page. It is `orbiter.forwarding` with `PROTOCOL_CCTP`, destination domain 1, the slice's Ethereum address as `mint_recipient`, and no `destination_caller`. There is no fee pre-action. [docs/self-relay.md](self-relay.md) is each later leg: who relays it, and what the user signs. The page preflights and submits the Avalanche mint once Circle has attested the Noble burn. It waits for USDC.inj and does not send the Injective `receiveMessage`.

The page does not ask a solver for a route or a message. Noble burns when the packet arrives, so the Noble account does not sign this withdrawal and does not pay a burn fee.

Circle burns on Noble toward Avalanche. The mint lands at the slice's Ethereum address after `receiveMessage`. A later burn from that address toward Injective, and a second `receiveMessage`, releases USDC.inj. The bank denom is `erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a`. The same Avalanche transaction does not release USDC.inj.

## Deposit

The page waits until that account's `inj` covers the deposit fee and its USDC.inj is at least 1. The wait is the CCTP window, 8 minutes. The account then signs one Injective transfer on channel-494 for the USDC.inj it holds. The receiver is the connected Zafu address.

The signature is local. Injective accounts use ethsecp256k1: keccak256 of the direct SignDoc, and a 65-byte signature `R || S || V` with recovery 0 or 1. The private key stays in the custody map. The page broadcasts with `POST https://lcd.injective.network/cosmos/tx/v1beta1/txs`. The account number and sequence are read after the funds arrive. A missing account throws and the key is kept.

The deposit is acknowledged when Zafu's USDC.inj balance rises. USDC.inj in Penumbra is `transfer/channel-N/erc20:` plus the Injective USDC address. Channel 18 is the channel the author's deposit used. It is not the return channel for USDC.noble. A symbol-USDC total is not this balance. The page shows USDC.noble and USDC.inj separately. USDC.noble is `transfer/channel-N/uusdc` with symbol USDC, and that is the only asset a slice withdraws.

## Fee reserve

Penumbra accepts USDC as a fee token. Each signature pays its own fee. The page asks Zafu `gasPrices` and uses the alt price whose asset id is the USDC metadata asset id. It does not use the staking-token price. One signature's ceiling is `(block space price * 12000 + compact block space price * 800 + verification price * 6000 + execution price * 80) / 1000`. The slice reserves that ceiling twice. Anything above the real fees stays in Penumbra. The planner is still asked for an automatic low fee. If the reserve is short, the planner refuses before broadcast.

A slice that cannot cover the quoted USDC input plus that reserve stops with "This slice cannot buy the Injective fee." Nothing is sent.

## Keys

`issue("injective")` returns the `inj` bech32 address and the Ethereum address of the same key. One key per slice. The walk does not import custody. The page passes `issueHop`, `signHop`, and `wipeKey`.

The key is wiped when a step fails before the first Penumbra broadcast, and after the deposit is acknowledged. After the fee withdrawal is broadcast, a failed migration keeps the key. The page does not send that fee withdrawal again. The error names the public `inj` address. A new hop is stored in local storage. Restart reads balances again and does not send the Penumbra exit a second time. When that stored account still holds USDC.inj, Deposit to Penumbra sends the balance it holds. A closed Zafu connection is asked again. The key stays until Zafu's USDC.inj increases.

The user's Keplr account signs the Osmosis bundle after the fee slice lands. A Penumbra slice relays its own Noble burn: the page finds that burn by the hop's mint recipient, asks Circle, and the hop signs the Avalanche mint once its AVAX balance covers the gas. The same hop then approves USDC and burns it toward Injective. USDC that did not start in Penumbra still uses the shared Osmosis and Noble steps, on a new hop.

## What this does not change

Osmosis USDC still returns on channel-750. The memo is the same client-built Orbiter burn, and Noble does not sign that burn. USDC already on Noble still burns in its own `MsgDepositForBurn`, with no caller and no extra fee send. The user's Injective fee shortfall, when the USDC is already outside Penumbra, is still the exact-out hop on the user's Osmosis account. The mixnet stays closed. The page does not call Skip.
