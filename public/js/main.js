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
  statusCloud: $("status-cloud"),
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
  verdictBadge: $("dash-verdict-badge"),
  empty: $("dash-empty"),
  result: $("dash-result"),
  maskedEmpty: $("masked-empty"),
  dashboard: document.querySelector(".dashboard"),
  techCode: $("dash-tech-code"),
  techStatus: $("dash-tech-status"),
  optSurface: $("opt-surface-message"),
  optAttachGrade: $("opt-attach-grade"),
  optAttachName: $("opt-attach-name"),
};

els.charMax.textContent = String(INPUT_MAX_CHARS);
let patterns = [];
let scenarios = {};

// --- Engine status strip ----------------------------------------------------
function renderStatus(status) {
  const nanoReady = status.onDevice.supported && status.onDevice.status === "ready";
  els.onDevice.textContent = nanoReady
    ? "Check is ready"
    : "Basic on-device check is ready (no advanced check — the basic check is enough in most cases)";
  els.onDevice.className = nanoReady ? "is-ok" : "is-off";
  els.statusCloud.textContent = status.cloud.configured
    ? "Deep analysis connected — used only when truly needed"
    : "Deep analysis not connected — the basic check works normally";
  els.statusCloud.className = status.cloud.configured ? "is-ok" : "is-off";
  els.appCheck.textContent = `App Check: ${status.appCheck}`;
  if (els.techStatus) {
    els.techStatus.textContent =
      `On-device (Gemini Nano): ${status.onDevice.supported ? status.onDevice.status : `unavailable — ${status.onDevice.detail}`} · ` +
      `Cloud (Firebase AI Logic): ${status.cloud.configured ? "configured" : "not configured in this build (project values pending) — local tiers fully active"}`;
  }
  els.budget.textContent = status.cloud.configured
    ? `Deep analysis is used only when truly needed (used ${status.cloud.callsUsed} time(s) this session · ${status.cloud.callsUsed} / ${status.cloud.budget})`
    : `Deep analysis is used only when truly needed (used ${status.cloud.callsUsed} time(s) this session · ${status.cloud.callsUsed} / ${status.cloud.budget}) — cloud not connected, budget frozen`;
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
const WHERE_LABEL = { "on-device": "Checked on this device only", cloud: "Only the masked skeleton was sent to the cloud", abstained: "Stopped on this device" };

const VERDICT_BADGE = {
  risk: ["badge badge-risk", "RISK"],
  "no-signals": ["badge badge-clear", "No risk signals"],
  abstained: ["badge badge-abstain", "Abstained"],
  rejected: ["badge badge-abstain", "Abstained"],
  "cloud-analysis": ["badge badge-cloud", "Deep analysis done"],
};

const VERDICT_LABEL = { risk: "Risk", "no-signals": "No risk signals", abstained: "Abstained", rejected: "Abstained", "cloud-analysis": "Deep analysis done" };

function renderReport(report) {
  els.empty.hidden = true;
  els.result.hidden = false;
  els.maskedEmpty.hidden = true;
  els.masked.textContent = report.maskedText || "(no masked text)";
  els.chips.innerHTML = "";
  for (const [type, n] of Object.entries(report.isolation ? report.isolation.byType : {})) {
    const chip = document.createElement("span");
    chip.className = "token-chip";
    chip.textContent = `${type} × ${n}`;
    els.chips.appendChild(chip);
  }

  const [badgeCls, badgeText] = VERDICT_BADGE[report.verdict] || ["badge badge-idle", "—"];
  els.verdictBadge.className = badgeCls;
  els.verdictBadge.textContent = badgeText;
  els.route.className = "badge badge-where";
  els.route.textContent = WHERE_LABEL[report.route] || "—";

  els.verdict.textContent =
    report.verdict === VERDICT.RISK ? `Matches known risk patterns (severity: ${report.severity}). Do not pay or sign.`
    : report.verdict === VERDICT.NO_SIGNALS ? "No risk signals found in the local ledger."
    : report.verdict === VERDICT.CLOUD_ANALYSIS ? "Deep analysis completed in the cloud — from the de-identified skeleton only."
    : report.verdict === VERDICT.ABSTAINED ? "Not enough evidence to decide — the Shield abstains."
    : "Input rejected.";
  if (els.techCode) {
    els.techCode.textContent = report.abstainCode ? `Abstain code: ${report.abstainCode}` : "";
  }
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

  const AXIS_LABEL = { AUTHORITY: "Authority claims", URGENCY: "Pressure and urgency", SECRECY: "Demands for secrecy", PAYMENT: "Payment inducement", LINK: "Suspicious link", THREAT: "Threatening language" };
  els.evidence.innerHTML = "";
  if (report.matched && report.matched.length > 0) {
    for (const m of report.matched) {
      const li = document.createElement("li");
      const axes = [...(m.bones || []), ...(m.clauseRisk || [])];
      const known = axes.filter((a) => AXIS_LABEL[a]);
      const unknown = axes.filter((a) => !AXIS_LABEL[a]);
      li.textContent = `${m.label} — risk signals: ${known.map((a) => AXIS_LABEL[a]).join(" · ") || "pattern match"}`;
      const span = document.createElement("span");
      span.className = "evidence-code";
      span.textContent = `Pattern ${m.id} · match score ${m.score}${unknown.length ? ` · ${unknown.join(", ")}` : ""}`;
      li.appendChild(span);
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

  if (window.NexusFX && report.verdict !== VERDICT.RISK) NexusFX.complete(els.dashboard);
}

async function renderHistory() {
  els.history.innerHTML = "";
  try {
    const rows = await listAnalyses(10);
    if (rows.length === 0) {
      const li = document.createElement("li");
      li.textContent = "No check history saved yet.";
      els.history.appendChild(li);
      return;
    }
    for (const row of rows) {
      const li = document.createElement("li");
      const when = new Date(row.ts).toLocaleString();
      li.textContent = `${when} — ${VERDICT_LABEL[row.verdict] || row.verdict} · ${WHERE_LABEL[row.route] || row.route} · ${row.isolation.count} personal item(s) masked · ${row.patternIds.length ? `${row.patternIds.length} pattern(s) matched` : "no pattern matched"}`;
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
    // Marketplace supplement intake: the optional block declares the
    // surface and any attachment the user saw. A file name, when typed,
    // wins over the format select (the extension chain decides the
    // grade); the name itself never leaves this handler.
    const surface = els.optSurface && els.optSurface.checked ? "message" : undefined;
    const attachments = [];
    const attachName = els.optAttachName ? els.optAttachName.value.trim() : "";
    if (attachName) attachments.push({ name: attachName });
    else if (els.optAttachGrade && els.optAttachGrade.value) {
      attachments.push({ format: els.optAttachGrade.value });
    }
    const report = await analyzeText(rawText, {
      patterns, escalate, nanoConfirm, surface,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
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
