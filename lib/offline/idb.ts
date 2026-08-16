// The ONE opener for the browser-local `allos-offline` database.
//
// Three features store PHI on the device — the offline write queue (#28/#475), the
// form drafts (#1699) and the offline read snapshots (#2908) — and they deliberately
// share one database: one PHI
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
// store (#1699), v4 the SNAPSHOTS store (#2908), v5 the META store holding the device
// WRITE GATE (#2908 again — lib/offline/write-gate.ts states why the gate has to live
// in the database rather than in a module variable). Append-only: a released version's
// stores are never renamed.
export const OFFLINE_DB_VERSION = 5;

export const INTENTS_STORE = "intents";
export const REJECTED_STORE = "rejected";
export const DRAFTS_STORE = "drafts";
export const SNAPSHOTS_STORE = "snapshots";
export const META_STORE = "meta";

export function hasIndexedDB(): boolean {
  return typeof indexedDB !== "undefined";
}

/**
 * Open (creating/upgrading on first use) the offline database. Rejections are
 * swallowed by callers so a blocked or failed open never breaks a submit.
 *
 * BLOCKED IS A REJECTION, NOT A WAIT (#2908). An upgrade — v3 → v4 is one, and it
 * ships to devices that have open tabs on the old build — cannot proceed while another
 * connection holds the database at the older version. IndexedDB reports that by firing
 * `blocked` and then simply SITTING: `error` never fires, so a promise with no
 * `onblocked` handler never settles at all. Every caller here awaits inside a
 * `try/catch` that can only catch a throw, so the hang propagated as a queue write that
 * never returned and an offline page that rendered nothing, forever, with no error
 * anywhere. That is strictly worse than the degraded-no-op path the whole module is
 * built on, and it is what the doc comment above always claimed happened. Now it does:
 * a blocked open rejects, the caller falls back to its no-op, and the next visit (by
 * which time the old tab is usually gone) upgrades cleanly.
 *
 * REJECTING IS NOT ABORTING, and the difference leaks a connection. `IDBOpenDBRequest`
 * has no abort: after `blocked` fires, the request is still live, and the moment the
 * old connection closes the upgrade completes and `onsuccess` fires — into a promise
 * that already settled. The resulting `IDBDatabase` would then be held open forever by
 * nothing, blocking the NEXT upgrade in exactly the way this handler exists to survive.
 * So the rejection is recorded, and a late success closes what it was handed.
 *
 * `onversionchange` is the other half, from the other side: it is how an OPEN
 * connection yields to a newer tab's upgrade instead of blocking it. Every connection
 * this opener hands out closes itself when a newer version asks.
 */
export function openOfflineDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    let settled = false;
    req.onblocked = () => {
      settled = true;
      reject(
        new Error(
          `${OFFLINE_DB_NAME}: upgrade to v${OFFLINE_DB_VERSION} blocked by an older open connection`
        )
      );
    };
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
      // Keyed by snapshot KIND, not by (profile, kind): the device holds the snapshots
      // of exactly ONE profile at a time — the one active at capture — because logout
      // and profile switch wipe the store outright (#2908, the #42 wipe shape). A
      // composite key would be a place for a second profile's payload to sit, which is
      // precisely the leak this feature has to be designed against.
      if (!db.objectStoreNames.contains(SNAPSHOTS_STORE)) {
        db.createObjectStore(SNAPSHOTS_STORE, { keyPath: "kind" });
      }
      // One record, the device write GATE. It is in THIS database rather than in a
      // module variable for the reason lib/offline/write-gate.ts opens with: a wipe and
      // the writes it must stop have to be settled by the same transaction, and tabs
      // share a database while they share no memory. Absent = the default open gate, so
      // an upgraded device is writable exactly as it was.
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Yield to a newer build's upgrade rather than blocking it. Callers close their
      // connection after each transaction, so this is the long-lived-tab case only.
      db.onversionchange = () => db.close();
      if (settled) {
        // The `blocked` rejection already answered the caller; the old connection has
        // since closed and the upgrade finished. Close this one or it is an orphan.
        db.close();
        return;
      }
      resolve(db);
    };
    req.onerror = () => {
      settled = true;
      reject(req.error);
    };
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
