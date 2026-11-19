// ---------------------------------------------------------------------------
// Local pattern ledger — deterministic scoring (plan §5).
//
// The ledger is a static JSON bundled with the app (public/data/ledger.json).
// Scoring is pure and deterministic: phrase signals are case-insensitive
// substring matches over the MASKED text; structure signals are evaluated
// against the mask result (links, account/card presence). The same input
// always produces the same score — this is what the determinism battery
// verifies.
//
// Threshold bands (tuned against the battery corpus; changes require a
// battery re-run and a note in the build record, plan §5.2):
//   - a fraud pattern scoring >= STRONG_PATTERN_SCORE on its own is a
//     strong local match;
//   - total >= STRONG_TOTAL is a strong local match;
//   - total >= ESCALATE_TOTAL (or >= 2 distinct contract clause risks)
//     is ambiguous/complex -> escalation candidate;
//   - 1..ESCALATE_TOTAL-1 is weak -> honest abstention;
//   - 0 -> no risk signals found.
// Asymmetry principle (plan §12): over-warning beats under-warning.
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
  PATTERN_MATCH_MIN: 3, // a pattern counts as "matched" at this score
  STRONG_PATTERN_SCORE: 8,
  STRONG_TOTAL: 10,
  ESCALATE_TOTAL: 4,
};

export async function loadLedger(url = "data/ledger.json") {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Ledger load failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.patterns;
}

function structureHolds(kind, mask) {
  switch (kind) {
    case "link":
      return mask.links.length > 0;
    case "account":
      return (mask.byType.ACCOUNT || 0) > 0;
    case "link+account":
      return mask.links.length > 0 && (mask.byType.ACCOUNT || 0) > 0;
    case "card":
      return (mask.byType.CARD || 0) > 0;
    case "phone":
      return (mask.byType.PHONE || 0) > 0;
    default:
      return false;
  }
}

// scoreText(maskedText, mask, patterns) -> {
//   totalScore,
//   matched: [{ id, type, score, severity, bones, clauseRisk, guidance,
//               verifyChannel, label }],
//   bonesHit: [...], clauseRisks: [...],
//   band: "strong" | "escalate" | "weak" | "none",
//   strongPattern: boolean,
// }
export function scoreText(maskedText, mask, patterns) {
  const haystack = maskedText.toLowerCase();
  const matched = [];
  let totalScore = 0;

  for (const pattern of patterns) {
    let phraseScore = 0;
    let structureScore = 0;
    for (const signal of pattern.signals) {
      if (signal.kind === "phrase") {
        if (haystack.includes(signal.value.toLowerCase())) phraseScore += signal.weight;
      } else if (signal.kind === "structure") {
        if (structureHolds(signal.value, mask)) structureScore += signal.weight;
      }
    }
    // Structure corroborates, never originates: a pattern's structural
    // signals (e.g. "contains a link") count only when at least one of its
    // own phrases also matched. Otherwise every link-bearing text would
    // score against every link-bearing pattern at once.
    const score = phraseScore > 0 ? phraseScore + structureScore : 0;
    if (score > 0) totalScore += score;
    if (score >= THRESHOLDS.PATTERN_MATCH_MIN) {
      matched.push({
        id: pattern.id,
        type: pattern.type,
        score,
        severity: pattern.severity,
        bones: pattern.bones || [],
        clauseRisk: pattern.clauseRisk || [],
        guidance: pattern.guidance,
        verifyChannel: pattern.verifyChannel,
        label: pattern.impersonation ? pattern.impersonation.label : pattern.id,
      });
    }
  }

  matched.sort((a, b) => b.score - a.score);
  const bonesHit = [...new Set(matched.flatMap((m) => m.bones))];
  const clauseRisks = [...new Set(matched.flatMap((m) => m.clauseRisk))];
  const strongPattern = matched.some(
    (m) => m.type !== "contract-clause" && m.score >= THRESHOLDS.STRONG_PATTERN_SCORE
  );

  let band;
  if (clauseRisks.length >= 2) band = "escalate";
  else if (strongPattern || totalScore >= THRESHOLDS.STRONG_TOTAL) band = "strong";
  else if (totalScore >= THRESHOLDS.ESCALATE_TOTAL) band = "escalate";
  else if (totalScore > 0) band = "weak";
  else band = "none";

  return { totalScore, matched, bonesHit, clauseRisks, band, strongPattern };
}
