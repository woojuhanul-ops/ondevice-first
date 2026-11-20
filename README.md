# Credit & Contract Hybrid Shield — OnDevice First

A web app that checks suspicious texts and contract clauses **before money
moves — and before a signature becomes binding**. Paste a text message, an
email, or a contract clause; the Shield looks for smishing / voice-phishing
patterns and unfair contract terms, and tells you what it found, what it
based that on, and what to verify through official channels. Measured
against the shipping code, a battery of 100 cases rebuilt from real-world
scam scripts was defended 100 out of 100 — zero scams passed as safe, zero
ordinary messages blocked (batteries run in Node; live cloud behavior is
verified separately at Gate 2 — see "Not yet claimed" below).

The core mechanism is **hybrid inference** with
[Firebase AI Logic](https://firebase.google.com/docs/ai-logic), organized
as a three-stage shield:

1. **On-device defense first.** Personally identifying details (card and
   account numbers, phone numbers, emails, ID numbers, names) are masked
   locally by a deterministic filter, and the masked text is matched
   against a local pattern ledger. The original text never leaves the
   device in this stage.
2. **Escalation only with a reason.** When local evidence is not enough —
   a compound clause or an ambiguous script — only the *de-identified
   skeleton* (masked text plus structural tags) is sent to cloud Gemini
   through Firebase AI Logic. The payload is re-scanned immediately before
   sending; if anything identifiable survives, the send is cancelled. The
   UI shows the escalation reason and exactly what was sent.
3. **Honest abstention — Active Harm Prevention.** When the evidence is
   insufficient, the Shield does **not** declare the text "safe".
   Abstention is a defense action, not a non-answer: the Shield stops,
   states the reason, and shows the safe next step — an official-channel
   verification checklist (verify through contact details you already
   trust, not the ones in the message).

This is an entry for
[#BuildHybridAI 2026](https://firebasehybridaihackathon.devpost.com/)
(Web platform).

## What is measured, and where

- The local pattern ledger ships with **64 patterns** (fraud scripts for
  KR / CA / US / common patterns, unfair contract clauses, and
  medical/insurance impersonation), each described by the four "bones"
  shared by these scams: authority impersonation, urgency, secrecy, and
  payment inducement. All example texts are fictional.
- A Node test battery that runs the actual shipping modules passes
  **55/55 checks** (masking corpus, re-scan gate, scenario verdicts,
  determinism across repeated runs, honest degradation paths).
- Deterministic masking of a 254-character scenario text averages
  **0.027 ms per pass, measured in Node**. No speed figure is claimed for
  model inference; the UI displays the measured per-stage timings of the
  running browser instead.
- **Not yet claimed:** live cloud escalation in a real browser and
  on-device Gemini Nano behavior are verified separately at the project's
  Gate 2 browser-verification step; until then the app degrades honestly —
  with the cloud unconfigured or unreachable it abstains with a stated
  reason instead of pretending to analyse.

## Architecture

```
 input (original text — held in memory only, never stored, never sent)
   │
   ▼
 [mask]      pii-mask.js — deterministic masking (Luhn/format-verified),
             name/address candidates flagged for on-device confirmation
   │
   ▼
 [match]     ledger.js + data/ledger.json — deterministic scoring
             against the local pattern ledger
   │
   ├── strong local match ───────────────▶ local verdict (cloud calls: 0)
   ├── compound / ambiguous ─▶ [re-scan gate] ─▶ cloud escalation
   │        (de-identified skeleton only, reason shown, budget-capped)
   └── weak / insufficient evidence ─────▶ ABSTAIN + verify checklist
```

- `public/js/shield.js` — the three-stage pipeline and verdict synthesis.
- `public/js/pii-mask.js` — deterministic PII masking and the pre-send
  re-scan gate (`rescanForPII`).
- `public/js/ledger.js`, `public/data/ledger.json` — the local pattern
  ledger and its deterministic scoring.
- `public/js/hybrid-adapter.js` — the inference entry point:
  `runInference({ prompt, needsCloud?, cloudReason? })` returns
  `{ route, text, escalationReason, error, timings }`. On-device first
  (Chrome Prompt API / Gemini Nano), cloud by escalation only.
- `public/js/ondevice.js` — Chrome Prompt API detection (both the
  `LanguageModel` global and the earlier `window.ai.languageModel` shape).
- `public/js/cloud.js` — the only place cloud calls happen, so the
  per-session cloud call budget (frozen at **20 calls per session**) is
  enforced in exactly one spot. When the budget is exhausted, the adapter
  degrades to an honest abstention.
- `public/js/firebase-init.js` — Firebase bootstrap and the **App Check**
  hookup point (reCAPTCHA Enterprise provider; a debug token can be used
  for the judging build, as the contest rules allow).
- `public/js/store.js` — IndexedDB history of **masked analyses only**.
  Original texts and original token values are structurally excluded from
  storage; a delete-all control is in the UI.
- `public/js/config.js` — all configuration in one place. It holds the
  public Firebase web identifiers of the submission project (a web apiKey
  is a project identifier, not a server secret).

Data principle: the original text is processed in session memory only.
What is stored locally is the masked text and the verdict record. What is
sent to the cloud, when escalation passes the gate, is the masked skeleton
— and the UI shows it.

## Project map

See [AKASHIC_TABLE.md](AKASHIC_TABLE.md) — the project's own record table
(name · location · role · connections for every component).

## Run it locally

No build step. Serve the `public/` folder with any static server:

```sh
python3 -m http.server 8080 --directory public
# then open http://localhost:8080
```

The status strip reports honestly what is live: on-device availability
depends on your Chrome build and flags; the local masking and ledger
stages work in any modern browser.

## Contest notes

- Platform: Web (targets the Best Web category as well as the main prizes).
- Firebase AI Logic is the hybrid inference mechanism; App Check is wired
  in `firebase-init.js`.
- The demo shows real working screens only, per the contest rules.
- All demo scenarios use fictional data only — no real personal
  information appears anywhere in this repository.

## License

MIT — see [LICENSE](LICENSE).
