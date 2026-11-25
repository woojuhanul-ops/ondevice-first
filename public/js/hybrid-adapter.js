// ---------------------------------------------------------------------------
// Hybrid inference adapter — the core mechanism of this app.
//
// Policy (fixed at foundation stage, from the design-freeze skeleton):
//   1. On-device first. Personal data and first-pass judgement stay on the
//      device whenever the Chrome Prompt API (Gemini Nano) can serve them.
//   2. Cloud is an escalation, never a default. Every escalation carries a
//      human-readable reason, and the UI displays that reason: *why* a
//      request left the device is part of the product experience.
//   3. Honest abstention. If neither path can answer, the adapter returns an
//      abstention result instead of inventing an answer.
//
// Feature code (added after Gate 1) calls runInference() and renders the
// returned route + escalationReason; it never talks to either engine
// directly.
// ---------------------------------------------------------------------------

import { detectOnDevice, runOnDevice } from "./ondevice.js";
import { getCloudBudget, getCloudCallCount, runCloud } from "./cloud.js";
import { getAppCheckState, initFirebase, isFirebaseConfigured } from "./firebase-init.js";

export const ROUTE = {
  ON_DEVICE: "on-device",
  CLOUD: "cloud",
  ABSTAINED: "abstained",
};

let cachedDetection = null;

export async function getEngineStatus(forceRefresh = false) {
  if (!cachedDetection || forceRefresh) {
    cachedDetection = await detectOnDevice();
  }
  await initFirebase();
  return {
    onDevice: cachedDetection,
    cloud: {
      configured: isFirebaseConfigured(),
      budget: getCloudBudget(),
      callsUsed: getCloudCallCount(),
    },
    appCheck: getAppCheckState(),
  };
}

// request: { prompt: string, needsCloud?: boolean, cloudReason?: string }
//   needsCloud lets a feature declare up front that a request exceeds
//   on-device capability (e.g. very long context); cloudReason is then the
//   escalation reason shown to the user.
// result:  { route, text|null, escalationReason|null, error|null,
//            timings: { onDeviceMs|null, cloudMs|null } }
export async function runInference(request) {
  const timings = { onDeviceMs: null, cloudMs: null };
  const prompt = request.prompt ?? "";
  let escalationReason = null;

  const tryCloud = async () => {
    const start = performance.now();
    try {
      const { text } = await runCloud(prompt);
      timings.cloudMs = Math.round(performance.now() - start);
      return {
        route: ROUTE.CLOUD,
        text,
        escalationReason,
        error: null,
        timings,
      };
    } catch (err) {
      timings.cloudMs = Math.round(performance.now() - start);
      return {
        route: ROUTE.ABSTAINED,
        text: null,
        escalationReason,
        error: `Cloud path failed: ${err.message}`,
        timings,
      };
    }
  };

  // Explicit feature-level escalation.
  if (request.needsCloud) {
    escalationReason =
      request.cloudReason || "This request exceeds on-device capability.";
    return tryCloud();
  }

  // Default path: on-device first.
  const status = await getEngineStatus();
  if (status.onDevice.supported && status.onDevice.status === "ready") {
    const start = performance.now();
    try {
      const { text } = await runOnDevice(prompt);
      timings.onDeviceMs = Math.round(performance.now() - start);
      return {
        route: ROUTE.ON_DEVICE,
        text,
        escalationReason: null,
        error: null,
        timings,
      };
    } catch (err) {
      timings.onDeviceMs = Math.round(performance.now() - start);
      escalationReason = `On-device inference failed (${err.message}); escalated to the cloud.`;
      return tryCloud();
    }
  }

  // On-device cannot serve this request right now; say exactly why.
  escalationReason =
    status.onDevice.status === "unsupported"
      ? "This browser has no on-device model (Chrome Prompt API unavailable); escalated to the cloud."
      : `On-device model is not ready (status: ${status.onDevice.status}); escalated to the cloud.`;
  return tryCloud();
}
