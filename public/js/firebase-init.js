// ---------------------------------------------------------------------------
// Firebase bootstrap: app initialisation, App Check hookup point, and the
// Firebase AI Logic handle used by the cloud path.
//
// SDK modules are loaded from the official Firebase CDN as ES modules; no
// build step is required, which keeps the repository directly servable.
// ---------------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app-check.js";
import {
  getAI,
  getGenerativeModel as sdkGetGenerativeModel,
  GoogleAIBackend,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-ai.js";

import { APPCHECK_SITE_KEY, FIREBASE_CONFIG } from "./config.js";

let app = null;
let ai = null;
let appCheckState = "not-configured";

export function isFirebaseConfigured() {
  return FIREBASE_CONFIG.projectId !== "REPLACE_AT_GATE1";
}

// Initialises Firebase once. Safe to call when placeholders are still in
// place: it reports "not-configured" instead of throwing, so the shell UI
// can run (and the on-device path can be exercised) before Gate 1.
export function initFirebase() {
  if (app) return { app, appCheckState };
  if (!isFirebaseConfigured()) {
    appCheckState = "not-configured";
    return { app: null, appCheckState };
  }

  app = initializeApp(FIREBASE_CONFIG);

  // --- App Check -----------------------------------------------------------
  // Contest requirement: App Check must be active; a debug token is
  // acceptable for the submission build. To use one locally, set
  //   self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;  (or a token string)
  // in the browser console before this module loads, then register the
  // printed token in the Firebase console.
  if (APPCHECK_SITE_KEY) {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(APPCHECK_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
    appCheckState = "active";
  } else {
    appCheckState = "configured-without-site-key";
  }

  // Firebase AI Logic handle (cloud path). Backend: Gemini Developer API.
  ai = getAI(app, { backend: new GoogleAIBackend() });
  return { app, appCheckState };
}

export function getAppCheckState() {
  return appCheckState;
}

export function getGenerativeModel(modelName) {
  if (!ai) {
    throw new Error(
      "Firebase AI Logic is not initialised (project not configured yet)."
    );
  }
  return sdkGetGenerativeModel(ai, { model: modelName });
}
