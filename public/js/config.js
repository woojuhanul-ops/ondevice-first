// ---------------------------------------------------------------------------
// Central configuration for the hybrid inference foundation.
//
// Gate 2 follow-up (2026-11-19): FIREBASE_CONFIG below now holds the REAL
// public web config values of the dedicated web app registration
// "Hybrid Shield" in Firebase project "nexus-2e23d", registered in the
// Firebase console. A Firebase web apiKey is a project identifier, not a
// server secret, and is safe to commit.
// (These values previously belonged to the project's dashboard web app
// registration "NEXUS-DASHBOARD-WEB"; they were replaced once the
// dedicated "Hybrid Shield" registration existed. This file remains the
// only place holding them.)
// ---------------------------------------------------------------------------

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyA09pwt2He5zaRw9DOwGaSWRdDazbV5Pgs",
  authDomain: "nexus-2e23d.firebaseapp.com",
  projectId: "nexus-2e23d",
  storageBucket: "nexus-2e23d.firebasestorage.app",
  messagingSenderId: "909004651863",
  appId: "1:909004651863:web:012eb51f76b99171b39212",
};

// App Check: reCAPTCHA Enterprise site key for the web app.
// Leave empty until Gate 1; while empty, App Check initialisation is skipped
// and the UI reports that state honestly. For contest judging, a debug token
// may be used instead (see firebase-init.js).
export const APPCHECK_SITE_KEY = "6LcRHikuAAAAAIpFxIgILSkvANqtMDFMsmiyn3VP";

// Cloud model used through Firebase AI Logic when inference escalates.
export const CLOUD_MODEL = "gemini-2.5-flash";

// Session budget for cloud calls. Frozen at Gate 1 (commander-approved,
// 2026-11-19): 20 calls per session. cloud.js enforces this number in
// exactly one place; when the budget is exhausted the adapter degrades to
// an honest abstention instead of spending more calls.
export const CLOUD_CALL_BUDGET_PER_SESSION = 20;

// Shield input limit. Texts longer than this are refused before analysis
// (plan §4.2 rule 3); the UI displays this limit next to the input box.
export const INPUT_MAX_CHARS = 20000;
