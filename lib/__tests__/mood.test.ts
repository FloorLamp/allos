import { describe, expect, it } from "vitest";
import {
  decideMoodKeep,
  isFinalMoodCheckin,
  isMoodCheckinPaused,
  MOOD_CHECKIN_PAUSE_NOTICE,
  MOOD_CHECKIN_PAUSED_LABEL,
} from "@/lib/mood";
import {
  normalizeMoodInput,
  parseMoodFactors,
  shouldSendMoodCheckin,
  moodFace,
  moodLabel,
  anxietyDisplaySlot,
  moodRatingColumn,
  moodSeriesPoints,
  moodSeriesValue,
  MOOD_CHART_SERIES,
  MOOD_FACES,
  MOOD_LABELS,
  MOOD_FACTORS,
  MOOD_CHECKIN_AUTOPAUSE_DAYS,
} from "@/lib/mood";
import { chartSeries } from "@/lib/chart-colors";
import { BODY_CARD_LAYOUT } from "@/lib/trends-card-rank";
import {
  BODY_METRIC_META,
  CHECK_IN_METRIC_SLUGS,
  isBodyMetricSlug,
} from "@/lib/trends-body-metrics";
import {
  detectLowMoodWindow,
  decideSleepMoodBridge,
  meanNightlySleepMin,
  lowMoodSignalKey,
  sleepMoodSignalKey,
  MOOD_OBS_PREFIX,
  SLEEP_MOOD_PREFIX,
  MOOD_LOW_MIN_LOGS,
  MOOD_LOW_MEAN_THRESHOLD,
  SLEEP_MOOD_SRI_DROP_POINTS,
  SLEEP_MOOD_DURATION_DROP_MIN,
  type LowMoodWindow,
} from "@/lib/mood-observation";
import { parseMoodCheckinCallback } from "@/lib/notifications/callback-data";

// Pure-tier coverage for the daily wellbeing check (issue #992): input
// normalization shared by every write path, the low-mood window detector, the
// sleep↔mood bridge's positive AND both single-series negative cases (the issue's
// pinned requirements), the reminder's auto-pause decision, and the Telegram
// token parser.

describe("normalizeMoodInput", () => {
  it("accepts a bare valence tap (the one-tap core)", () => {
    expect(normalizeMoodInput({ valence: 4 })).toEqual({
      valence: 4,
      energy: null,
      anxiety: null,
      factors: [],
      note: null,
    });
  });

  it("accepts the expanded dimensions, factor chips, and note", () => {
    const out = normalizeMoodInput({
      valence: "2",
      energy: "3",
      anxiety: 5,
      factors: ["social", "work", "work"],
      note: "  long day  ",
    });
    expect(out).toEqual({
      valence: 2,
      energy: 3,
      anxiety: 5,
      // Deduped, vocabulary order (work before social).
      factors: ["work", "social"],
      note: "long day",
    });
  });

  it("rejects a missing or out-of-range valence", () => {
    expect(normalizeMoodInput({ valence: null })).toHaveProperty("error");
    expect(normalizeMoodInput({ valence: 0 })).toHaveProperty("error");
    expect(normalizeMoodInput({ valence: 6 })).toHaveProperty("error");
    expect(normalizeMoodInput({ valence: 2.5 })).toHaveProperty("error");
    expect(normalizeMoodInput({ valence: "nope" })).toHaveProperty("error");
  });

  it("rejects an out-of-range optional scale but tolerates its absence", () => {
    expect(normalizeMoodInput({ valence: 3, energy: 9 })).toHaveProperty(
      "error"
    );
    expect(normalizeMoodInput({ valence: 3, anxiety: 0 })).toHaveProperty(
      "error"
    );
    expect(normalizeMoodInput({ valence: 3, energy: "" })).toMatchObject({
      energy: null,
    });
  });

  it("drops off-vocabulary factors instead of erroring (a stale chip never loses the tap)", () => {
    expect(
      normalizeMoodInput({ valence: 3, factors: ["work", "weather", "x"] })
    ).toMatchObject({ factors: ["work"] });
  });

  it("drops the retired sleep/health/cycle slugs (#1311 vocabulary shrink)", () => {
    // The three former slugs left the vocabulary AND the validation set outright —
    // their meaning is carried by Poor sleep / the illness door / Period — so a stray
    // stored value simply stops rendering (no migration, no legacy tolerance).
    expect(
      normalizeMoodInput({
        valence: 3,
        factors: ["sleep", "health", "cycle", "work"],
      })
    ).toMatchObject({ factors: ["work"] });
  });
});

describe("parseMoodFactors", () => {
  it("round-trips a stored blob and degrades malformed / retired content to []", () => {
    expect(parseMoodFactors(JSON.stringify(["work", "social"]))).toEqual([
      "work",
      "social",
    ]);
    // A stored `cycle` (a retired #1311 slug) is filtered on parse — display of a
    // dead slug simply stops, no throw.
    expect(parseMoodFactors(JSON.stringify(["work", "cycle"]))).toEqual([
      "work",
    ]);
    expect(parseMoodFactors(null)).toEqual([]);
    expect(parseMoodFactors("not json")).toEqual([]);
    expect(parseMoodFactors(JSON.stringify({ a: 1 }))).toEqual([]);
    expect(parseMoodFactors(JSON.stringify(["bogus"]))).toEqual([]);
  });
});

describe("scales", () => {
  it("faces/labels cover exactly the 5-point scale and resolve per valence", () => {
    expect(MOOD_FACES).toHaveLength(5);
    expect(MOOD_LABELS).toHaveLength(5);
    expect(MOOD_FACTORS.length).toBeGreaterThan(0);
    expect(moodFace(5)).toBe(MOOD_FACES[4]);
    expect(moodLabel(1)).toBe("Rough");
  });
});

// ---- The three charted check-in series (#1408) --------------------------------
//
// The check-in has always STORED valence + energy + anxiety and plotted valence
// alone. These pin the one mapper every plotting surface now shares: which column a
// series reads, that an unanswered scale is an absent reading rather than a zero,
// and that Calm crosses the #1313 relabel exactly once on the way out.

const CHECK_INS = [
  { date: "2026-03-02", valence: 4, energy: 2, anxiety: 5 },
  { date: "2026-03-03", valence: 2, energy: null, anxiety: null },
  { date: "2026-03-04", valence: 5, energy: 5, anxiety: 1 },
];

describe("moodSeriesPoints (#1408)", () => {
  it("reads each series off the same rows, in date order", () => {
    expect(moodSeriesPoints(CHECK_INS, "valence")).toEqual([
      { date: "2026-03-02", value: 4 },
      { date: "2026-03-03", value: 2 },
      { date: "2026-03-04", value: 5 },
    ]);
    expect(moodSeriesPoints(CHECK_INS, "energy")).toEqual([
      { date: "2026-03-02", value: 2 },
      { date: "2026-03-04", value: 5 },
    ]);
  });

  it("drops the days a scale went unanswered rather than plotting a zero", () => {
    // Energy and Calm are expand-only, so most days carry valence alone. A skipped
    // scale must not read as "rated 0" or drag a mean.
    expect(
      moodSeriesPoints(CHECK_INS, "energy").map((p) => p.date)
    ).not.toContain("2026-03-03");
    expect(moodSeriesPoints(CHECK_INS, "calm").map((p) => p.date)).not.toContain(
      "2026-03-03"
    );
    expect(moodSeriesPoints([], "valence")).toEqual([]);
  });

  it("plots Calm on the card's relabelled axis — the good end is high (#1313)", () => {
    // Stored anxiety 5 (most anxious) plots at 1; stored 1 (calmest) plots at 5, so
    // "up is better" holds on all three cards. The store is untouched either way.
    expect(moodSeriesPoints(CHECK_INS, "calm")).toEqual([
      { date: "2026-03-02", value: 1 },
      { date: "2026-03-04", value: 5 },
    ]);
    expect(moodSeriesValue(CHECK_INS[0], "calm")).toBe(
      anxietyDisplaySlot(CHECK_INS[0].anxiety)
    );
  });

  it("maps each charted series to the column it is stored in", () => {
    expect(MOOD_CHART_SERIES.map(moodRatingColumn)).toEqual([
      "valence",
      "energy",
      // Calm is a DISPLAY word; the column it reads is still `anxiety`.
      "anxiety",
    ]);
  });
});

describe("the check-in metric registry (#1408)", () => {
  it("registers all three check-in ratings as body metrics", () => {
    // Registry membership is what earns a series its tile, chart, detail page and
    // star — the treatment valence already had and the other two never did.
    for (const slug of CHECK_IN_METRIC_SLUGS) {
      expect(isBodyMetricSlug(slug)).toBe(true);
      expect(BODY_METRIC_META[slug].unit).toBe("");
    }
    expect(CHECK_IN_METRIC_SLUGS).toEqual(["mood", "energy", "calm"]);
  });

  it("gives the three neighbouring 1–5 cards distinct blessed hues", () => {
    const colors = CHECK_IN_METRIC_SLUGS.map((s) => BODY_METRIC_META[s].color);
    expect(new Set(colors).size).toBe(colors.length);
    for (const color of colors) {
      expect(Object.values(chartSeries)).toContain(color);
    }
  });

  it("ranks the three together, in the order the card asks them", () => {
    const at = (id: string) => BODY_CARD_LAYOUT.indexOf(id as never);
    expect(at("energy")).toBe(at("mood") + 1);
    expect(at("calm")).toBe(at("energy") + 1);
  });
});

// ---- Low-mood window detector ------------------------------------------------

const TODAY = "2026-07-19";
const WINDOW_START = "2026-07-06"; // 14-day inclusive window

function days(valences: number[]): { date: string; valence: number }[] {
  // Consecutive days ending at TODAY.
  const out: { date: string; valence: number }[] = [];
  for (let i = 0; i < valences.length; i++) {
    const d = new Date(Date.UTC(2026, 6, 19));
    d.setUTCDate(d.getUTCDate() - (valences.length - 1 - i));
    out.push({ date: d.toISOString().slice(0, 10), valence: valences[i] });
  }
  return out;
}

describe("detectLowMoodWindow", () => {
  it("fires on a sustained low stretch with enough logged days", () => {
    const low = detectLowMoodWindow(
      days([2, 2, 1, 2, 3, 2, 2, 2]),
      TODAY,
      WINDOW_START
    );
    expect(low).not.toBeNull();
    expect(low!.dedupeKey).toBe(lowMoodSignalKey("2026-07"));
    expect(low!.dedupeKey.startsWith(MOOD_OBS_PREFIX)).toBe(true);
    expect(low!.meanValence).toBeLessThanOrEqual(MOOD_LOW_MEAN_THRESHOLD);
    expect(low!.daysLogged).toBe(8);
    // Calm, non-diagnostic copy — an observation, never a verdict.
    expect(low!.detail).toMatch(/observation/i);
  });

  it("stays silent below the minimum logged days (sparse data)", () => {
    const sparse = days(Array(MOOD_LOW_MIN_LOGS - 1).fill(1));
    expect(detectLowMoodWindow(sparse, TODAY, WINDOW_START)).toBeNull();
  });

  it("stays silent when the window mean is above the threshold", () => {
    expect(
      detectLowMoodWindow(days([4, 3, 4, 5, 3, 4, 4, 3]), TODAY, WINDOW_START)
    ).toBeNull();
  });

  it("ignores entries outside the window", () => {
    const oldLows = [
      { date: "2026-06-01", valence: 1 },
      { date: "2026-06-02", valence: 1 },
      { date: "2026-06-03", valence: 1 },
      { date: "2026-06-04", valence: 1 },
      { date: "2026-06-05", valence: 1 },
      { date: "2026-06-06", valence: 1 },
      { date: "2026-06-07", valence: 1 },
    ];
    expect(detectLowMoodWindow(oldLows, TODAY, WINDOW_START)).toBeNull();
  });
});

// ---- Sleep↔mood bridge -------------------------------------------------------

const LOW: LowMoodWindow = {
  dedupeKey: lowMoodSignalKey("2026-07"),
  title: "Mood has been low lately",
  detail: "…",
  meanValence: 2.1,
  daysLogged: 10,
};

describe("decideSleepMoodBridge", () => {
  it("fires on a low-mood window co-occurring with an SRI drop", () => {
    const obs = decideSleepMoodBridge(
      {
        lowMood: LOW,
        recentSri: 62,
        priorSri: 62 + SLEEP_MOOD_SRI_DROP_POINTS,
        recentAvgSleepMin: null,
        priorAvgSleepMin: null,
      },
      "2026-07"
    );
    expect(obs).not.toBeNull();
    expect(obs!.dedupeKey).toBe(sleepMoodSignalKey("2026-07"));
    expect(obs!.dedupeKey.startsWith(SLEEP_MOOD_PREFIX)).toBe(true);
    // Co-occurrence phrasing, never causal/diagnostic.
    expect(obs!.detail).toMatch(/move together/i);
    expect(obs!.detail).toMatch(/not a diagnosis/i);
    expect(obs!.detail).not.toMatch(/because|caused/i);
  });

  it("fires on a low-mood window co-occurring with a duration drop", () => {
    const obs = decideSleepMoodBridge(
      {
        lowMood: LOW,
        recentSri: null,
        priorSri: null,
        recentAvgSleepMin: 400,
        priorAvgSleepMin: 400 + SLEEP_MOOD_DURATION_DROP_MIN,
      },
      "2026-07"
    );
    expect(obs).not.toBeNull();
    expect(obs!.detail).toMatch(/minutes less per night/);
  });

  it("NEGATIVE: low mood with steady sleep → no bridge finding", () => {
    expect(
      decideSleepMoodBridge(
        {
          lowMood: LOW,
          recentSri: 70,
          priorSri: 71, // steady (< threshold drop)
          recentAvgSleepMin: 450,
          priorAvgSleepMin: 455, // steady
        },
        "2026-07"
      )
    ).toBeNull();
  });

  it("NEGATIVE: a sleep dip with steady mood (no low-mood window) → no bridge finding", () => {
    expect(
      decideSleepMoodBridge(
        {
          lowMood: null,
          recentSri: 40,
          priorSri: 80, // a huge drop — still silent without the mood half
          recentAvgSleepMin: 300,
          priorAvgSleepMin: 480,
        },
        "2026-07"
      )
    ).toBeNull();
  });

  it("stays silent when neither sleep signal has both windows computable", () => {
    expect(
      decideSleepMoodBridge(
        {
          lowMood: LOW,
          recentSri: 50,
          priorSri: null,
          recentAvgSleepMin: null,
          priorAvgSleepMin: 480,
        },
        "2026-07"
      )
    ).toBeNull();
  });
});

describe("meanNightlySleepMin", () => {
  const nights = Array.from({ length: 10 }, (_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, "0")}`,
    value: 400 + i,
  }));
  it("averages the in-window nights", () => {
    expect(
      meanNightlySleepMin(nights, "2026-07-01", "2026-07-10", 7)
    ).toBeCloseTo(404.5);
  });
  it("returns null under the night gate", () => {
    expect(meanNightlySleepMin(nights, "2026-07-01", "2026-07-05", 7)).toBe(
      null
    );
  });
});

// ---- Check-in reminder auto-pause --------------------------------------------

describe("shouldSendMoodCheckin", () => {
  it("sends only when enabled, unlogged today, and under the ignored cap", () => {
    expect(
      shouldSendMoodCheckin({
        enabled: true,
        alreadyLoggedToday: false,
        ignoredCount: 0,
      })
    ).toBe(true);
    expect(
      shouldSendMoodCheckin({
        enabled: false,
        alreadyLoggedToday: false,
        ignoredCount: 0,
      })
    ).toBe(false);
    expect(
      shouldSendMoodCheckin({
        enabled: true,
        alreadyLoggedToday: true,
        ignoredCount: 0,
      })
    ).toBe(false);
  });

  it(`auto-pauses at ${MOOD_CHECKIN_AUTOPAUSE_DAYS} ignored days and re-arms on reset`, () => {
    expect(
      shouldSendMoodCheckin({
        enabled: true,
        alreadyLoggedToday: false,
        ignoredCount: MOOD_CHECKIN_AUTOPAUSE_DAYS - 1,
      })
    ).toBe(true);
    expect(
      shouldSendMoodCheckin({
        enabled: true,
        alreadyLoggedToday: false,
        ignoredCount: MOOD_CHECKIN_AUTOPAUSE_DAYS,
      })
    ).toBe(false);
    // A submitted check-in resets the counter to 0 → armed again.
    expect(
      shouldSendMoodCheckin({
        enabled: true,
        alreadyLoggedToday: false,
        ignoredCount: 0,
      })
    ).toBe(true);
  });
});

// ---- Telegram token parsing --------------------------------------------------

describe("parseMoodCheckinCallback", () => {
  it("parses a well-formed face-button token", () => {
    expect(parseMoodCheckinCallback("mood:7:4:2026-07-19")).toEqual({
      profileId: 7,
      valence: 4,
      date: "2026-07-19",
    });
  });

  it("refuses malformed tokens", () => {
    expect(parseMoodCheckinCallback("mood:7:9:2026-07-19")).toBeNull();
    expect(parseMoodCheckinCallback("mood:7:4")).toBeNull();
    expect(parseMoodCheckinCallback("mood:0:4:2026-07-19")).toBeNull();
    expect(parseMoodCheckinCallback("take:7:4:2026-07-19")).toBeNull();
    expect(parseMoodCheckinCallback(42)).toBeNull();
  });
});

// ---- The auto-pause, announced (issue #1668) ----
//
// The pause was INVISIBLE: reminders simply stopped, which reads as "notifications
// broke". The mechanism is right (#992 — a disengaged user must not be nagged); this
// closes the visibility gap without turning contact reduction into a question the user
// must answer to keep being left alone.
describe("mood check-in pause visibility (#1668)", () => {
  it("the send that will EXHAUST the streak is the one that announces", () => {
    // Every earlier send is silent — the announcement fires once, on the last one.
    for (let i = 0; i < MOOD_CHECKIN_AUTOPAUSE_DAYS - 1; i++) {
      expect(isFinalMoodCheckin(i)).toBe(false);
    }
    expect(isFinalMoodCheckin(MOOD_CHECKIN_AUTOPAUSE_DAYS - 1)).toBe(true);
    // Past the line nothing sends at all, so nothing announces.
    expect(isFinalMoodCheckin(MOOD_CHECKIN_AUTOPAUSE_DAYS)).toBe(false);
  });

  it("the announcement rides a send that was happening anyway — it adds none", () => {
    // The final reminder is still a legitimate send by the unchanged gate.
    expect(
      shouldSendMoodCheckin({
        enabled: true,
        alreadyLoggedToday: false,
        ignoredCount: MOOD_CHECKIN_AUTOPAUSE_DAYS - 1,
      })
    ).toBe(true);
    // And the pause still proceeds for someone who ignores it.
    expect(
      shouldSendMoodCheckin({
        enabled: true,
        alreadyLoggedToday: false,
        ignoredCount: MOOD_CHECKIN_AUTOPAUSE_DAYS,
      })
    ).toBe(false);
  });

  it("paused is DERIVED state — enabled stays true, and logging lifts it", () => {
    expect(
      isMoodCheckinPaused({
        enabled: true,
        ignoredCount: MOOD_CHECKIN_AUTOPAUSE_DAYS,
      })
    ).toBe(true);
    expect(isMoodCheckinPaused({ enabled: true, ignoredCount: 0 })).toBe(false);
    // A disabled check-in is OFF, not paused — the card must not offer to resume it.
    expect(isMoodCheckinPaused({ enabled: false, ignoredCount: 99 })).toBe(
      false
    );
  });

  it("keep/resume is one decision with a typed outcome, never a blind confirm", () => {
    expect(decideMoodKeep({ enabled: true, ignoredCount: 4 })).toBe("kept");
    // Already re-armed elsewhere (a mood logged on another device) — not a failure.
    expect(decideMoodKeep({ enabled: true, ignoredCount: 0 })).toBe(
      "already-active"
    );
    expect(decideMoodKeep({ enabled: false, ignoredCount: 4 })).toBe(
      "not-enabled"
    );
  });

  it("the copy carries no guilt and no streak language (#992/#716)", () => {
    for (const copy of [MOOD_CHECKIN_PAUSE_NOTICE, MOOD_CHECKIN_PAUSED_LABEL]) {
      expect(copy.toLowerCase()).not.toMatch(
        /streak|missed|failed|don't break|keep it up|day \d|in a row/
      );
    }
    // It says what will happen and why it's fine — nothing more.
    expect(MOOD_CHECKIN_PAUSE_NOTICE.toLowerCase()).toContain("no pressure");
  });
});
