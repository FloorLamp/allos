// Form drafts (issue #1699) — the browser-only IndexedDB glue over the shared
// `allos-offline` database. The pure shapes, key derivation and offer/persist rules
// live in lib/offline/drafts.ts (unit-tested); the React binding is
// components/useFormDraft.ts. This file is exercised by the Playwright e2e tier
// (form-drafts.spec.ts) the same way lib/offline/queue-db.ts is — there is no
// IndexedDB in the pure or DB suites.
//
// Every call is best-effort: a browser without IndexedDB (private mode, embedded
// webview) simply gets no draft net, never an error in a form's path.

import {
  DRAFTS_STORE,
  hasIndexedDB,
  openOfflineDb,
  txDone,
} from "@/lib/offline/idb";
import { DRAFT_TTL_MS, type FormDraft } from "@/lib/offline/drafts";

function store(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(DRAFTS_STORE, mode).objectStore(DRAFTS_STORE);
}

/** Write (overwrite) one form's draft. */
export async function putDraft(draft: FormDraft): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const db = await openOfflineDb();
    const s = store(db, "readwrite");
    s.put(draft);
    await txDone(s.transaction);
    db.close();
  } catch {
    /* ignore — no draft net this keystroke; the form itself is unaffected */
  }
}

/**
 * Read one form's draft by key. An expired draft is deleted and reported as absent,
 * so a forgotten draft can never resurface weeks later.
 */
export async function getDraft(
  key: string,
  now: number
): Promise<FormDraft | null> {
  if (!hasIndexedDB()) return null;
  try {
    const db = await openOfflineDb();
    const s = store(db, "readonly");
    const row: FormDraft | undefined = await new Promise((resolve, reject) => {
      const req = s.get(key);
      req.onsuccess = () => resolve(req.result as FormDraft | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!row) return null;
    if (now - row.savedAt >= DRAFT_TTL_MS) {
      await deleteDraft(key);
      return null;
    }
    return row;
  } catch {
    return null;
  }
}

/** Drop one form's draft — on successful submit, or on explicit discard. */
export async function deleteDraft(key: string): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const db = await openOfflineDb();
    const s = store(db, "readwrite");
    s.delete(key);
    await txDone(s.transaction);
    db.close();
  } catch {
    /* ignore — an undeleted draft expires on its own */
  }
}

/**
 * Sweep every expired draft. Called once when the draft machinery first mounts, so
 * the TTL is enforced even for forms the user never reopens.
 */
export async function purgeExpiredDrafts(now: number): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const db = await openOfflineDb();
    const s = store(db, "readwrite");
    const rows: FormDraft[] = await new Promise((resolve, reject) => {
      const req = s.getAll();
      req.onsuccess = () => resolve((req.result as FormDraft[]) ?? []);
      req.onerror = () => reject(req.error);
    });
    for (const row of rows) {
      if (now - row.savedAt >= DRAFT_TTL_MS) s.delete(row.key);
    }
    await txDone(s.transaction);
    db.close();
  } catch {
    /* ignore */
  }
}

/**
 * Wipe EVERY draft. Logout only: drafts are PHI at rest on a possibly shared
 * device, and the next login must never be offered the previous one's half-typed
 * workout. A profile SWITCH deliberately does not clear — drafts are keyed per
 * profile, so switching simply stops finding them, and switching back still
 * resumes.
 */
export async function clearDrafts(): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const db = await openOfflineDb();
    const s = store(db, "readwrite");
    s.clear();
    await txDone(s.transaction);
    db.close();
  } catch {
    /* ignore */
  }
}
