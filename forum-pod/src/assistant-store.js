const DB_NAME = "forum-civic-ai-assistant";
const DB_VERSION = 1;
const CONVERSATIONS = "conversations";

let dbPromise;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function conversationId(webId, topic = "default") {
  return `${webId || "local"}::${topic || "default"}`;
}

function openAssistantStore() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CONVERSATIONS)) {
        const store = db.createObjectStore(CONVERSATIONS, { keyPath: "id" });
        store.createIndex("webId", "webId", { unique: false });
        store.createIndex("updated_at", "updated_at", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function withConversationStore(mode, fn) {
  const db = await openAssistantStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONVERSATIONS, mode);
    const store = tx.objectStore(CONVERSATIONS);
    const result = fn(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function loadAssistantConversation(webId, topic = "default") {
  const id = conversationId(webId, topic);
  const db = await openAssistantStore();
  const tx = db.transaction(CONVERSATIONS, "readonly");
  const row = await requestToPromise(tx.objectStore(CONVERSATIONS).get(id));
  return row?.messages || [];
}

export async function saveAssistantConversation(webId, messages, topic = "default") {
  const now = new Date().toISOString();
  const id = conversationId(webId, topic);
  await withConversationStore("readwrite", (store) => {
    store.put({
      id,
      webId: webId || "local",
      topic: topic || "default",
      messages: Array.isArray(messages) ? messages : [],
      updated_at: now,
    });
  });
}

export async function clearAssistantConversation(webId, topic = "default") {
  const id = conversationId(webId, topic);
  await withConversationStore("readwrite", (store) => {
    store.delete(id);
  });
}

export async function clearAllAssistantConversations() {
  await withConversationStore("readwrite", (store) => {
    store.clear();
  });
}
