// WHAT IS LEFT OF THE SHARED-CADENCE GUARD (#2089), AND WHY (#5351).
//
// This file used to make membership TOTAL by reconciling `KIND_CADENCE` against the
// `NotificationKind` union on every run — every kind declared, no stale entry, no
// duplicate, no exemption spelled as a bare "no", no safety kind riding the engine —
// and then read the declared adapter paths back against the real import graph.
//
// `KIND_CADENCE` is now keyed on the union and its safety arm is typed, so all of that
// is `tsc`: an undeclared kind, a retired one, a duplicate, an exemption outside the
// `SendCadence` vocabulary and a safety kind claiming membership are each a compile
// error. The import-graph tooth is deleted rather than converted — it names a class it
// might catch, not a defect it has (docs/orchestration/what-earns-a-guard.md).
//
// What stays cannot be typed: the `why` prose has to actually say something, and the
// membership set is a POLICY about which families the shared engine may decide for.
import { describe, expect, it } from "vitest";
import {
  KIND_CADENCE,
  SHARED_CADENCE_KINDS,
} from "@/lib/notifications/cadence-registry";

describe("the shared-cadence declaration (#2089)", () => {
  it("both answers carry a real reason — including every exemption", () => {
    // The floor is what keeps "we decided against it" distinguishable from "nobody
    // looked": a member has to say what makes it an episode nudge and name its adapter,
    // an exemption has to name the mechanism that owns the decision instead.
    for (const [kind, e] of Object.entries(KIND_CADENCE))
      expect(e.why.length, `${kind} needs a real reason`).toBeGreaterThan(40);
  });

  it("the four #2036 families are the members, and they are care/coaching tier", () => {
    // A POLICY set. The type says a safety kind may not be a member; it does not say
    // WHICH four families are, and widening the engine's jurisdiction is a decision
    // about contact rather than a refactor.
    expect([...SHARED_CADENCE_KINDS].sort()).toEqual([
      "followup",
      "illness-care",
      "preventive",
      "refill",
    ]);
  });

  it("the safety kinds name their own timing contract", () => {
    // Exempt is not enough: a safety kind's timing has to come from the user's own
    // schedule or the item's clock, never from something that could hold a send.
    for (const kind of ["dose", "escalation", "redose"] as const)
      expect(KIND_CADENCE[kind].cadence, kind).toMatch(
        /user-schedule|item-clock/
      );
  });
});
