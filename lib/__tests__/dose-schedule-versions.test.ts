// Effective-dated dose schedules (issue #1973) — the PURE tier.
//
// The bug this pins: `doseAdherenceSince` took a dose's adherence lower bound from
// `updated_at`, so ANY dueness-relevant edit reset the dose's adherence lifetime to the
// edit date and voided every day before it. The invariant it was implementing —
// "editing a dose must not rewrite adherence history" — is correct and is NOT relaxed
// here. What changes is the mechanism: instead of throwing the past away, each day is
// judged against the schedule VERSION in force on that day.
//
// The two failure directions are symmetric and both are pinned below:
//   • erasing   — a present edit voiding days that were already judged (the bug);
//   • rewriting — a present edit re-judging days under today's rule, which would
//     invent misses on a once-daily → three-times-daily change and quietly forgive
//     them on a daily → every-other-day one.

import { describe, it, expect } from "vitest";
import {
  doseOnDay,
  doseScheduleAsOf,
  doseScheduleDiffers,
  unrecordedScheduleChangeOn,
  type DoseScheduleVersion,
} from "@/lib/intake-cadence";
import {
  doseBucketOn,
  doseDueOn,
  doseSlotChangedSince,
} from "@/lib/intake-schedule";
import { doseWindowSince } from "@/lib/intake-adherence";
import { lastNDates } from "@/lib/date";
import { ADHERENCE_PATTERN_DAYS } from "@/lib/adherence-patterns";

const TZ = "UTC";

// A plain daily supplement — the item half of dueness is deliberately uninteresting
// here, so every assertion below is about the DOSE's own schedule.
const ITEM = {
  condition: "daily" as const,
  situation: null,
  obligation: "should" as const,
};

const ctx = (date: string) => ({
  date,
  isWorkoutDay: false,
  activeSituations: new Set<string>(),
});

describe("doseScheduleAsOf: the version in force on a day", () => {
  const versions: DoseScheduleVersion[] = [
    { effective_from: "2026-06-01", time_of_day: "Evening" },
    { effective_from: "2026-07-15", time_of_day: "Morning" },
  ];
  const dose = { time_of_day: "Morning", versions };

  it("resolves the latest version at or before the day", () => {
    expect(doseScheduleAsOf(dose, "2026-06-30").time_of_day).toBe("Evening");
    expect(doseScheduleAsOf(dose, "2026-07-14").time_of_day).toBe("Evening");
    // Inclusive on its own effective day.
    expect(doseScheduleAsOf(dose, "2026-07-15").time_of_day).toBe("Morning");
    expect(doseScheduleAsOf(dose, "2026-08-03").time_of_day).toBe("Morning");
  });

  it("falls back to the EARLIEST version before recorded history begins", () => {
    // Not "no schedule": existence is a different question with a better answer
    // (doseWindowSince). The oldest recorded rule is the best statement available
    // about a day before recording started.
    expect(doseScheduleAsOf(dose, "2026-01-01").time_of_day).toBe("Evening");
  });

  it("falls back to the live row when a dose has no recorded history at all", () => {
    // The pre-#1973 reading, and what every fixture / seed / importer row keeps.
    const bare = { time_of_day: "Midday", weekdays: "1,3" };
    expect(doseScheduleAsOf(bare, "2020-01-01").time_of_day).toBe("Midday");
    expect(doseScheduleAsOf(bare, "2026-08-03").weekdays).toBe("1,3");
  });

  it("lets the last version of a day win when two share an effective_from", () => {
    // Two edits on one calendar day. The write path upserts on (dose_id,
    // effective_from) so this should not arise, but dueness is evaluated per DAY and
    // the resolver must still be total.
    const sameDay = {
      time_of_day: "Morning",
      versions: [
        { effective_from: "2026-07-15", time_of_day: "Evening" },
        { effective_from: "2026-07-15", time_of_day: "Morning" },
      ],
    };
    expect(doseScheduleAsOf(sameDay, "2026-07-20").time_of_day).toBe("Morning");
  });
});

describe("#1973 REGRESSION PIN: an edit must not void the days before it", () => {
  // The exact shape from the issue: a dose that has existed since 1 June and was
  // re-timed TODAY. Before this change the window collapsed to the edit day —
  // `doseAdherenceSince` returned "2026-08-03" and every earlier day dropped out.
  const TODAY = "2026-08-03";
  const ITEM_CREATED = "2026-06-01 08:00:00";
  const DOSE_CREATED = "2026-06-01 08:00:00";

  const dates = lastNDates(TODAY, ADHERENCE_PATTERN_DAYS);
  const dose = {
    time_of_day: "Morning",
    versions: [
      { effective_from: "2026-06-01", time_of_day: "Evening" },
      { effective_from: TODAY, time_of_day: "Morning" },
    ],
  };

  it("keeps every pre-edit due day in the pattern window", () => {
    // The bound is now EXISTENCE only. This is the assertion that fails on the
    // pre-#1973 tree, where the same window contained only ["2026-08-03"].
    const since = doseWindowSince(ITEM_CREATED, DOSE_CREATED, undefined, TZ);
    const windowDates = since ? dates.filter((d) => d >= since) : dates;

    expect(since).toBe("2026-06-01");
    expect(windowDates).toContain("2026-07-01");
    expect(windowDates).toContain("2026-08-02");
    // The dose predates the whole 56-day lookback, so the edit costs it NOTHING: all
    // 56 days survive. On the pre-#1973 tree this array was ["2026-08-03"] — one day.
    expect(windowDates.length).toBe(ADHERENCE_PATTERN_DAYS);
    expect(windowDates[0]).toBe("2026-06-09");
  });

  it("still judges each of those days as due", () => {
    // Retaining the days would be worthless if they all scored "not applicable".
    expect(doseDueOn(ITEM, dose, ctx("2026-07-01"))).toBe(true);
    expect(doseDueOn(ITEM, dose, ctx(TODAY))).toBe(true);
  });

  it("still does not reach back before the dose EXISTED", () => {
    // The half of #430/#1442 that is NOT the edit clamp, and correctly survives: a
    // dose born mid-window is judged only from its birth, so the days before it
    // existed never become phantom misses.
    const bornMidWindow = doseWindowSince(
      "2026-07-10 08:00:00",
      "2026-07-10 08:00:00",
      undefined,
      TZ
    );
    expect(bornMidWindow).toBe("2026-07-10");
    const windowDates = dates.filter((d) => d >= bornMidWindow!);
    expect(windowDates).not.toContain("2026-07-09");
    expect(windowDates).toContain("2026-07-10");
  });

  it("lets a logged day widen the bound back past creation (#1442)", () => {
    // A backfilled history is proof the dose existed then, and outranks a same-day
    // created_at. Pinned here because it is the reason the existence bound must NOT
    // be re-derived from a UTC slice of created_at inside doseOnDay.
    const backfilled = doseWindowSince(
      "2026-07-10 08:00:00",
      "2026-07-10 08:00:00",
      { taken: new Set(["2026-06-20"]), skipped: new Set<string>() },
      TZ
    );
    expect(backfilled).toBe("2026-06-20");
  });
});

describe("a re-timed dose: old days by the OLD time, new days by the new one", () => {
  const dose = {
    time_of_day: "Morning",
    versions: [
      { effective_from: "2026-06-01", time_of_day: "Evening" },
      { effective_from: "2026-07-15", time_of_day: "Morning" },
    ],
  };

  it("attributes each day to the slot the dose actually held then", () => {
    expect(doseBucketOn(dose, "2026-06-20")).toBe("Evening");
    expect(doseBucketOn(dose, "2026-07-14")).toBe("Evening");
    expect(doseBucketOn(dose, "2026-07-15")).toBe("Morning");
    expect(doseBucketOn(dose, "2026-08-03")).toBe("Morning");
  });

  it("notices a slot change inside the window, and ignores one outside it", () => {
    expect(doseSlotChangedSince(dose, "2026-06-01")).toBe(true);
    // Window opening after the last change: nothing moved inside it.
    expect(doseSlotChangedSince(dose, "2026-07-20")).toBe(false);
  });

  it("does not call a within-bucket nudge a slot change", () => {
    // 08:00 → 07:30 is still Morning. The suggestion machinery keys on the BUCKET.
    const nudged = {
      time_of_day: "07:30 morning",
      versions: [
        { effective_from: "2026-06-01", time_of_day: "08:00 morning" },
        { effective_from: "2026-07-15", time_of_day: "07:30 morning" },
      ],
    };
    expect(doseSlotChangedSince(nudged, "2026-06-01")).toBe(false);
  });
});

describe("a cadence change is judged forward, never backward", () => {
  // The rewriting direction, which the invariant also forbids. A dose narrowed to
  // Mondays on 15 July was due every day in June; a dose widened from Mondays was not.
  const narrowed = {
    weekdays: "1",
    versions: [
      { effective_from: "2026-06-01", weekdays: null },
      { effective_from: "2026-07-15", weekdays: "1" },
    ],
  };

  it("does not retroactively forgive the days a daily dose was due", () => {
    // 2026-06-17 is a Wednesday. Under today's Mondays-only rule it would be "not
    // applicable"; under the rule in force then it was due, and stays due.
    expect(doseOnDay(narrowed, "2026-06-17")).toBe(true);
    expect(doseDueOn(ITEM, narrowed, ctx("2026-06-17"))).toBe(true);
  });

  it("applies the narrowed rule from its effective day onward", () => {
    // 2026-07-22 is a Wednesday, after the narrowing.
    expect(doseOnDay(narrowed, "2026-07-22")).toBe(false);
    // 2026-07-20 is a Monday.
    expect(doseOnDay(narrowed, "2026-07-20")).toBe(true);
  });

  it("does not retroactively INVENT misses when a dose is widened", () => {
    const widened = {
      weekdays: null,
      versions: [
        { effective_from: "2026-06-01", weekdays: "1" },
        { effective_from: "2026-07-15", weekdays: null },
      ],
    };
    // A Wednesday in June: the dose was Mondays-only then, so nothing was owed.
    expect(doseOnDay(widened, "2026-06-17")).toBe(false);
    // A Wednesday after the widening: owed.
    expect(doseOnDay(widened, "2026-07-22")).toBe(true);
  });

  it("effective-dates a validity window the same way", () => {
    const tapered = {
      start_date: "2026-07-15",
      end_date: null,
      versions: [
        { effective_from: "2026-06-01", start_date: null, end_date: null },
        { effective_from: "2026-07-15", start_date: "2026-07-15" },
      ],
    };
    expect(doseOnDay(tapered, "2026-06-20")).toBe(true);
    expect(doseOnDay(tapered, "2026-07-20")).toBe(true);
  });
});

describe("a legacy re-time, whose old slot nothing recorded", () => {
  // The one case effective-dating cannot reach: a dose re-timed BEFORE #1973 shipped.
  // Migration 151 seeds one version from the CURRENT row, so the pre-edit slot is
  // simply not knowable. Judging those days by today's rule would be the retroactive
  // re-accusation #430 clamped to avoid, so the conservative bound stays for them.
  it("reports the edit day when no version records the change", () => {
    expect(
      unrecordedScheduleChangeOn({
        updated_at: "2026-07-20 09:00:00",
        versions: [{ effective_from: "2026-06-01", time_of_day: "Evening" }],
      })
    ).toBe("2026-07-20");
  });

  it("reports it for a dose carrying no history at all", () => {
    expect(
      unrecordedScheduleChangeOn({ updated_at: "2026-07-20 09:00:00" })
    ).toBe("2026-07-20");
  });

  it("goes quiet once a version records that change", () => {
    // The self-heal: the write path records the pre-edit rule before appending the new
    // version, so the first edit after this ships gives the dose a real history.
    expect(
      unrecordedScheduleChangeOn({
        updated_at: "2026-07-20 09:00:00",
        versions: [
          { effective_from: "2026-06-01", time_of_day: "Evening" },
          { effective_from: "2026-07-20", time_of_day: "Morning" },
        ],
      })
    ).toBeNull();
  });

  it("is silent for a dose that was never edited", () => {
    expect(unrecordedScheduleChangeOn({ updated_at: null })).toBeNull();
    expect(
      unrecordedScheduleChangeOn({
        versions: [{ effective_from: "2026-06-01" }],
      })
    ).toBeNull();
  });

  it("withholds the move suggestion for a legacy re-time", () => {
    expect(
      doseSlotChangedSince(
        { time_of_day: "Morning", updated_at: "2026-07-20 09:00:00" },
        "2026-06-09"
      )
    ).toBe(true);
    // …but not when the edit predates the window being judged.
    expect(
      doseSlotChangedSince(
        { time_of_day: "Morning", updated_at: "2026-05-01 09:00:00" },
        "2026-06-09"
      )
    ).toBe(false);
  });
});

describe("a cosmetic edit moves no boundary at all", () => {
  // Name, amount, food timing and sort are absent from DoseSchedule by construction,
  // so they cannot reach the comparator that decides whether a version is appended.
  it("sees no difference when only non-schedule fields change", () => {
    const before = {
      time_of_day: "Morning",
      weekdays: null,
      start_date: null,
      end_date: null,
    };
    expect(
      doseScheduleDiffers(before, { ...before, amount: "1000 mg" } as never)
    ).toBe(false);
    expect(
      doseScheduleDiffers(before, {
        ...before,
        food_timing: "with_fat",
      } as never)
    ).toBe(false);
    expect(doseScheduleDiffers(before, before)).toBe(false);
  });

  it("treats absent and null schedule fields as the same rule", () => {
    // A no-op resubmission of a form must not look like a change, or every save would
    // append a version and fragment the history.
    expect(
      doseScheduleDiffers(
        { time_of_day: "Morning" },
        {
          time_of_day: "Morning",
          weekdays: null,
          start_date: null,
          end_date: null,
        }
      )
    ).toBe(false);
  });

  it("DOES see a dueness-relevant change", () => {
    const before = { time_of_day: "Morning", weekdays: null };
    expect(
      doseScheduleDiffers(before, { ...before, time_of_day: "Evening" })
    ).toBe(true);
    expect(doseScheduleDiffers(before, { ...before, weekdays: "1" })).toBe(
      true
    );
    expect(
      doseScheduleDiffers(before, { ...before, start_date: "2026-07-15" })
    ).toBe(true);
    expect(
      doseScheduleDiffers(before, { ...before, end_date: "2026-07-15" })
    ).toBe(true);
  });

  it("leaves the judged days untouched across a cosmetic edit", () => {
    // The whole point, stated end to end: a dose whose amount changed has ONE version,
    // so every day in its life resolves to the same rule and nothing moves.
    const dose = {
      time_of_day: "Morning",
      versions: [{ effective_from: "2026-06-01", time_of_day: "Morning" }],
    };
    for (const date of ["2026-06-02", "2026-07-01", "2026-08-03"]) {
      expect(doseDueOn(ITEM, dose, ctx(date))).toBe(true);
      expect(doseBucketOn(dose, date)).toBe("Morning");
    }
    expect(doseSlotChangedSince(dose, "2026-06-01")).toBe(false);
  });
});
