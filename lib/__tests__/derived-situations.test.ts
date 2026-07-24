import { describe, it, expect } from "vitest";
import {
  measureRoughNight,
  roughNightVerdict,
  periodVerdict,
  poorSleepStateLine,
  periodStateLine,
  withPeriodOption,
  poorSleepOverrideKey,
  POOR_SLEEP_OVERRIDE_PREFIX,
  BUILTIN_POOR_SLEEP_SITUATION,
  BUILTIN_PERIOD_SITUATION,
} from "@/lib/derived-situations";
import {
  restReasons,
  DEFAULT_COACHING_THRESHOLDS,
  type CoachingInput,
  type SleepSignal,
} from "@/lib/coaching";
import { dedupeKeyHasKnownPrefix } from "@/lib/rule-finding-prefixes";
import { mergedSituationOptions } from "@/lib/situations";

const TH = DEFAULT_COACHING_THRESHOLDS;

// A minimal CoachingInput that fires ONLY the sleep trigger (no training history, no
// RHR), so restReasons output isolates the rough-night behavior for the pin test.
function sleepOnlyInput(
  sleep: SleepSignal | null,
  poorSleepDeclared = false
): CoachingInput {
  return {
    today: "2026-07-24",
    routine: [],
    strength: [],
    cardio: [],
    trainingDates: [],
    sleep,
    restingHr: null,
    poorSleepDeclared,
  };
}

describe("measureRoughNight — the extracted threshold evaluation", () => {
  it("fires below the absolute floor regardless of baseline", () => {
    // 5h (300 min) < 6h floor, baseline unknown/low.
    const m = measureRoughNight({ lastNightMin: 300, baselineMin: 300 }, TH);
    expect(m.belowFloor).toBe(true);
    expect(m.fired).toBe(true);
  });

  it("fires below baseline by more than the deficit", () => {
    // 6.5h vs 8.5h baseline → 120 min under, > 90 deficit, above floor.
    const m = measureRoughNight({ lastNightMin: 390, baselineMin: 510 }, TH);
    expect(m.belowBaseline).toBe(true);
    expect(m.belowFloor).toBe(false);
    expect(m.fired).toBe(true);
  });

  it("does NOT fire on a normal night", () => {
    const m = measureRoughNight({ lastNightMin: 470, baselineMin: 480 }, TH);
    expect(m.fired).toBe(false);
  });

  it("widens the deficit for a variable sleeper (spread-aware)", () => {
    // 100 min under baseline, above floor. With a 60-min spread the effective deficit
    // is 2×60=120 > 100, so a variable sleeper is NOT flagged; a stable one IS.
    const sig = { lastNightMin: 440, baselineMin: 540, baselineSpreadMin: 60 };
    expect(measureRoughNight(sig, TH).fired).toBe(false);
    expect(
      measureRoughNight({ ...sig, baselineSpreadMin: undefined }, TH).fired
    ).toBe(true);
  });

  it("partial-night boundary: exactly at the floor does not fire on floor alone", () => {
    // lastNight == floor (360) → belowFloor is strict `<`, so not fired by floor.
    const m = measureRoughNight({ lastNightMin: 360, baselineMin: 360 }, TH);
    expect(m.belowFloor).toBe(false);
    expect(m.fired).toBe(false);
  });
});

describe("roughNightVerdict — declared/measured/override matrix (#1292)", () => {
  const rough: SleepSignal = { lastNightMin: 300, baselineMin: 480 };
  const fine: SleepSignal = { lastNightMin: 475, baselineMin: 480 };

  it("measured: a rough night with no declaration is ON with basis measured", () => {
    const v = roughNightVerdict({
      sleep: rough,
      thresholds: TH,
      declared: false,
      overridden: false,
    });
    expect(v).toMatchObject({ on: true, basis: "measured", lastNightMin: 300 });
  });

  it("override suppresses ONLY the derived (measured) contribution for the day", () => {
    const v = roughNightVerdict({
      sleep: rough,
      thresholds: TH,
      declared: false,
      overridden: true,
    });
    expect(v.on).toBe(false);
    expect(v.basis).toBeNull();
  });

  it("declared wins over the data (user wins): ON, basis declared, even with a fine night", () => {
    const v = roughNightVerdict({
      sleep: fine,
      thresholds: TH,
      declared: true,
      overridden: false,
    });
    expect(v).toEqual({ on: true, basis: "declared" });
  });

  it("declared is NOT cleared by the override (override only touches derived)", () => {
    const v = roughNightVerdict({
      sleep: rough,
      thresholds: TH,
      declared: true,
      overridden: true,
    });
    expect(v).toEqual({ on: true, basis: "declared" });
  });

  it("missing data ⇒ OFF (never a guess) unless declared", () => {
    expect(
      roughNightVerdict({
        sleep: null,
        thresholds: TH,
        declared: false,
        overridden: false,
      }).on
    ).toBe(false);
    expect(
      roughNightVerdict({
        sleep: null,
        thresholds: TH,
        declared: true,
        overridden: false,
      })
    ).toEqual({ on: true, basis: "declared" });
  });

  it("no baseline (baselineMin 0) ⇒ measured never fires by baseline", () => {
    // Only the floor can fire; a long night with no baseline stays OFF.
    const v = roughNightVerdict({
      sleep: { lastNightMin: 470, baselineMin: 0 },
      thresholds: TH,
      declared: false,
      overridden: false,
    });
    expect(v.on).toBe(false);
  });
});

describe("restReasons — the #1292 coaching pin (measured unchanged, declared added)", () => {
  it("measured rough night yields the byte-for-byte pre-extraction copy", () => {
    // 5.0h vs 8.0h baseline → below baseline.
    const reasons = restReasons(
      sleepOnlyInput({ lastNightMin: 300, baselineMin: 480 }),
      TH
    );
    const sleep = reasons.find((r) => r.id === "rest-sleep");
    expect(sleep).toBeTruthy();
    expect(sleep!.reasonCore).toBe(
      "You slept 5.0h last night, below your ~8.0h average"
    );
    expect(sleep!.also).toBe("slept 5.0h (below your ~8.0h average)");
  });

  it("a DECLARED rough night reaches coaching with basis-aware copy (no figures)", () => {
    // A fine measured night, but the user declared Poor sleep.
    const reasons = restReasons(
      sleepOnlyInput({ lastNightMin: 475, baselineMin: 480 }, true),
      TH
    );
    const sleep = reasons.find((r) => r.id === "rest-sleep");
    expect(sleep).toBeTruthy();
    expect(sleep!.reasonCore).toBe("You flagged a rough night");
    expect(sleep!.also).toBe("you flagged a rough night");
  });

  it("measured wins the copy when both fire (no double rest-sleep reason)", () => {
    const reasons = restReasons(
      sleepOnlyInput({ lastNightMin: 300, baselineMin: 480 }, true),
      TH
    );
    const sleepReasons = reasons.filter((r) => r.id === "rest-sleep");
    expect(sleepReasons).toHaveLength(1);
    expect(sleepReasons[0].reasonCore).toContain("You slept 5.0h");
  });

  it("no signal + no declaration ⇒ no rest-sleep reason", () => {
    const reasons = restReasons(
      sleepOnlyInput({ lastNightMin: 475, baselineMin: 480 }, false),
      TH
    );
    expect(reasons.some((r) => r.id === "rest-sleep")).toBe(false);
  });
});

describe("periodVerdict — logged / declared / off (#1298)", () => {
  it("a logged menses day is ON with basis logged", () => {
    expect(periodVerdict({ coversToday: true, declared: false })).toEqual({
      on: true,
      basis: "logged",
    });
  });

  it("a gap day with a declared toggle falls back to declared", () => {
    expect(periodVerdict({ coversToday: false, declared: true })).toEqual({
      on: true,
      basis: "declared",
    });
  });

  it("logged wins over declared", () => {
    expect(periodVerdict({ coversToday: true, declared: true }).basis).toBe(
      "logged"
    );
  });

  it("a mid-cycle gap day with no declaration is OFF", () => {
    expect(periodVerdict({ coversToday: false, declared: false })).toEqual({
      on: false,
      basis: null,
    });
  });
});

describe("state-line formatters", () => {
  it("poor-sleep measured names the numbers", () => {
    // 5h 10m = 310 min; baseline 480 → 170 under ≈ ~3h.
    const line = poorSleepStateLine(
      {
        on: true,
        basis: "measured",
        lastNightMin: 310,
        baselineMin: 480,
        belowBaseline: true,
      },
      2
    );
    expect(line).toBe(
      "Rough night (5h 10m, ~3h under usual) — 2 sleep-support items active today (auto)"
    );
  });

  it("poor-sleep declared never invents figures", () => {
    expect(poorSleepStateLine({ on: true, basis: "declared" }, 1)).toBe(
      "You flagged a rough night — 1 sleep-support item active today (auto)"
    );
  });

  it("poor-sleep renders nothing when off or no keyed items", () => {
    expect(poorSleepStateLine({ on: false, basis: null }, 3)).toBeNull();
    expect(poorSleepStateLine({ on: true, basis: "declared" }, 0)).toBeNull();
  });

  it("period logged names the log", () => {
    expect(periodStateLine({ on: true, basis: "logged" }, 2)).toBe(
      "Period logged — 2 items active"
    );
    expect(periodStateLine({ on: true, basis: "declared" }, 1)).toBe(
      "Period — 1 item active"
    );
    expect(periodStateLine({ on: false, basis: null }, 2)).toBeNull();
  });
});

describe("withPeriodOption — cycle relevance gate (#1298)", () => {
  const base = mergedSituationOptions([]);

  it("adds Period only when cycle tracking is relevant", () => {
    expect(
      withPeriodOption(base, true).some(
        (o) => o.name === BUILTIN_PERIOD_SITUATION
      )
    ).toBe(true);
    expect(
      withPeriodOption(base, false).some(
        (o) => o.name === BUILTIN_PERIOD_SITUATION
      )
    ).toBe(false);
  });

  it("does not double-add when a Period vocabulary row already exists", () => {
    const withRow = mergedSituationOptions([{ name: "Period" }]);
    const out = withPeriodOption(withRow, true);
    expect(out.filter((o) => o.name.toLowerCase() === "period")).toHaveLength(
      1
    );
  });
});

describe("override key registry discipline (#448)", () => {
  it("the date-scoped override key parses against the known-prefix registry", () => {
    const key = poorSleepOverrideKey("2026-07-24");
    expect(key).toBe(`${POOR_SLEEP_OVERRIDE_PREFIX}2026-07-24`);
    expect(dedupeKeyHasKnownPrefix(key)).toBe(true);
  });

  it("the built-in names are the stable identities", () => {
    expect(BUILTIN_POOR_SLEEP_SITUATION).toBe("Poor sleep");
    expect(BUILTIN_PERIOD_SITUATION).toBe("Period");
  });
});
