import { stepsFor } from "./route.js";

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
    usdcInj: Boolean(input.usdcInj),
    injGasShort: Boolean(input.injGasShort),
    osmosisFunds: Boolean(input.osmosisFunds),
  };
  const inbound = findings.noble || findings.usdcInj;
  if (!findings.penumbra && !inbound) throw new Error("The query found no USDC.");
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
  if (inbound && BigInt(input.amountIn) <= 0n) throw new Error("amount must be positive");
  const amountBase = findings.penumbra ? input.amountOut : input.amountIn;
  const steps = stepsFor(findings);
  return {
    status: "idle",
    findings,
    slices,
    intervalSec,
    jitterMaxSec,
    amountIn: inbound ? input.amountIn : "0",
    amounts: splitAmount(amountBase, slices),
    steps,
    sliceIndex: 0,
    stepIndex: 0,
    drawnJitterSec: null,
    halt: null,
    sliceKeys: Array.from({ length: slices }, emptyKeys),
  };
}

export function currentStep(run) {
  return run.steps[run.stepIndex];
}

export function stepState(run, sliceIndex, stepIndex) {
  if (run.status === "idle") return "pending";
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

function noteKey(keys, role, note) {
  if (!Object.hasOwn(keys, role)) throw new Error(`unknown hop ${role}`);
  if (keys[role]) throw new Error(`${role} already noted`);
  return { ...keys, [role]: note };
}

export function reduce(run, event) {
  if (event.type === "START") {
    if (run.status !== "idle") throw new Error("start is only valid from idle");
    return { ...run, status: "running" };
  }
  if (event.type === "NOTE") {
    if (run.status !== "running") throw new Error("notes belong on a running step");
    const keys = run.sliceKeys.map((item) => ({ ...item }));
    keys[run.sliceIndex] = noteKey(keys[run.sliceIndex], event.role, {
      address: event.address,
      ethereum: event.ethereum ?? null,
      keyId: event.keyId ?? null,
    });
    return { ...run, sliceKeys: keys };
  }
  if (event.type === "ACK") {
    if (run.status !== "running") throw new Error("ack is only valid while running");
    const lastStep = run.stepIndex === run.steps.length - 1;
    const lastSlice = run.sliceIndex === run.slices - 1;
    if (!lastStep) return { ...run, stepIndex: run.stepIndex + 1 };
    if (!lastSlice) return { ...run, status: "waiting", drawnJitterSec: null };
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
