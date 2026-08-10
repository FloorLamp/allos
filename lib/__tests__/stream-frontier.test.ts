// PURE TIER — the frontier fold (#2341): the state transition the ingest path applies
// on every successful push, and the evidence question every silence predicate asks of
// the result.
//
// The two consumers (the bedtime send and the quiet-stream row) exercise this through
// realistic push sequences in their own files. What is pinned HERE is the transition's
// own edges — the ones a sequence test would never reach and a wrong answer to which
// would be invisible: an empty stream, a frontier that moves BACKWARD, and the exact
// boundary at which accumulated evidence becomes an answer.

import { describe, expect, it } from "vitest";
import {
  classifyFrontier,
  frontierEvidence,
  observeFrontier,
  FROZEN_SYNC_EVIDENCE,
  type StreamFrontierState,
} from "@/lib/stream-frontier";

const T = (hhmm: string) => `2026-08-08T${hhmm}:00Z`;

describe("classifyFrontier", () => {
  it("calls the first row ever an advance", () => {
    expect(classifyFrontier(null, T("21:05"))).toBe("advanced");
  });

  it("calls a stream that has never delivered EMPTY, not frozen", () => {
    // There is no baseline to be silent against, and announcing one would be
    // announcing a device the profile does not have.
    expect(classifyFrontier(null, null)).toBe("empty");
    expect(classifyFrontier(T("21:05"), null)).toBe("empty");
  });

  it("needs STRICTLY newer to be an advance", () => {
    // A re-push of the identical rolling window is exactly what a stopped device
    // produces, and it is the observation this exists to record.
    expect(classifyFrontier(T("21:05"), T("21:05"))).toBe("frozen");
    expect(classifyFrontier(T("21:05"), T("21:06"))).toBe("advanced");
  });

  it("does not call a BACKWARD move an advance", () => {
    // Rows deleted, or a re-import sweep. The frontier got older, which is not the
    // source producing.
    expect(classifyFrontier(T("21:05"), T("20:30"))).toBe("frozen");
  });

  it("compares instants, never text", () => {
    // The same moment in the two serializations the schema has carried (#2096/#2205).
    // Lexically 'T' sorts after ' ', so a text comparison calls the bare stamp older
    // than its own canonical twin and reports a phantom advance every push.
    expect(classifyFrontier("2026-08-08 21:05:00", T("21:05"))).toBe("frozen");
  });
});

describe("observeFrontier", () => {
  it("resets the evidence on an advance and stamps when it happened", () => {
    const first = observeFrontier(null, T("21:05"), T("21:28"));
    expect(first).toEqual({
      frontierAt: T("21:05"),
      advancedAt: T("21:28"),
      observedAt: T("21:28"),
      syncsSinceAdvance: 0,
    });
    const second = observeFrontier(first, T("21:20"), T("21:44"));
    expect(second.advancedAt).toBe(T("21:44"));
    expect(second.syncsSinceAdvance).toBe(0);
  });

  it("counts each quiet push and keeps the ORIGINAL advance instant", () => {
    let state: StreamFrontierState | null = null;
    for (const push of ["21:28", "21:44", "21:59", "22:15"])
      state = observeFrontier(state, T("21:05"), T(push));
    expect(state!.syncsSinceAdvance).toBe(3);
    // The advance is when the frontier last MOVED, not when it was last looked at —
    // the two are different questions and the row answers both.
    expect(state!.advancedAt).toBe(T("21:28"));
    expect(state!.observedAt).toBe(T("22:15"));
  });

  it("adopts a backward-moved frontier while still counting it as frozen", () => {
    const first = observeFrontier(null, T("21:05"), T("21:28"));
    const next = observeFrontier(first, T("20:30"), T("21:44"));
    expect(next.frontierAt).toBe(T("20:30"));
    expect(next.syncsSinceAdvance).toBe(1);
  });

  it("holds an empty stream at zero however many pushes land", () => {
    let state: StreamFrontierState | null = null;
    for (const push of ["21:28", "21:44", "21:59"])
      state = observeFrontier(state, null, T(push));
    expect(state).toEqual({
      frontierAt: null,
      advancedAt: T("21:59"),
      observedAt: T("21:59"),
      syncsSinceAdvance: 0,
    });
  });
});

describe("frontierEvidence", () => {
  it("treats a never-observed stream as no evidence, not as silence", () => {
    expect(frontierEvidence(null)).toEqual({
      frozen: false,
      why: "no-recent-sync",
    });
  });

  it("names an advance as an advance", () => {
    expect(frontierEvidence(0)).toEqual({ frozen: false, why: "advanced" });
  });

  it("needs the declared number of quiet pushes, and it is two", () => {
    expect(FROZEN_SYNC_EVIDENCE).toBe(2);
    expect(frontierEvidence(1)).toEqual({
      frozen: false,
      why: "no-recent-sync",
    });
    expect(frontierEvidence(2)).toEqual({ frozen: true, syncs: 2 });
    expect(frontierEvidence(9)).toEqual({ frozen: true, syncs: 9 });
  });

  it("takes the bar from its caller when one is declared", () => {
    expect(frontierEvidence(1, 1)).toEqual({ frozen: true, syncs: 1 });
    expect(frontierEvidence(2, 3)).toEqual({
      frozen: false,
      why: "no-recent-sync",
    });
  });
});
