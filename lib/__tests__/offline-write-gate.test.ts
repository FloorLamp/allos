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
  openSession,
  openSnapshots,
  type WriteGate,
  type WriteLane,
} from "@/lib/offline/write-gate";

const LANES: readonly WriteLane[] = ["snapshots", "queue", "drafts"];

function at(gate: WriteGate): number {
  return gate.generation;
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
    const gate = openSession(closeSession(closeSnapshots(defaultGate())));
    expect(gateAllows(gate, "snapshots", at(gate))).toBe(false);
    expect(gateAllows(gate, "queue", at(gate))).toBe(true);
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
    const wiped = closeSession(defaultGate());
    const reopened = openSession(wiped);
    expect(reopened.generation).toBe(wiped.generation);
    expect(gateAllows(reopened, "queue", at(defaultGate()))).toBe(false);
  });
});
