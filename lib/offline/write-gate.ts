// THE DEVICE-LOCAL PHI WRITE GATE (#2908, and #28/#475/#1699 with it).
//
// Three rounds of review decided this PR on one shape of mistake, and it is worth
// stating before the code, because the code is only correct if the shape is:
//
//   THE GUARD WAS TRUE OF ITS OWN FUNCTION AND FALSE OF THE SYSTEM.
//
// A React `cancelled` flag was true about unmounting and false about wipes. An in-memory
// generation was true about one refresh's flight and false about the refresh that
// started after the wipe. A module-level `closed` was true about the document that
// pressed Log out and false about the second tab. Each fix was correct and each was
// scoped narrower than the property, so the next round found the next wipe or the next
// document. Patching a fourth instance would find a fifth.
//
// So the gate lives WHERE THE DATA LIVES — in the same IndexedDB the writes land in —
// and is checked INSIDE THE WRITE'S OWN TRANSACTION. That closes the whole class:
//
//   • it crosses documents, because tabs share one database (a module variable is the
//     one thing that cannot);
//   • it crosses wipes, because a wipe writes the gate in the same transaction that
//     clears the data, so there is no instant where one has landed and the other has not;
//   • it cannot be read-then-violated, because IndexedDB transactions are atomic: the
//     check and the put are the same transaction, so nothing can interleave between them.
//
// WHAT IT GATES, and why the lanes are separate. Logout ends every device-local write:
// the queue, the dead-letter entries, the drafts and the snapshots are all one login's
// PHI (#28/#475/#1699/#2908 share one perimeter and one wipe). The offline-reads OFF
// SWITCH is narrower — it must stop snapshots and must NOT stop the write queue, which
// is a different feature with a different promise.
//
// WHAT IT DOES NOT GATE: reads. `/offline` renders with no session and must keep doing
// so, and a read cannot leak what a wipe already removed.

import {
  META_STORE,
  hasIndexedDB,
  openOfflineDb as openDb,
  txDone as done,
} from "@/lib/offline/idb";

export const GATE_KEY = "device-writes";

// The lanes a write belongs to. Not a free string: a new device-local store has to say
// which promise governs it.
export type WriteLane = "snapshots" | "queue" | "drafts";

export interface WriteGate {
  key: string;
  // Bumped by every wipe. A writer captures it before its background work and the write
  // transaction refuses a stale one — that is the in-flight half, and it is what covers
  // a PROFILE SWITCH, which wipes so the next profile can be captured and therefore must
  // not close anything.
  generation: number;
  // Logout. Closes every lane until a DIFFERENT session opens it again — `different` is
  // the load-bearing word, and `sessionKey` below is why.
  sessionClosed: boolean;
  // WHICH SESSION the gate stands for: the one it is open for, or — once closed — the one
  // that closed it. `null` on a device that has never seen one.
  //
  // This is the fourth scope the same mistake was found at, and it is the last one
  // available. Putting the gate in the database was necessary and not sufficient, because
  // `openSession` re-opened it on any MOUNT: every tab open at logout is still mounted,
  // still authenticated (the session outlives the logout POST), and about to run its own
  // mount effect. Tab B's mount handed the close straight back and wrote all five
  // snapshots into the store tab A had just cleared — reproduced by CI against the very
  // test written for it. A tab that merely LOADS during the logout window does it with no
  // race at all.
  //
  // A mount cannot tell "there is a session" from "there is a NEW session", and only the
  // second may re-open. A session's own name can, so the gate remembers it.
  sessionKey: string | null;
  // WHEN the session was closed, epoch ms. The close is a bet that the logout will land,
  // and `closedAt` is how the bet is settled when the closer is not around to settle it —
  // see LOGOUT_SETTLE_MS and `openSessionAs`. 0 on a gate that has never been closed.
  closedAt: number;
  // The offline-reads off switch. Closes the snapshots lane for as long as the SERVER has
  // not been told, and no longer — see `closeSnapshots` for why that scope is the whole
  // of it. The server stays authoritative: its own `enabled: false` answer wipes.
  snapshotsClosed: boolean;
}

// How long after a logout close a document of the SAME session is still assumed to be
// racing that logout rather than surviving it. See `openSessionAs`, which is the only
// reader; the number is a bound on an ambiguity that has no clock-free resolution, and
// the comment there is the argument for why a bound is what is left.
export const LOGOUT_SETTLE_MS = 30_000;

export function defaultGate(): WriteGate {
  return {
    key: GATE_KEY,
    generation: 0,
    sessionClosed: false,
    sessionKey: null,
    closedAt: 0,
    snapshotsClosed: false,
  };
}

function parseGate(value: unknown): WriteGate {
  if (!value || typeof value !== "object") return defaultGate();
  const o = value as Partial<WriteGate>;
  return {
    key: GATE_KEY,
    generation: typeof o.generation === "number" ? o.generation : 0,
    sessionClosed: o.sessionClosed === true,
    // An absent key reads as null, which matches no session, so the next mount re-opens.
    // Same for an absent `closedAt`: 0 reads as "closed long ago", which also re-opens.
    // Both fail TOWARD a usable device, and that direction was attacked and ruled on
    // rather than assumed, so the reasoning is here for whoever makes this branch
    // reachable:
    //
    //   • It is unreachable today. The META_STORE these rows live in is new at
    //     OFFLINE_DB_VERSION 5; main is at 3. No released build has ever written a gate
    //     record, so there is no field-less row in the world to read.
    //   • The alternative is worse, and we know exactly how much worse, because we
    //     shipped it: treating "I cannot tell whose close this was" as permanently closed
    //     is the same brick as a failed logout (see `openSessionAs`) — the queue stops
    //     capturing, the drafts stop saving, the snapshots stop refreshing, and nothing
    //     on the device says why or ever recovers.
    //   • The exposure it buys is bounded. A build old enough to have written a row
    //     without these fields is a build without this file, so it has no tab running the
    //     code that would exploit the re-open.
    //
    // If a future change makes an old row readable — a downgrade path, an export/import,
    // a repair tool — this is the sentence that has to be re-decided, not silently kept.
    sessionKey: typeof o.sessionKey === "string" ? o.sessionKey : null,
    closedAt: typeof o.closedAt === "number" ? o.closedAt : 0,
    snapshotsClosed: o.snapshotsClosed === true,
  };
}

/** Whether a write on `lane`, captured at `token`, may land. Pure — the tested part. */
export function gateAllows(
  gate: WriteGate,
  lane: WriteLane,
  token: number
): boolean {
  if (gate.sessionClosed) return false;
  if (lane === "snapshots" && gate.snapshotsClosed) return false;
  return gate.generation === token;
}

function readGate(store: IDBObjectStore): Promise<WriteGate> {
  return new Promise((resolve, reject) => {
    const req = store.get(GATE_KEY);
    req.onsuccess = () => resolve(parseGate(req.result));
    req.onerror = () => reject(req.error);
  });
}

/**
 * The generation a background task must carry to be allowed to write when it finishes.
 * Captured BEFORE the work (the fetch, the debounce, the flush round trip).
 *
 * Answers -1 where there is no IndexedDB, which no gate can equal, so a device with no
 * storage degrades to writing nothing rather than to writing unguarded.
 */
export async function captureWriteToken(): Promise<number> {
  if (!hasIndexedDB()) return -1;
  try {
    const db = await openDb();
    const gate = await readGate(
      db.transaction(META_STORE, "readonly").objectStore(META_STORE)
    );
    db.close();
    return gate.generation;
  } catch {
    return -1;
  }
}

/**
 * THE ONE WRITER. Runs `work` against `stores` only if the gate still allows `lane` at
 * `token` — checked in the SAME transaction, so no wipe can interleave between the
 * check and the put. Answers whether it actually wrote.
 */
export async function guardedWrite(
  stores: readonly string[],
  lane: WriteLane,
  token: number,
  work: (tx: IDBTransaction) => void
): Promise<boolean> {
  if (!hasIndexedDB()) return false;
  try {
    const db = await openDb();
    const tx = db.transaction([META_STORE, ...stores], "readwrite");
    const gate = await readGate(tx.objectStore(META_STORE));
    if (!gateAllows(gate, lane, token)) {
      tx.abort();
      db.close();
      return false;
    }
    work(tx);
    await done(tx);
    db.close();
    return true;
  } catch {
    // A quota failure, a blocked open, or our own abort — the device simply does not
    // keep this copy, which is every caller's existing degraded path.
    return false;
  }
}

/**
 * A FOREGROUND write: one the person is making right now, with nothing between the
 * decision and the write for a wipe to slip into. `enqueueIntent` and a draft autosave
 * are both this — by the time they run, the tap has happened and the debounce has already
 * elapsed, so the generation they would capture is the generation they would spend.
 *
 * Same guarantee, half the work. `guardedWrite` needs a token because its caller did
 * something slow first, and taking one costs a second database open and a second
 * transaction on top of the write's own — which is the entire reason a gated draft
 * autosave got materially slower than the plain put it replaced. Here the gate is read
 * inside the write's own transaction and only the CLOSES are asked about, because a
 * generation comparison against a generation read one line earlier answers nothing.
 *
 * The closes are what matter on this path anyway: a logged-out device must not accept new
 * PHI just because a stale tab still has a button, and `sessionClosed` says so atomically.
 */
export async function guardedWriteNow(
  stores: readonly string[],
  lane: WriteLane,
  work: (tx: IDBTransaction) => void
): Promise<boolean> {
  if (!hasIndexedDB()) return false;
  try {
    const db = await openDb();
    const tx = db.transaction([META_STORE, ...stores], "readwrite");
    const gate = await readGate(tx.objectStore(META_STORE));
    if (!gateAllows(gate, lane, gate.generation)) {
      tx.abort();
      db.close();
      return false;
    }
    work(tx);
    await done(tx);
    db.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Mutate the gate, and optionally clear stores in the SAME transaction. Wipes go through
 * here so the data and the gate can never disagree: there is no instant at which the
 * store is empty and the gate still says "writable at the old generation".
 */
export async function updateGate(
  change: (gate: WriteGate) => WriteGate,
  clearStores: readonly string[] = []
): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const db = await openDb();
    const tx = db.transaction([META_STORE, ...clearStores], "readwrite");
    const gate = await readGate(tx.objectStore(META_STORE));
    for (const name of clearStores) tx.objectStore(name).clear();
    tx.objectStore(META_STORE).put(change(gate));
    await done(tx);
    db.close();
  } catch {
    /* ignore — the caller's own degraded path applies */
  }
}

/** Bump only: an identity wipe that must still allow re-capture (the profile switch). */
export function bumpGeneration(gate: WriteGate): WriteGate {
  return { ...gate, generation: gate.generation + 1 };
}

/**
 * Logout: every lane closed until a DIFFERENT session opens them — or until this one is
 * shown to have outlived the logout that closed it. `now` is stamped so the second half
 * is possible at all.
 *
 * `sessionKey` is deliberately left as it stands rather than cleared — it is now the
 * record of WHICH session closed the gate, and that is the whole defence against the
 * session's own surviving tabs re-opening it.
 */
export function closeSession(now: number): (gate: WriteGate) => WriteGate {
  return (gate) => ({
    ...bumpGeneration(gate),
    sessionClosed: true,
    closedAt: now,
  });
}

/**
 * THE CLOSE IS A BET ON A LOGOUT THAT HAS NOT HAPPENED YET, and this undoes it when the
 * bet is lost.
 *
 * components/SidebarContent wipes and closes, and only THEN submits the logout. If that
 * POST never lands — no signal, a 5xx during a deploy — the session is still alive and
 * the gate is closed for it, which used to be permanent: `openSessionAs` refuses the
 * session that closed it, and only a successful logout followed by a new login changes
 * `sessionKey`. The whole device-local write perimeter stopped: the #28 write queue
 * stopped capturing while the app still said "saved offline — will sync when you
 * reconnect", drafts stopped saving, snapshots stopped refreshing. That is a shipped
 * feature going silently dead on a path the error boundary explicitly invites ("Reload
 * the app").
 *
 * Only the CLOSER calls this, and only once its own logout has provably failed, so it
 * cannot be reached by the tab that R2/R2b are about: that tab never pressed anything and
 * has no failure to observe. It does not touch `sessionKey` — the session is unchanged,
 * and the close simply never should have been made.
 */
export function reopenAfterFailedLogout(gate: WriteGate): WriteGate {
  return { ...gate, sessionClosed: false, closedAt: 0 };
}

/**
 * A live authenticated document says which session it belongs to, and the gate re-opens
 * only if that is not the session that closed it — or if that session has outlasted its
 * own logout by long enough that it plainly did not log out.
 *
 * The key half is the finding from three rounds ago, so read it as one: `key ===
 * gate.sessionKey` on a closed gate means "a document of the logged-out session is
 * asking", which is every tab that was open when someone pressed Log out and every tab
 * that loads while the logout POST is still in flight. Those must stay closed. Anything
 * else is a session that did not exist when the close happened — a fresh login, on this
 * device, by whoever is holding it now — and that is what re-opening is for.
 *
 * THE `now` HALF IS THE LIVENESS QUESTION, and it is a bound because the question has no
 * clock-free answer. At the instant a same-key document mounts, "the logout is in flight
 * and will succeed" (R2b — must refuse) and "the logout failed and this is the reload"
 * (R-A — must re-open) are the same observation: the session row still exists in both,
 * so the server cannot tell them apart either, and being served the authenticated app
 * proves only that the logout has not landed YET. The outcome is knowable only after the
 * POST settles, and only to the document that issued it — which is why
 * `reopenAfterFailedLogout` above is the primary path and handles every case where that
 * document is still alive to see the failure.
 *
 * What is left is the case where that document was DESTROYED mid-POST (the tab was
 * closed, the app was force-quit). A form-action POST dies with its document, so in that
 * case the logout was cancelled and can never land — re-opening is not merely safe, it is
 * the only correct answer. The bound is how a later document recognises that case: a
 * logout POST that is still outstanding is being awaited by a document that is still
 * alive, and no such document waits half a minute without its own failure path running.
 */
export function openSessionAs(
  key: string,
  now: number
): (gate: WriteGate) => WriteGate {
  return (gate) => {
    // `now - closedAt` rather than a comparison against a stored deadline: a device clock
    // that jumped BACKWARDS makes this negative, which is inside the window, so it
    // refuses — the closed direction, which is the safe one to be wrong in.
    const racingItsOwnLogout =
      gate.sessionKey === key && now - gate.closedAt < LOGOUT_SETTLE_MS;
    if (gate.sessionClosed && racingItsOwnLogout) return gate;
    return { ...gate, sessionClosed: false, sessionKey: key, closedAt: 0 };
  };
}

// ── THE RE-OPEN AND THE FIRST WRITE, IN THAT ORDER ───────────────────────────
//
// Two mount-scoped effects in one document: OfflineQueueProvider re-opens the gate, and
// its child OfflineSnapshotRefresher schedules the first refresh. React runs child
// effects first, so the refresh is scheduled before the re-open is even asked for, and a
// refresh that asks `snapshotWritesClosed()` before the re-open lands gives up — leaving
// a freshly logged-in device with no offline copy until something happens to trigger
// another refresh. Not a leak; a feature that silently does nothing, which is how this
// one keeps failing.
//
// This IS module state, which the same file spends its header arguing against, so the
// distinction matters: the gate itself is a security decision and lives in the database
// because it must cross documents. This is a sequencing handle between two components of
// the SAME document, and it can only ever make a writer wait for its own document's
// re-open. It decides nothing about whether a write is allowed — `guardedWrite` still
// does that, in its own transaction, having never heard of this.
let reopened: Promise<void> = Promise.resolve();

/** The mount-scoped re-open. Records the attempt so a writer can wait for it. */
export function openSessionForDocument(key: string): Promise<void> {
  reopened = updateGate(openSessionAs(key, Date.now()));
  return reopened;
}

/**
 * The closer's own undo, for a logout that did not land. See `reopenAfterFailedLogout`.
 * Recorded on the same handle as the mount re-open, so a writer that is waiting for this
 * document's gate decision waits for this one too.
 */
export function reopenForFailedLogout(): Promise<void> {
  reopened = updateGate(reopenAfterFailedLogout);
  return reopened;
}

/** Resolves once this document's re-open has landed (or immediately, if there was none). */
export function whenSessionOpened(): Promise<void> {
  return reopened;
}

/**
 * The offline-reads off switch — and it closes only the gap it exists to cover, which is
 * the SECOND FINDING of the same shape as the logout one.
 *
 * Why it exists at all: untick the box and a Server Action starts. Until it lands the
 * server still answers `enabled: true`, so a refresh beginning anywhere in that window
 * reads an empty store, asks for all five kinds, and is told yes — every payload back.
 * The wipe alone cannot stop that; this close can, and it is persisted so it also holds
 * across a reload and across a second tab.
 *
 * Why it must NOT outlive that window: it was persisted with no path back except this
 * device's own toggle being ticked ON again, which made it a one-way latch. A device that
 * turned offline reads off could never learn the server had been told YES again — the
 * refresher asks the gate before it asks the server, so a latched device never hears the
 * answer that would release it. The checkbox is server-driven, so it rendered ON while
 * the device held nothing, forever. That is "a silent, permanent death of offline reads",
 * which is the exact property R2c pins for the logout direction and nothing pinned here.
 *
 * So the latch is scoped to the flight of the Server Action that makes it redundant, and
 * `openSnapshots` releases it when that action settles. After that the SERVER is the off
 * switch: it answers `enabled: false` to every refresh, and the refresher wipes on that
 * answer without re-latching, so nothing re-materialises and nothing is stranded.
 */
export function closeSnapshots(gate: WriteGate): WriteGate {
  return { ...bumpGeneration(gate), snapshotsClosed: true };
}

/**
 * Releasing the latch above. Two callers, one transition: the toggle turning offline
 * reads back ON, and the toggle's own `finally` once the server has been told OFF and no
 * longer needs this device to remember it.
 */
export function openSnapshots(gate: WriteGate): WriteGate {
  return { ...gate, snapshotsClosed: false };
}

/** Read the gate as it stands. For tests and for the refresher's pre-fetch check. */
export async function currentGate(): Promise<WriteGate> {
  if (!hasIndexedDB()) return defaultGate();
  try {
    const db = await openDb();
    const gate = await readGate(
      db.transaction(META_STORE, "readonly").objectStore(META_STORE)
    );
    db.close();
    return gate;
  } catch {
    return defaultGate();
  }
}
