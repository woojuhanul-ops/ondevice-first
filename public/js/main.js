// ---------------------------------------------------------------------------
// Shield UI wiring.
//
// The original text lives only in this tab's memory: it is read from the
// textarea, handed to the shield pipeline, and never stored or sent. What
// the dashboard renders comes from the shield report (masked text, verdict,
// evidence coordinates, escalation reason, the exact cloud payload).
//
// Cloud escalation is wired to the hybrid adapter (runInference with
// needsCloud + cloudReason); the Nano assistant confirmation is wired to
// the on-device path with fixed judgement prompts (plan §4.3). Both are
// injected into shield.analyzeText, which stays pure.
// ---------------------------------------------------------------------------

import { getEngineStatus, runInference, ROUTE } from "./hybrid-adapter.js";
import { detectOnDevice, runOnDevice } from "./ondevice.js";
import { loadLedger } from "./ledger.js";
import { analyzeText, OFFICIAL_CHECKLIST, VERDICT } from "./shield.js";
import { clearAnalyses, listAnalyses, saveAnalysis } from "./store.js";
import { INPUT_MAX_CHARS } from "./config.js";

const $ = (id) => document.getElementById(id);
const els = {
  onDevice: $("status-ondevice"),
  cloud: $("status-cloud"),
  appCheck: $("status-appcheck"),
  form: $("shield-form"),
  input: $("shield-input"),
  analyzeBtn: $("analyze-btn"),
  charCount: $("char-count"),
  charMax: $("char-max"),
  masked: $("masked-preview"),
  chips: $("token-chips"),
  route: $("dash-route"),
  verdict: $("dash-verdict"),
  message: $("dash-message"),
  escalation: $("dash-escalation"),
  isolation: $("dash-isolation"),
  evidence: $("dash-evidence"),
  budget: $("dash-budget"),
  timings: $("dash-timings"),
  payloadWrap: $("dash-payload-wrap"),
  payload: $("dash-payload"),
  cloudWrap: $("dash-cloud-wrap"),
  cloud: $("dash-cloud"),
  guidance: $("dash-guidance"),
  history: $("dash-history"),
  clearHistory: $("clear-history"),
};

els.charMax.textContent = String(INPUT_MAX_CHARS);
let patterns = [];
let scenarios = {};

// --- Engine status strip ----------------------------------------------------
function renderStatus(status) {
  els.onDevice.textContent = status.onDevice.supported
    ? `On-device (Gemini Nano): ${status.onDevice.status}`
    : `On-device (Gemini Nano): unavailable — ${status.onDevice.detail}`;
  els.cloud.textContent = status.cloud.configured
    ? `Cloud (Firebase AI Logic): configured · budget ${status.cloud.budget} · calls used ${status.cloud.callsUsed}`
    : "Cloud (Firebase AI Logic): not configured in this build (project values pending) — local tiers fully active";
  els.appCheck.textContent = `App Check: ${status.appCheck}`;
  els.budget.textContent = status.cloud.configured
    ? `${status.cloud.callsUsed} / ${status.cloud.budget} calls this session.`
    : `Budget frozen at ${status.cloud.budget} calls per session; cloud project not connected in this build.`;
}

async function refreshStatus() {
  renderStatus(await getEngineStatus(true));
}

// --- Injected cloud escalation (adapter) --------------------------------------
async function escalate(prompt, reason) {
  const result = await runInference({ prompt, needsCloud: true, cloudReason: reason });
  return {
    route: result.route === ROUTE.CLOUD ? "cloud" : "abstained",
    text: result.text,
    error: result.error,
    cloudMs: result.timings ? result.timings.cloudMs : null,
  };
}

// --- Injected Nano confirmation (plan §4.3, judgement prompts only) -----------
// Runs entirely on-device. Confirms or rejects name candidates extracted by
// the deterministic layer. Returns the values confirmed as person names.
async function nanoConfirmFactory(rawText) {
  const detection = await detectOnDevice();
  if (!detection.supported || detection.status !== "ready") return null;
  return async (values) => {
    const confirmed = [];
    for (const value of values) {
      const at = rawText.indexOf(value);
      const snippet = at >= 0 ? rawText.slice(Math.max(0, at - 60), at + value.length + 60) : rawText.slice(0, 160);
      try {
        const { text } = await runOnDevice(
          `In the text below, is "${value}" used as a person's name? Answer YES or NO only.\n\n${snippet}`
        );
        if (/^\s*yes\b/i.test(text)) confirmed.push(value);
      } catch {
        // A failed judgement leaves the candidate unconfirmed (safe side).
      }
    }
    return confirmed;
  };
}

// --- Rendering ------------------------------------------------------------------
const ROUTE_LABEL = { "on-device": "ON-DEVICE", cloud: "CLOUD", abstained: "ABSTAINED" };

function renderReport(report) {
  els.masked.textContent = report.maskedText || "(no masked text)";
  els.chips.innerHTML = "";
  for (const [type, n] of Object.entries(report.isolation ? report.isolation.byType : {})) {
    const chip = document.createElement("span");
    chip.className = "token-chip";
    chip.textContent = `${type} × ${n}`;
    els.chips.appendChild(chip);
  }

  const badgeClass =
    report.verdict === VERDICT.RISK ? "badge badge-risk"
    : report.verdict === VERDICT.CLOUD_ANALYSIS ? "badge badge-cloud"
    : report.verdict === VERDICT.ABSTAINED || report.verdict === VERDICT.REJECTED ? "badge badge-abstain"
    : "badge badge-device";
  els.route.className = badgeClass;
  els.route.textContent = ROUTE_LABEL[report.route] || "—";

  els.verdict.textContent =
    report.verdict === VERDICT.RISK ? `Matches known risk patterns (severity: ${report.severity}). Do not pay or sign.`
    : report.verdict === VERDICT.NO_SIGNALS ? "No risk signals found in the local ledger."
    : report.verdict === VERDICT.CLOUD_ANALYSIS ? "Deep analysis completed in the cloud — from the de-identified skeleton only."
    : report.verdict === VERDICT.ABSTAINED ? `Abstained (${report.abstainCode}).`
    : "Input rejected.";
  els.message.textContent = report.message || "";

  els.escalation.textContent = report.cloudAttempted
    ? `Escalated once. Why: ${report.escalationReason}`
    : report.escalationReason
      ? `Escalation was considered but did not happen. Why it stopped: ${report.abstainCode}. Intended reason: ${report.escalationReason}`
      : "No cloud call — everything ran on this device.";

  const byType = report.isolation
    ? Object.entries(report.isolation.byType).map(([t, n]) => `${t} × ${n}`).join(", ")
    : "";
  els.isolation.textContent = report.isolation
    ? `${report.isolation.count} item(s) masked and kept on this device${byType ? ` (${byType})` : ""}.` +
      (report.unconfirmedNames ? ` ${report.unconfirmedNames} name candidate(s) unconfirmed — escalation blocked.` : "")
    : "0 items masked.";

  els.evidence.innerHTML = "";
  if (report.matched && report.matched.length > 0) {
    for (const m of report.matched) {
      const li = document.createElement("li");
      const axes = [...(m.bones || []), ...(m.clauseRisk || [])].join(", ");
      li.textContent = `${m.id} — ${m.label} · score ${m.score}${axes ? ` · ${axes}` : ""}`;
      els.evidence.appendChild(li);
    }
  } else {
    const li = document.createElement("li");
    li.textContent = "No ledger pattern matched.";
    els.evidence.appendChild(li);
  }

  const t = report.timings || {};
  const fmt = (v) => (v === null || v === undefined ? "—" : `${v} ms`);
  els.timings.textContent =
    `mask ${fmt(t.maskMs)} · nano ${fmt(t.nanoMs)} · ledger ${fmt(t.ledgerMs)} · cloud ${fmt(t.cloudMs)} · total ${fmt(t.totalMs)}`;

  if (report.cloudPayload) {
    els.payloadWrap.hidden = false;
    els.payload.textContent = report.cloudPayload;
  } else {
    els.payloadWrap.hidden = true;
    els.payload.textContent = "";
  }
  if (report.cloudText) {
    els.cloudWrap.hidden = false;
    els.cloud.textContent = report.cloudText;
  } else {
    els.cloudWrap.hidden = true;
    els.cloud.textContent = "";
  }

  els.guidance.innerHTML = "";
  const items = [];
  if (report.verdict === VERDICT.ABSTAINED) {
    for (const step of OFFICIAL_CHECKLIST) items.push({ text: step });
  } else if (report.guidance && report.guidance.length > 0) {
    for (const g of report.guidance) items.push({ text: g.guidance, channel: g.verifyChannel });
  } else if (report.verdict === VERDICT.NO_SIGNALS) {
    items.push({ text: "No local pattern matched. That is not a guarantee of safety — if money or a signature is involved, still verify through an official channel you reach yourself." });
  }
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item.text;
    if (item.channel) {
      const span = document.createElement("span");
      span.className = "channel";
      span.textContent = `Verify via: ${item.channel}`;
      li.appendChild(span);
    }
    els.guidance.appendChild(li);
  }
}

async function renderHistory() {
  els.history.innerHTML = "";
  try {
    const rows = await listAnalyses(10);
    if (rows.length === 0) {
      const li = document.createElement("li");
      li.textContent = "No analyses stored yet.";
      els.history.appendChild(li);
      return;
    }
    for (const row of rows) {
      const li = document.createElement("li");
      const when = new Date(row.ts).toLocaleString();
      li.textContent = `${when} — ${row.verdict} (${row.route}) · masked ${row.isolation.count} · ${row.patternIds.join(", ") || "no pattern"}`;
      els.history.appendChild(li);
    }
  } catch {
    const li = document.createElement("li");
    li.textContent = "Local history unavailable in this browser.";
    els.history.appendChild(li);
  }
}

// --- Events -----------------------------------------------------------------------
els.input.addEventListener("input", () => {
  els.charCount.textContent = String(els.input.value.length);
});

document.querySelectorAll("[data-scenario]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const sc = scenarios[btn.dataset.scenario];
    if (sc) {
      els.input.value = sc.input;
      els.charCount.textContent = String(sc.input.length);
      els.input.focus();
    }
  });
});

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const rawText = els.input.value;
  els.analyzeBtn.disabled = true;
  els.verdict.textContent = "Analysing on this device…";
  try {
    const nanoConfirm = await nanoConfirmFactory(rawText);
    const report = await analyzeText(rawText, { patterns, escalate, nanoConfirm });
    renderReport(report);
    if (report.verdict !== VERDICT.REJECTED) {
      try { await saveAnalysis(report); } catch { /* history is best-effort */ }
      await renderHistory();
    }
  } finally {
    els.analyzeBtn.disabled = false;
    renderStatus(await getEngineStatus());
  }
});

els.clearHistory.addEventListener("click", async () => {
  await clearAnalyses();
  await renderHistory();
});

// --- Init ---------------------------------------------------------------------------
(async () => {
  await refreshStatus();
  try {
    patterns = await loadLedger("data/ledger.json");
  } catch (err) {
    els.verdict.textContent = `Pattern ledger failed to load: ${err.message}`;
  }
  try {
    const res = await fetch("data/scenarios.json");
    const data = await res.json();
    for (const sc of data.scenarios) scenarios[sc.id] = sc;
  } catch {
    // Scenario buttons simply stay inert if the data file is unreachable.
  }
  await renderHistory();
})();
