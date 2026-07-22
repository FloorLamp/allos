import { describe, expect, it } from "vitest";
import {
  SOURCE_FIDELITY,
  KNOWN_HEALTH_CONNECT_KEYS,
  recommendedSettingForKey,
  detectGranularityHints,
  maxRecordsPerDay,
  distinctRecordDays,
  FINE_GRAINED_ROWS_PER_DAY,
  COARSE_HR_MAX_ROWS_PER_DAY,
} from "@/lib/integrations/health-connect";

// Issue #1065: the per-type granularity guidance is ONE source of truth (SOURCE_FIDELITY)
// that the setup card, the README table, and the at-ingest detectors all read from — so
// a parser change can't strand the instructions. These pin the registry-completeness
// invariant (the #448 pattern) and the payload-shape detectors.

describe("SOURCE_FIDELITY registry completeness (#1065)", () => {
  it("declares a recommended setting for every parser-consumed payload key", () => {
    const covered = new Set(SOURCE_FIDELITY.flatMap((r) => r.keys));
    const missing = [...KNOWN_HEALTH_CONNECT_KEYS].filter(
      (k) => !covered.has(k)
    );
    expect(
      missing,
      `Every parser-handled type must declare its guidance in SOURCE_FIDELITY: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("every home key (setting !== off) is a known parser key — no stale guidance", () => {
    const homeKeys = SOURCE_FIDELITY.filter((r) => r.setting !== "off").flatMap(
      (r) => r.keys
    );
    for (const key of homeKeys) {
      expect(
        KNOWN_HEALTH_CONNECT_KEYS.has(key),
        `SOURCE_FIDELITY references '${key}', which the parser no longer consumes`
      ).toBe(true);
    }
  });

  it("keeps skin temperature as an explicit 'off' row with no parser home", () => {
    const skin = SOURCE_FIDELITY.find((r) =>
      r.keys.includes("skin_temperature")
    );
    expect(skin?.setting).toBe("off");
    expect(KNOWN_HEALTH_CONNECT_KEYS.has("skin_temperature")).toBe(false);
  });

  it("maps the load-bearing recommendations from the verified matrix", () => {
    expect(recommendedSettingForKey("steps")).toBe("daily");
    expect(recommendedSettingForKey("distance")).toBe("daily");
    expect(recommendedSettingForKey("heart_rate")).toBe("1m");
    expect(recommendedSettingForKey("blood_pressure")).toBe("full");
    expect(recommendedSettingForKey("sleep")).toBe("full");
    expect(recommendedSettingForKey("exercise")).toBe("full");
    expect(recommendedSettingForKey("nutrition")).toBe("daily");
    expect(recommendedSettingForKey("skin_temperature")).toBe("off");
    expect(recommendedSettingForKey("no_such_key")).toBeUndefined();
  });
});

describe("payload-shape day counters", () => {
  it("maxRecordsPerDay counts the busiest calendar day", () => {
    const recs = [
      { start_time: "2026-06-01T01:00:00Z" },
      { start_time: "2026-06-01T02:00:00Z" },
      { start_time: "2026-06-02T01:00:00Z" },
    ];
    expect(maxRecordsPerDay(recs)).toBe(2);
    // Point records use `time`.
    expect(maxRecordsPerDay([{ time: "2026-06-01T01:00:00Z" }])).toBe(1);
  });

  it("ignores records with no usable timestamp", () => {
    expect(maxRecordsPerDay([{}, { start_time: 42 }])).toBe(0);
    expect(distinctRecordDays([{}, { foo: "bar" }])).toBe(0);
  });

  it("distinctRecordDays counts distinct calendar days", () => {
    const recs = [
      { time: "2026-06-01T01:00:00Z" },
      { time: "2026-06-01T23:00:00Z" },
      { time: "2026-06-03T05:00:00Z" },
    ];
    expect(distinctRecordDays(recs)).toBe(2);
  });
});

describe("detectGranularityHints (#1065)", () => {
  // A `daily`-set day carries ~1 row/day; a fine setting carries many.
  const dailySteps = (day: string) => ({
    start_time: `${day}T00:00:00Z`,
    end_time: `${day}T23:59:00Z`,
    count: 8000,
  });
  const fineSteps = (day: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      start_time: `${day}T${String(i % 24).padStart(2, "0")}:15:00Z`,
      end_time: `${day}T${String(i % 24).padStart(2, "0")}:30:00Z`,
      count: 300,
    }));

  it("hints when steps arrive as many sub-daily intervals per day", () => {
    const hints = detectGranularityHints({
      steps: fineSteps("2026-06-01", FINE_GRAINED_ROWS_PER_DAY + 4),
    });
    expect(hints.some((h) => /Steps/.test(h) && /`daily`/.test(h))).toBe(true);
  });

  it("does NOT hint when steps arrive as clean daily totals", () => {
    const hints = detectGranularityHints({
      steps: [
        dailySteps("2026-06-01"),
        dailySteps("2026-06-02"),
        dailySteps("2026-06-03"),
      ],
    });
    expect(hints).toEqual([]);
  });

  it("tolerates a few per-origin daily rows without flagging", () => {
    // Two origin apps writing one daily total each = 2 rows/day, well below the
    // fine-grained threshold, so no false positive.
    const hints = detectGranularityHints({
      distance: [
        {
          start_time: "2026-06-01T00:00:00Z",
          end_time: "2026-06-01T23:59:00Z",
          meters: 5000,
        },
        {
          start_time: "2026-06-01T00:00:00Z",
          end_time: "2026-06-01T23:59:00Z",
          meters: 4000,
        },
      ],
    });
    expect(hints).toEqual([]);
  });

  it("hints when heart rate arrives as daily aggregates (coarse)", () => {
    const hints = detectGranularityHints({
      heart_rate: [
        { time: "2026-06-01T12:00:00Z", bpm: 62 },
        { time: "2026-06-02T12:00:00Z", bpm: 64 },
        { time: "2026-06-03T12:00:00Z", bpm: 61 },
      ],
    });
    expect(hints.some((h) => /Heart rate/.test(h) && /`1m`/.test(h))).toBe(
      true
    );
  });

  it("does NOT hint on minute-resolution heart rate", () => {
    // ~90 samples in one minute-dense hour on two days: busiest day well above the
    // coarse ceiling, so it reads as the correct 1m shape.
    const hr = Array.from({ length: 120 }, (_, i) => ({
      time: `2026-06-0${1 + (i % 2)}T08:${String(i % 60).padStart(2, "0")}:00Z`,
      bpm: 60 + (i % 20),
    }));
    expect(maxRecordsPerDay(hr)).toBeGreaterThan(COARSE_HR_MAX_ROWS_PER_DAY);
    expect(detectGranularityHints({ heart_rate: hr })).toEqual([]);
  });

  it("does NOT hint on a single-day heart-rate batch (ambiguous)", () => {
    // One day of data can't be told apart from an in-progress day, so no coarse hint.
    const hints = detectGranularityHints({
      heart_rate: [{ time: "2026-06-01T12:00:00Z", bpm: 62 }],
    });
    expect(hints).toEqual([]);
  });

  it("is defensive against a non-object body and empty types", () => {
    expect(detectGranularityHints(null)).toEqual([]);
    expect(detectGranularityHints("nope")).toEqual([]);
    expect(detectGranularityHints({})).toEqual([]);
    expect(detectGranularityHints({ steps: [] })).toEqual([]);
  });
});
