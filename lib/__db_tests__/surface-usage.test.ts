// DB INTEGRATION TIER — the surface-usage read model (issue #4249) and its first
// consumer, the log sheet's opening segment.
//
// `logged_via` has been fully built on the WRITE side since #3087 and had ZERO
// analytical readers; this file covers the first one. What needs a database is
// everything the model claims: that it separates surfaces at all, that it counts
// distinct days per surface over its declared window, that an unattributable row is
// not evidence — and, for the consumer, the defect that filed the issue.
//
// THE DEFECT, IN ONE SENTENCE. The sheet's opening segment was inferred from
// `source` filters, and `source` describes device-versus-hand rather than surface,
// so a profile who logged food exclusively through Telegram taught the WEB sheet a
// food habit it did not have on the web — the sheet opened on Consume for somebody
// who had never logged food there. The case named "opens on Care, not Consume"
// below is that defect, and it fails on the old measure.
//
// EVERY FIXTURE DRIVES A REAL WRITE CORE. The surfaces have to be the ones the app
// stamps, or the separation this file asserts is a separation of the fixture's own
// invention (#2720's lesson, one column over).
//
// SYNTHETIC ONLY: fictional profiles, invented symptoms. No PHI.

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { logFoodServingCore } from "@/lib/food-log-write";
import { logSymptomCore } from "@/lib/symptom-log-write";
import {
  LOG_HABIT_MIN_DAYS,
  logSheetSegments,
  openingLogSegment,
} from "@/lib/log-sheet";
import { getSegmentLogDays } from "@/lib/queries/log-sheet";
import { channelDays, getSurfaceUsage } from "@/lib/queries/surface-usage";
import { SURFACE_USAGE_WINDOW_DAYS } from "@/lib/surface-usage";

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
  return { profileId, anchor: today(profileId) };
}

/** `n` consecutive days of food ending on the anchor, logged from one surface. */
function foodDays(
  profileId: number,
  anchor: string,
  n: number,
  via: "telegram-text" | "telegram-nudge" | "quick-log" | "page",
  offset = 0
): void {
  for (let d = 0; d < n; d++) {
    expect(
      logFoodServingCore(
        profileId,
        "fruit",
        shiftDateStr(anchor, -(d + offset)),
        via
      ).kind
    ).toBe("logged");
  }
}

/** The same, for symptoms. */
function symptomDays(
  profileId: number,
  anchor: string,
  n: number,
  via: "telegram-nudge" | "page",
  offset = 0
): void {
  for (let d = 0; d < n; d++) {
    expect(
      logSymptomCore(
        profileId,
        "headache",
        2,
        shiftDateStr(anchor, -(d + offset)),
        via
      ).kind
    ).toBe("logged");
  }
}

function daysOn(
  profileId: number,
  anchor: string,
  ledger: "food_log_events" | "symptom_logs",
  channel: "web" | "telegram"
): number {
  return (
    channelDays(getSurfaceUsage(profileId, anchor), channel).get(ledger)
      ?.size ?? 0
  );
}

describe("getSurfaceUsage — which surfaces this profile acts on", () => {
  it("keeps the chat and the web apart, per ledger", () => {
    const { profileId, anchor } = makeProfile("Usage Split");
    foodDays(profileId, anchor, 5, "telegram-text");
    symptomDays(profileId, anchor, 3, "page");

    const usage = getSurfaceUsage(profileId, anchor);
    expect(usage.windowDays).toBe(SURFACE_USAGE_WINDOW_DAYS);
    expect(usage.through).toBe(anchor);

    // The raw model reports the SURFACE, not only the channel: that is what the
    // named future consumer (which surface do you confirm doses on?) will read.
    expect([...(usage.days.get("food_log_events")?.keys() ?? [])]).toEqual([
      "telegram-text",
    ]);
    expect([...(usage.days.get("symptom_logs")?.keys() ?? [])]).toEqual([
      "page",
    ]);

    expect(daysOn(profileId, anchor, "food_log_events", "telegram")).toBe(5);
    expect(daysOn(profileId, anchor, "food_log_events", "web")).toBe(0);
    expect(daysOn(profileId, anchor, "symptom_logs", "web")).toBe(3);
    expect(daysOn(profileId, anchor, "symptom_logs", "telegram")).toBe(0);
  });

  it("counts DAYS per surface, not rows", () => {
    const { profileId, anchor } = makeProfile("Usage Days");
    for (const group of ["fruit", "legumes", "nuts_seeds"]) {
      expect(
        logFoodServingCore(profileId, group, anchor, "quick-log").kind
      ).toBe("logged");
    }
    expect(daysOn(profileId, anchor, "food_log_events", "web")).toBe(1);
  });

  it("splits one ledger's days across the two surfaces that wrote them", () => {
    const { profileId, anchor } = makeProfile("Usage Mixed");
    foodDays(profileId, anchor, 4, "quick-log");
    foodDays(profileId, anchor, 6, "telegram-nudge", 4);
    expect(daysOn(profileId, anchor, "food_log_events", "web")).toBe(4);
    expect(daysOn(profileId, anchor, "food_log_events", "telegram")).toBe(6);
  });

  it("stops at the declared window edge", () => {
    const { profileId, anchor } = makeProfile("Usage Window");
    foodDays(profileId, anchor, 1, "quick-log", SURFACE_USAGE_WINDOW_DAYS - 1);
    foodDays(profileId, anchor, 1, "quick-log", SURFACE_USAGE_WINDOW_DAYS);
    expect(daysOn(profileId, anchor, "food_log_events", "web")).toBe(1);
  });

  it("reads an unstamped row as no surface at all", () => {
    const { profileId, anchor } = makeProfile("Usage Unstamped");
    // The shape of every row written before #3087's tranche: the column arrived
    // nullable with no backfill, so the app does not know where these came from.
    db.prepare(
      `INSERT INTO symptom_logs (profile_id, date, symptom, severity)
       VALUES (?, ?, 'headache', 2)`
    ).run(profileId, anchor);
    expect(getSurfaceUsage(profileId, anchor).days.get("symptom_logs")).toBe(
      undefined
    );
  });

  it("counts one profile's acts only", () => {
    const mine = makeProfile("Usage Mine");
    const theirs = makeProfile("Usage Theirs");
    foodDays(theirs.profileId, theirs.anchor, 4, "quick-log");
    expect(getSurfaceUsage(mine.profileId, mine.anchor).days.size).toBe(0);
    expect(
      daysOn(theirs.profileId, theirs.anchor, "food_log_events", "web")
    ).toBe(4);
  });
});

describe("habitualLogSegment's evidence base is the web half of that model", () => {
  // ── THE RED-FIRST CASE (#4249's acceptance criterion) ──────────────────────
  //
  // On the old `source` measure this profile's 14 Telegram food days outvoted its
  // 10 web symptom days and the dashboard opened on Consume — a food habit the
  // person does not have on the web. It now opens on Care.
  it("opens on Care, not Consume, for a chat-only eater who logs symptoms here", () => {
    const { profileId, anchor } = makeProfile("Surface Care");
    foodDays(profileId, anchor, 14, "telegram-text");
    symptomDays(profileId, anchor, 10, "page");

    expect(getSegmentLogDays(profileId, anchor)).toEqual({ care: 10 });
    expect(
      openingLogSegment({
        segments: logSheetSegments(true),
        pathname: "/",
        habitDays: getSegmentLogDays(profileId, anchor),
      })
    ).toBe("care");
  });

  it("counts the web half of a profile who logs food on both surfaces", () => {
    const { profileId, anchor } = makeProfile("Surface Mixed");
    foodDays(profileId, anchor, 8, "quick-log");
    foodDays(profileId, anchor, 20, "telegram-nudge", 8);
    expect(getSegmentLogDays(profileId, anchor)).toEqual({ food: 8 });
    expect(
      openingLogSegment({
        segments: logSheetSegments(true),
        pathname: "/",
        habitDays: getSegmentLogDays(profileId, anchor),
      })
    ).toBe("food");
  });

  it("keeps the route's own default below the seven-day floor", () => {
    const { profileId, anchor } = makeProfile("Surface Floor");
    symptomDays(profileId, anchor, LOG_HABIT_MIN_DAYS - 1, "page");
    expect(getSegmentLogDays(profileId, anchor)).toEqual({
      care: LOG_HABIT_MIN_DAYS - 1,
    });
    // Under the floor the answer is not adapted at all — the dashboard's historical
    // fallback stands, exactly as it does for a profile with no history.
    expect(
      openingLogSegment({
        segments: logSheetSegments(true),
        pathname: "/",
        habitDays: getSegmentLogDays(profileId, anchor),
      })
    ).toBe("train");
    symptomDays(profileId, anchor, 1, "page", LOG_HABIT_MIN_DAYS - 1);
    expect(
      openingLogSegment({
        segments: logSheetSegments(true),
        pathname: "/",
        habitDays: getSegmentLogDays(profileId, anchor),
      })
    ).toBe("care");
  });

  // ── THE #3077 GUARDRAIL, ASSERTED RATHER THAN ASSUMED ──────────────────────
  //
  // Usage evidence may pick a default or an order, NEVER remove or hide. A profile
  // whose every act is in the chat has no web evidence at all, which is precisely
  // the state that could tempt a measure into hiding something.
  it("never removes a segment or lands off the track, however lopsided the evidence", () => {
    const { profileId, anchor } = makeProfile("Surface Doctrine");
    foodDays(profileId, anchor, 30, "telegram-text");
    symptomDays(profileId, anchor, 30, "telegram-nudge");
    const segments = logSheetSegments(true);
    expect(segments.map((s) => s.id)).toEqual([
      "train",
      "food",
      "body",
      "care",
    ]);
    expect(getSegmentLogDays(profileId, anchor)).toEqual({});
    const opened = openingLogSegment({
      segments,
      pathname: "/",
      habitDays: getSegmentLogDays(profileId, anchor),
    });
    expect(segments.map((s) => s.id)).toContain(opened);
    // And every entry is still reachable: the measure chose which tab opens, and
    // nothing else.
    expect(segments.flatMap((s) => s.items).length).toBeGreaterThan(0);
  });
});
