// ---------------------------------------------------------------------------
// Local analysis history — IndexedDB (plan §7.2).
//
// Database: ondevice-first-shield / store: analyses.
//
// Stored per analysis: timestamp, the MASKED text, token type counts, the
// verdict (route, severity, pattern ids, structure axes), the escalation
// reason, and measured stage timings.
// NEVER stored: the original text, token original values, or anything that
// leaves this device. There is no sync. The user can wipe the whole store
// from the UI ("Delete all local history").
// ---------------------------------------------------------------------------

const DB_NAME = "ondevice-first-shield";
const STORE_NAME = "analyses";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, run) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const req = run(store);
    transaction.oncomplete = () => resolve(req ? req.result : undefined);
    transaction.onerror = () => reject(transaction.error);
  });
}

// Accepts the shield report object; picks out only the storable fields so
// an original text can never ride along by accident.
export async function saveAnalysis(report) {
  const record = {
    ts: Date.now(),
    maskedText: report.maskedText,
    isolation: report.isolation,
    verdict: report.verdict,
    route: report.route,
    severity: report.severity,
    patternIds: (report.matched || []).map((m) => m.id),
    bonesHit: report.bonesHit || [],
    clauseRisks: report.clauseRisks || [],
    escalationReason: report.escalationReason,
    abstainCode: report.abstainCode,
    timings: report.timings,
  };
  const db = await openDb();
  try {
    return await tx(db, "readwrite", (store) => store.add(record));
  } finally {
    db.close();
  }
}

export async function listAnalyses(limit = 20) {
  const db = await openDb();
  try {
    const all = await tx(db, "readonly", (store) => store.getAll());
    return (all || []).sort((a, b) => b.ts - a.ts).slice(0, limit);
  } finally {
    db.close();
  }
}

export async function countAnalyses() {
  const db = await openDb();
  try {
    return await tx(db, "readonly", (store) => store.count());
  } finally {
    db.close();
  }
}

export async function clearAnalyses() {
  const db = await openDb();
  try {
    await tx(db, "readwrite", (store) => store.clear());
  } finally {
    db.close();
  }
}
