import { DB_NAME, DB_VERSION, STORE, DEFAULT_SETTINGS } from "./constants.js";

let dbPromise;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE.SESSIONS)) {
        const store = db.createObjectStore(STORE.SESSIONS, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE.CHUNKS)) {
        const store = db.createObjectStore(STORE.CHUNKS, { keyPath: "id" });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("sessionSeq", ["sessionId", "seq"], { unique: true });
      }
      if (!db.objectStoreNames.contains(STORE.EVENTS)) {
        const store = db.createObjectStore(STORE.EVENTS, { keyPath: "id" });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("sessionTime", ["sessionId", "tMs"], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE.SETTINGS)) {
        db.createObjectStore(STORE.SETTINGS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE.LOGS)) {
        const store = db.createObjectStore(STORE.LOGS, { keyPath: "id", autoIncrement: true });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const result = fn(store);
    transaction.oncomplete = () => resolve(result?.result ?? result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function putSession(session) {
  return tx(STORE.SESSIONS, "readwrite", (store) => store.put(session));
}

export async function getSession(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE.SESSIONS, "readonly");
    const req = transaction.objectStore(STORE.SESSIONS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function listSessions(limit = 50) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE.SESSIONS, "readonly");
    const index = transaction.objectStore(STORE.SESSIONS).index("updatedAt");
    const req = index.openCursor(null, "prev");
    const rows = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || rows.length >= limit) {
        resolve(rows);
        return;
      }
      rows.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function putChunk(chunk) {
  return tx(STORE.CHUNKS, "readwrite", (store) => store.put(chunk));
}

export async function listChunks(sessionId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE.CHUNKS, "readonly");
    const index = transaction.objectStore(STORE.CHUNKS).index("sessionSeq");
    const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
    const req = index.openCursor(range, "next");
    const chunks = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(chunks);
        return;
      }
      chunks.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function putEvent(event) {
  return tx(STORE.EVENTS, "readwrite", (store) => store.put(event));
}

export async function listEvents(sessionId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE.EVENTS, "readonly");
    const index = transaction.objectStore(STORE.EVENTS).index("sessionTime");
    const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
    const req = index.openCursor(range, "next");
    const events = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(events);
        return;
      }
      events.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function log(kind, payload) {
  const row = { kind, payload, createdAt: Date.now() };
  return tx(STORE.LOGS, "readwrite", (store) => store.add(row));
}

export async function listLogs(limit = 200) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE.LOGS, "readonly");
    const index = transaction.objectStore(STORE.LOGS).index("createdAt");
    const req = index.openCursor(null, "prev");
    const rows = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || rows.length >= limit) {
        resolve(rows);
        return;
      }
      rows.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getSettings() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE.SETTINGS, "readonly");
    const req = transaction.objectStore(STORE.SETTINGS).get("default");
    req.onsuccess = () => resolve({ ...DEFAULT_SETTINGS, ...(req.result?.value || {}) });
    req.onerror = () => reject(req.error);
  });
}

export async function setSettings(value) {
  return tx(STORE.SETTINGS, "readwrite", (store) =>
    store.put({ id: "default", value, updatedAt: Date.now() })
  );
}

export async function getSessionMediaBlob(sessionId) {
  const chunks = await listChunks(sessionId);
  if (!chunks.length) return null;
  return new Blob(chunks.map((chunk) => chunk.blob), { type: chunks[0].mimeType || "video/webm" });
}
