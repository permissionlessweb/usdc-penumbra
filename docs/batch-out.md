# Batch out

A Penumbra slice is two Zafu signatures. Each signature carries one `Ics20Withdrawal`. The fee withdrawal is signed first. After Zafu detects that transaction, the migration is a second signature. The second spends the change from the first, so the two are not parallel and they are not one plan. One plan with both withdrawals was shown to Zafu 29.5.3 and the approval QR threw "The amount of data is too big to be stored in a QR Code". Nothing was broadcast. The deposit back into Penumbra is a later signature from the slice's Injective account. The next slice waits out its interval and uses a new Injective account.

The return address on both withdrawals is the Zafu ephemeral address for account 0. The deposit receiver is the one diversified address of the connected Zafu account. Slices do not fan out.

Each withdrawal carries a timeout height and a timeout time. The height comes from the light client on the USDC.noble source channel: the client's revision number, and its latest height plus 1000 blocks. That headroom keeps the height in the future when the client lags. The page does not pin a Noble block. The time is ten minutes ahead, in unix nanoseconds, rounded down to one minute. Penumbra refuses the withdrawal when the height is missing. A signed attempt stopped in the planner with that error, before broadcast, so no packet was sent. A missing, inactive, or non-Noble client still sends nothing.

USDC that is already on Osmosis or Noble keeps the existing path. A Penumbra slice does not land on the user's Noble account, and it is not burned again by the shared steps.

## Action A, the fee

The ephemeral Injective account starts with no INJ. The page quotes an Osmosis exact-out for the full Injective deposit fee (`fee("injective-1", GAS.deposit)`, 64000000000000 inj). The quote is `GET https://sqs.osmosis.zone/router/quote` with `tokenOut` set to that fee and `tokenInDenom` set to Osmosis USDC. The quoted output denom must be Osmosis INJ (`ibc/64BA6E31FE887D66C6F8F31C7B1A80C7CA179239677B4088BB55F5EA07DBE273`) and the output amount must be the fee. The pool id and the USDC input are not pinned. SQS lists the pools from the output token back toward USDC. The page reverses that list, then requires the first pool to take Osmosis USDC. A quote may be more than one pool. A live leave stopped on this check: SQS had quoted the fee, and the page rejected the quote because the first listed pool was not USDC. Nothing was broadcast.

Action A withdraws that quoted USDC input. Penumbra sends it to Noble. The packet receiver is the string `pfm`, not a Noble account. The memo is packet-forward middleware:

```json
{
  "forward": {
    "receiver": "osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs",
    "port": "transfer",
    "channel": "channel-1",
    "timeout": "10m",
    "retries": 2,
    "next": {
      "wasm": {
        "contract": "osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs",
        "msg": {
          "osmosis_swap": {
            "output_denom": "ibc/64BA6E31FE887D66C6F8F31C7B1A80C7CA179239677B4088BB55F5EA07DBE273",
            "slippage": { "min_output_amount": "<deposit fee, inj base units>" },
            "receiver": "<ephemeral inj bech32>",
            "on_failed_delivery": "do_nothing"
          }
        }
      }
    }
  }
}
```

`channel-1` is Noble's channel to Osmosis. The forward receiver is the Osmosis contract, because Osmosis runs the wasm hook when the incoming packet's receiver is that contract. The contract is CrossChainSwaps v1.2, code id 37, label read from `lcd.osmosis.zone` on 2026-11-01. It sells the whole coin and emits one IBC transfer. The message is the v1 shape: `output_denom`, `slippage`, `receiver`, `on_failed_delivery`. It does not set v2 `route` or `final_memo`. The page uses the quote for the USDC amount and to confirm the output is the fee. The contract sells through the route stored on its swap router, not the pools in the page quote. That stored route was not read.

`min_output_amount` is the deposit fee. The contract cannot exact-out and it does not partial-fill. A price move that would deliver less than the fee fails the swap, and the packet should refund to the Penumbra return address rather than leave USDC.inj beside too little INJ.

The contract's channel registry is `(bech32 prefix, channel id)` set by the governor. The page does not put a channel in the swap message. The `inj` prefix on this instance was not confirmed. A missing prefix fails the wasm execute. The expected result is an IBC refund to the Penumbra return address. That registry was not checked live.

Noble's packet receiver is the placeholder `pfm` so a missing middleware does not credit a user account. If Noble rejects that receiver, the packet refunds. The first signed attempt never reached Noble: the planner rejected it for a missing timeout height.

## Action B, the burn

Action B is the rest of the slice, after action A and after a Penumbra fee reserve. The receiver is the Noble Orbiter module account `noble15xt7kx5mles58vkkfxvf0lq78sw04jajvfgd4d`. The memo is the Skip memo the page already accepts for an Osmosis to Injective route, unchanged.

Skip is asked for that remainder with `allow_swaps: false`, `allow_multi_tx: true`, and `smart_relay: true`. The source chain in the request is `osmosis-1`, because a Noble-source quote returns burn messages and no memo. The connected Keplr Osmosis address is the signer Skip requires. The page does not sign or broadcast that Osmosis `MsgTransfer`. It checks the message the same way as the inbound Osmosis return: one Osmosis transfer, receiver Orbiter, amount equal to the remainder, memo protocol `PROTOCOL_CCTP`, destination domain 1. The memo string from that message is copied onto the withdrawal.

The address list is the Osmosis account, a Noble account (the connected Noble address, or Orbiter when Noble is not connected), the ephemeral account's Ethereum address, and the ephemeral `inj` address. The Ethereum address is the CCTP mint recipient. The relay fee is amount-specific, so the quote is fetched for this remainder.

Circle then burns on Noble, mints on Avalanche, and the same Avalanche transaction releases USDC.inj to the ephemeral account. The bank denom is `erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a`.

## Deposit

The page waits until that account's `inj` covers the deposit fee and its USDC.inj is at least 1. The wait is the CCTP window, 8 minutes. The account then signs one Injective transfer on channel-494 for the USDC.inj it holds. The receiver is the connected Zafu address.

The signature is local. Injective accounts use ethsecp256k1: keccak256 of the direct SignDoc, and a 65-byte signature `R || S || V` with recovery 0 or 1. The private key stays in the custody map. The page broadcasts with `POST https://lcd.injective.network/cosmos/tx/v1beta1/txs`. The account number and sequence are read after the funds arrive. A missing account throws and the key is kept.

The deposit is acknowledged when Zafu's USDC.inj balance rises. USDC.inj in Penumbra is `transfer/channel-N/erc20:` plus the Injective USDC address. Channel 18 is the channel the author's deposit used. It is not the return channel for USDC.noble. A symbol-USDC total is not this balance. The page shows USDC.noble and USDC.inj separately. USDC.noble is `transfer/channel-N/uusdc` with symbol USDC, and that is the only asset a slice withdraws.

## Fee reserve

Penumbra accepts USDC as a fee token. Each signature pays its own fee. The page asks Zafu `gasPrices` and uses the alt price whose asset id is the USDC metadata asset id. It does not use the staking-token price. One signature's ceiling is `(block space price * 12000 + compact block space price * 800 + verification price * 6000 + execution price * 80) / 1000`. The slice reserves that ceiling twice. Anything above the real fees stays in Penumbra. The planner is still asked for an automatic low fee. If the reserve is short, the planner refuses before broadcast.

A slice that cannot cover the quoted USDC input plus that reserve stops with "This slice cannot buy the Injective fee." Nothing is sent.

## Keys

`issue("injective")` returns the `inj` bech32 address and the Ethereum address of the same key. One key per slice. The walk does not import custody. The page passes `issueHop`, `signHop`, and `wipeKey`.

The key is wiped when a step fails before the first Penumbra broadcast, and after the deposit is acknowledged. After the fee withdrawal is broadcast, a failed migration keeps the key for this page session. The page does not send that fee withdrawal again. The error names the public `inj` address. Restart reads balances again and does not send those funds a second time. It also does not resume the deposit. Reloading the page drops the in-memory key.

The user's Keplr accounts still sign the Osmosis and Noble steps for USDC that did not start in Penumbra. A Penumbra-only selection does not buy INJ on the user's Osmosis account and does not run the shared burn or the shared deposit.

## What this does not change

Osmosis USDC still returns on channel-750 with Skip's Orbiter memo, and Noble does not sign that burn. USDC already on Noble still burns in its own transaction. The user's Injective fee shortfall, when the USDC is already outside Penumbra, is still the exact-out hop on the user's Osmosis account. The mixnet stays closed.
