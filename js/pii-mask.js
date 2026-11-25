// ---------------------------------------------------------------------------
// PII masking — deterministic layer (plan §4).
//
// Pure regex + format validation (Luhn, date-part checks). No DOM, no
// network, no model calls: this module runs identically in every browser
// and in the Node verification battery.
//
// Output contract:
//   maskText(text) -> {
//     maskedText,                       // text with tokens substituted
//     tokens: [{ type, token }],        // one entry per masked span
//     isolationCount,                   // tokens.length
//     byType: { CARD: n, ... },
//     signals: [{ kind, detail }],      // non-masked findings (long numeric
//                                       // runs, links) used by the ledger
//     links: [domain, ...],
//     candidates: {
//       names:     [{ value, token, source, confirmed }],
//       addresses: [{ value, token, source, confirmed }],
//     },
//     unconfirmedNames,                 // context-sourced name candidates
//                                       // not yet confirmed (Nano, §4.3)
//   }
//
// Token originals are NEVER stored in this module's output beyond the
// candidate list the caller needs for the Nano confirmation step; callers
// must not persist or transmit them (plan §4.1, §7.2).
//
// Confirmation rule (plan §4.2/§4.3): candidates found via an explicit
// label ("Name:", "Borrower:", "Recipient:") are deterministically
// confirmed — the label itself is the evidence. Candidates found via
// honorific/context patterns stay unconfirmed until the Nano assistant
// layer confirms them; while any remain, cloud escalation is forbidden.
// ---------------------------------------------------------------------------

function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const digitsOnly = (s) => s.replace(/\D/g, "");

// Each detector returns candidate spans: { start, end, type, value }.
// Priority order is the array order in DETECTORS: structural types with
// cryptographic/format validation first (plan §4.1 masking order).
const DETECTORS = [
  {
    type: "CARD",
    find(text, push) {
      const re = /\d[\d -]{11,24}\d/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const digits = digitsOnly(m[0]);
        if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
          push(m.index, m.index + m[0].length, "CARD", m[0]);
        }
      }
    },
  },
  {
    type: "SIN",
    find(text, push) {
      const re = /\b\d{3}[ -]\d{3}[ -]\d{3}\b/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (luhnValid(digitsOnly(m[0]))) push(m.index, m.index + m[0].length, "SIN", m[0]);
      }
    },
  },
  {
    type: "ID",
    find(text, push) {
      // Korean resident-registration shape: YYMMDD-[1-4]XXXXXX with a
      // valid month/day in the date part.
      const re = /\b(\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])-[1-4]\d{6}\b/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        push(m.index, m.index + m[0].length, "ID", m[0]);
      }
    },
  },
  {
    type: "EMAIL",
    find(text, push) {
      const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
      let m;
      while ((m = re.exec(text)) !== null) push(m.index, m.index + m[0].length, "EMAIL", m[0]);
    },
  },
  {
    type: "PHONE",
    find(text, push) {
      const patterns = [
        /\b01[016789][- ]?\d{3,4}[- ]?\d{4}\b/g, // KR mobile
        /\+1[-. ]\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g, // NA with +1
        /\(\d{3}\)[ ]?\d{3}[-. ]\d{4}\b/g, // NA (NPA) form
        /\b\d{3}[-.]\d{3}[-.]\d{4}\b/g, // NA separated form
      ];
      for (const re of patterns) {
        let m;
        while ((m = re.exec(text)) !== null) push(m.index, m.index + m[0].length, "PHONE", m[0]);
      }
    },
  },
  {
    type: "ACCOUNT",
    find(text, push) {
      // Account numbers are only masked with a nearby account context
      // keyword (plan §4.1); context-free long numbers become signals.
      const kw = /(account|acct|a\/c|deposit to|입금|계좌|예금주)/gi;
      const windows = [];
      let k;
      while ((k = kw.exec(text)) !== null) {
        windows.push([Math.max(0, k.index - 10), k.index + k[0].length + 40]);
      }
      if (windows.length === 0) return;
      const re = /\d{2,6}[- ]\d{2,6}(?:[- ]\d{2,8}){0,2}|\d{8,16}/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const inside = windows.some(([a, b]) => m.index >= a && m.index < b);
        if (inside) push(m.index, m.index + m[0].length, "ACCOUNT", m[0]);
      }
    },
  },
  {
    type: "ADDRESS",
    find(text, push, pushCandidate) {
      // Full-span rule (2026-11-20, Gate 2 live finding): masking only the
      // postal code left the street and city portion of an address in
      // plaintext in the cloud payload. When a postal code (CA) or ZIP
      // (US) anchors the tail of an address, mask the whole span — street
      // number + street name/type, city, province/state, code — as one
      // ADDRESS token. A bare code with no recognized street span keeps
      // the original on-sight masking as fallback.
      const spanRe =
        /\b\d{1,6}\s+(?:[A-Za-z][A-Za-z'.-]*\s+){0,4}(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Boulevard|Blvd|Lane|Ln|Court|Ct|Crescent|Cres|Place|Pl|Terrace|Ter|Way|Trail|Parkway|Pkwy|Highway|Hwy|Circle|Cir|Square|Sq)\b(?:\s+(?:North|South|East|West|NE|NW|SE|SW))?[,\s]+[A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,2}[,\s]+(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT|AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)[,\s]+(?:[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d|\d{5}(?:-\d{4})?)\b/g;
      const covered = [];
      let m;
      while ((m = spanRe.exec(text)) !== null) {
        push(m.index, m.index + m[0].length, "ADDRESS", m[0]);
        pushCandidate("addresses", m[0], "address-span", true);
        covered.push([m.index, m.index + m[0].length]);
      }
      const re = /\b[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d\b/g;
      while ((m = re.exec(text)) !== null) {
        if (covered.some(([a, b]) => m.index >= a && m.index < b)) continue;
        push(m.index, m.index + m[0].length, "ADDRESS", m[0]);
        pushCandidate("addresses", m[0], "postal-code", true);
      }
    },
  },
  {
    type: "NAME",
    find(text, push, pushCandidate) {
      // Label-sourced candidates: deterministic confirmation.
      const labelRe =
        /(?:Name|Borrower|Recipient|Account holder|Payee|성명|예금주|수취인)\s*[:：]\s*([A-Z][A-Za-z]+(?:\s+[A-Z]\.)?(?:\s+[A-Z][A-Za-z]+){0,2}|[가-힣]{2,4})/g;
      let m;
      while ((m = labelRe.exec(text)) !== null) {
        const start = m.index + m[0].length - m[1].length;
        push(start, start + m[1].length, "NAME", m[1]);
        pushCandidate("names", m[1], "label", true);
      }
      // Honorific/context candidates: need Nano confirmation (§4.3).
      const honRe =
        /(Mr\.|Mrs\.|Ms\.|Dr\.)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)|([가-힣]{2,4})\s*(님|씨|검사|수사관|과장|대리)/g;
      while ((m = honRe.exec(text)) !== null) {
        const value = m[2] || m[3];
        const start = m.index + m[0].indexOf(value);
        push(start, start + value.length, "NAME", value);
        pushCandidate("names", value, "context", false);
      }
    },
  },
];

export function maskText(text) {
  const spans = [];
  const candidates = { names: [], addresses: [] };
  const push = (start, end, type, value) => spans.push({ start, end, type, value });
  const pushCandidate = (kind, value, source, confirmed) =>
    candidates[kind].push({ value, source, confirmed, token: null });

  for (const detector of DETECTORS) detector.find(text, push, pushCandidate);

  // Resolve overlaps: earlier span wins; within a tie, the span from the
  // higher-priority detector (earlier in DETECTORS order) wins because
  // spans were pushed in detector order and Array.sort is stable.
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const accepted = [];
  let cursor = -1;
  for (const span of spans) {
    if (span.start >= cursor) {
      accepted.push(span);
      cursor = span.end;
    }
  }

  // Number tokens per type in order of appearance and substitute.
  const counters = {};
  const tokens = [];
  let out = "";
  let pos = 0;
  for (const span of accepted) {
    counters[span.type] = (counters[span.type] || 0) + 1;
    const token = `[${span.type}_${counters[span.type]}]`;
    tokens.push({ type: span.type, token });
    out += text.slice(pos, span.start) + token;
    pos = span.end;
    for (const kind of ["names", "addresses"]) {
      for (const c of candidates[kind]) {
        if (c.value === span.value && c.token === null) c.token = token;
      }
    }
  }
  out += text.slice(pos);

  // Non-masked findings: links (signal + skeleton replacement) and
  // context-free long numeric runs (signal only; the rescan gate treats
  // them as escalation blockers, plan §4.1).
  //
  // Stage 1 of the public-corpus supplement (2026-11-24): real circulating
  // scam texts hide their links three ways the plain extractor missed —
  // defanged schemes/hosts (hxxps://host[.]com), scheme-less short links
  // (wa.me/…), and crypto wallet addresses, which are not links at all but
  // the payment destination itself. All three are normalized/extracted
  // here with the same treatment as links (skeleton replacement + signal);
  // a wallet is NOT counted as a PII token, so the isolation count and the
  // rescan gate behave exactly as before. Structure signals never
  // originate a score on their own — the ledger's corroboration rule
  // (structure counts only when the pattern's own phrase fired) is
  // unchanged.
  const findText = out
    .replace(/\bhxxps\b/gi, "https")
    .replace(/\bhxxp\b/gi, "http")
    .replace(/\[\.\]|\(\.\)|\{\.\}|\[dot\]/gi, ".");
  const links = [];
  const linkRe = /https?:\/\/([^\s/]+)[^\s]*/g;
  let lm;
  while ((lm = linkRe.exec(findText)) !== null) links.push(lm[1]);
  let maskedText = findText.replace(linkRe, "[LINK]");

  const SHORT_LINK_DOMAINS = [
    "wa.me", "t.me", "bit.ly", "tinyurl.com", "rb.gy",
    "cutt.ly", "is.gd", "tiny.cc", "shorturl.at",
  ];
  for (const domain of SHORT_LINK_DOMAINS) {
    const shortRe = new RegExp(`\\b${domain.replace(/\./g, "\\.")}(/[^\\s]*)?`, "g");
    maskedText = maskedText.replace(shortRe, () => {
      links.push(domain);
      return "[LINK]";
    });
  }

  const WALLET_RES = [
    /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g, // BTC legacy (P2PKH / P2SH)
    /\bbc1[a-z0-9]{39,59}\b/gi, // BTC bech32 (SegWit / Taproot)
    /\b0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g, // ETH-style address
  ];
  let walletCount = 0;
  for (const walletRe of WALLET_RES) {
    maskedText = maskedText.replace(walletRe, () => {
      walletCount += 1;
      return "[WALLET]";
    });
  }

  const signals = [];
  if (links.length > 0) signals.push({ kind: "link", detail: links.join(", ") });
  if (walletCount > 0) signals.push({ kind: "wallet", detail: `${walletCount} address(es)` });
  const longNumeric = maskedText.match(/(?<![\dA-Za-z])\d{10,}(?![\dA-Za-z])/g);
  if (longNumeric) {
    signals.push({ kind: "long-numeric", detail: `${longNumeric.length} run(s)` });
  }

  const byType = {};
  for (const t of tokens) byType[t.type] = (byType[t.type] || 0) + 1;

  return {
    maskedText,
    tokens,
    isolationCount: tokens.length,
    byType,
    signals,
    links,
    candidates,
    unconfirmedNames: candidates.names.filter((c) => !c.confirmed).length,
  };
}

// ---------------------------------------------------------------------------
// Rescan gate (plan §6.1 layer 2). Runs the structural detectors over a
// finished cloud payload. Returns { clean, findings }. A single structural
// finding cancels the send. Long context-free numeric runs also block:
// they were signals, not masks, so they must never ride along.
// ---------------------------------------------------------------------------
export function rescanForPII(payload) {
  const findings = [];
  const probe = maskText(payload);
  for (const t of probe.tokens) {
    // Tokens the probe produces here are *unmasked* PII sitting in the
    // payload (the payload's own [TYPE_n] placeholders do not re-trigger
    // detectors: they contain no digit runs of the required shapes).
    findings.push({ type: t.type, token: t.token });
  }
  for (const s of probe.signals) {
    if (s.kind === "long-numeric") findings.push({ type: "LONG_NUMERIC", token: null });
  }
  return { clean: findings.length === 0, findings };
}
