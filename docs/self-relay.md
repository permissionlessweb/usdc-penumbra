# Self relay

The page does not ask Skip for a route, a message, a quote, or a relay. Circle's public Iris API attests a burn. That is an attestation service. It is not a solver. Nothing on the demo list is signed or broadcast.

Reads on 2026-11-02, no transaction sent:

- `GET https://noble-api.polkachu.com/circle/cctp/v1/remote_token_messengers` returned ten domains: 0, 1, 2, 3, 5, 6, 7, 8, 9, 10. Domain 29 returned HTTP 404 `not found`. Domain 1 returned HTTP 200. Noble's local domain is 4. `local_message_version` and `burn_message_version` are 0. Noble speaks CCTP V1.
- Noble `transfer/channel-31` is `STATE_OPEN`. The counterparty is Injective `transfer/channel-148` on connection-55, client `07-tendermint-57`. That client is chain `injective-1`, status Active, frozen height 0. Injective `channel-148` is `STATE_OPEN` back to Noble `channel-31`. The chain-registry file `_IBC/injective-noble.json` marks the same pair preferred and `ACTIVE`.
- A search for a Noble to Terp channel was not confirmed.

## Which designs are fully self-relayed

(a) Circle lists Injective as CCTP V2 domain 29. Noble has no remote token messenger for that domain, and Noble emits V1 messages. A Noble burn cannot go straight to Injective. This design does not work from Noble.

(b) Noble channel-31 to Injective channel-148 is an open IBC path. Anyone can relay `RecvPacket` if they run a relayer, so that packet is fully self-relayed. The coin that lands is the IBC hash of `uusdc`, not Injective native USDC (`erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a`). No Injective pool that swaps that hash into native USDC was identified, so this leg does not finish the deposit the page already signs. A Noble to Terp channel was not confirmed.

(c) Peggy needs Ethereum and Peggy's orchestrators. It is not the same call as `receiveMessage`. It is not fully self-relayed. Noble does register Ethereum as CCTP domain 0. That registration is not Peggy.

(d) Wormhole (guardians, and a VAA delivered through Noble's wormhole module) and IBC-Eureka use a third-party relayer. They are not fully self-relayed.

The path below is the one the page builds. Each relay is the user or anyone. It lands the native Injective USDC denom the deposit already uses.

## Legs

The mint recipient is an address this page generated for the hop. `destination_caller` is left empty. Noble rejects 32 zero bytes as a malformed caller. An empty caller burns with `DepositForBurn`, so anyone may submit `receiveMessage`. There is no fee pre-action. `maxFee` `0` is the documented fee for a standard transfer (`minFinalityThreshold` 2000). A chain call to `getMinFeeAmount` was not made. A non-zero on-chain minimum would revert that burn.

1. Osmosis to Noble. The Osmosis account signs one IBC transfer on channel-750. The receiver is Orbiter `noble15xt7kx5mles58vkkfxvf0lq78sw04jajvfgd4d`. The memo is `orbiter.forwarding` with `PROTOCOL_CCTP`, destination domain 1, the hop as `mint_recipient`, no `destination_caller`, and an empty `passthrough_payload`. Anyone can deliver the packet. This team relays it. Noble burns when the packet is received. The Noble account does not sign this leg.

2. Noble burn, when the USDC is already on Noble. The connected Noble account signs one `/circle.cctp.v1.MsgDepositForBurn`. The destination domain is 1. The message is not `MsgDepositForBurnWithCaller`, so the caller is zero. The gas fee stays in the account. There is no extra fee send. Noble burns in that transaction.

3. Attestation. Nobody signs. Noble is CCTP V1. The page reads `MessageSent` from the Noble burn and asks `GET https://iris-api.circle.com/v1/attestations/0x{keccak256 of that message}`. The V2 messages route does not list these burns. A missing or pending attestation stays on the step as "Waiting for Circle to attest the Noble burn." It is not a failure on the first miss. The page keeps waiting for the Injective balance.

4. Mint on Avalanche. The page preflights `receiveMessage(bytes,bytes)` on the V1 MessageTransmitter `0x8186359aF5F57FbB40c6b14A588d2A59C0C29880`. When an ephemeral account was funded, that account signs and submits the mint on Avalanche after its AVAX balance is visible. The browser wallet is not asked. Noble emits V1, so this is not MessageTransmitterV2. The destination caller is 32 zero bytes, so the hop, the connected EVM wallet, or anyone may submit it. The mint lands at the hop. The AVAX bought for the hop is five times a 500000 gas call at the live gas price, plus the Axelar fee. That covers the mint, the USDC approval, and the burn. 500000 is headroom, not a measured median of `receiveMessage`.

5. Burn toward Injective. After that mint, the same account signs `depositForBurn` on Avalanche TokenMessengerV2 `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`. The burn token is Avalanche USDC `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`. The destination domain is 29. The mint recipient is the same hop, left-padded to 32 bytes. The destination caller is 32 zero bytes. `maxFee` is `0`. `minFinalityThreshold` is 2000. The page submits that call. Avalanche burns in that transaction.

6. Mint on Injective. Iris would be read again for the Avalanche burn, source domain 1, and `receiveMessage` would go to Injective MessageTransmitterV2 `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`. This page does not send that call. No Injective EVM endpoint was verified, and Keplr's Cosmos signer is not that call. The page waits until USDC.inj rises. Native USDC then sits at the hop's Ethereum address, which is the same key as the `inj` account. The bank denom stays `erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a`. The existing channel-494 deposit runs after that balance rises.

When the connected Injective wallet cannot pay the deposit fee, the page issues a new Injective account and quotes the full fee, not the shortfall. The quote is still exact-out on `sqs.osmosis.zone`. The INJ buy and the AVAX buy are one Osmosis transaction: both exact-out swaps, then the channel-122 INJ transfer and the channel-208 AVAX transfer. Each of those four messages is inside a 600000 gas limit. Axelar relays the AVAX. The fee list Osmosis accepts is embedded. The page does not query it. A live spot price on `osmosis-api.polkachu.com` converts a USDC.noble fee into the base denom. Osmosis balances, the account sequence, the broadcast, and the wait for inclusion use that same API. USDC.noble is preferred when the wallet holds it and the spot matches the embedded pool. A missing spot falls back to `uosmo`. The Noble return and the dev return send the minimum of the selected amount and the live balance minus 0.01 USDC. The fee stays the priced amount. That fee is taken from the cent left in the account. A sample of 20 Osmosis transfers used a median of 250339 gas and a maximum of 330937.

The fee withdrawal is unchanged. It is a Penumbra signature to `pfm`, then the Osmosis swap contract. It is not a solver relay.

## What is still open

No packet has left under this memo. The mixnet is closed. The Osmosis contract's stored USDC to INJ route was not read. `getMinFeeAmount` was not read. The installed Zafu extension still clips the approval QR until that extension is rebuilt. GitHub issues 1 through 8 were not edited, so those bodies still name Skip.
