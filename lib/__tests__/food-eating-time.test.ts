// PURE TIER — the web bar's eating-time statement (#2053): the choice vocabulary, the
// offered hours, and the ONE acceptance gate every path goes through.
//
// The properties worth pinning are the ones that keep a serving from contradicting
// itself: an offered hour always lands on the day it is being logged to, a future or
// wrong-day instant costs the STATEMENT rather than the serving, and the profile's
// timezone — never the runner's — decides which day an instant belongs to.

import { describe, it, expect } from "vitest";
import {
  EATEN_AT_FUTURE_SKEW_MS,
  EATING_TIME_LAST_HOURS_BACK,
  judgeEatenAt,
  eatingHoursOnDate,
  eatingTimeChoiceValue,
  eatingTimeOptions,
  parseEatingTimeChoice,
  resolveEatingTimeChoice,
} from "@/lib/food-eating-time";
import {
  DEFAULT_EVENING_BOUNDARY_MIN,
  DEFAULT_MIDDAY_BOUNDARY_MIN,
  foodSlotForHhmm,
  type FoodSlotBoundaries,
} from "@/lib/food-slot";
import { dateStrInTz, zonedDateParts } from "@/lib/date";
import {
  chipOffers,
  collapseBursts,
  pickerHourOptions,
  statedHourInstant,
} from "@/lib/correction-time";

const UTC = "UTC";
const NY = "America/New_York";

describe("parsing an eating-time choice (#2053)", () => {
  it("accepts the two shapes and nothing else", () => {
    expect(parseEatingTimeChoice("now")).toEqual({ kind: "now" });
    expect(parseEatingTimeChoice("13:00")).toEqual({
      kind: "at",
      hhmm: "13:00",
    });
    expect(parseEatingTimeChoice(" 07:30 ")).toEqual({
      kind: "at",
      hhmm: "07:30",
    });
  });

  it("refuses garbage rather than coercing it into a plausible time", () => {
    for (const raw of [
      "",
      "   ",
      "later",
      "25:00",
      "7:00",
      "13:60",
      13,
      null,
    ]) {
      expect(parseEatingTimeChoice(raw)).toBeNull();
    }
  });

  it("round-trips through the wire spelling", () => {
    for (const choice of [
      { kind: "now" as const },
      { kind: "at" as const, hhmm: "09:00" },
    ]) {
      expect(parseEatingTimeChoice(eatingTimeChoiceValue(choice))).toEqual(
        choice
      );
    }
  });
});

describe("resolving a choice to an instant (#2053)", () => {
  const now = new Date("2026-03-10T18:30:00Z");

  it("`now` is the caller's own now — the server's clock on the online path", () => {
    expect(
      resolveEatingTimeChoice({ kind: "now" }, now, UTC)!.toISOString()
    ).toBe(now.toISOString());
  });

  it("an absolute hour resolves to that wall time today", () => {
    expect(
      resolveEatingTimeChoice({ kind: "at", hhmm: "13:00" }, now, UTC)!
    ).toEqual(new Date("2026-03-10T13:00:00Z"));
  });

  it("an hour LATER than the current local time means yesterday's — the day rule", () => {
    const justAfterMidnight = new Date("2026-03-10T00:30:00Z");
    expect(
      resolveEatingTimeChoice(
        { kind: "at", hhmm: "20:00" },
        justAfterMidnight,
        UTC
      )!
    ).toEqual(new Date("2026-03-09T20:00:00Z"));
  });

  it("does not drift with the delay between rendering and choosing", () => {
    const later = new Date(now.getTime() + 7 * 60_000);
    expect(
      resolveEatingTimeChoice({ kind: "at", hhmm: "13:00" }, later, UTC)!
    ).toEqual(
      resolveEatingTimeChoice({ kind: "at", hhmm: "13:00" }, now, UTC)!
    );
  });
});

// The profile-default boundaries, spelled through the same constants the derivation
// exports — the neutral case for the tests that are not about the enrichment.
const DEFAULTS: FoodSlotBoundaries = {
  midday: DEFAULT_MIDDAY_BOUNDARY_MIN,
  evening: DEFAULT_EVENING_BOUNDARY_MIN,
};

describe("the offered `earlier…` hours (#2053)", () => {
  it("runs back from one hour ago, newest first", () => {
    const now = new Date("2026-03-10T18:30:00Z");
    const options = eatingTimeOptions(now, UTC, "2026-03-10", DEFAULTS);
    expect(options).toHaveLength(EATING_TIME_LAST_HOURS_BACK);
    expect(options[0].hhmm).toBe("17:00");
    expect(options[options.length - 1].hhmm).toBe("06:00");
    expect(options[0].iso).toBe("2026-03-10T17:00:00.000Z");
  });

  it("offers only hours that land on the day being logged to", () => {
    // 04:30 — the twelve-hour reach mostly points at yesterday, and those chips are
    // dropped rather than being offered and then refused by the write.
    const options = eatingTimeOptions(
      new Date("2026-03-10T04:30:00Z"),
      UTC,
      "2026-03-10",
      DEFAULTS
    );
    expect(options.map((o) => o.hhmm)).toEqual([
      "03:00",
      "02:00",
      "01:00",
      "00:00",
    ]);
  });

  it("every offered instant is accepted by the write's own gate", () => {
    const now = new Date("2026-03-10T04:30:00Z");
    for (const option of eatingTimeOptions(now, UTC, "2026-03-10", DEFAULTS)) {
      expect(
        judgeEatenAt(new Date(option.iso), UTC, "2026-03-10", now).kind
      ).toBe("accepted");
    }
  });

  it("uses the PROFILE's timezone to decide which day an hour belongs to", () => {
    // 02:30Z is still the evening of the 9th in New York, so a full twelve hours are
    // offerable there while UTC — already past midnight on the 10th — offers two.
    const now = new Date("2026-03-10T02:30:00Z");
    expect(dateStrInTz(NY, now)).toBe("2026-03-09");
    expect(eatingTimeOptions(now, UTC, "2026-03-10", DEFAULTS)).toHaveLength(2);
    const options = eatingTimeOptions(now, NY, "2026-03-09", DEFAULTS);
    expect(options).toHaveLength(EATING_TIME_LAST_HOURS_BACK);
    expect(options[0].hhmm).toBe("21:00");
    for (const option of options) {
      expect(dateStrInTz(NY, new Date(option.iso))).toBe("2026-03-09");
    }
  });

  // ---- #2269: the log-time offer carries the filing --------------------------
  //
  // The chip announces the CONSEQUENCE before the tap: a stated hour wins the meal
  // at log time, so each option carries the window `foodSlotForHhmm` derives under
  // the profile's OWN boundaries — non-default ones here, so a hard-coded 11:00/15:00
  // in the enrichment cannot pass. Same shape as the correction sheet's
  // `eatingHoursOnDate` (#2268): one vocabulary, two surfaces.
  it("each option carries the window its hour derives to under the profile's boundaries (#2269)", () => {
    // Morning ends 10:00, Evening starts 16:00 — a coherently shifted schedule.
    const SHIFTED: FoodSlotBoundaries = { midday: 10 * 60, evening: 16 * 60 };
    const now = new Date("2026-03-10T18:30:00Z");
    const options = eatingTimeOptions(now, UTC, "2026-03-10", SHIFTED);
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.slot).toBe(foodSlotForHhmm(option.hhmm, SHIFTED));
    }
    // The boundaries actually bit: 10:00 is Midday here (default calls it Morning),
    // and 17:00 — the newest offer — is already Evening.
    expect(options[0]).toMatchObject({ hhmm: "17:00", slot: "Evening" });
    expect(options.find((o) => o.hhmm === "10:00")).toMatchObject({
      slot: "Midday",
    });
  });
});

// ---- #2227: the correction sheet's day-hours offer ---------------------------
//
// The neutral halves — today truncation, the profile-local "today", DST behavior,
// option ordering — are pinned in lib/__tests__/stated-time.test.ts against
// statedHoursOnDate itself. What is genuinely FOOD here, and therefore pinned here,
// is the enrichment: each offered hour carries the meal window it derives to under
// the profile's OWN boundaries, which is the data decision 4's follow-the-hour Meal
// default runs on. Non-default boundaries throughout, so an accidental hard-coded
// 11:00/15:00 in the adapter cannot pass.
describe("eatingHoursOnDate — the correction offer (#2227)", () => {
  // A coherently shifted schedule: Morning ends 10:00, Evening starts 16:00.
  const SHIFTED: FoodSlotBoundaries = { midday: 10 * 60, evening: 16 * 60 };
  const now = new Date("2026-03-10T18:30:00Z");

  it("offers all 24 hours of a past day, each carrying its derived meal window", () => {
    const options = eatingHoursOnDate("2026-03-09", UTC, now, SHIFTED);
    expect(options).toHaveLength(24);
    for (const option of options) {
      // The slot is exactly what the boundary function says for that wall hour —
      // the same derivation the server's tallies use, so the Meal default the sheet
      // renders is the window the corrected serving will actually be counted in.
      expect(option.slot).toBe(foodSlotForHhmm(option.hhmm, SHIFTED));
    }
    // The boundaries actually bit: the shifted schedule flips 10:00 to Midday
    // (default boundaries would call it Morning).
    expect(options[9]).toMatchObject({ hhmm: "09:00", slot: "Morning" });
    expect(options[10]).toMatchObject({ hhmm: "10:00", slot: "Midday" });
    expect(options[16]).toMatchObject({ hhmm: "16:00", slot: "Evening" });
  });

  it("truncates today at the current local hour", () => {
    const options = eatingHoursOnDate("2026-03-10", UTC, now, SHIFTED);
    expect(options.map((o) => o.hhmm)).toEqual(
      Array.from({ length: 19 }, (_, h) => `${String(h).padStart(2, "0")}:00`)
    );
  });

  it("every option's iso round-trips to its own hhmm and date", () => {
    for (const option of eatingHoursOnDate("2026-03-09", NY, now, SHIFTED)) {
      const parts = zonedDateParts(NY, new Date(option.iso));
      expect(parts.date).toBe("2026-03-09");
      expect(parts.hhmm).toBe(option.hhmm);
    }
  });

  it("a DST transition day has no duplicate or missing hour", () => {
    // Spring forward (America/New_York, 2026-03-08): 02:00 does not exist, so the
    // day offers 23 hours — the nonexistent one absent, none doubled.
    const spring = eatingHoursOnDate("2026-03-08", NY, now, SHIFTED);
    expect(spring).toHaveLength(23);
    expect(spring.map((o) => o.hhmm)).not.toContain("02:00");
    expect(new Set(spring.map((o) => o.hhmm)).size).toBe(23);
    // Fall back (2026-11-01): each wall hour offered exactly once, settled onto one
    // instant, with its slot still derived from the wall clock.
    const fall = eatingHoursOnDate("2026-11-01", NY, now, SHIFTED);
    expect(fall).toHaveLength(24);
    expect(new Set(fall.map((o) => o.hhmm)).size).toBe(24);
  });

  it("never offers an hour the acceptance gate would refuse (offer↔gate agreement)", () => {
    for (const date of ["2026-03-09", "2026-03-10"]) {
      for (const option of eatingHoursOnDate(date, UTC, now, SHIFTED)) {
        expect(judgeEatenAt(new Date(option.iso), UTC, date, now).kind).toBe(
          "accepted"
        );
      }
    }
  });
});

describe("judgeEatenAt — validate, never drop, never silently (#2053, #2296)", () => {
  const now = new Date("2026-03-10T18:30:00Z");
  const date = "2026-03-10";

  it("accepts a same-day instant in the past", () => {
    const at = new Date("2026-03-10T13:00:00Z");
    expect(judgeEatenAt(at, UTC, date, now)).toEqual({ kind: "accepted", at });
  });

  it("tolerates small clock skew but refuses a genuinely future instant", () => {
    const withinSkew = new Date(now.getTime() + EATEN_AT_FUTURE_SKEW_MS);
    expect(judgeEatenAt(withinSkew, UTC, date, now)).toEqual({
      kind: "accepted",
      at: withinSkew,
    });
    const beyondSkew = new Date(now.getTime() + EATEN_AT_FUTURE_SKEW_MS + 1000);
    expect(judgeEatenAt(beyondSkew, UTC, date, now)).toEqual({
      kind: "refused",
      reason: "future",
    });
  });

  it("refuses an instant whose profile-local date isn't the row's own day", () => {
    expect(
      judgeEatenAt(new Date("2026-03-09T20:00:00Z"), UTC, date, now)
    ).toEqual({ kind: "refused", reason: "other-day" });
  });

  it("judges that day in the PROFILE's timezone", () => {
    // 02:00Z on the 10th is 21:00 on the 9th in New York — the same instant belongs to
    // two different days depending on whose calendar is asked.
    const at = new Date("2026-03-10T02:00:00Z");
    expect(judgeEatenAt(at, UTC, "2026-03-10", now)).toEqual({
      kind: "accepted",
      at,
    });
    expect(judgeEatenAt(at, NY, "2026-03-10", now)).toEqual({
      kind: "refused",
      reason: "other-day",
    });
    expect(judgeEatenAt(at, NY, "2026-03-09", now)).toEqual({
      kind: "accepted",
      at,
    });
  });

  it("keeps `no statement` apart from `a statement we threw away`", () => {
    // The #2296 distinction, at the food door: an absent choice has nothing to
    // report, an unreadable one does. Both leave `eaten_at` NULL; only one leaves
    // the user owed an explanation.
    expect(judgeEatenAt(null, UTC, date, now)).toEqual({ kind: "unstated" });
    expect(judgeEatenAt(undefined, UTC, date, now)).toEqual({
      kind: "unstated",
    });
    expect(judgeEatenAt(new Date("not a date"), UTC, date, now)).toEqual({
      kind: "refused",
      reason: "malformed",
    });
  });
});

// ---- #2206: the two surfaces speak ONE chip language ------------------------
//
// The web bar and the Telegram correction row answer the same question ("when was this
// eaten") and share `hourOptionsBack`. Before #2206 they had drifted apart in what a
// button SAYS: the web offered absolute local hours, Telegram offered `−1h`. This pins
// them together — an offer on either surface names a WALL TIME, never a bare offset,
// because a bare offset is arithmetic handed back to the user.
describe("the web and Telegram offers use one vocabulary (#2206)", () => {
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d/;
  const TZ = "Europe/Berlin";

  it("names an absolute local time on every offer of both surfaces", () => {
    const now = new Date("2026-08-05T19:30:00Z");
    // Web: the "Earlier…" hours.
    const web = eatingTimeOptions(now, TZ, dateStrInTz(TZ, now), DEFAULTS);
    expect(web.length).toBeGreaterThan(0);
    for (const option of web) expect(option.hhmm).toMatch(HHMM);

    // Telegram: the picker's hours, and the chips beside it.
    for (const hhmm of pickerHourOptions(now, TZ)) expect(hhmm).toMatch(HHMM);
    const burst = collapseBursts([
      { id: 1, tapAt: "2026-08-05T19:02:00Z", label: "Salmon" },
    ])[0];
    const offers = chipOffers(burst, now, TZ);
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      expect(offer.label).toMatch(HHMM);
      // And that time is the one the tap would store, not a re-derivation of it.
      expect(offer.label.startsWith(zonedDateParts(TZ, offer.at).hhmm)).toBe(
        true
      );
    }
  });

  it("resolves a web hour and a picker hour through the SAME day rule", () => {
    // 00:30 local: an offered hour later than now means yesterday's, on both surfaces,
    // because there is only one `statedHourInstant`.
    const now = new Date("2026-08-05T22:30:00Z");
    expect(
      resolveEatingTimeChoice({ kind: "at", hhmm: "20:00" }, now, TZ)
    ).toEqual(statedHourInstant("20:00", now, TZ));
  });
});
