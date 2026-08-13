import { describe, it, expect } from "vitest";
import { glanceAgeToken } from "@/lib/glance-age";
import { RECENT_LAB_STALE_LABEL } from "@/lib/recent-labs";
import { VITAL_PRESENTATION_FLOORS } from "@/lib/vitals-latest";

// The ONE glance-card age decision (#2332). Two dashboard cards answered "how old is
// this reading?" two ways — a compact age recolored amber with one hover sentence, and
// an ISO date swapped for "4 years ago" with a different one — so the next glance
// surface would have found two precedents. What each card still declares is the FORM
// its layout can hold and the interval its own floor names; everything else is here.

const TODAY = "2026-08-12";

describe("what a glance card says about a reading's age", () => {
  it("says a compact age at every state, in the narrow form", () => {
    // A `w-14` column takes "4y" and cannot take "4 years ago", so the compact form
    // states the age whether or not the floor was crossed — and on a glance surface the
    // age is also the more useful of the two facts.
    expect(
      glanceAgeToken({
        date: "2026-08-09",
        today: TODAY,
        freshness: "current",
        form: "compact",
        floorLabel: RECENT_LAB_STALE_LABEL,
      }).text
    ).toBe("3d");
    expect(
      glanceAgeToken({
        date: "2022-03-08",
        today: TODAY,
        freshness: "due",
        form: "compact",
        floorLabel: RECENT_LAB_STALE_LABEL,
      }).text
    ).toBe("4y");
  });

  it("swaps the date for the age only when stale, in the long form", () => {
    // For a recent reading the exact day is the more useful fact and "3 days ago" is a
    // downgrade; past the floor, an ISO date does not read as an age at a glance, which
    // is the whole of #2303's argument.
    const current = glanceAgeToken({
      date: "2026-08-09",
      today: TODAY,
      freshness: "current",
      form: "long",
      floorLabel: VITAL_PRESENTATION_FLOORS["blood-pressure"].label,
    });
    expect(current.text).toBe("2026-08-09");
    const stale = glanceAgeToken({
      date: "2022-03-08",
      today: TODAY,
      freshness: "due",
      form: "long",
      floorLabel: VITAL_PRESENTATION_FLOORS["blood-pressure"].label,
    });
    expect(stale.text).toBe("4 years ago");
  });

  it("gives both cards the same amber treatment and the same sentence", () => {
    // The convergence itself, asserted across the two real surfaces: same color pair,
    // same grammar, and each naming its OWN interval — which is the one thing a
    // relative date cannot say.
    const labs = glanceAgeToken({
      date: "2022-03-08",
      today: TODAY,
      freshness: "due",
      form: "compact",
      floorLabel: RECENT_LAB_STALE_LABEL,
    });
    const vitals = glanceAgeToken({
      date: "2022-03-08",
      today: TODAY,
      freshness: "due",
      form: "long",
      floorLabel: VITAL_PRESENTATION_FLOORS["resting-hr"].label,
    });
    expect(labs.className).toBe(vitals.className);
    expect(labs.className).toContain("amber");
    expect(labs.title).toBe(
      "Older than a year — still your latest reading, but not a current one"
    );
    expect(vitals.title).toBe(
      "Older than two weeks — still your latest reading, but not a current one"
    );
  });

  it("never folds not-applicable into due", () => {
    // An undatable reading has no knowable age, so it claims nothing either way: no
    // amber, no hover sentence, and — in the long form — the date rather than a
    // relative age it cannot honestly state.
    for (const form of ["compact", "long"] as const) {
      const na = glanceAgeToken({
        date: "2022-03-08",
        today: TODAY,
        freshness: "not-applicable",
        form,
        floorLabel: RECENT_LAB_STALE_LABEL,
      });
      expect(na.stale).toBe(false);
      expect(na.title).toBeNull();
      expect(na.className).not.toContain("amber");
    }
    expect(
      glanceAgeToken({
        date: "2022-03-08",
        today: TODAY,
        freshness: "not-applicable",
        form: "long",
        floorLabel: RECENT_LAB_STALE_LABEL,
      }).text
    ).toBe("2022-03-08");
  });
});
