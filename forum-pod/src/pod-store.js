const DB_NAME = "forum-personal-pod";
const DB_VERSION = 3;
const SUBMISSIONS = "civic_submissions";
const RAW_SUBMISSIONS = "raw_submissions";
const BEHAVIORAL = "behavioral_data";
const PSYCHOGRAPHIC = "psychographic_data";

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let dbPromise;

export function openPodStore() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SUBMISSIONS)) {
        const store = db.createObjectStore(SUBMISSIONS, { keyPath: "receipt_id" });
        store.createIndex("egress_status", "egress_status", { unique: false });
        store.createIndex("submitted_at", "submitted_at", { unique: false });
      }
      if (event.oldVersion < 2 && db.objectStoreNames.contains(SUBMISSIONS)) {
        /* v2: share_status, policy_version on rows — no index migration required */
      }
      if (event.oldVersion < 3) {
        if (!db.objectStoreNames.contains(RAW_SUBMISSIONS)) {
          const raw = db.createObjectStore(RAW_SUBMISSIONS, { keyPath: "submission_id" });
          raw.createIndex("submitted_at", "submitted_at", { unique: false });
          raw.createIndex("source_context", "source_context", { unique: false });
          raw.createIndex("lexicon_version", "lexicon_version", { unique: false });
        }
        if (!db.objectStoreNames.contains(BEHAVIORAL)) {
          const beh = db.createObjectStore(BEHAVIORAL, { keyPath: "behavior_id" });
          beh.createIndex("submission_id", "submission_id", { unique: false });
          beh.createIndex("category", "category", { unique: false });
          beh.createIndex("created_at", "created_at", { unique: false });
        }
        if (!db.objectStoreNames.contains(PSYCHOGRAPHIC)) {
          const psy = db.createObjectStore(PSYCHOGRAPHIC, { keyPath: "psycho_id" });
          psy.createIndex("submission_id", "submission_id", { unique: false });
          psy.createIndex("category", "category", { unique: false });
          psy.createIndex("attribute", "attribute", { unique: false });
          psy.createIndex("created_at", "created_at", { unique: false });
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

async function withStore(mode, fn) {
  const db = await openPodStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SUBMISSIONS, mode);
    const store = tx.objectStore(SUBMISSIONS);
    const result = fn(store);

    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getSubmissions() {
  const db = await openPodStore();
  const tx = db.transaction(SUBMISSIONS, "readonly");
  const rows = await requestToPromise(tx.objectStore(SUBMISSIONS).getAll());
  return rows.sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
}

export async function saveSubmission(row) {
  await withStore("readwrite", (store) => {
    store.put({
      sync_attempts: 0,
      last_error: null,
      ...row,
      updated_at: new Date().toISOString(),
    });
  });
}

export async function patchSubmission(receiptId, patch) {
  const db = await openPodStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SUBMISSIONS, "readwrite");
    const store = tx.objectStore(SUBMISSIONS);
    const getReq = store.get(receiptId);

    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) {
        reject(new Error(`Submission ${receiptId} not found`));
        return;
      }
      store.put({
        ...existing,
        ...patch,
        updated_at: new Date().toISOString(),
      });
    };

    getReq.onerror = () => reject(getReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getRetryableSubmissions() {
  const rows = await getSubmissions();
  return rows.filter((row) =>
    ["pending", "failed", "syncing"].includes(row.egress_status)
  );
}

export async function clearAllSubmissions() {
  await withStore("readwrite", (store) => {
    store.clear();
  });
}

/** Wipe every object store (session cache). Call on sign-out. */
export async function clearAllPodData() {
  const db = await openPodStore();
  const names = [SUBMISSIONS, RAW_SUBMISSIONS, BEHAVIORAL, PSYCHOGRAPHIC];
  await Promise.all(
    names.map(
      (name) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(name, "readwrite");
          tx.objectStore(name).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        })
    )
  );
  db.close();
  dbPromise = null;
}

// ---- Journal / insight tables ----

async function withStoreNamed(name, mode, fn) {
  const db = await openPodStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const store = tx.objectStore(name);
    const out = fn(store);
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function getAllFrom(name, sortKey = "submitted_at") {
  const db = await openPodStore();
  const tx = db.transaction(name, "readonly");
  const rows = await requestToPromise(tx.objectStore(name).getAll());
  return rows.sort((a, b) => String(b[sortKey] || "").localeCompare(String(a[sortKey] || "")));
}

export async function saveRawSubmission(row) {
  await withStoreNamed(RAW_SUBMISSIONS, "readwrite", (store) => {
    store.put({
      processing_status: "unprocessed",
      lexicon_version: null,
      ...row,
      updated_at: new Date().toISOString(),
    });
  });
}

export async function patchRawSubmission(submissionId, patch) {
  const db = await openPodStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RAW_SUBMISSIONS, "readwrite");
    const store = tx.objectStore(RAW_SUBMISSIONS);
    const getReq = store.get(submissionId);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) return reject(new Error(`raw_submissions ${submissionId} not found`));
      store.put({ ...existing, ...patch, updated_at: new Date().toISOString() });
    };
    getReq.onerror = () => reject(getReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getRawSubmissions() {
  return getAllFrom(RAW_SUBMISSIONS, "submitted_at");
}

export async function saveBehavior(row) {
  await withStoreNamed(BEHAVIORAL, "readwrite", (store) => {
    store.put({ ...row, created_at: row.created_at || new Date().toISOString() });
  });
}

export async function getBehaviors() {
  return getAllFrom(BEHAVIORAL, "created_at");
}

export async function deleteBehavior(behaviorId) {
  await withStoreNamed(BEHAVIORAL, "readwrite", (store) => {
    store.delete(behaviorId);
  });
}

export async function savePsychographic(row) {
  await withStoreNamed(PSYCHOGRAPHIC, "readwrite", (store) => {
    store.put({ ...row, created_at: row.created_at || new Date().toISOString() });
  });
}

export async function getPsychographics() {
  return getAllFrom(PSYCHOGRAPHIC, "created_at");
}

export async function deletePsychographic(psychoId) {
  await withStoreNamed(PSYCHOGRAPHIC, "readwrite", (store) => {
    store.delete(psychoId);
  });
}

export async function deleteInsightsForSubmission(submissionId) {
  const db = await openPodStore();
  await Promise.all([BEHAVIORAL, PSYCHOGRAPHIC].map((name) => new Promise((resolve, reject) => {
    const tx = db.transaction(name, "readwrite");
    const store = tx.objectStore(name);
    const idx = store.index("submission_id");
    const req = idx.openCursor(IDBKeyRange.only(submissionId));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      cur.delete();
      cur.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  })));
}
