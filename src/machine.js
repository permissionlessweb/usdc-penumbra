import { blockReason, keysForStep, planFor } from "./route.js";

export function splitAmount(amountBase, slices) {
  const total = BigInt(amountBase);
  const count = BigInt(slices);
  if (total <= 0n) throw new Error("amount must be positive");
  if (count <= 0n) throw new Error("slices must be positive");
  const base = total / count;
  const remainder = total % count;
  const parts = [];
  for (let i = 0n; i < count; i += 1n) {
    const extra = i === count - 1n ? remainder : 0n;
    parts.push((base + extra).toString());
  }
  return parts;
}

function emptyKeys() {
  return { noble: null, avalanche: null, injLeave: null, exitNoble: null };
}

export function initRun(input) {
  const findings = {
    penumbra: Boolean(input.penumbra),
    noble: Boolean(input.noble),
    osmosis: Boolean(input.osmosis),
    usdcInj: Boolean(input.usdcInj),
    injGasShort: Boolean(input.injGasShort),
  };
  const blocked = blockReason(findings);
  if (blocked) throw new Error(blocked);
  let slices = 1;
  let intervalSec = 0;
  let jitterMaxSec = 0;
  if (findings.penumbra) {
    slices = Number(input.slices);
    if (!Number.isInteger(slices) || slices < 1 || slices > 12) {
      throw new Error("slices must be an integer from 1 to 12");
    }
    if (!Number.isInteger(input.intervalSec) || input.intervalSec < 0) {
      throw new Error("interval must be a whole number of seconds");
    }
    if (!Number.isInteger(input.jitterMaxSec) || input.jitterMaxSec < 0) {
      throw new Error("jitter must be a whole number of seconds");
    }
    intervalSec = input.intervalSec;
    jitterMaxSec = input.jitterMaxSec;
    if (BigInt(input.amountOut) <= 0n) throw new Error("amount must be positive");
  }
  const inboundOnly = findings.usdcInj && !findings.noble && !findings.penumbra && !findings.osmosis;
  if (findings.noble || inboundOnly) {
    if (BigInt(input.amountIn || "0") <= 0n) throw new Error("amount must be positive");
  }
  if (findings.osmosis && BigInt(input.amountOsmosis || "0") <= 0n) {
    throw new Error("amount must be positive");
  }
  const amountOut = findings.penumbra ? input.amountOut : "0";
  const amountIn = findings.noble || findings.usdcInj ? input.amountIn : "0";
  const amountOsmosis = findings.osmosis ? input.amountOsmosis : "0";
  const amountBase = findings.penumbra ? amountOut : findings.noble ? amountIn : findings.osmosis ? amountOsmosis : amountIn;
  const plan = planFor(findings);
  const phase = plan.exit.length ? "exit" : "return";
  return {
    status: "idle",
    findings,
    slices,
    intervalSec,
    jitterMaxSec,
    amountIn,
    amountOut,
    amountOsmosis,
    amounts: splitAmount(amountBase, slices),
    phase,
    exitSteps: plan.exit,
    onceSteps: plan.once,
    steps: phase === "exit" ? plan.exit : plan.once,
    sliceIndex: 0,
    stepIndex: 0,
    drawnJitterSec: null,
    halt: null,
    keys: emptyKeys(),
  };
}

export function currentStep(run) {
  return run.steps[run.stepIndex];
}

export function stepState(run, sliceIndex, stepIndex) {
  if (run.status === "idle") return "pending";
  if (run.exitSteps.length && run.phase === "return" && sliceIndex < run.slices) return "acked";
  if (sliceIndex < run.sliceIndex) return "acked";
  if (sliceIndex > run.sliceIndex) return "pending";
  if (run.status === "done" || run.status === "waiting") return "acked";
  if (run.status === "halted") {
    if (stepIndex < run.stepIndex) return "acked";
    if (stepIndex === run.stepIndex) return "failed";
    return "pending";
  }
  if (stepIndex < run.stepIndex) return "acked";
  if (stepIndex === run.stepIndex) return "running";
  return "pending";
}

export function keysNeeded(run) {
  if (run.status !== "running") return [];
  return keysForStep(currentStep(run).id, run.findings).filter((role) => !run.keys[role]);
}

export function reduce(run, event) {
  if (event.type === "START") {
    if (run.status !== "idle") throw new Error("start is only valid from idle");
    return { ...run, status: "running" };
  }
  if (event.type === "NOTE") {
    if (run.status !== "running") throw new Error("notes belong on a running step");
    if (!Object.hasOwn(run.keys, event.role)) throw new Error(`unknown hop ${event.role}`);
    if (run.keys[event.role]) throw new Error(`${event.role} already noted`);
    return {
      ...run,
      keys: {
        ...run.keys,
        [event.role]: {
          address: event.address,
          ethereum: event.ethereum ?? null,
          keyId: event.keyId ?? null,
        },
      },
    };
  }
  if (event.type === "ACK") {
    if (run.status !== "running") throw new Error("ack is only valid while running");
    const steps = run.phase === "exit" ? run.exitSteps : run.onceSteps;
    const lastStep = run.stepIndex === steps.length - 1;
    if (!lastStep) return { ...run, stepIndex: run.stepIndex + 1 };
    if (run.phase === "exit" && run.sliceIndex < run.slices - 1) {
      return { ...run, status: "waiting", drawnJitterSec: null };
    }
    if (run.phase === "exit" && run.onceSteps.length) {
      return { ...run, phase: "return", status: "running", steps: run.onceSteps, stepIndex: 0 };
    }
    return { ...run, status: "done" };
  }
  if (event.type === "FAIL") {
    if (run.status !== "running") throw new Error("fail is only valid while running");
    return {
      ...run,
      status: "halted",
      halt: {
        sliceIndex: run.sliceIndex,
        stepId: currentStep(run).id,
        reason: event.reason || "simulated ack failed",
      },
    };
  }
  if (event.type === "DRAW_JITTER") {
    if (run.status !== "waiting") throw new Error("jitter is drawn while waiting");
    if (run.drawnJitterSec !== null) throw new Error("jitter already drawn");
    if (!Number.isInteger(event.seconds) || event.seconds < 0) {
      throw new Error("jitter draw must be a whole number of seconds");
    }
    if (event.seconds > run.jitterMaxSec) throw new Error("jitter draw exceeds the max");
    return { ...run, drawnJitterSec: event.seconds };
  }
  if (event.type === "WAIT_ELAPSED") {
    if (run.status !== "waiting" || run.drawnJitterSec === null) {
      throw new Error("the wait needs a drawn buffer first");
    }
    return {
      ...run,
      status: "running",
      sliceIndex: run.sliceIndex + 1,
      stepIndex: 0,
      drawnJitterSec: null,
    };
  }
  throw new Error(`unknown event ${event.type}`);
}
