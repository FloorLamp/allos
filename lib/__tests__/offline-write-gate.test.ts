// THE DEVICE WRITE GATE's decision (#2908) — the pure half, and only the pure half.
//
// WHAT THIS FILE MAY AND MAY NOT ASSERT, because its predecessor got this wrong in a way
// worth recording. `offline-snapshot-fence.test.ts` asserted
// `expect(await putSnapshots(…)).toBe(false)` and called that the proof of the property
// that had shipped red. There is no `indexedDB` in the pure tier, so `putSnapshots`
// returned false for EVERY input, and every one of those assertions passed against any
// implementation — including two mutants of the exact claims under review (dropping the
// generation comparison from the writer, and moving the re-open onto the navigation
// effect that the comment said must never hold it). The predicate was covered; the
// wiring from predicate to writer, which is where every shipped bug actually lived, was
// not, and a test that cannot fail is worse than no test because it reads as coverage.
//
// So: this file tests `gateAllows` and the gate transitions — pure decisions that go red
// when mutated. Everything about whether a WRITE actually lands lives in
// e2e/offline-write-gate.spec.ts and e2e/offline-snapshots.spec.ts, against a real
// IndexedDB in a real browser, which is the only tier that can observe it.

import { describe, it, expect } from "vitest";
import {
  bumpGeneration,
  closeSession,
  closeSnapshots,
  defaultGate,
  gateAllows,
  LOGOUT_SETTLE_MS,
  openSessionAs,
  openSessionForDocument,
  openSnapshots,
  reopenAfterFailedLogout,
  whenSessionOpened,
  type WriteGate,
  type WriteLane,
} from "@/lib/offline/write-gate";

// The one database call `whenSessionOpened` sequences, held open on demand — see the last
// describe for why it has to be a genuinely pending promise rather than an absent
// IndexedDB. Everything else in this file is pure and never touches it.
//
// A GLOBAL, NOT A MODULE MOCK. lib/offline/idb reads `indexedDB` off the global and
// nothing else, so a global is all this needs — and a mock marker would buy this spec a
// private module registry, which lib/__tests__/vitest-isolation-budget.test.ts exists to
// stop happening by accident. Installed and removed per test, because the registry is
// shared with every other spec in the tier.
let answerTheDatabase: (() => void) | null = null;

function holdTheDatabaseOpen(): void {
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const req: {
        error: unknown;
        onerror: null | (() => void);
        onblocked: null | (() => void);
        onupgradeneeded: null | (() => void);
        onsuccess: null | (() => void);
      } = {
        error: new Error("no database in this tier"),
        onerror: null,
        onblocked: null,
        onupgradeneeded: null,
        onsuccess: null,
      };
      answerTheDatabase = () => req.onerror?.();
      return req;
    },
  };
}

function releaseTheDatabase(): void {
  answerTheDatabase = null;
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
}

const LANES: readonly WriteLane[] = ["snapshots", "queue", "drafts"];

// Two session names, low-entropy on purpose. `THIS_SESSION` is the one that logs out;
// `NEXT_SESSION` is whoever signs in on the device afterwards.
const THIS_SESSION = "session key 1";
const NEXT_SESSION = "session key 2";

// A fixed device clock. Every close below happens AT it, and every re-open is measured
// from it, so "inside the logout window" and "long after it" are stated rather than timed.
const CLICKED_LOG_OUT = 1_700_000_000_000;

function at(gate: WriteGate): number {
  return gate.generation;
}

/** A gate as logout leaves it, at the moment Log out was pressed. */
function closeAt(
  gate: WriteGate = defaultGate(),
  now: number = CLICKED_LOG_OUT
): WriteGate {
  return closeSession(now)(gate);
}

/** A gate as a live document of `key` leaves it, `now` after that click. */
function openFor(
  key: string,
  gate: WriteGate = defaultGate(),
  now: number = CLICKED_LOG_OUT
): WriteGate {
  return openSessionAs(key, now)(gate);
}

describe("gateAllows — the one decision every device-local PHI write asks", () => {
  it("allows a current token on every lane when nothing has closed", () => {
    const gate = defaultGate();
    for (const lane of LANES) {
      expect(gateAllows(gate, lane, at(gate)), lane).toBe(true);
    }
  });

  it("refuses a token from before a wipe — the in-flight case", () => {
    const before = defaultGate();
    const after = bumpGeneration(before);
    for (const lane of LANES) {
      expect(gateAllows(after, lane, at(before)), lane).toBe(false);
      expect(gateAllows(after, lane, at(after)), lane).toBe(true);
    }
  });

  it("refuses a PERFECTLY CURRENT token on every lane once logout has closed", () => {
    // The case a generation cannot express, and the one that shipped red twice: a write
    // that STARTS after the wipe holds a legitimately current generation. Nothing about
    // its token is stale — the session is simply over.
    const gate = closeAt();
    for (const lane of LANES) {
      expect(gateAllows(gate, lane, at(gate)), lane).toBe(false);
    }
  });

  it("refuses only SNAPSHOTS when the off switch closed, and lets writes keep queueing", () => {
    // The asymmetry, asserted rather than described. Turning offline READS off must not
    // stop the offline write QUEUE: a different feature with a different promise, and
    // someone in a dead zone still needs their dose tap captured.
    const gate = closeSnapshots(defaultGate());
    expect(gateAllows(gate, "snapshots", at(gate))).toBe(false);
    expect(gateAllows(gate, "queue", at(gate))).toBe(true);
    expect(gateAllows(gate, "drafts", at(gate))).toBe(true);
  });

  it("keeps logout closed even after the off switch is turned back on", () => {
    // Two independent closes. Re-opening one must not silently re-open the other, which
    // is exactly what a single boolean would have done.
    const gate = openSnapshots(closeSnapshots(closeAt()));
    for (const lane of LANES) {
      expect(gateAllows(gate, lane, at(gate)), lane).toBe(false);
    }
  });

  it("keeps the off switch closed even after a new session opens", () => {
    // And the other direction: logging back in does not undo a toggle the person set.
    const gate = openFor(
      NEXT_SESSION,
      closeAt(closeSnapshots(openFor(THIS_SESSION)))
    );
    expect(gateAllows(gate, "snapshots", at(gate))).toBe(false);
    expect(gateAllows(gate, "queue", at(gate))).toBe(true);
  });
});

describe("who may re-open a closed session — the second-tab defect", () => {
  // The finding this describes was found FOUR TIMES, each time one scope out, and it is
  // worth being blunt about what these assertions are for. Every previous guard was
  // correct about its own subject and wrong about the system: a React flag knew about
  // unmounting, a generation knew about one flight, a module `closed` knew about one
  // document. Putting the gate in the database fixed the third — and the re-open was
  // still "a component mounted", which is true of every tab that was already open when
  // someone pressed Log out. CI caught it against the second-tab test itself.
  //
  // These are pure and they go red when mutated: an `openSessionAs` that opens
  // unconditionally — the shipped behaviour — fails the first two.

  it("REFUSES a document of the session that closed it — every tab still open at logout", () => {
    const closed = closeAt(openFor(THIS_SESSION));
    // Tab B: same session, still mounted, still authenticated because the logout POST has
    // not landed, running its own mount effect. It asks, and it is refused.
    const afterTabB = openFor(THIS_SESSION, closed);
    expect(afterTabB.sessionClosed).toBe(true);
    for (const lane of LANES) {
      expect(gateAllows(afterTabB, lane, at(afterTabB)), lane).toBe(false);
    }
  });

  it("stays refused however many of them ask, in any order", () => {
    // A device with several tabs open, each mounting whenever it gets scheduled. No
    // number of them adds up to a new session.
    let gate = closeAt(openFor(THIS_SESSION));
    for (let i = 0; i < 5; i += 1) gate = openFor(THIS_SESSION, gate);
    expect(gateAllows(gate, "snapshots", at(gate))).toBe(false);
    expect(gateAllows(gate, "queue", at(gate))).toBe(false);
  });

  it("ADMITS a genuinely new session — the person who signs in next", () => {
    // The other half, and the reason "stay closed forever" is not the fix: whoever picks
    // the device up and logs in must get the feature back.
    const reopened = openFor(NEXT_SESSION, closeAt(openFor(THIS_SESSION)));
    expect(reopened.sessionClosed).toBe(false);
    for (const lane of LANES) {
      expect(gateAllows(reopened, lane, at(reopened)), lane).toBe(true);
    }
  });

  it("does not rewind the generation when a new session re-opens it", () => {
    // A write in flight at the moment of logout must not be revived by the login that
    // follows it. The close's fence outlives the close.
    const closed = closeAt(openFor(THIS_SESSION));
    const reopened = openFor(NEXT_SESSION, closed);
    expect(reopened.generation).toBe(closed.generation);
    expect(gateAllows(reopened, "queue", at(defaultGate()))).toBe(false);
  });

  it("records the session on a gate that is merely OPEN, so the next close knows whose it was", () => {
    // The key has to be written by the ordinary open, not only by the close — `closeSession`
    // has no session to name, and a gate that closed without one would admit anybody.
    expect(openFor(THIS_SESSION).sessionKey).toBe(THIS_SESSION);
    expect(closeAt(openFor(THIS_SESSION)).sessionKey).toBe(THIS_SESSION);
  });

  it("a device that has never held a session is open, and any session may claim it", () => {
    expect(defaultGate().sessionKey).toBe(null);
    expect(gateAllows(defaultGate(), "snapshots", 0)).toBe(true);
    expect(openFor(THIS_SESSION).sessionClosed).toBe(false);
  });
});

describe("the gate transitions — which wipes close, and which only fence", () => {
  it("logout closes the session AND moves the generation", () => {
    const before = defaultGate();
    const after = closeAt(before);
    expect(after.sessionClosed).toBe(true);
    expect(after.generation).toBeGreaterThan(before.generation);
  });

  it("the off switch closes snapshots AND moves the generation", () => {
    const before = defaultGate();
    const after = closeSnapshots(before);
    expect(after.snapshotsClosed).toBe(true);
    expect(after.sessionClosed).toBe(false);
    expect(after.generation).toBeGreaterThan(before.generation);
  });

  it("a PROFILE SWITCH closes nothing — it wipes so the next profile CAN be captured", () => {
    // The asymmetry three rounds of review kept circling. A switch must fence writes
    // already in flight for the previous profile and must NOT stop the new profile's
    // capture, so it moves the generation and closes no lane.
    const before = defaultGate();
    const after = bumpGeneration(before);
    expect(after.sessionClosed).toBe(false);
    expect(after.snapshotsClosed).toBe(false);
    expect(gateAllows(after, "snapshots", at(before))).toBe(false);
    expect(gateAllows(after, "snapshots", at(after))).toBe(true);
  });

  it("re-opening never rewinds the generation", () => {
    // A wipe's fence must survive the re-open that follows it, or a write in flight at
    // the moment of a switch-then-login could still land.
    const wiped = closeAt(openFor(THIS_SESSION));
    const reopened = openFor(NEXT_SESSION, wiped);
    expect(reopened.generation).toBe(wiped.generation);
    expect(gateAllows(reopened, "queue", at(defaultGate()))).toBe(false);
  });
});

describe("a logout that never landed — the close is a bet, and it can be lost", () => {
  // The close is made BEFORE the logout POST is sent, which is what makes the whole
  // logout window safe. When that POST fails — no signal, a 5xx mid-deploy — the session
  // is still alive and the gate is closed for it, and every rule above says only a
  // DIFFERENT session may re-open. Nothing changes `sessionKey` short of a successful
  // logout and a new login, so the device stayed shut: no queued writes, no drafts, no
  // snapshots, and a "saved offline" toast over a queue that captured nothing.

  it("the closer's own undo re-opens every lane for the session that never ended", () => {
    const closed = closeAt(openFor(THIS_SESSION));
    const recovered = reopenAfterFailedLogout(closed);
    for (const lane of LANES) {
      expect(gateAllows(recovered, lane, at(recovered)), lane).toBe(true);
    }
  });

  it("the undo keeps the session's name and the wipe's fence", () => {
    // It is the same session — nothing logged out — so the key stands, and the generation
    // must not rewind or a write in flight when Log out was pressed could still land.
    const closed = closeAt(openFor(THIS_SESSION));
    const recovered = reopenAfterFailedLogout(closed);
    expect(recovered.sessionKey).toBe(THIS_SESSION);
    expect(recovered.generation).toBe(closed.generation);
    expect(gateAllows(recovered, "queue", at(defaultGate()))).toBe(false);
  });

  it("the undo does not touch the offline-reads off switch", () => {
    const closed = closeAt(closeSnapshots(openFor(THIS_SESSION)));
    const recovered = reopenAfterFailedLogout(closed);
    expect(gateAllows(recovered, "snapshots", at(recovered))).toBe(false);
    expect(gateAllows(recovered, "queue", at(recovered))).toBe(true);
  });

  it("a same-session document still refuses INSIDE the logout window", () => {
    // The control for the test below, and the R2b property restated as a clock: while the
    // POST could still land, a document of this session is racing its own logout and must
    // be refused however plainly authenticated it is.
    const closed = closeAt(openFor(THIS_SESSION));
    const inside = openFor(
      THIS_SESSION,
      closed,
      CLICKED_LOG_OUT + LOGOUT_SETTLE_MS - 1
    );
    expect(inside.sessionClosed).toBe(true);
    expect(gateAllows(inside, "queue", at(inside))).toBe(false);
  });

  it("a same-session document re-opens once it has plainly OUTLASTED that window", () => {
    // The case the closer cannot cover: its document was destroyed mid-POST, so no
    // failure path ran. A form-action POST dies with its document, so that logout can
    // never land — and a session still being served the authenticated app this long
    // afterwards did not log out.
    const closed = closeAt(openFor(THIS_SESSION));
    const later = openFor(
      THIS_SESSION,
      closed,
      CLICKED_LOG_OUT + LOGOUT_SETTLE_MS
    );
    expect(later.sessionClosed).toBe(false);
    for (const lane of LANES) {
      expect(gateAllows(later, lane, at(later)), lane).toBe(true);
    }
  });

  it("a clock that jumped BACKWARDS refuses rather than opens", () => {
    // The bound is read as elapsed time, never as a stored deadline, so a device whose
    // clock moved back lands OUTSIDE the window on the closed side.
    const closed = closeAt(openFor(THIS_SESSION));
    const skewed = openFor(THIS_SESSION, closed, CLICKED_LOG_OUT - 86_400_000);
    expect(skewed.sessionClosed).toBe(true);
  });
});

describe("the off switch is not a latch — it lasts exactly as long as the server is untold", () => {
  // R-B: `snapshotsClosed` was persisted with no path back but this device's own toggle
  // being ticked ON again. The refresher asks the gate before it asks the server, so a
  // closed device could never hear `enabled: true` from a profile turned back on
  // anywhere — and the checkbox is server-driven, so it rendered ON above an empty store
  // forever. `openSnapshots` is the release, and components/offline/OfflineSnapshotsSettings
  // calls it when the Server Action settles.

  it("releasing the switch re-opens snapshots without rewinding the wipe it made", () => {
    const off = closeSnapshots(defaultGate());
    const released = openSnapshots(off);
    expect(gateAllows(released, "snapshots", at(released))).toBe(true);
    expect(released.generation).toBe(off.generation);
    // The wipe's fence outlives the release: a refresh that captured its token before the
    // switch was touched still cannot land its payload.
    expect(gateAllows(released, "snapshots", at(defaultGate()))).toBe(false);
  });

  it("releasing the switch does not re-open a logged-out session", () => {
    const gate = openSnapshots(closeAt(closeSnapshots(openFor(THIS_SESSION))));
    for (const lane of LANES) {
      expect(gateAllows(gate, lane, at(gate)), lane).toBe(false);
    }
  });
});

describe("whenSessionOpened — the sequencing handle, which nothing used to observe", () => {
  // The refresher awaits this before asking the gate anything, because React runs child
  // effects first: without it the first refresh after a login reads a gate still closed
  // for the PREVIOUS session, gives up, and leaves a freshly logged-in device with no
  // offline copy until something else triggers a refresh. It decides nothing — it can
  // only delay a writer — but "can only delay" is not the same as "does delay", and a
  // mutant returning `Promise.resolve()` went unnoticed by the whole suite.
  //
  // The database is held pending by the mock at the top of this file, so the re-open is
  // genuinely in flight while we look.

  it("does not resolve until this document's re-open has landed", async () => {
    holdTheDatabaseOpen();
    try {
      let landed = false;
      const reopen = openSessionForDocument(THIS_SESSION);
      void reopen.then(() => {
        landed = true;
      });
      const waited = whenSessionOpened();
      void waited.then(() => {
        landed = true;
      });
      // Several microtask turns — enough for any promise that was already settled.
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      expect(landed).toBe(false);

      answerTheDatabase?.();
      await waited;
      expect(landed).toBe(true);
    } finally {
      releaseTheDatabase();
    }
  });

  it("is the SAME handle the re-open returned, not a fresh resolved promise", async () => {
    const reopen = openSessionForDocument(NEXT_SESSION);
    expect(whenSessionOpened()).toBe(reopen);
    await reopen;
  });
});
