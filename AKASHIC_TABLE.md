# Akashic Table — Credit & Contract Hybrid Shield (OnDevice First)

Per the standing rule, every piece of software built by Nexus Group carries
its own record table: one record per row, with name · location · role ·
connections. This table is the map of this project; the software (and any
agent working on it) reads this table to know what exists and how it links.

Gate 1 (design freeze, 2026-11-19): concept attached — Credit & Contract
Hybrid Shield. Frozen values: cloud call budget **20/session** (config.js,
enforced in cloud.js); original text is **never stored** (store.js keeps
masked records only); product name "Credit & Contract Hybrid Shield",
subtitle "OnDevice First".

| Name | Location | Role | Connections |
|---|---|---|---|
| firebase.json | /firebase.json | Firebase Hosting configuration (public dir, SPA rewrite, cache headers). Site id remains the placeholder "REPLACE_AT_GATE1": Firebase Hosting is not the live deployment path — the live build is served from GitHub Pages (since 2026-11-19). Kept for a possible future Hosting deploy. | → public/ (served root), .firebaserc (project) |
| .firebaserc | /.firebaserc | Firebase project alias: default project fixed to nexus-2e23d (Gate 2 prep, 2026-11-19). | → firebase.json |
| index.html | /public/index.html | Shield product UI (Gate 1): text input + scenario loaders, masked preview with token chips, hybrid dashboard (route badge, escalation log, isolation counts, evidence, cloud budget, measured timings, exact cloud payload, guidance, local history). | → styles.css, js/main.js |
| styles.css | /public/styles.css | Dark instrument-panel styling for the Shield UI. | → index.html |
| config.js | /public/js/config.js | Single source of configuration: the REAL public web config of the dedicated "Hybrid Shield" web app registration (project nexus-2e23d), injected at the Gate 2 config swap (2026-11-19, commit 737a0c1) — a web apiKey is a project identifier, not a server secret. App Check site key slot (still empty — App Check init is skipped and that state is reported honestly until the console step), cloud model name, **cloud call budget frozen at 20/session (Gate 1)**, shield input limit 20000 chars. | → firebase-init.js, cloud.js, shield.js |
| firebase-init.js | /public/js/firebase-init.js | Firebase bootstrap: app init, App Check hookup point (incl. debug-token note for judging), Firebase AI Logic handle. | → config.js, cloud.js (via getGenerativeModel) |
| ondevice.js | /public/js/ondevice.js | On-device path: Chrome Prompt API (Gemini Nano) detection for both API shapes + session runner. | → hybrid-adapter.js |
| cloud.js | /public/js/cloud.js | Cloud path: the only place cloud calls happen; enforces the per-session call budget. | → firebase-init.js, config.js, hybrid-adapter.js |
| hybrid-adapter.js | /public/js/hybrid-adapter.js | Core mechanism: on-device first, cloud by escalation with a user-visible reason, honest abstention when both paths fail. Feature code calls runInference() only. | → ondevice.js, cloud.js, firebase-init.js, main.js |
| main.js | /public/js/main.js | Shield wiring: engine status strip, scenario loading, analyze flow (injects adapter escalation + Nano candidate confirmation into shield.js), dashboard rendering, local history rendering. | → hybrid-adapter.js, ondevice.js, ledger.js, shield.js, store.js, index.html |
| pii-mask.js | /public/js/pii-mask.js | Tier 1 masking (Gate 1, new): deterministic regex + Luhn/format validation for card, SIN, KR resident id, phone, email, contextual account, postal code; name candidates (label-confirmed vs Nano-pending); link/long-numeric signals; rescanForPII gate for outgoing payloads. | → shield.js |
| ledger.js | /public/js/ledger.js | Tier 1 scoring (Gate 1, new): loads ledger.json, deterministic pattern scoring over masked text (phrase signals + corroborating structure signals), threshold bands strong/escalate/weak/none. | → data/ledger.json, shield.js |
| ledger.json | /public/data/ledger.json | Local pattern ledger: 64 patterns (fraud KR 13, fraud CA/US/common 35, contract clauses 10, medical/insurance 6), all fictional example phrases based on publicly known methods. Expanded 41 → 53 by the real-case 100-case battery (2026-11-19), then 53 → 64 by the research department candidate verification — 11 new patterns + QR signal reinforcement, 48/48 new cases defended, regression 100/100, Gate 1 55/55, determinism identical (2026-11-19). | → ledger.js |
| shield.js | /public/js/shield.js | Tier 1–3 judgement pipeline (Gate 1, new): mask → Nano confirm → ledger score → local verdict / de-identification-gated cloud escalation of the skeleton only / honest abstention with reason codes. Cloud call and Nano confirmation are injected. | → pii-mask.js, ledger.js, config.js, main.js |
| store.js | /public/js/store.js | Local history (Gate 1, new): IndexedDB `ondevice-first-shield`, masked analysis records only — originals and token values are never stored; user-wipeable. | → main.js |
| scenarios.json | /public/data/scenarios.json | Demo + battery scenarios A–D (all fictional data) with the expected-verdict table. | → main.js, tests/battery.mjs |
| battery.mjs | /../tests/battery.mjs | Node verification battery (plan §9): masking corpus, rescan gate, scenario expectations, de-id uncertainty gate, degradation, input guards, determinism ×5. Imports the real modules. | → js/pii-mask.js, js/ledger.js, js/shield.js, data/ledger.json, data/scenarios.json |
| battery100.mjs | /../tests/battery100.mjs | Real-case-pattern battery (2026-11-19): 100 fraud cases reproduced from public scam typologies (CAFC / police advisories) + 20 legitimate cases, all fictional data. Standard: fraud defended 100/100, false-safe 0, legit falsely blocked 0; `det` mode re-runs all 120 cases ×5 for determinism. Case file: /../battery100_cases.json. | → js/shield.js, data/ledger.json, battery100_cases.json |
| README.md | /README.md | Public repository front page: what this is, architecture, setup, contest notes. | → AKASHIC_TABLE.md |
| LICENSE | /LICENSE | MIT license (public-repository requirement). | → README.md |
| AKASHIC_TABLE.md | /AKASHIC_TABLE.md | This record table. | → all rows above |

## Records to append after Gate 1

- Firebase project fixed: nexus-2e23d; dedicated web app "Hybrid Shield"
  registered in the console and its real public config injected into
  config.js (2026-11-19, commit 737a0c1). Live deployment: GitHub Pages —
  repository woojuhanul-ops/ondevice-first, site verified live
  (https://woojuhanul-ops.github.io/ondevice-first/). Firebase Hosting
  site id remains a placeholder; Hosting is not used for the live build.
- Gate 2 verification results: real Chrome on-device run, real cloud
  escalation run, App Check state in the deployed build. (Pending.)
