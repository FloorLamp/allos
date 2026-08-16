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
import { captureWriteToken, guardedWrite } from "@/lib/offline/write-gate";

function store(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(DRAFTS_STORE, mode).objectStore(DRAFTS_STORE);
}

// ── DRAFT MUTATIONS RUN IN CALL ORDER ────────────────────────────────────────
//
// components/useFormDraft fires the two that matter WITHOUT AWAITING EITHER: the autosave
// debounce (and the unmount flush) call `putDraft`, and a successful save calls `clear()`
// → `deleteDraft`. Nothing made the second land after the first, so the pair raced on how
// long each took — and the write got substantially slower the moment it was gated: a
// token capture and a guarded transaction where there had been one plain put. A put that
// overtakes its own delete leaves the draft on the device, and the person is then offered
// "restore your unsaved work?" for work that saved perfectly well. #2471's reload spec
// caught precisely that on a loaded CI runner, against this branch.
//
// So the mutations share one chain and run in the order they were called. Ordering is
// what the callers already assume by writing them in sequence; this makes the assumption
// true rather than probable, and it stays true however slow a gated write becomes. Reads
// stay off the chain: a read reorders nothing, and putting them on it would make every
// draft lookup queue behind a write.
let mutations: Promise<unknown> = Promise.resolve();

function inOrder<T>(work: () => Promise<T>): Promise<T> {
  const next = mutations.then(work, work);
  // The chain has to survive a rejected link, or one failure strands every later draft
  // write behind it forever. Each caller still gets its own result.
  mutations = next.catch(() => undefined);
  return next;
}

/**
 * Write (overwrite) one form's draft.
 *
 * GATED (#2908's write gate). The autosave that calls this is debounced by 600ms, so a
 * keystroke typed just before Log out lands AFTER the wipe — a half-typed record back on
 * a logged-out device, which is exactly what the contract further down this file forbids.
 *
 * The token is captured here rather than by the caller, and that is honest about what
 * does the work: by the time this runs the debounce has already elapsed, so the token is
 * current and it is the gate's `sessionClosed` — set by logout, read inside this write's
 * own transaction — that refuses it. The token still covers the ordering it cannot skip:
 * a wipe landing between the capture and the transaction moves the generation, and the
 * write is refused for that reason instead.
 */
export function putDraft(draft: FormDraft): Promise<void> {
  return inOrder(async () => {
    const token = await captureWriteToken();
    await guardedWrite([DRAFTS_STORE], "drafts", token, (tx) => {
      tx.objectStore(DRAFTS_STORE).put(draft);
    });
  });
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
export function deleteDraft(key: string): Promise<void> {
  return inOrder(() => deleteDraftNow(key));
}

async function deleteDraftNow(key: string): Promise<void> {
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
export function purgeExpiredDrafts(now: number): Promise<void> {
  return inOrder(() => purgeExpiredDraftsNow(now));
}

async function purgeExpiredDraftsNow(now: number): Promise<void> {
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
