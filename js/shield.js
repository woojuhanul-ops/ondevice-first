// ---------------------------------------------------------------------------
// Shield pipeline — the 3-tier judgement flow (plan §3.1).
//
//   input (original text, memory only)
//     -> [mask]    pii-mask.js: deterministic masking + candidates
//     -> [nano]    optional assistant confirmation of name candidates
//                  (injected by the caller; absent in non-Chrome engines)
//     -> [ledger]  ledger.js: deterministic scoring over the masked text
//     -> branch:
//          strong local match   -> local risk verdict, 0 cloud calls
//          clause-complex / ambiguous
//                               -> de-identification checks, then cloud
//                                  escalation of the skeleton ONLY
//          weak evidence        -> ABSTAIN (insufficient evidence)
//          no signals           -> local "no risk signals found" verdict
//
// Invariants (plan §3.1, §6.1):
//   - A text whose masking is uncertain NEVER reaches the cloud:
//     unconfirmed name candidates block escalation (ABSTAIN_DEID_UNCERTAIN).
//   - The cloud prompt is assembled from the masked text only; the
//     original text is not an input to the prompt builder.
//   - The finished payload is rescanned; one structural PII finding
//     cancels the send (ABSTAIN_RESCAN_FAIL).
//   - The cloud call itself is injected (`escalate`) so this module stays
//     pure and testable; in the browser the caller wires it to the hybrid
//     adapter's runInference with needsCloud + cloudReason.
//
// Verdict wording follows plan §2.2: local verdicts say "matches risk
// patterns" or "no risk signals found" — never "safe".
// ---------------------------------------------------------------------------

import { maskText, rescanForPII } from "./pii-mask.js";
import { scoreText } from "./ledger.js";
import { INPUT_MAX_CHARS } from "./config.js";

export const VERDICT = {
  RISK: "risk",
  NO_SIGNALS: "no-signals",
  CLOUD_ANALYSIS: "cloud-analysis",
  ABSTAINED: "abstained",
  REJECTED: "rejected",
};

export const ABSTAIN = {
  INSUFFICIENT_EVIDENCE: "ABSTAIN_INSUFFICIENT_EVIDENCE",
  DEID_UNCERTAIN: "ABSTAIN_DEID_UNCERTAIN",
  RESCAN_FAIL: "ABSTAIN_RESCAN_FAIL",
  CLOUD_UNAVAILABLE: "ABSTAIN_CLOUD_UNAVAILABLE",
  ENGINE: "ABSTAIN_ENGINE",
};

// Upper length (characters) for the short-input abstention policy below.
export const SHORT_INPUT_MAX_CHARS = 80;

// Marketplace-message surface abstention limit (2026-11-24 supplement,
// union-conference design V5): on the message surface a text with no
// local signals still abstains up to this length, and at any length when
// a high-risk attachment grade is declared — a bare order claim in a
// chat message carries too little verifiable context for a clean bill.
export const MESSAGE_ABSTAIN_MAX_CHARS = 160;

// --- Attachment metadata normalization (marketplace supplement) ------------
// Callers may declare attachment metadata (what the user saw in the chat
// UI: a file name or a format). Only a risk GRADE is derived here, from
// the extension chain — invoice.pdf.html grades as "web", because the
// last extension is what a browser would open. The normalized summary
// ({ count, grades }) is all that ever reaches scoring, the report, the
// local history, or the cloud prompt: file names are never propagated.
const GRADE_BY_EXT = {
  html: "web", htm: "web", xhtml: "web", svg: "web",
  exe: "exec", msi: "exec", scr: "exec", bat: "exec", cmd: "exec",
  com: "exec", js: "exec", jar: "exec", ps1: "exec", vbs: "exec",
  zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive",
  pdf: "doc", doc: "doc", docx: "doc", xls: "doc", xlsx: "doc",
  ppt: "doc", pptx: "doc", txt: "doc", csv: "doc", rtf: "doc", odt: "doc",
};
const GRADE_RANK = { doc: 1, other: 2, archive: 3, web: 4, exec: 4 };

function gradeOfOne(att) {
  const src = String((att && (att.name || att.format)) || "").toLowerCase().trim();
  if (!src) return "other";
  const parts = src.split(".").map((s) => s.trim()).filter(Boolean);
  const exts = parts.length > 1 ? parts.slice(1) : parts;
  let best = null;
  for (const ext of exts) {
    const g = GRADE_BY_EXT[ext] || "other";
    if (best === null || GRADE_RANK[g] > GRADE_RANK[best]) best = g;
  }
  return best || "other";
}

export function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return null;
  const grades = [...new Set(attachments.map(gradeOfOne))].sort();
  return { count: attachments.length, grades };
}

export const OFFICIAL_CHECKLIST = [
  "Stop — do not send money or sign anything yet.",
  "Reach the institution through a channel you already trust: the number on your card, its official app, or its published website typed by hand — never a contact from the message itself.",
  "Ask the institution directly whether this request is real.",
  "If money has already moved, call your bank's fraud line immediately.",
];

function highestSeverity(matched) {
  if (matched.some((m) => m.severity === "high")) return "high";
  if (matched.some((m) => m.severity === "medium")) return "medium";
  return "low";
}

function buildCloudPrompt(report) {
  const lines = [
    "You are a fraud-and-contract risk analyst. The text below was de-identified on the user's device before sending: placeholders like [NAME_1] and [ACCOUNT_1] replace personal data. Never ask for the original values, and do not declare the text safe.",
    `Local pattern matches: ${report.matched.map((m) => m.id).join(", ") || "none"}.`,
  ];
  if (report.clauseRisks.length > 0) {
    lines.push(`Contract clause risks detected locally: ${report.clauseRisks.join(", ")}.`);
  }
  if (report.bonesHit.length > 0) {
    lines.push(`Fraud structure axes present: ${report.bonesHit.join(", ")}.`);
  }
  lines.push(
    "Explain in plain language: (1) the risk mechanism at work, (2) the specific phrases or clauses that create the risk, (3) the questions the user should ask before paying or signing.",
    "--- DE-IDENTIFIED TEXT ---",
    report.maskedText
  );
  return lines.join("\n");
}

// options: {
//   patterns,                       // ledger patterns (ledger.js loadLedger)
//   escalate?: (prompt, reason) => Promise<{ route, text, error, cloudMs }>,
//   nanoConfirm?: (names) => Promise<string[]>,  // confirmed candidate values
//   surface?: string,               // input surface, e.g. "message" for a
//                                   // marketplace/chat message (supplement)
//   attachments?: [{ name?, format?, sizeBytes? }],  // declared attachment
//                                   // metadata; only grades are derived
// }
export async function analyzeText(rawText, options) {
  const totalStart = performance.now();
  const timings = { maskMs: null, nanoMs: null, ledgerMs: null, cloudMs: null, totalMs: null };
  const finish = (report) => {
    timings.totalMs = Math.round(performance.now() - totalStart);
    report.timings = timings;
    return report;
  };

  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    return finish({ verdict: VERDICT.REJECTED, route: "abstained", code: "EMPTY_INPUT",
      message: "Paste a message, email, or contract clause first." });
  }
  if (rawText.length > INPUT_MAX_CHARS) {
    return finish({ verdict: VERDICT.REJECTED, route: "abstained", code: "INPUT_TOO_LONG",
      message: `This text is ${rawText.length} characters; the limit is ${INPUT_MAX_CHARS}. Split it and check one part at a time.` });
  }

  // --- Tier 1a: deterministic masking -------------------------------------
  const maskStart = performance.now();
  const mask = maskText(rawText);
  timings.maskMs = Math.round(performance.now() - maskStart);

  // --- Tier 1b: Nano assistant confirmation (optional, injected) ----------
  if (options.nanoConfirm && mask.unconfirmedNames > 0) {
    const nanoStart = performance.now();
    try {
      const pending = mask.candidates.names.filter((c) => !c.confirmed).map((c) => c.value);
      const confirmed = await options.nanoConfirm(pending);
      for (const c of mask.candidates.names) {
        if (!c.confirmed && confirmed.includes(c.value)) c.confirmed = true;
      }
      mask.unconfirmedNames = mask.candidates.names.filter((c) => !c.confirmed).length;
    } catch {
      // Assistant unavailable: candidates stay unconfirmed and the
      // conservative rule below applies. This is by design (plan §4.3).
    }
    timings.nanoMs = Math.round(performance.now() - nanoStart);
  }

  // --- Tier 1c: ledger scoring --------------------------------------------
  // Declared attachments are normalized to grades and ride on a copy of
  // the mask summary; with no attachments declared the mask object is
  // passed through untouched, so existing surfaces score byte-identically.
  const attachments = normalizeAttachments(options.attachments);
  const maskForScoring = attachments ? { ...mask, attachments } : mask;
  const ledgerStart = performance.now();
  const score = scoreText(mask.maskedText, maskForScoring, options.patterns);
  timings.ledgerMs = Math.round(performance.now() - ledgerStart);

  const base = {
    maskedText: mask.maskedText,
    isolation: { count: mask.isolationCount, byType: mask.byType },
    signals: mask.signals,
    links: mask.links,
    attachments,
    unconfirmedNames: mask.unconfirmedNames,
    totalScore: score.totalScore,
    band: score.band,
    matched: score.matched,
    bonesHit: score.bonesHit,
    clauseRisks: score.clauseRisks,
    severity: highestSeverity(score.matched),
    escalationReason: null,
    cloudPayload: null,
    cloudText: null,
    cloudAttempted: false,
    abstainCode: null,
    guidance: score.matched.map((m) => ({
      patternId: m.id, guidance: m.guidance, verifyChannel: m.verifyChannel,
    })),
  };

  // --- Branch: strong local match ------------------------------------------
  if (score.band === "strong") {
    return finish({ ...base, verdict: VERDICT.RISK, route: "on-device" });
  }

  // --- Branch: no signals ----------------------------------------------------
  if (score.band === "none") {
    // Short-input policy (2026-11-24 fix round, pilot proposal #5): a single
    // very short sentence carries almost no evidence either way, so the
    // honest answer is abstention, not a clean bill. The 10,000-mutant
    // pilot's border bucket showed first-sentence-only fraud texts of up to
    // 72 characters passing as "no signals"; the limit below covers that
    // measured range. Longer or multi-sentence texts keep the plain
    // no-signals verdict.
    const trimmed = rawText.trim();
    // Marketplace-message surface (2026-11-24 supplement, design V5):
    // a chat message with no local signals is not cleared either — short
    // messages abstain up to a higher limit, and any message declaring a
    // high-risk attachment grade abstains at any length, because the
    // attachment itself cannot be inspected here.
    if (options.surface === "message") {
      const highRiskAttachment = attachments !== null &&
        attachments.grades.some((g) => g === "web" || g === "exec" || g === "archive");
      if (trimmed.length <= MESSAGE_ABSTAIN_MAX_CHARS || highRiskAttachment) {
        return finish({ ...base, verdict: VERDICT.ABSTAINED, route: "abstained",
          abstainCode: ABSTAIN.INSUFFICIENT_EVIDENCE,
          message: "This message carries too little verifiable signal to judge on this device. Treat any order or payment claim in it as unconfirmed until you check it inside the platform itself — and do not open its attachments." });
      }
    }
    // Decimal points inside amounts ("$899.99") are not sentence breaks.
    const sentenceCount = trimmed.replace(/(\d)\.(\d)/g, "$1$2")
      .split(/[.!?…]+/).filter((s) => s.trim().length > 0).length;
    if (trimmed.length <= SHORT_INPUT_MAX_CHARS && sentenceCount <= 1) {
      return finish({ ...base, verdict: VERDICT.ABSTAINED, route: "abstained",
        abstainCode: ABSTAIN.INSUFFICIENT_EVIDENCE,
        message: "This text is very short — a single brief line carries too little context to judge. Treat it as unverified: if it asks for money, codes, or personal data, check through an official channel first." });
    }
    return finish({ ...base, verdict: VERDICT.NO_SIGNALS, route: "on-device" });
  }

  // --- Branch: weak evidence -> honest abstention ----------------------------
  if (score.band === "weak") {
    return finish({ ...base, verdict: VERDICT.ABSTAINED, route: "abstained",
      abstainCode: ABSTAIN.INSUFFICIENT_EVIDENCE,
      message: "There are faint signals here, but not enough evidence to judge this text. Treat it as unverified and use the official-channel checklist." });
  }

  // --- Branch: escalation candidate ------------------------------------------
  const reason = score.clauseRisks.length >= 2
    ? `Local analysis isolated the personal data and matched contract-risk patterns (${score.matched.map((m) => m.id).join(", ")}), but how these clauses interact needs deep reading. Only the de-identified skeleton is sent to the cloud.`
    : "Local patterns matched, but the wording is ambiguous and needs deep analysis. Only the de-identified skeleton is sent to the cloud.";
  base.escalationReason = reason;

  if (mask.unconfirmedNames > 0) {
    return finish({ ...base, verdict: VERDICT.ABSTAINED, route: "abstained",
      abstainCode: ABSTAIN.DEID_UNCERTAIN,
      message: "Some name-like text could not be confirmed as fully masked, so this was NOT sent to the cloud. The local result above is all that can be said safely." });
  }

  const prompt = buildCloudPrompt(base);
  const rescan = rescanForPII(prompt);
  if (!rescan.clean) {
    return finish({ ...base, verdict: VERDICT.ABSTAINED, route: "abstained",
      abstainCode: ABSTAIN.RESCAN_FAIL,
      rescanFindings: rescan.findings.map((f) => f.type),
      message: "A final safety scan found unmasked personal data in the outgoing text, so the cloud send was cancelled. Nothing left this device." });
  }
  base.cloudPayload = prompt;

  if (!options.escalate) {
    return finish({ ...base, verdict: VERDICT.ABSTAINED, route: "abstained",
      abstainCode: ABSTAIN.CLOUD_UNAVAILABLE,
      message: "This needs cloud analysis, but the cloud path is not connected in this build. The local result above stands; use the official-channel checklist." });
  }

  base.cloudAttempted = true;
  const result = await options.escalate(prompt, reason);
  timings.cloudMs = result.cloudMs ?? null;
  if (result.route === "cloud") {
    return finish({ ...base, verdict: VERDICT.CLOUD_ANALYSIS, route: "cloud", cloudText: result.text });
  }
  return finish({ ...base, verdict: VERDICT.ABSTAINED, route: "abstained",
    abstainCode: ABSTAIN.ENGINE,
    message: result.error || "The cloud path could not answer; rather than guess, the shield abstains." });
}
