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
  acceptEatenAt,
  eatingTimeChoiceValue,
  eatingTimeOptions,
  parseEatingTimeChoice,
  resolveEatingTimeChoice,
} from "@/lib/food-eating-time";
import { dateStrInTz } from "@/lib/date";

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

describe("the offered `earlier…` hours (#2053)", () => {
  it("runs back from one hour ago, newest first", () => {
    const now = new Date("2026-03-10T18:30:00Z");
    const options = eatingTimeOptions(now, UTC, "2026-03-10");
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
      "2026-03-10"
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
    for (const option of eatingTimeOptions(now, UTC, "2026-03-10")) {
      expect(
        acceptEatenAt(new Date(option.iso), UTC, "2026-03-10", now)
      ).not.toBeNull();
    }
  });

  it("uses the PROFILE's timezone to decide which day an hour belongs to", () => {
    // 02:30Z is still the evening of the 9th in New York, so a full twelve hours are
    // offerable there while UTC — already past midnight on the 10th — offers two.
    const now = new Date("2026-03-10T02:30:00Z");
    expect(dateStrInTz(NY, now)).toBe("2026-03-09");
    expect(eatingTimeOptions(now, UTC, "2026-03-10")).toHaveLength(2);
    const options = eatingTimeOptions(now, NY, "2026-03-09");
    expect(options).toHaveLength(EATING_TIME_LAST_HOURS_BACK);
    expect(options[0].hhmm).toBe("21:00");
    for (const option of options) {
      expect(dateStrInTz(NY, new Date(option.iso))).toBe("2026-03-09");
    }
  });
});

describe("acceptEatenAt — validate, never drop (#2053)", () => {
  const now = new Date("2026-03-10T18:30:00Z");
  const date = "2026-03-10";

  it("accepts a same-day instant in the past", () => {
    const at = new Date("2026-03-10T13:00:00Z");
    expect(acceptEatenAt(at, UTC, date, now)).toEqual(at);
  });

  it("tolerates small clock skew but refuses a genuinely future instant", () => {
    const withinSkew = new Date(now.getTime() + EATEN_AT_FUTURE_SKEW_MS);
    expect(acceptEatenAt(withinSkew, UTC, date, now)).toEqual(withinSkew);
    const beyondSkew = new Date(now.getTime() + EATEN_AT_FUTURE_SKEW_MS + 1000);
    expect(acceptEatenAt(beyondSkew, UTC, date, now)).toBeNull();
  });

  it("refuses an instant whose profile-local date isn't the row's own day", () => {
    expect(
      acceptEatenAt(new Date("2026-03-09T20:00:00Z"), UTC, date, now)
    ).toBeNull();
  });

  it("judges that day in the PROFILE's timezone", () => {
    // 02:00Z on the 10th is 21:00 on the 9th in New York — the same instant belongs to
    // two different days depending on whose calendar is asked.
    const at = new Date("2026-03-10T02:00:00Z");
    expect(acceptEatenAt(at, UTC, "2026-03-10", now)).toEqual(at);
    expect(acceptEatenAt(at, NY, "2026-03-10", now)).toBeNull();
    expect(acceptEatenAt(at, NY, "2026-03-09", now)).toEqual(at);
  });

  it("treats absent and unparseable input as `no statement`", () => {
    expect(acceptEatenAt(null, UTC, date, now)).toBeNull();
    expect(acceptEatenAt(undefined, UTC, date, now)).toBeNull();
    expect(acceptEatenAt(new Date("not a date"), UTC, date, now)).toBeNull();
  });
});
