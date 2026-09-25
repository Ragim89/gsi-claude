/**
 * Minimal IndexedDB wrapper for the offline queue.
 *
 * Not localStorage on purpose: a photo is a Blob, and localStorage is both a synchronous
 * string store with a few MB of headroom and shared, unnamespaced storage — the wrong shape
 * for "hold binary field work until there's a signal".
 */

const DB_NAME = 'gsi-offline';
const DB_VERSION = 2;
export const STORE = 'queue';
/** Last-known-good server reads (checklist, etc.), keyed `${userId}:${...}` — a phone reopened
 * offline should show what it saw last, not an empty screen, while never showing it to the
 * next person who logs in on the same device (the key always starts with the owning userId). */
export const CACHE_STORE = 'reads';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('byUser', 'userId');
          store.createIndex('byUserStatus', ['userId', 'status']);
        }
        if (!db.objectStoreNames.contains(CACHE_STORE)) {
          db.createObjectStore(CACHE_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function put<T>(record: T): Promise<T> {
  return withStore('readwrite', (store) => store.put(record)).then(() => record);
}

export function remove(id: string): Promise<void> {
  return withStore('readwrite', (store) => store.delete(id)).then(() => undefined);
}

export async function allForUser<T>(userId: string): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const index = tx.objectStore(STORE).index('byUser');
    const req = index.getAll(IDBKeyRange.only(userId));
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheSet<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE_STORE, 'readwrite');
    const req = tx.objectStore(CACHE_STORE).put({ key, value, savedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE_STORE, 'readonly');
    const req = tx.objectStore(CACHE_STORE).get(key);
    req.onsuccess = () => resolve(req.result?.value as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

/** IndexedDB can throw synchronously (private browsing, disabled storage) — every caller treats it as "no offline support here" rather than a crash. */
export function isIndexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined';
  } catch {
    return false;
  }
}
