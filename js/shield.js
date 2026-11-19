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
  const ledgerStart = performance.now();
  const score = scoreText(mask.maskedText, mask, options.patterns);
  timings.ledgerMs = Math.round(performance.now() - ledgerStart);

  const base = {
    maskedText: mask.maskedText,
    isolation: { count: mask.isolationCount, byType: mask.byType },
    signals: mask.signals,
    links: mask.links,
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
