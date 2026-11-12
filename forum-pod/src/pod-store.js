const DB_NAME = "forum-personal-pod";
const DB_VERSION = 3;
const SUBMISSIONS = "civic_submissions";

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
  const names = Array.from(db.objectStoreNames);
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
