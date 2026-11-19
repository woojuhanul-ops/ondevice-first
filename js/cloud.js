// ---------------------------------------------------------------------------
// Cloud inference path: Firebase AI Logic (Gemini cloud models).
//
// This module is the ONLY place cloud calls are made, so the session budget
// from config.js is enforced in exactly one spot. While the budget is null
// (not yet frozen at Gate 1) the cloud path refuses to run: the foundation
// never spends unbounded calls by accident.
// ---------------------------------------------------------------------------

import { getGenerativeModel } from "./firebase-init.js";
import { CLOUD_CALL_BUDGET_PER_SESSION, CLOUD_MODEL } from "./config.js";

let cloudCallsThisSession = 0;

export function getCloudCallCount() {
  return cloudCallsThisSession;
}

export function getCloudBudget() {
  return CLOUD_CALL_BUDGET_PER_SESSION;
}

// Runs one prompt in the cloud. Throws on budget refusal or API failure so
// the adapter can surface an honest abstention instead of a fake answer.
export async function runCloud(prompt) {
  if (CLOUD_CALL_BUDGET_PER_SESSION === null) {
    throw new Error(
      "Cloud budget is not frozen yet (Gate 1 decision pending); cloud path is disabled in the foundation build."
    );
  }
  if (cloudCallsThisSession >= CLOUD_CALL_BUDGET_PER_SESSION) {
    throw new Error(
      `Cloud call budget for this session is exhausted (${CLOUD_CALL_BUDGET_PER_SESSION} calls).`
    );
  }
  const model = getGenerativeModel(CLOUD_MODEL);
  cloudCallsThisSession += 1;
  const result = await model.generateContent(prompt);
  const text = result.response.text();
  return { text };
}
