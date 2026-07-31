// The ONE opener for the browser-local `allos-offline` database.
//
// Two features store PHI on the device — the offline write queue (#28/#475) and the
// form drafts (#1699) — and they deliberately share one database: one PHI
// perimeter, one logout wipe, one quota story, one place to look. That only works if
// there is a single version number and a single upgrade path: two modules opening
// the same database at different versions is a `VersionError` waiting for whichever
// one opens second. So both go through here.
//
// Everything is guarded so it degrades to a no-op where IndexedDB is unavailable
// (SSR, private mode, older/embedded webviews): the app stays fully functional, it
// just can't persist a queue or a draft. Browser-only glue — exercised by the
// Playwright e2e tier, not the pure suite.

export const OFFLINE_DB_NAME = "allos-offline";

// v1 the intents store, v2 the REJECTED dead-letter store (#475), v3 the DRAFTS
// store (#1699). Append-only: a released version's stores are never renamed.
export const OFFLINE_DB_VERSION = 3;

export const INTENTS_STORE = "intents";
export const REJECTED_STORE = "rejected";
export const DRAFTS_STORE = "drafts";

export function hasIndexedDB(): boolean {
  return typeof indexedDB !== "undefined";
}

/**
 * Open (creating/upgrading on first use) the offline database. Rejections are
 * swallowed by callers so a blocked or failed open never breaks a submit.
 */
export function openOfflineDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(INTENTS_STORE)) {
        db.createObjectStore(INTENTS_STORE, { keyPath: "key" });
      }
      // Keyed by the wrapped intent's idempotency key so re-parking the same key is
      // an overwrite, not a duplicate.
      if (!db.objectStoreNames.contains(REJECTED_STORE)) {
        db.createObjectStore(REJECTED_STORE, { keyPath: "intent.key" });
      }
      // Keyed by `draftKey()` (profile + form + record) so autosaving a form is an
      // overwrite of its own draft and nothing else.
      if (!db.objectStoreNames.contains(DRAFTS_STORE)) {
        db.createObjectStore(DRAFTS_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Resolve when a transaction completes; reject on error/abort. */
export function txDone(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
