// ---------------------------------------------------------------------------
// Central configuration for the hybrid inference foundation.
//
// Gate 2 prep (2026-11-19): FIREBASE_CONFIG below now holds REAL public web
// config values for Firebase project "nexus-2e23d", fetched through the
// service-account path (Firebase Management API). A Firebase web apiKey is
// a project identifier, not a server secret, and is safe to commit.
// INTERIM NOTE: these values belong to the project's existing web app
// registration ("NEXUS-DASHBOARD-WEB"). A dedicated web app registration
// for this product could NOT be created through the service-account path
// (measured 403 PERMISSION_DENIED on webApps create) and remains a
// Firebase-console step; when it is registered, replace appId (and the
// apiKey if a new key is issued) here — this file is the only place.
// ---------------------------------------------------------------------------

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyA09pwt2He5zaRw9DOwGaSWRdDazbV5Pgs",
  authDomain: "nexus-2e23d.firebaseapp.com",
  projectId: "nexus-2e23d",
  appId: "1:909004651863:web:c17c8984c253c655b39212",
};

// App Check: reCAPTCHA Enterprise site key for the web app.
// Leave empty until Gate 1; while empty, App Check initialisation is skipped
// and the UI reports that state honestly. For contest judging, a debug token
// may be used instead (see firebase-init.js).
export const APPCHECK_SITE_KEY = "";

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
