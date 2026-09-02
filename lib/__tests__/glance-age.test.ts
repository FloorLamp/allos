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
      dateLabel: "Sunday, August 9",
    });
    // The DAY the caller handed in, not the stored one (#3492). This assertion used
    // to read "2026-08-09", which is precisely the defect: the module printed the
    // machine date whenever a caller declined to render one.
    expect(current.text).toBe("Sunday, August 9");
    const stale = glanceAgeToken({
      date: "2022-03-08",
      today: TODAY,
      freshness: "due",
      form: "long",
      floorLabel: VITAL_PRESENTATION_FLOORS["blood-pressure"].label,
      dateLabel: "Tuesday, March 8, 2022",
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
      dateLabel: "Tuesday, March 8, 2022",
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
    for (const na of [
      glanceAgeToken({
        date: "2022-03-08",
        today: TODAY,
        freshness: "not-applicable",
        form: "compact",
        floorLabel: RECENT_LAB_STALE_LABEL,
      }),
      glanceAgeToken({
        date: "2022-03-08",
        today: TODAY,
        freshness: "not-applicable",
        form: "long",
        floorLabel: RECENT_LAB_STALE_LABEL,
        dateLabel: "Mar 8, 2022",
      }),
    ]) {
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
        dateLabel: "Mar 8, 2022",
      }).text
    ).toBe("Mar 8, 2022");
  });
});

describe("the as-of form (#2615 item 3)", () => {
  it("states the day, never the age", () => {
    // "2 weeks ago" beside "99.2 °F" reads as a second quantity. An as-of stamp means a
    // day, so this form says one at every state — the CARD decides when it has an
    // occasion to render the token at all.
    for (const freshness of ["current", "due", "not-applicable"] as const) {
      expect(
        glanceAgeToken({
          date: "2026-07-29",
          today: TODAY,
          freshness,
          form: "as-of",
          floorLabel: "a week",
          dateLabel: "Jul 29",
        }).text
      ).toBe("as of Jul 29");
    }
  });

  // THE FALLBACK IS GONE, AND ITS ABSENCE IS THE ASSERTION (#3492).
  //
  // This test used to pin the opposite behaviour — "falls back to the ISO day when
  // the caller states no formatted one" — and that fallback is exactly how a machine
  // date reached the dashboard: the two Standing vitals rows asked for a form that
  // states a day and passed no label, so the module printed `2026-07-22`. A surface
  // that states a day now cannot be constructed without one, and the check is a
  // COMPILE-time one because that is the only kind a future call site cannot skip.
  it("a form that states a day cannot be built without a pref-formatted label", () => {
    const withoutLabel = {
      date: "2026-07-29",
      today: TODAY,
      freshness: "due",
      form: "as-of",
      floorLabel: "a week",
    } as const;
    // @ts-expect-error — a day-stating form with no `dateLabel` is the defect this
    // boundary exists to make unrepresentable. If this line ever stops erroring, the
    // ISO escape hatch is back and #3492 has regressed.
    void glanceAgeToken(withoutLabel);
    // The runtime half of the same claim: nothing but the caller's label reaches the
    // text, so there is no second source a day could come from.
    expect(
      glanceAgeToken({ ...withoutLabel, dateLabel: "Jul 29, 2026" }).text
    ).toBe("as of Jul 29, 2026");
  });

  it("takes the same amber treatment and sentence as the two glance cards", () => {
    // A third FORM, not a third treatment — the whole reason the decision lives here.
    const chartCard = glanceAgeToken({
      date: "2026-07-29",
      today: TODAY,
      freshness: "due",
      form: "as-of",
      floorLabel: "a week",
      dateLabel: "Jul 29",
    });
    const vitals = glanceAgeToken({
      date: "2022-03-08",
      today: TODAY,
      freshness: "due",
      form: "long",
      floorLabel: VITAL_PRESENTATION_FLOORS["resting-hr"].label,
      dateLabel: "Mar 8, 2022",
    });
    expect(chartCard.className).toBe(vitals.className);
    expect(chartCard.stale).toBe(true);
    expect(chartCard.title).toBe(
      "Older than a week — still your latest reading, but not a current one"
    );
  });
});

describe("the long form's two spoken days (#4757)", () => {
  // "Wednesday, September 2" IS today, and a reader should not do calendar math to
  // learn a reading is current. Only the freshest two days are worded — the day after
  // yesterday is already a date worth naming — and a stale reading is untouched, since
  // nothing inside a floor is both due and yesterday. Lowercase: the token follows the
  // value on one line. The compact form keeps its column-cell "Today".
  it.each([
    ["2026-08-12", "current", "today"],
    ["2026-08-11", "current", "yesterday"],
    ["2026-08-10", "current", "Monday, August 10"],
    ["2026-08-13", "current", "today"], // future-dated: the same side as today
    ["2022-03-08", "due", "4 years ago"],
  ] as const)("%s (%s) reads %s", (date, freshness, text) => {
    expect(
      glanceAgeToken({
        date,
        today: TODAY,
        freshness,
        form: "long",
        floorLabel: VITAL_PRESENTATION_FLOORS["resting-hr"].label,
        dateLabel: "Monday, August 10",
      }).text
    ).toBe(text);
  });

  it("leaves the compact and as-of forms alone", () => {
    expect(
      glanceAgeToken({
        date: TODAY,
        today: TODAY,
        freshness: "current",
        form: "compact",
        floorLabel: RECENT_LAB_STALE_LABEL,
      }).text
    ).toBe("Today");
    expect(
      glanceAgeToken({
        date: TODAY,
        today: TODAY,
        freshness: "current",
        form: "as-of",
        floorLabel: "a week",
        dateLabel: "Aug 12",
      }).text
    ).toBe("as of Aug 12");
  });
});
