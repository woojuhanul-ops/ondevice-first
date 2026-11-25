// ---------------------------------------------------------------------------
// Firebase bootstrap: app initialisation, App Check hookup point, and the
// Firebase AI Logic handle used by the cloud path.
//
// SDK modules are loaded from the official Firebase CDN as ES modules; no
// build step is required, which keeps the repository directly servable.
//
// Loading structure (structural repair, 2026-11-24): the SDK is loaded
// LAZILY, via dynamic import(), the first time the cloud path is actually
// needed — never as a static import. The on-device defence (masking, ledger
// scoring, verdicts, abstention) must work even on a network that cannot
// reach the CDN at all; a static import chain made one unreachable CDN
// take the whole app down, local verdicts included. If the SDK cannot be
// loaded, initFirebase() reports appCheckState "unavailable" and the cloud
// path abstains honestly, exactly like any other cloud failure.
// ---------------------------------------------------------------------------

import { APPCHECK_SITE_KEY, FIREBASE_CONFIG } from "./config.js";

const SDK_BASE = "https://www.gstatic.com/firebasejs/11.10.0/";
const SDK_LOAD_TIMEOUT_MS = 15000;

let app = null;
let ai = null;
let sdkGetGenerativeModel = null;
let appCheckState = "not-configured";
let initPromise = null;
let sdkPromise = null;

// Loads the three Firebase SDK modules in parallel. A failed or timed-out
// load clears the cached promise so a later call can retry (the network
// may recover); a successful load is fetched once per page.
function loadSdk() {
  if (!sdkPromise) {
    const loading = Promise.all([
      import(SDK_BASE + "firebase-app.js"),
      import(SDK_BASE + "firebase-app-check.js"),
      import(SDK_BASE + "firebase-ai.js"),
    ]).then(([appSdk, appCheckSdk, aiSdk]) => ({ appSdk, appCheckSdk, aiSdk }));
    const timeout = new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `Firebase SDK load timed out after ${SDK_LOAD_TIMEOUT_MS} ms`
            )
          ),
        SDK_LOAD_TIMEOUT_MS
      )
    );
    sdkPromise = Promise.race([loading, timeout]).catch((err) => {
      sdkPromise = null;
      throw err;
    });
  }
  return sdkPromise;
}

export function isFirebaseConfigured() {
  return FIREBASE_CONFIG.projectId !== "REPLACE_AT_GATE1";
}

// Initialises Firebase once, loading the SDK on first use. Safe to call
// when placeholders are still in place: it reports "not-configured"
// instead of throwing, so the shell UI can run (and the on-device path can
// be exercised) before Gate 1. Also safe on a network that cannot reach
// the Firebase CDN: it reports "unavailable" and leaves the local path
// fully functional.
export function initFirebase() {
  if (app) return Promise.resolve({ app, appCheckState });
  if (!isFirebaseConfigured()) {
    appCheckState = "not-configured";
    return Promise.resolve({ app: null, appCheckState });
  }
  if (!initPromise) {
    initPromise = (async () => {
      let sdk;
      try {
        sdk = await loadSdk();
      } catch {
        // CDN unreachable or too slow: no Firebase, honest state, and a
        // later call may retry the load.
        appCheckState = "unavailable";
        initPromise = null;
        return { app: null, appCheckState };
      }

      app = sdk.appSdk.initializeApp(FIREBASE_CONFIG);

      // --- App Check -----------------------------------------------------
      // Contest requirement: App Check must be active; a debug token is
      // acceptable for the submission build. To use one locally, set
      //   self.FIREBASE_APPCHECK_DEBUG_TOKEN=<redacted>
      // in the browser console before the cloud path first initialises
      // Firebase, then register the printed token in the Firebase console.
      if (APPCHECK_SITE_KEY) {
        sdk.appCheckSdk.initializeAppCheck(app, {
          provider: new sdk.appCheckSdk.ReCaptchaEnterpriseProvider(
            APPCHECK_SITE_KEY
          ),
          isTokenAutoRefreshEnabled: true,
        });
        appCheckState = "active";
      } else {
        appCheckState = "configured-without-site-key";
      }

      // Firebase AI Logic handle (cloud path). Backend: Gemini Developer API.
      ai = sdk.aiSdk.getAI(app, { backend: new sdk.aiSdk.GoogleAIBackend() });
      sdkGetGenerativeModel = sdk.aiSdk.getGenerativeModel;
      return { app, appCheckState };
    })();
  }
  return initPromise;
}

export function getAppCheckState() {
  return appCheckState;
}

export async function getGenerativeModel(modelName) {
  await initFirebase();
  if (!ai) {
    throw new Error(
      "Firebase AI Logic is not initialised (project not configured, or the Firebase SDK could not be loaded from the CDN)."
    );
  }
  return sdkGetGenerativeModel(ai, { model: modelName });
}
