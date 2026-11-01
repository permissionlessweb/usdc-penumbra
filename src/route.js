// Wallet balances select the actions.
//
// USDC in Penumbra leaves in slices. The interval and the optional random
// buffer belong only to that exit.
// USDC.noble and USDC already on Injective enter Penumbra in one move.
// When the Injective wallet cannot pay the IBC into Penumbra, row 7 of
// MATRIX.md takes 0.25 USDC from the migration, multi-hops it to Osmosis,
// swaps it for INJ, and bridges that INJ to the Injective wallet. The code
// below still treats gas as an unpriced Osmosis balance. That is not the hop.
//
// The noble path still follows the known CCTP release shape. The page does
// not show that sample as the product. Hop keys are cosmes. This page does
// not broadcast.

export const RELEASE_DENOM = "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";
export const RELEASE_CHAIN = "1776";
export const AVALANCHE_CHAIN = "43114";
export const NOBLE_CHAIN = "noble-1";
export const USDC_NOBLE_DENOM = "uusdc";
export const ZAFU_RECEIVER = "diversified address of the connected Zafu account, not derived yet";
export const USER_INJ = "Injective account from the query, not connected in this cut";
export const USER_OSMOSIS = "Osmosis account from the query, not connected in this cut";
const INJ_ON_OSMOSIS = "INJ on Osmosis, denom not pinned";
const OSMOSIS_IN = "spendable Osmosis balance, denom not pinned";
const GAS_AMOUNT = "a bit, unpriced";

export const BALANCE_QUERY = [
  {
    asset: "Penumbra",
    field: "penumbra",
    options: [
      ["no", "None"],
      ["yes", "USDC"],
    ],
  },
  {
    asset: "USDC.noble",
    field: "noble",
    options: [
      ["no", "None"],
      ["yes", "USDC"],
    ],
  },
  {
    asset: "USDC.inj",
    field: "usdcInj",
    options: [
      ["no", "None"],
      ["yes", "USDC"],
    ],
  },
  {
    asset: "INJ",
    field: "injGas",
    options: [
      ["enough", "Enough"],
      ["short", "Short"],
    ],
  },
  {
    asset: "Osmosis",
    field: "osmosis",
    options: [
      ["yes", "Funds"],
      ["no", "None"],
    ],
  },
];

const EMPTY = "not derived yet";

export function blockReason(findings) {
  if (!findings.penumbra && !findings.noble && !findings.usdcInj) {
    return "The query found no USDC.";
  }
  if ((findings.noble || findings.usdcInj) && findings.injGasShort && !findings.osmosisFunds) {
    return "INJ is short. Osmosis has no funds.";
  }
  return "";
}

function enterSteps(findings) {
  const steps = [];
  const moving = findings.noble || findings.usdcInj;
  if (findings.noble) {
    steps.push(
      {
        id: "cctp-noble",
        once: true,
        hop: "In",
        title: "Move USDC.noble",
      },
      {
        id: "cctp-forward",
        once: true,
        hop: "In",
        title: "Release USDC.inj",
      },
    );
  }
  if (moving && findings.injGasShort) {
    steps.push({
      id: "gas-osmosis",
      once: true,
      hop: "INJ",
      title: findings.osmosisFunds ? "Bring INJ from Osmosis" : "INJ is short",
    });
  }
  if (moving) {
    steps.push({
      id: "deposit",
      once: true,
      hop: "In",
      title: "Enter Penumbra",
    });
  }
  if (findings.noble) {
    steps.push({
      id: "wipe",
      once: true,
      hop: "Local",
      title: "Wipe the inbound keys",
    });
  }
  return steps;
}

function exitSteps() {
  return [
    {
      id: "leave",
      hop: "Out",
      title: "Leave Penumbra",
    },
    {
      id: "wipe",
      hop: "Local",
      title: "Wipe the slice keys",
    },
  ];
}

export function stepsFor(findings) {
  return [...enterSteps(findings), ...(findings.penumbra ? exitSteps() : [])];
}

export function keysForStep(stepId) {
  if (stepId === "cctp-noble") return ["noble", "avalanche"];
  if (stepId === "cctp-forward") return ["injLeave"];
  if (stepId === "leave") return ["exitNoble"];
  return [];
}

function addr(value) {
  return value || EMPTY;
}

function ibcTransfer(sender, denom, amount, receiver) {
  return {
    type: "cosmos-sdk/MsgTransfer",
    value: {
      source_port: "transfer",
      source_channel: "not pinned",
      token: { denom, amount },
      sender,
      receiver,
      timeout_height: {},
      timeout_timestamp: "set at signing",
      memo: "",
    },
  };
}

export function describeStep(stepId, ctx) {
  const a = ctx.addresses;
  const findings = ctx.findings;
  const enterAmount = ctx.amountIn;
  if (stepId === "leave") {
    return {
      detail: "This slice leaves Penumbra.",
      messages: [
        {
          type: "penumbra-withdraw",
          value: {
            asset: "USDC",
            to: "USDC.noble",
            amount: ctx.amountBase,
            receiver: addr(a.exitNoble),
          },
        },
      ],
    };
  }
  if (stepId === "cctp-noble") {
    return {
      detail: "USDC.noble leaves Noble.",
      messages: [
        {
          type: "cctpTransfer",
          value: {
            fromChainId: NOBLE_CHAIN,
            toChainId: AVALANCHE_CHAIN,
            burn_token: USDC_NOBLE_DENOM,
            asset: "USDC.noble",
            amount: enterAmount,
            signer: addr(a.noble),
            mint_recipient: addr(a.avalanche),
          },
        },
      ],
    };
  }
  if (stepId === "cctp-forward") {
    return {
      detail: "The same move releases USDC.inj.",
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
            amount: enterAmount,
            released: true,
            recipient: addr(a.injEthereum),
          },
        },
      ],
    };
  }
  if (stepId === "gas-osmosis") {
    if (!findings.osmosisFunds) {
      return {
        detail: "INJ is short. Osmosis has no funds.",
        messages: [],
      };
    }
    const messages = [
      {
        type: "osmosis/gamm/swap-exact-amount-in",
        value: {
          sender: USER_OSMOSIS,
          routes: [{ pool_id: "not pinned", token_out_denom: INJ_ON_OSMOSIS }],
          token_in: { denom: OSMOSIS_IN, amount: GAS_AMOUNT },
          token_out_min_amount: "unpriced",
        },
      },
    ];
    if (findings.noble) messages.push(ibcTransfer(USER_OSMOSIS, INJ_ON_OSMOSIS, GAS_AMOUNT, addr(a.injLeave)));
    if (findings.usdcInj) messages.push(ibcTransfer(USER_OSMOSIS, INJ_ON_OSMOSIS, GAS_AMOUNT, USER_INJ));
    return {
      detail: "A small part of the Osmosis balance becomes INJ.",
      messages,
    };
  }
  if (stepId === "deposit") {
    const messages = [];
    if (findings.noble) messages.push(ibcTransfer(addr(a.injLeave), RELEASE_DENOM, enterAmount, ZAFU_RECEIVER));
    if (findings.usdcInj) {
      messages.push(ibcTransfer(USER_INJ, RELEASE_DENOM, findings.noble ? "already held, unread in this cut" : enterAmount, ZAFU_RECEIVER));
    }
    return {
      detail: "USDC enters the Zafu account.",
      messages,
    };
  }
  return {
    detail: "The page drops the keys for this slice.",
    messages: [],
  };
}
