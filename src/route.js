// Balances select the actions. The person chooses how much of each balance to move.
//
// USDC in Penumbra leaves in slices. The interval and the optional buffer
// belong only to that exit. Each slice is two withdrawals, each its own signature.
// One buys INJ for a new Injective account. The other burns the rest to that
// account. That account deposits to one diversified address. The next slice
// uses a new Injective account. docs/batch-out.md is the flow.
// USDC.noble that is already outside Penumbra migrates in one move.
// USDC already on Injective deposits in one move.
//
// Circle burns the USDC.noble and mints it on Avalanche. The same Avalanche
// transaction issues USDC.inj. A balance still on Osmosis returns to Noble in
// that same transfer: the memo burns it on arrival. That bridge does not sell
// the USDC into an Osmosis pool.
//
// When the user's Injective wallet cannot pay the IBC, and the USDC is already
// outside Penumbra, quote the shortfall on Osmosis and bridge that INJ to the
// wallet. That hop is the first return step. A Penumbra slice buys INJ for its
// own account and does not use this hop. The pool is quoted when that swap is
// signed. Circle's burn is quoted when that step runs. The connected Keplr
// account signs the steps that start outside Penumbra.

export const RELEASE_DENOM = "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";
export const RELEASE_CHAIN = "1776";
export const AVALANCHE_CHAIN = "43114";
export const NOBLE_CHAIN = "noble-1";
export const USDC_NOBLE_DENOM = "uusdc";
// Hash of transfer/channel-750/uusdc. This identifies the Osmosis balance.
export const OSMOSIS_USDC_DENOM =
  "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";
// Hash of transfer/channel-122/inj. The fee swap pays this denom out.
export const INJ_ON_OSMOSIS =
  "ibc/64BA6E31FE887D66C6F8F31C7B1A80C7CA179239677B4088BB55F5EA07DBE273";
export const OSMOSIS_TO_NOBLE = "channel-750";
export const NOBLE_TO_OSMOSIS = "channel-1";
export const OSMOSIS_TO_INJECTIVE = "channel-122";
export const INJECTIVE_TO_PENUMBRA = "channel-494";
// Bank denom of native USDC on Injective. The CCTP release still uses the
// 0x contract address above.
export const INJ_USDC_DENOM = `erc20:${RELEASE_DENOM}`;
export const ZAFU_RECEIVER = "diversified address of the connected Zafu account, not derived yet";
export const USER_INJ = "Injective account from the query, not connected in this cut";
export const USER_OSMOSIS = "Osmosis account from the query, not connected in this cut";
const UNPINNED = "not pinned";
const UNPRICED = "quoted at signing, not pinned";

const SHORT_INJ = "INJ is short. This USDC is already on Injective.";
const NO_USDC = "The query found no USDC.";

export function migrateAmount(findings, amountOut, amountIn, amountOsmosis = "0") {
  let total = 0n;
  if (findings.penumbra) total += BigInt(amountOut || "0");
  if (findings.noble) total += BigInt(amountIn || "0");
  if (findings.osmosis) total += BigInt(amountOsmosis || "0");
  return total.toString();
}

// USDC that is already outside Penumbra. A Penumbra slice migrates itself.
export function outsideAmount(findings, amountIn, amountOsmosis = "0") {
  let total = 0n;
  if (findings.noble) total += BigInt(amountIn || "0");
  if (findings.osmosis) total += BigInt(amountOsmosis || "0");
  return total.toString();
}

export function blockReason(findings) {
  const pays = findings.penumbra || findings.noble || findings.osmosis;
  if (!pays && !findings.usdcInj) return NO_USDC;
  if (findings.injGasShort && findings.usdcInj && !pays) return SHORT_INJ;
  return "";
}

// The address that holds USDC.noble already outside Penumbra. A Penumbra slice
// does not join it. Osmosis joins the connected Noble account.
export function pileRole(findings) {
  if (findings.noble) return "noble";
  if (findings.penumbra) return "exitNoble";
  return "noble";
}

function gasStep() {
  return { id: "gas-osmosis", once: true, hop: "INJ", title: "Buy INJ for the Injective fee" };
}

export function planFor(findings) {
  const blocked = blockReason(findings);
  if (blocked) throw new Error(blocked);
  const outside = findings.noble || findings.osmosis;
  const pays = findings.penumbra || outside;
  const once = [];
  if (outside && findings.injGasShort) once.push(gasStep());
  if (findings.osmosis) {
    once.push({ id: "gather-osmosis", once: true, hop: "In", title: "Return Osmosis USDC to Noble" });
  }
  if (outside) {
    once.push(
      { id: "cctp-noble", once: true, hop: "In", title: "Burn USDC.noble" },
      { id: "cctp-forward", once: true, hop: "In", title: "Issue USDC.inj" },
    );
  }
  if (outside || findings.usdcInj) {
    once.push({ id: "deposit", once: true, hop: "In", title: "Enter Penumbra" });
  }
  if (pays) {
    once.push({ id: "wipe", once: true, hop: "Local", title: "Wipe the inbound keys" });
  }
  const exit = findings.penumbra
    ? [{ id: "leave", hop: "Out", title: "Leave Penumbra" }]
    : [];
  return { exit, once };
}

export function stepsFor(findings) {
  const plan = planFor(findings);
  return [...plan.exit, ...plan.once];
}

export function keysForStep(stepId, findings = {}) {
  const pile = pileRole(findings);
  if (stepId === "cctp-noble") return pile === "noble" ? ["noble", "avalanche"] : ["avalanche"];
  if (stepId === "cctp-forward") return ["injLeave"];
  if (stepId === "leave") return [];
  if (stepId === "gather-osmosis" || stepId === "gather-exit") return pile === "noble" ? ["noble"] : [];
  return [];
}

function addr(value) {
  return value || "not derived yet";
}

function ibcTransfer(sender, denom, amount, receiver, channel, memo = "") {
  return {
    type: "cosmos-sdk/MsgTransfer",
    value: {
      source_port: "transfer",
      source_channel: channel,
      token: { denom, amount },
      sender,
      receiver,
      timeout_height: {},
      timeout_timestamp: "set at signing",
      memo,
    },
  };
}

function named(ctx, role, fallback) {
  return ctx.addresses?.[role] || fallback;
}

export function describeStep(stepId, ctx) {
  const a = ctx.addresses;
  const findings = ctx.findings;
  const outside = outsideAmount(findings, ctx.amountIn, ctx.amountOsmosis);
  const holder = named(ctx, pileRole(findings), "");
  if (stepId === "leave") {
    return {
      detail: "This slice buys INJ for a new Injective account and burns the rest to that account.",
      messages: [
        {
          type: "penumbra-withdraw",
          value: {
            asset: "USDC",
            to: "INJ",
            amount: "the quoted input",
            receiver: "a new Injective account",
          },
        },
        {
          type: "penumbra-withdraw",
          value: {
            asset: "USDC",
            to: "USDC.inj",
            amount: "the remainder",
            receiver: "a new Injective account",
          },
        },
      ],
    };
  }
  if (stepId === "cctp-noble") {
    return {
      detail: "Circle burns this USDC.noble and mints it on Avalanche.",
      messages: [
        {
          type: "cctpTransfer",
          value: {
            fromChainId: NOBLE_CHAIN,
            toChainId: AVALANCHE_CHAIN,
            burn_token: USDC_NOBLE_DENOM,
            asset: "USDC.noble",
            amount: outside,
            signer: addr(holder),
            mint_recipient: addr(a.avalanche),
          },
        },
      ],
    };
  }
  if (stepId === "cctp-forward") {
    return {
      detail: "The same Avalanche transaction issues USDC.inj.",
      messages: [
        {
          type: "cctpTransfer",
          value: {
            fromChainId: NOBLE_CHAIN,
            toChainId: AVALANCHE_CHAIN,
            state: "CCTP_TRANSFER_RECEIVED",
            mint_recipient: addr(a.avalanche),
          },
        },
        {
          type: "cctpTransferV2",
          value: {
            fromChainId: AVALANCHE_CHAIN,
            toChainId: RELEASE_CHAIN,
            state: "CCTP_TRANSFER_RECEIVED",
            same_transaction_as_avalanche_receive: true,
            mint_recipient: addr(a.injEthereum),
          },
        },
        {
          type: "transferAssetRelease",
          value: {
            chainId: RELEASE_CHAIN,
            denom: RELEASE_DENOM,
            asset: "USDC.inj",
            amount: outside,
            released: true,
            recipient: addr(a.injEthereum),
          },
        },
      ],
    };
  }
  if (stepId === "gather-osmosis") {
    return {
      detail: "This transfer returns the USDC to Noble and burns it on arrival.",
      messages: [
        ibcTransfer(
          named(ctx, "userOsmosis", USER_OSMOSIS),
          OSMOSIS_USDC_DENOM,
          ctx.amountOsmosis,
          addr(holder),
          OSMOSIS_TO_NOBLE,
        ),
      ],
    };
  }
  if (stepId === "gather-exit") {
    return {
      detail: "Penumbra receipts join the Noble balance.",
      messages: [
        {
          type: "cosmos-sdk/MsgSend",
          value: {
            from_address: addr(a.exitNoble),
            to_address: addr(a.noble),
            amount: [{ denom: USDC_NOBLE_DENOM, amount: ctx.amountOut }],
          },
        },
      ],
    };
  }
  if (stepId === "gas-osmosis") {
    return {
      detail: "Osmosis buys the INJ the Injective fee still needs. That INJ bridges to the Injective wallet.",
      messages: [
        {
          type: "osmosis/poolmanager/swap-exact-amount-out",
          value: {
            sender: named(ctx, "userOsmosis", USER_OSMOSIS),
            routes: [{ pool_id: UNPINNED, token_in_denom: OSMOSIS_USDC_DENOM }],
            token_in_max_amount: UNPRICED,
            token_out: { denom: INJ_ON_OSMOSIS, amount: UNPRICED },
          },
        },
        ibcTransfer(
          named(ctx, "userOsmosis", USER_OSMOSIS),
          INJ_ON_OSMOSIS,
          UNPRICED,
          named(ctx, "userInj", USER_INJ),
          OSMOSIS_TO_INJECTIVE,
        ),
      ],
    };
  }
  if (stepId === "deposit") {
    const messages = [];
    const receiver = a?.zafu || ZAFU_RECEIVER;
    const also = findings.penumbra || findings.noble || findings.osmosis;
    if (findings.noble || findings.osmosis) {
      messages.push(ibcTransfer(addr(a.injLeave), INJ_USDC_DENOM, outside, receiver, INJECTIVE_TO_PENUMBRA));
    }
    if (findings.usdcInj) {
      messages.push(ibcTransfer(
        named(ctx, "userInj", USER_INJ),
        INJ_USDC_DENOM,
        also ? (ctx.amountHeld ?? "already held, unread in this cut") : ctx.amountIn,
        receiver,
        INJECTIVE_TO_PENUMBRA,
      ));
    }
    return { detail: "USDC enters the Zafu account. The Injective wallet pays the gas.", messages };
  }
  return { detail: "No hop key was issued.", messages: [] };
}

const UNREADY = /not pinned|not derived|quoted at signing|not connected|unread in this cut/;

export function signingGaps(messages) {
  const gaps = new Set();
  const walk = (value) => {
    if (typeof value === "string") {
      if (UNREADY.test(value)) gaps.add(value);
      return;
    }
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  for (const message of messages) walk(message);
  return [...gaps];
}

export function closedDoors() {
  return [
    "The mixnet is closed.",
    "Bank balances are read from the chain LCD.",
    "Penumbra balances are read from Zafu.",
    "A swapping route is refused.",
  ];
}
