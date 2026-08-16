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
import { guardedWriteNow } from "@/lib/offline/write-gate";

function store(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(DRAFTS_STORE, mode).objectStore(DRAFTS_STORE);
}

// ── ONE FORM'S DRAFT MUTATIONS RUN IN CALL ORDER ─────────────────────────────
//
// components/useFormDraft fires the two that matter WITHOUT AWAITING EITHER: the autosave
// debounce (and the unmount flush) call `putDraft`, and a successful save calls `clear()`
// → `deleteDraft`. Nothing makes the second land after the first, so the pair races on
// how long each takes. A put that overtakes its own delete leaves the draft on the device
// and the person is then offered "restore your unsaved work?" for work that saved
// perfectly well.
//
// PER KEY, and the scope is the point. The ordering the callers assume exists only within
// ONE draft — `putDraft(k)` then `deleteDraft(k)`, written in sequence in the same hook
// instance. Two different forms have no ordering relationship at all, so a single global
// chain made every form's draft write wait behind every other's, which is a real
// behaviour change well beyond the assumption it was making true. Keyed chains give the
// same guarantee exactly where the assumption lives and nowhere else.
//
// Reads stay off the chain entirely: a read reorders nothing, and putting them on it would
// make every draft lookup queue behind a write.
//
// HONESTLY STATED, because the previous round's note was not: this ordering was written to
// explain a CI red in e2e/stale-build-save.spec.ts, and that diagnosis is NOT established
// — see the block above `deleteDraft`. It is kept on the merits above, which stand
// whether or not it ever fixed that spec.
const chains = new Map<string, Promise<unknown>>();

function inOrder<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).then(work, work);
  // The chain has to survive a rejected link, or one failure strands every later write to
  // that draft behind it forever. Each caller still gets its own result.
  const tail = next.catch(() => undefined);
  chains.set(key, tail);
  // Drop the entry once this is the last link, so the map does not grow with every form
  // key the session ever touches.
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return next;
}

/**
 * Write (overwrite) one form's draft.
 *
 * GATED (#2908's write gate). The autosave that calls this is debounced by 600ms, so a
 * keystroke typed just before Log out lands AFTER the wipe — a half-typed record back on
 * a logged-out device, which is exactly what the contract further down this file forbids.
 *
 * `guardedWriteNow` rather than a captured token, and that is honest about what does the
 * work: by the time this runs the debounce has already elapsed, so a token captured here
 * would be spent on the next line and its generation comparison would answer nothing. It
 * is the gate's `sessionClosed` — set by logout, read inside this write's own transaction
 * — that refuses the write, and asking for it directly costs one database open instead of
 * two, which matters on the path a person is typing on.
 */
export function putDraft(draft: FormDraft): Promise<void> {
  return inOrder(draft.key, async () => {
    await guardedWriteNow([DRAFTS_STORE], "drafts", (tx) => {
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

// ── WHAT IS AND IS NOT KNOWN ABOUT THE CI RED THIS ORDERING WAS WRITTEN FOR ──
//
// The claim made when the chain landed was that it fixed `e2e/stale-build-save.spec.ts`,
// where a restored edit expected to have cleared its draft and found one left. THAT
// DIAGNOSIS IS NOT ESTABLISHED, and the evidence since is against its detail:
//
//   • 40 trials per tree under identical load put this branch at 1 failure / 39 passes
//     and origin/main at 40/40, so the branch DOES destabilise that spec — "both jobs
//     went green at the next head" was never evidence the cause had been found.
//   • But the failure that remains is a DIFFERENT assertion in the same test: the
//     restored form does not come back at all, rather than coming back with a leftover
//     draft. That is what a slower — or refused — draft flush before the self-reload
//     looks like, not a put overtaking its own delete.
//   • 32 counterfactual trials cannot tell "fixed" from "1-in-40"; at that rate they had
//     roughly even odds of seeing nothing either way.
//
// So this ordering is kept on its own merits (the block above `putDraft`), not on that
// story, and the cost that plausibly drives the remaining instability is addressed where
// it actually is: `putDraft` no longer takes a separate write token, which halves the
// database work a gated autosave does.
//
// MEASURED AFTER THAT CHANGE: 80 consecutive passes, one worker, box load 2.6–6.3. AND
// THAT DOES NOT SETTLE IT EITHER, which is the whole reason this block exists. At the
// 1-in-40 rate previously observed, 80 trials miss the failure about 13% of the time;
// 0/80 bounds the true rate at roughly 3.7% with 95% confidence, and 2.5% is inside that.
// Against the earlier 1/40 it is p≈0.33 — no evidence of a difference in either
// direction. A sample large enough to separate these hypotheses is not affordable here,
// so the claim being made is the narrow one: no failure has been reproduced since, the
// ordering earns its place on the reasoning above rather than on a fix it may never have
// been, and if the spec fails again the investigation should start from "the flush is too
// slow or is being refused", not from write ordering.

/** Drop one form's draft — on successful submit, or on explicit discard. */
export function deleteDraft(key: string): Promise<void> {
  return inOrder(key, () => deleteDraftNow(key));
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
 *
 * NOT on the ordering chain above, and it does not need to be: it reads the rows and
 * deletes the expired ones in ONE readwrite transaction, and IndexedDB will not
 * interleave another readwrite transaction over the same store with it. A draft written
 * while this runs therefore either predates the read (and is fresh, so it is not swept)
 * or lands after the whole sweep.
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
