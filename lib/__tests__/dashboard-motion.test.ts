import { describe, expect, it } from "vitest";
import { witnessedNowMotion } from "@/lib/dashboard-motion";
import { MICRO_MOTIONS, withinMicroMotionBand } from "@/lib/micro-motion";

// WITNESSED CHANGES ONLY (#3253 decision 4).
//
// The rule the dashboard's one animated moment is held to: a promotion animates when it
// happens IN FRONT OF the viewer, and lands silently otherwise. Everything here is the
// pure decision — whether a card set changed, and whether anyone was there for it.
//
// The resume half is tested even though nothing can currently trigger it: #3075's silent
// refresh is what makes `hiddenSinceLast` reachable in production, and the branch exists
// now so that refresh arrives quiet by construction. Testing a dormant branch is the
// point — an untested branch that first executes on the day the feature lands is how a
// resume comes to replay two hours of changes at somebody.

const WATCHING = {
  hiddenSinceLast: false,
  pageVisible: true,
  reduceMotion: false,
};

describe("witnessedNowMotion", () => {
  it("animates a card that arrived while the page was being watched", () => {
    expect(
      witnessedNowMotion({
        previous: ["dose.due:1"],
        next: ["dose.due:1", "weight.latest:2026-08-21"],
        ...WATCHING,
      })
    ).toEqual({ animate: ["weight.latest:2026-08-21"], emptyArrived: false });
  });

  it("never animates the first paint, however the page got here", () => {
    // A reload, a first visit, and a resume that re-navigates all land here. There is
    // no "before" the viewer saw, so there is nothing for motion to be about.
    expect(
      witnessedNowMotion({
        previous: null,
        next: ["dose.due:1", "weight.latest:2026-08-21"],
        ...WATCHING,
      })
    ).toEqual({ animate: [], emptyArrived: false });
  });

  it("lands a diff that arrived across a hidden interval quietly", () => {
    // The resume case. The same diff, the same visible page at the moment of render —
    // and no animation, because the change did not happen in front of anyone.
    expect(
      witnessedNowMotion({
        previous: ["dose.due:1"],
        next: ["dose.due:1", "weight.latest:2026-08-21"],
        hiddenSinceLast: true,
        pageVisible: true,
        reduceMotion: false,
      })
    ).toEqual({ animate: [], emptyArrived: false });
  });

  it("stays quiet for a change that lands in a backgrounded tab", () => {
    expect(
      witnessedNowMotion({
        previous: ["dose.due:1"],
        next: ["weight.latest:2026-08-21"],
        hiddenSinceLast: false,
        pageVisible: false,
        reduceMotion: false,
      }).animate
    ).toEqual([]);
  });

  it("reports Now BECOMING empty, but not arriving empty", () => {
    // The interaction-local case that ships today: the last card resolves under your
    // hand and "Nothing needs you." fades in. Arriving at an already-empty Now is a
    // fact about the day, not an event.
    expect(
      witnessedNowMotion({ previous: ["dose.due:1"], next: [], ...WATCHING })
    ).toEqual({ animate: [], emptyArrived: true });
    expect(
      witnessedNowMotion({ previous: [], next: [], ...WATCHING }).emptyArrived
    ).toBe(false);
    expect(
      witnessedNowMotion({ previous: null, next: [], ...WATCHING }).emptyArrived
    ).toBe(false);
  });

  it("gives a reduced-motion viewer the end state and no keyframe", () => {
    // Rule 3 of the micro-motion doctrine: reduced motion is the DESIGNED state. The
    // card is simply there — which from here means no id is ever marked.
    expect(
      witnessedNowMotion({
        previous: ["dose.due:1"],
        next: ["weight.latest:2026-08-21"],
        hiddenSinceLast: false,
        pageVisible: true,
        reduceMotion: true,
      })
    ).toEqual({ animate: [], emptyArrived: false });
  });

  it("does not animate a card that merely moved position", () => {
    // Re-ranking is not arrival. Only an id that was not there before may animate,
    // which is what keeps a re-order from strobing the whole strip.
    expect(
      witnessedNowMotion({
        previous: ["a", "b"],
        next: ["b", "a"],
        ...WATCHING,
      }).animate
    ).toEqual([]);
  });

  it("times the lift inside the micro-motion band", () => {
    // The issue says "~320ms"; the vocabulary's band ends at 300 and its one exemption
    // is a ruling with reasoning attached. The tilde is what pays for the difference.
    expect(MICRO_MOTIONS.promote.ms).toBe(300);
    expect(withinMicroMotionBand(MICRO_MOTIONS.promote.ms)).toBe(true);
  });
});
