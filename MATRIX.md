# Todo matrix

Work the rows in order. A later row that broadcasts, or that shows a balance, waits until the earlier soundness cells are met.

Three labels:

- **Sound.** The page refuses a wrong action. No invented balance, no invented address, no direct RPC, no spend key on the page, hop keys wiped.
- **Usable.** A person can see what the connected accounts imply, and can tell a missing wallet from a missing balance.
- **Complete.** The step has run once against real wallets. Record the run in the pull request. Do not paste a production transaction hash into the page.

| Order | Work | Sound | Usable | Complete |
| --- | --- | --- | --- | --- |
| 1 | Connect Keplr and Zafu together | Connect is not a signature. Enabling a chain does not hand Keplr a new RPC URL. Closing one wallet does not clear the other. | Both buttons work in a normal browser. Each status stays honest. | One person besides the author connects both extensions and leaves them connected. |
| 2 | Read USDC.noble | The query goes out only on the Nym mixnet. A closed transport throws. The page does not invent a number. | The page lists each Keplr account that holds USDC.noble, including Osmosis. An empty result says the query found none. | A real Keplr account is read over Nym and the figure matches that result. |
| 3 | Diversified address | The address comes from the connected Zafu account. The page does not hold the Penumbra spend key. Index selection is not a signature. | The destination on the figure is that address, or an explicit "not derived" while the port is closed. | ViewService returns one diversified address for the connected account, and the deposit template uses it. |
| 4 | Prepare the withdrawal | The plan is built from the query. USDC.noble migrates into USDC.inj. The inbound move is one move. Amounts are the queried amounts. | The message preview is closed until the person opens it. The preview names the Zafu address as receiver. | A preview is produced from a real query without a broadcast. |
| 5 | Deposit | The receiver is only the address from row 3. The IBC channel stays unpinned until a quote exists. No sample transfer is hardcoded as the route. | One action sends the prepared deposit. A failure stops the queue and wipes hop keys. | One small deposit lands on the diversified address. |
| 6 | Penumbra USDC withdraw | Slices, the interval, and the optional buffer apply only when USDC leaves Penumbra. Each return uses a distinct diversified address of the same Zafu account. | A Penumbra balance shows the exit schedule. A balance that is only USDC.noble does not. | A shielded balance leaves in slices and returns to distinct diversified addresses. |
| 7 | INJ for the Injective hop | Gas is a small Osmosis swap beside the move, and only when INJ is short. The pool id stays unpinned until a quote exists. Osmosis is not a fourth destination. | The page says when INJ is short and Osmosis cannot fill it. The walk stops. | A short INJ balance is filled from Osmosis as part of one deposit. |
| 8 | Transport door | `@nymproject/nym-client-wasm` is the client. `query` and `broadcast` throw until it is open. CSP gains no chain RPC origin. | A closed mixnet is visible on the page. A failed broadcast does not fall through to a direct RPC. | One query and one broadcast complete on the mixnet, and a direct RPC attempt still fails. |

Rows 1 through 5 finish the product named by this repository: withdraw USDC.noble, deposit it to Penumbra. Rows 6 through 8 finish the shielded exit, the gas hop, and the transport that makes those runs sound.
