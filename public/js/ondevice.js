// ---------------------------------------------------------------------------
// On-device inference path: Chrome Prompt API (Gemini Nano).
//
// Two API shapes exist in the wild and both are handled:
//   - Newer Chrome:  global `LanguageModel` with static availability()/create()
//   - Earlier Chrome: `window.ai.languageModel` with capabilities()/create()
// Detection never throws; every outcome is reported as a status object so the
// hybrid adapter can decide (and explain) what to do next.
// ---------------------------------------------------------------------------

const STATUS = {
  READY: "ready", // model present and usable now
  DOWNLOADABLE: "downloadable", // model can be fetched on first use
  DOWNLOADING: "downloading", // model download in progress
  UNAVAILABLE: "unavailable", // API exists but model cannot run here
  UNSUPPORTED: "unsupported", // Prompt API not present in this browser
};

function getApi() {
  if (typeof LanguageModel !== "undefined") {
    return { kind: "LanguageModel", api: LanguageModel };
  }
  if (typeof window !== "undefined" && window.ai && window.ai.languageModel) {
    return { kind: "window.ai", api: window.ai.languageModel };
  }
  return null;
}

function normaliseAvailability(raw) {
  // Newer shape returns a string; older shape returns { available: string }.
  const value = typeof raw === "string" ? raw : raw && raw.available;
  switch (value) {
    case "available":
    case "readily":
      return STATUS.READY;
    case "downloadable":
    case "after-download":
      return STATUS.DOWNLOADABLE;
    case "downloading":
      return STATUS.DOWNLOADING;
    default:
      return STATUS.UNAVAILABLE;
  }
}

// Returns { supported, status, detail } without creating a session.
export async function detectOnDevice() {
  const found = getApi();
  if (!found) {
    return {
      supported: false,
      status: STATUS.UNSUPPORTED,
      detail: "Chrome Prompt API is not available in this browser.",
    };
  }
  try {
    let raw;
    if (found.kind === "LanguageModel") {
      raw = await found.api.availability();
    } else {
      raw = await found.api.capabilities();
    }
    const status = normaliseAvailability(raw);
    return {
      supported: status !== STATUS.UNAVAILABLE,
      status,
      detail: `Prompt API present (${found.kind}); model status: ${status}.`,
    };
  } catch (err) {
    return {
      supported: false,
      status: STATUS.UNAVAILABLE,
      detail: `Prompt API present but availability check failed: ${err.message}`,
    };
  }
}

let sessionPromise = null;

async function getSession() {
  const found = getApi();
  if (!found) throw new Error("Prompt API unsupported in this browser.");
  if (!sessionPromise) {
    sessionPromise = (async () => {
      // A system prompt slot is intentionally generic at foundation stage;
      // the app concept (Gate 1) supplies its own instructions per feature.
      return found.api.create({ expectedInputs: [{ type: "text" }] });
    })();
    // Do not cache a rejected promise; allow a later retry.
    sessionPromise.catch(() => {
      sessionPromise = null;
    });
  }
  return sessionPromise;
}

// Runs one prompt on-device. Throws on any failure so the adapter can
// escalate with a recorded reason.
export async function runOnDevice(prompt) {
  const session = await getSession();
  const text = await session.prompt(prompt);
  return { text };
}
