import { describe, expect, it } from "vitest";
import {
  slotDue,
  slotAttempt,
  clampTickMinutes,
  observedTickMinutes,
  subHourlySlotsAtRisk,
  inWakingWindow,
  parseNotifyTime,
  parseNotifyHour,
  formatNotifyTime,
  preWorkoutSlotMinute,
  AUTO_TIME,
  WAKING_START_HOUR,
  WAKING_END_HOUR,
  DEFAULT_TICK_MINUTES,
} from "@/lib/notifications/schedule";

const m = (h: number, min = 0) => h * 60 + min;

describe("slotAttempt / slotDue — minute grain with attempt bands (#2121)", () => {
  it("is due on the first tick at/after the slot minute", () => {
    expect(slotAttempt(m(8), m(8), 60)).toBe("first");
    expect(slotAttempt(m(8, 30), m(9), 60)).toBe("first"); // hourly tick, 8:30 slot → 9:00
    expect(slotAttempt(m(8, 30), m(8, 30), 15)).toBe("first");
    expect(slotAttempt(m(8, 37), m(8, 45), 15)).toBe("first");
  });

  it("offers exactly one retry attempt, an hour after the slot, at every tick rate", () => {
    // Hourly: identical to the old [slotHour, slotHour+1] behavior.
    expect(slotAttempt(m(8), m(9), 60)).toBe("retry");
    expect(slotAttempt(m(8), m(10), 60)).toBeNull();
    // 15-minute ticks: the intermediate ticks are NOT attempts — that is the
    // decided retry budget (2 attempts/day, not window/tick).
    expect(slotAttempt(m(8), m(8), 15)).toBe("first");
    expect(slotAttempt(m(8), m(8, 15), 15)).toBeNull();
    expect(slotAttempt(m(8), m(8, 30), 15)).toBeNull();
    expect(slotAttempt(m(8), m(8, 45), 15)).toBeNull();
    expect(slotAttempt(m(8), m(9), 15)).toBe("retry");
    expect(slotAttempt(m(8), m(9, 15), 15)).toBeNull();
  });

  it("counts exactly two due ticks per day for a failing send, hourly or 15-minute", () => {
    for (const tick of [60, 15, 5, 1]) {
      let due = 0;
      for (let now = 0; now < 1440; now += tick) {
        if (slotDue(m(7, 30), now, tick)) due++;
      }
      expect(due, `tick=${tick}`).toBe(2);
    }
  });

  it("is not due before the slot minute", () => {
    expect(slotDue(m(8), m(7, 59), 60)).toBe(false);
    expect(slotDue(m(8, 30), m(8, 15), 15)).toBe(false);
  });

  it("recovers a DST spring-forward skip: the first tick after the gap is an attempt", () => {
    // Slot 02:30; local minutes [120,180) never occur. Hourly tick: the 03:00
    // tick (offset 30) is the FIRST band — same recovery the old hour+1 gave.
    expect(slotAttempt(m(2, 30), m(3), 60)).toBe("first");
    // 15-minute ticks: 03:00/03:15 (offsets 30/45) skip, 03:30 (offset 60) is
    // the retry band — the slot still fires that day.
    expect(slotAttempt(m(2, 30), m(3), 15)).toBeNull();
    expect(slotAttempt(m(2, 30), m(3, 30), 15)).toBe("retry");
  });

  it("does not wrap past midnight (next day = fresh dedup key)", () => {
    expect(slotDue(m(23), m(23), 60)).toBe(true);
    expect(slotDue(m(23), m(0), 60)).toBe(false); // no midnight retry
    expect(slotDue(m(23), m(22), 60)).toBe(false);
    expect(slotDue(m(23, 30), m(0), 15)).toBe(false);
    expect(slotDue(m(23, 45), m(0, 45), 15)).toBe(false);
  });

  it("gives a last-hour slot its single attempt (no same-day retry exists)", () => {
    expect(slotAttempt(m(23, 30), m(23, 30), 15)).toBe("first");
    let due = 0;
    for (let now = 0; now < 1440; now += 15) {
      if (slotDue(m(23, 30), now, 15)) due++;
    }
    expect(due).toBe(1);
  });

  it("defaults to the hourly band width when no tick cadence is passed", () => {
    expect(slotDue(m(8, 30), m(9), DEFAULT_TICK_MINUTES)).toBe(
      slotDue(m(8, 30), m(9))
    );
  });
});

describe("clampTickMinutes / observedTickMinutes", () => {
  it("clamps unknown and out-of-range cadences to hourly", () => {
    expect(clampTickMinutes(null)).toBe(60);
    expect(clampTickMinutes(undefined)).toBe(60);
    expect(clampTickMinutes(NaN)).toBe(60);
    expect(clampTickMinutes(0)).toBe(60);
    expect(clampTickMinutes(-5)).toBe(60);
    expect(clampTickMinutes(240)).toBe(60); // downtime never widens past hourly
    expect(clampTickMinutes(15)).toBe(15);
  });

  it("rounds a measured interval to the nearest minute (never widens a band)", () => {
    // 15 min + a second of jitter must stay a 15-minute band: a 16-minute band
    // would let a slot on a tick boundary match two consecutive ticks.
    expect(clampTickMinutes(15.02)).toBe(15);
    expect(clampTickMinutes(14.98)).toBe(15);
  });

  it("derives the observed interval from the previous tick watermark", () => {
    const now = Date.parse("2026-08-05T12:00:00Z");
    expect(observedTickMinutes(null, now)).toBe(60); // first tick ever
    expect(observedTickMinutes(now - 15 * 60000, now)).toBe(15);
    expect(observedTickMinutes(now - 60 * 60000, now)).toBe(60);
    expect(observedTickMinutes(now - 4 * 3600000, now)).toBe(60); // outage clamps
    expect(observedTickMinutes(now + 1000, now)).toBe(60); // clock skew
  });
});

describe("subHourlySlotsAtRisk — the operator honesty check (#2121 constraint 4)", () => {
  it("flags sub-hourly times under an hourly scheduler and none under a 15-minute one", () => {
    expect(subHourlySlotsAtRisk([m(7, 30), m(13), null], 60)).toEqual([
      m(7, 30),
    ]);
    expect(subHourlySlotsAtRisk([m(7, 30), m(13)], 15)).toEqual([]);
  });

  it("never flags on-the-hour times at any cadence", () => {
    expect(subHourlySlotsAtRisk([m(7), m(23)], 60)).toEqual([]);
  });

  it("flags a time past the day's last tick even at a fine cadence", () => {
    // 23:50 under 15-minute ticks: last tick is 23:45 and slots never wrap.
    expect(subHourlySlotsAtRisk([m(23, 50)], 15)).toEqual([m(23, 50)]);
    expect(subHourlySlotsAtRisk([m(23, 40)], 15)).toEqual([]);
  });
});

describe("preWorkoutSlotMinute", () => {
  it("fires one hour before the inferred training time, wrapping at midnight", () => {
    expect(preWorkoutSlotMinute(m(18))).toBe(m(17));
    expect(preWorkoutSlotMinute(m(0, 30))).toBe(m(23, 30));
  });
});

describe("formatNotifyTime", () => {
  it("formats a minute of day as zero-padded HH:MM", () => {
    expect(formatNotifyTime(0)).toBe("00:00");
    expect(formatNotifyTime(m(7, 5))).toBe("07:05");
    expect(formatNotifyTime(m(23, 59))).toBe("23:59");
  });

  it("round-trips through parseNotifyTime", () => {
    for (const v of [0, m(6, 50), m(13), m(23, 59)]) {
      expect(parseNotifyTime(formatNotifyTime(v), null)).toBe(v);
    }
  });
});

describe("inWakingWindow — minute-grain current time over hour-typed bounds", () => {
  it("holds the episode nudges out at the local-midnight rollover and the 1-3am hours (#378)", () => {
    expect(inWakingWindow(m(0))).toBe(false);
    expect(inWakingWindow(m(1, 30))).toBe(false);
    expect(inWakingWindow(m(3))).toBe(false);
  });

  it("is inclusive of both window boundaries, through the end hour's :59", () => {
    expect(inWakingWindow(m(WAKING_START_HOUR))).toBe(true); // 8:00
    expect(inWakingWindow(m(WAKING_END_HOUR))).toBe(true); // 21:00
    expect(inWakingWindow(m(WAKING_END_HOUR, 59))).toBe(true); // 21:59
  });

  it("rejects the minutes just outside each boundary", () => {
    expect(inWakingWindow(m(WAKING_START_HOUR) - 1)).toBe(false); // 7:59
    expect(inWakingWindow(m(WAKING_END_HOUR + 1))).toBe(false); // 22:00
  });

  it("accepts an overridden window", () => {
    expect(inWakingWindow(m(7), 6, 22)).toBe(true);
    expect(inWakingWindow(m(5, 59), 6, 22)).toBe(false);
  });

  // #450 — per-profile quiet hours, incl. a night-shift window that wraps midnight.
  it("supports a wrapped (overnight) window for a night-shift rhythm (#450)", () => {
    // Awake 20:00 → 08:59 (start > end): the daytime hours are the QUIET ones.
    expect(inWakingWindow(m(20), 20, 8)).toBe(true); // start boundary
    expect(inWakingWindow(m(23, 30), 20, 8)).toBe(true); // late night
    expect(inWakingWindow(m(0), 20, 8)).toBe(true); // past midnight
    expect(inWakingWindow(m(8, 59), 20, 8)).toBe(true); // end boundary
    expect(inWakingWindow(m(9), 20, 8)).toBe(false); // into the quiet daytime
    expect(inWakingWindow(m(12), 20, 8)).toBe(false); // midday quiet
    expect(inWakingWindow(m(19, 59), 20, 8)).toBe(false); // just before waking
  });

  it("treats a full 0→23 window as always waking (no quiet hours)", () => {
    for (let h = 0; h <= 23; h++) {
      expect(inWakingWindow(m(h, 30), 0, 23)).toBe(true);
    }
  });

  it("treats a same start/end as a literal one-hour window", () => {
    expect(inWakingWindow(m(9, 59), 9, 9)).toBe(true);
    expect(inWakingWindow(m(10), 9, 9)).toBe(false);
  });
});

describe("parseNotifyTime — wake-aware resolution at minute grain (#1117, #2121)", () => {
  // The Morning slot: default IS the wake-derived minute, so absent AND "auto"
  // both resolve to it; a manual time wins; "" is off.
  const morning = (raw: string | undefined) =>
    parseNotifyTime(raw, m(6, 50), m(6, 50));

  it("resolves absent → the (wake-derived) default for the Morning slot", () => {
    expect(morning(undefined)).toBe(m(6, 50));
  });

  it("resolves the AUTO sentinel → the wake-derived value", () => {
    expect(morning(AUTO_TIME)).toBe(m(6, 50));
  });

  it("honors a manual HH:MM — it always wins over seeding", () => {
    expect(morning("09:15")).toBe(m(9, 15));
    expect(morning("00:00")).toBe(0);
    expect(morning("23:59")).toBe(m(23, 59));
  });

  it("parses a LEGACY bare integer hour as HH:00 (pre-migration-158 value)", () => {
    expect(morning("9")).toBe(m(9));
    expect(morning("0")).toBe(0);
    expect(morning("23")).toBe(m(23));
  });

  it("treats an empty string as explicitly off (null)", () => {
    expect(morning("")).toBeNull();
  });

  it("falls back for a corrupt / out-of-range value", () => {
    expect(morning("99")).toBe(m(6, 50));
    expect(morning("-1")).toBe(m(6, 50));
    expect(morning("24:00")).toBe(m(6, 50));
    expect(morning("7:5")).toBe(m(6, 50)); // malformed minutes
    expect(morning("nonsense")).toBe(m(6, 50));
  });

  it("digest: absent → off (opt-in preserved), but AUTO → wake-derived", () => {
    expect(parseNotifyTime(undefined, null, m(6, 56))).toBeNull();
    expect(parseNotifyTime(AUTO_TIME, null, m(6, 56))).toBe(m(6, 56));
    expect(parseNotifyTime("", null, m(6, 56))).toBeNull();
    expect(parseNotifyTime("08:00", null, m(6, 56))).toBe(m(8));
  });

  it("autoValue defaults to absentFallback for slots without a wake mode", () => {
    expect(parseNotifyTime(AUTO_TIME, m(13))).toBe(m(13));
    expect(parseNotifyTime(undefined, m(13))).toBe(m(13));
  });
});

describe("parseNotifyHour — the surviving hour-typed settings (waking window, backup)", () => {
  it("keeps the 0-23 vocabulary for hour-typed keys", () => {
    expect(parseNotifyHour(undefined, 8)).toBe(8);
    expect(parseNotifyHour("", 8)).toBeNull();
    expect(parseNotifyHour("21", 8)).toBe(21);
    expect(parseNotifyHour("99", 8)).toBe(8);
  });
});
