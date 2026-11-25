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

// --- Supplementary match views (2026-11-24 fix round) ----------------------
// The 10,000-mutant pilot (2026-11-21) showed three mechanical ways a real
// signal phrase gets broken without any change in meaning: a dropped space
// joins two words ("holding fee" -> "holdingfee"), a one-character typo
// lands inside the phrase ("photo radar" -> "photo raadar"), or a word is
// swapped for a common synonym ("payment" -> "charge", "avoid" ->
// "prevent"). Phrase matching therefore runs over four views of the text —
// raw, whitespace-stripped, synonym-canonicalized, and a token view that
// tolerates agglutinative endings (prefix tokens) plus exactly one
// single-character typo in one token (phrase tokens of 4+ characters).
// A signal counts once if ANY view matches. Every view is a
// pure function of the masked text, so scoring stays deterministic.
const SYNONYM_CANON = [
  ["확인해 주세요", "확인하세요"],
  ["is going to be", "will be"],
  ["right away", "immediately"],
  ["urgently", "immediately"],
  ["log in", "sign in"],
  ["you've", "you have"],
  ["profile", "account"],
  ["prevent", "avoid"],
  ["confirm", "verify"],
  ["charge", "payment"],
  ["phone", "call"],
  ["문의", "연락"],
  ["사용", "이용"],
];

function canonicalize(s) {
  let out = s;
  for (const [variant, canon] of SYNONYM_CANON) out = out.split(variant).join(canon);
  return out;
}

function stripToken(tok) {
  return tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function editDistanceAtMost1(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i += 1) {
      if (a[i] !== b[i]) { diff += 1; if (diff > 1) return false; }
    }
    return diff === 1;
  }
  const short = la < lb ? a : b;
  const long = la < lb ? b : a;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i += 1; j += 1; } else {
      if (skipped) return false;
      skipped = true;
      j += 1;
    }
  }
  return true;
}

// Token-pair match for the fuzzy view. Exact match, or one token is a
// prefix of the other (agglutinative endings: phrase token "알려" inside
// the text token "알려주세요", "입력" inside "입력해"), or — budgeted by
// the caller, at most once per phrase — a single-character typo in a
// phrase token of 4+ characters. The length floor is on the PHRASE token
// only: a deletion typo shortens the text token ("just" -> "jut",
// "your" -> "yor") and must still count.
function tokenPairMatch(p, h) {
  if (p === h) return "exact";
  if (p.length >= 2 && h.startsWith(p)) return "exact";
  if (h.length >= 2 && p.startsWith(h)) return "exact";
  if (p.length >= 4 && editDistanceAtMost1(p, h)) return "fuzzy";
  return null;
}

function fuzzyPhraseMatch(phraseTokens, hayTokens) {
  const n = phraseTokens.length;
  if (n === 0 || hayTokens.length < n) return false;
  for (let s = 0; s + n <= hayTokens.length; s += 1) {
    let fuzzyUsed = false;
    let ok = true;
    for (let k = 0; k < n; k += 1) {
      const m = tokenPairMatch(phraseTokens[k], hayTokens[s + k]);
      if (m === "exact") continue;
      if (m === "fuzzy" && !fuzzyUsed) { fuzzyUsed = true; continue; }
      ok = false;
      break;
    }
    if (ok) return true;
  }
  return false;
}

// Tokens are split on sentence punctuation as well as whitespace: the
// spacing mutation can glue two sentences into one whitespace token
// ("...in 2 hours.Confirm your PIN..."), and the token view must still
// see "confirm" as a token. Applied identically to phrases and text.
const TOKEN_SPLIT = /[\s.!?…,:;]+/;

function buildMatchViews(haystack) {
  return {
    raw: haystack,
    flat: haystack.replace(/\s+/g, ""),
    canon: canonicalize(haystack),
    tokens: haystack.split(TOKEN_SPLIT).map(stripToken).filter(Boolean),
  };
}

function phraseHit(value, views) {
  const v = value.toLowerCase();
  if (views.raw.includes(v)) return true;
  if (views.flat.includes(v.replace(/\s+/g, ""))) return true;
  if (views.canon.includes(canonicalize(v))) return true;
  const toks = v.split(TOKEN_SPLIT).map(stripToken).filter(Boolean);
  return fuzzyPhraseMatch(toks, views.tokens);
}

function structureHolds(kind, mask) {
  switch (kind) {
    case "link":
      return mask.links.length > 0;
    case "wallet":
      return (mask.signals || []).some((s) => s.kind === "wallet");
    case "account":
      return (mask.byType.ACCOUNT || 0) > 0;
    case "link+account":
      return mask.links.length > 0 && (mask.byType.ACCOUNT || 0) > 0;
    case "card":
      return (mask.byType.CARD || 0) > 0;
    case "phone":
      return (mask.byType.PHONE || 0) > 0;
    case "attachment":
      return attachmentGrades(mask).length > 0;
    case "attachment:web":
      return attachmentGrades(mask).includes("web");
    case "attachment:exec":
      return attachmentGrades(mask).includes("exec");
    case "attachment:archive":
      return attachmentGrades(mask).includes("archive");
    case "attachment:other":
      return attachmentGrades(mask).includes("other");
    case "attachment:doc":
      return attachmentGrades(mask).includes("doc");
    default:
      return false;
  }
}

// Attachment grades ride on the mask object as a normalized summary
// ({ grades: [...] }) produced by shield.js from user-declared metadata.
// Only grades — never file names — reach the scorer.
function attachmentGrades(mask) {
  return mask && mask.attachments && Array.isArray(mask.attachments.grades)
    ? mask.attachments.grades
    : [];
}

// --- Negation guard (marketplace supplement, 2026-11-24) -------------------
// Patterns flagged negationGuard are scored over a guarded copy of the
// text: within each clause (split on sentence punctuation, commas and
// newlines), everything from the first negation cue onward is replaced by
// filler, so a lure phrase that is only being quoted or refused ("I won't
// arrange payment directly outside the platform") does not fire. The
// filler is a non-space character so the whitespace-stripped view cannot
// rejoin the two sides. Unflagged patterns keep the standard views, so
// the existing ledger behaves exactly as before.
const NEGATION_CUE = /\bnot\b|\bnever\b|\bcannot\b|\bno longer\b|n't/i;

function guardNegations(text) {
  return text
    .split(/([.!?…;,\n]+)/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      const m = NEGATION_CUE.exec(part);
      if (!m) return part;
      return part.slice(0, m.index) + "#".repeat(part.length - m.index);
    })
    .join("");
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
  const views = buildMatchViews(haystack);
  const guardedViews = patterns.some((p) => p.negationGuard)
    ? buildMatchViews(guardNegations(haystack))
    : null;
  const matched = [];
  let totalScore = 0;

  for (const pattern of patterns) {
    const pviews = pattern.negationGuard && guardedViews ? guardedViews : views;
    let phraseScore = 0;
    let structureScore = 0;
    const groupBest = new Map();
    for (const signal of pattern.signals) {
      if (signal.kind === "phrase") {
        if (!phraseHit(signal.value, pviews)) continue;
        // Grouped phrase signals are mutually exclusive phrasings of one
        // lure (e.g. the ways to say "outside the platform"): only the
        // strongest matched phrasing counts, so stacked variants of the
        // same lure cannot inflate the score.
        if (signal.group) {
          if (signal.weight > (groupBest.get(signal.group) || 0)) {
            groupBest.set(signal.group, signal.weight);
          }
        } else {
          phraseScore += signal.weight;
        }
      } else if (signal.kind === "structure") {
        if (structureHolds(signal.value, mask)) structureScore += signal.weight;
      }
    }
    for (const w of groupBest.values()) phraseScore += w;
    // A pattern cap bounds its phrase evidence (structure is added after
    // the cap): claim-only patterns can never reach a strong verdict on
    // assertions alone, however many claims are stacked.
    const cap = Number(pattern.cap);
    const effectivePhrase =
      Number.isFinite(cap) && cap > 0 ? Math.min(phraseScore, cap) : phraseScore;
    // Structure corroborates, never originates: a pattern's structural
    // signals (e.g. "contains a link") count only when at least one of its
    // own phrases also matched. Otherwise every link-bearing text would
    // score against every link-bearing pattern at once.
    const score = phraseScore > 0 ? effectivePhrase + structureScore : 0;
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
