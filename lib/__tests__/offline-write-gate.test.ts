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
  openSessionAs,
  openSnapshots,
  type WriteGate,
  type WriteLane,
} from "@/lib/offline/write-gate";

const LANES: readonly WriteLane[] = ["snapshots", "queue", "drafts"];

// Two session names, low-entropy on purpose. `THIS_SESSION` is the one that logs out;
// `NEXT_SESSION` is whoever signs in on the device afterwards.
const THIS_SESSION = "session key 1";
const NEXT_SESSION = "session key 2";

function at(gate: WriteGate): number {
  return gate.generation;
}

/** A gate as a live document of `key` leaves it. */
function openFor(key: string, gate: WriteGate = defaultGate()): WriteGate {
  return openSessionAs(key)(gate);
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
    const gate = closeSession(defaultGate());
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
    const gate = openSnapshots(closeSnapshots(closeSession(defaultGate())));
    for (const lane of LANES) {
      expect(gateAllows(gate, lane, at(gate)), lane).toBe(false);
    }
  });

  it("keeps the off switch closed even after a new session opens", () => {
    // And the other direction: logging back in does not undo a toggle the person set.
    const gate = openFor(
      NEXT_SESSION,
      closeSession(closeSnapshots(openFor(THIS_SESSION)))
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
    const closed = closeSession(openFor(THIS_SESSION));
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
    let gate = closeSession(openFor(THIS_SESSION));
    for (let i = 0; i < 5; i += 1) gate = openFor(THIS_SESSION, gate);
    expect(gateAllows(gate, "snapshots", at(gate))).toBe(false);
    expect(gateAllows(gate, "queue", at(gate))).toBe(false);
  });

  it("ADMITS a genuinely new session — the person who signs in next", () => {
    // The other half, and the reason "stay closed forever" is not the fix: whoever picks
    // the device up and logs in must get the feature back.
    const reopened = openFor(NEXT_SESSION, closeSession(openFor(THIS_SESSION)));
    expect(reopened.sessionClosed).toBe(false);
    for (const lane of LANES) {
      expect(gateAllows(reopened, lane, at(reopened)), lane).toBe(true);
    }
  });

  it("does not rewind the generation when a new session re-opens it", () => {
    // A write in flight at the moment of logout must not be revived by the login that
    // follows it. The close's fence outlives the close.
    const closed = closeSession(openFor(THIS_SESSION));
    const reopened = openFor(NEXT_SESSION, closed);
    expect(reopened.generation).toBe(closed.generation);
    expect(gateAllows(reopened, "queue", at(defaultGate()))).toBe(false);
  });

  it("records the session on a gate that is merely OPEN, so the next close knows whose it was", () => {
    // The key has to be written by the ordinary open, not only by the close — `closeSession`
    // has no session to name, and a gate that closed without one would admit anybody.
    expect(openFor(THIS_SESSION).sessionKey).toBe(THIS_SESSION);
    expect(closeSession(openFor(THIS_SESSION)).sessionKey).toBe(THIS_SESSION);
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
    const after = closeSession(before);
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
    const wiped = closeSession(openFor(THIS_SESSION));
    const reopened = openFor(NEXT_SESSION, wiped);
    expect(reopened.generation).toBe(wiped.generation);
    expect(gateAllows(reopened, "queue", at(defaultGate()))).toBe(false);
  });
});
