import { describe, expect, it } from "vitest";
import {
  rankNowCards,
  NOW_CARD_IDS,
  NOW_STRIP_CAP,
  WAKE_WINDOW_MIN,
  MEAL_WINDOW_MIN,
  DEFAULT_WAKE_MINUTES,
  type NowSignals,
  type NowCardId,
} from "../now-strip";
import { hhmmToMinutes, zonedDateParts } from "../date";

// The dashboard "Now" strip ranker (issue #1413, section A).
//
// These tests pin the two things the strip's whole value rests on: that it fires
// on the RIGHT moment, and that it stays SILENT otherwise. A ranker that
// over-fires is worse than none — it trains the user to scroll past the strip,
// which costs exactly the relevance it was built to buy.

const MIN = (h: number, m = 0) => h * 60 + m;

// A signals fixture with every window CLOSED. Each test opens exactly the ones it
// is about, so a passing assertion can't be an accident of the default.
function signals(over: Partial<NowSignals> = {}): NowSignals {
  return {
    // 3pm: past the wake window, and 2h from the nearest meal anchor (13:00) so it
    // clears the ±MEAL_WINDOW_MIN edge rather than sitting on it.
    minutesOfDay: MIN(15),
    wakeMinutes: MIN(7),
    freshSleepSummary: false,
    sleepWaiting: false,
    workoutFinishedMinAgo: null,
    mealAnchors: [MIN(8), MIN(13), MIN(20)],
    eveningAnchor: MIN(20),
    checkInDone: false,
    eligible: NOW_CARD_IDS,
    ...over,
  };
}

describe("rankNowCards", () => {
  it("returns nothing when no signal is firing — the strip's zero state is zero height, never a filler card", () => {
    expect(rankNowCards(signals())).toEqual([]);
  });

  it("promotes the sleep card in the morning when there is a fresh summary to show", () => {
    const out = rankNowCards(
      signals({ minutesOfDay: MIN(7, 30), freshSleepSummary: true })
    );
    expect(out[0]).toBe("sleep-last-night");
  });

  it("does NOT promote sleep without a fresh summary — the wake window alone would promote an empty card", () => {
    const out = rankNowCards(
      signals({ minutesOfDay: MIN(7, 30), freshSleepSummary: false })
    );
    expect(out).not.toContain("sleep-last-night");
  });

  it("promotes sleep for the WAITING state too — it is an answer, not filler (#2097)", () => {
    // "Waiting for last night's sleep" is a real answer to "how did I sleep this
    // morning"; withholding it would leave the strip silent in exactly the hour it
    // exists for.
    const out = rankNowCards(
      signals({
        minutesOfDay: MIN(7, 30),
        freshSleepSummary: false,
        sleepWaiting: true,
      })
    );
    expect(out[0]).toBe("sleep-last-night");
  });

  it("keeps the PRE-WAKE in-progress state off the strip by construction", () => {
    // The waiting decision can be open at 3am (the night is in progress), but the
    // strip's own `since >= 0` gate is what keeps the top of the page quiet then —
    // no second rule, and nothing added that comments on the hour.
    expect(
      rankNowCards(
        signals({
          minutesOfDay: MIN(3),
          wakeMinutes: MIN(7),
          freshSleepSummary: false,
          sleepWaiting: true,
        })
      )
    ).not.toContain("sleep-last-night");
  });

  it("closes the wake window after WAKE_WINDOW_MIN and never opens it before wake", () => {
    const fresh = { freshSleepSummary: true, wakeMinutes: MIN(7) };
    // Just inside the far edge.
    expect(
      rankNowCards(
        signals({ ...fresh, minutesOfDay: MIN(7) + WAKE_WINDOW_MIN - 1 })
      )
    ).toContain("sleep-last-night");
    // Just outside it.
    expect(
      rankNowCards(
        signals({ ...fresh, minutesOfDay: MIN(7) + WAKE_WINDOW_MIN + 1 })
      )
    ).not.toContain("sleep-last-night");
    // Before the typical wake time — a 5am insomniac check is not "just woke".
    expect(
      rankNowCards(signals({ ...fresh, minutesOfDay: MIN(5) }))
    ).not.toContain("sleep-last-night");
  });

  it("falls back to the shared default wake anchor when there is no sleep history yet", () => {
    // typicalWakeTime needs 14 nights; a newer profile gets null. The fallback is
    // the SAME one the wake-aware morning notify slot uses (08:00).
    expect(DEFAULT_WAKE_MINUTES).toBe(MIN(8));
    const out = rankNowCards(
      signals({
        minutesOfDay: MIN(8, 30),
        wakeMinutes: null,
        freshSleepSummary: true,
      })
    );
    expect(out).toContain("sleep-last-night");
  });

  it("ranks a recently-finished workout ABOVE sleep — the recap window is the perishable one", () => {
    const out = rankNowCards(
      signals({
        minutesOfDay: MIN(7, 30),
        freshSleepSummary: true,
        workoutFinishedMinAgo: 10,
      })
    );
    expect(out).toEqual(["session-recap", "sleep-last-night"]);
  });

  it("drops the recap once its window has closed", () => {
    expect(rankNowCards(signals({ workoutFinishedMinAgo: 61 }))).not.toContain(
      "session-recap"
    );
    expect(rankNowCards(signals({ workoutFinishedMinAgo: 59 }))).toContain(
      "session-recap"
    );
  });

  it("promotes nutrition around a mealtime anchor and not between them", () => {
    // Right at the midday anchor.
    expect(rankNowCards(signals({ minutesOfDay: MIN(13) }))).toEqual([
      "nutrition-today",
    ]);
    // Just inside the window edge, and just outside it.
    expect(
      rankNowCards(signals({ minutesOfDay: MIN(13) + MEAL_WINDOW_MIN - 1 }))
    ).toContain("nutrition-today");
    expect(
      rankNowCards(signals({ minutesOfDay: MIN(13) + MEAL_WINDOW_MIN + 1 }))
    ).not.toContain("nutrition-today");
  });

  it("honors a profile's SHIFTED meal anchors rather than a hardcoded lunchtime", () => {
    const nightShift = { mealAnchors: [MIN(16), MIN(21), MIN(2)] };
    expect(
      rankNowCards(signals({ ...nightShift, minutesOfDay: MIN(13) }))
    ).not.toContain("nutrition-today");
    expect(
      rankNowCards(signals({ ...nightShift, minutesOfDay: MIN(16, 15) }))
    ).toContain("nutrition-today");
  });

  it("promotes the evening check-in only while it is still undone", () => {
    const evening = { minutesOfDay: MIN(21) };
    expect(rankNowCards(signals({ ...evening, checkInDone: false }))).toContain(
      "symptom-log"
    );
    expect(
      rankNowCards(signals({ ...evening, checkInDone: true }))
    ).not.toContain("symptom-log");
  });

  it("does not promote the check-in before the profile's evening anchor", () => {
    expect(rankNowCards(signals({ minutesOfDay: MIN(15) }))).not.toContain(
      "symptom-log"
    );
  });

  it("caps the strip at NOW_STRIP_CAP even when everything fires at once", () => {
    // 20:00 with an unfinished check-in, a fresh sleep summary inside a late wake
    // window, a just-finished workout, and the evening meal anchor: four signals.
    const out = rankNowCards(
      signals({
        minutesOfDay: MIN(20),
        wakeMinutes: MIN(18),
        freshSleepSummary: true,
        workoutFinishedMinAgo: 5,
        checkInDone: false,
      })
    );
    expect(out.length).toBe(NOW_STRIP_CAP);
    expect(out).toEqual(["session-recap", "sleep-last-night"]);
  });

  it("NEVER promotes a card the user has hidden or that has nothing to render", () => {
    // The two STRONGEST signals both firing — a just-finished workout and a fresh
    // morning sleep summary — but neither card is eligible (hidden, or unavailable).
    // The clock must not be able to drag a hidden widget back onto the page.
    const eligible: NowCardId[] = ["nutrition-today"];
    const out = rankNowCards(
      signals({
        minutesOfDay: MIN(7, 30),
        freshSleepSummary: true,
        workoutFinishedMinAgo: 5,
        eligible,
      })
    );
    expect(out).not.toContain("sleep-last-night");
    expect(out).not.toContain("session-recap");
    // Only the eligible card, which happens to be inside its 08:00 meal window.
    expect(out).toEqual(["nutrition-today"]);
  });

  it("promotes nothing at all when the eligible set is empty (every widget hidden)", () => {
    const out = rankNowCards(
      signals({
        minutesOfDay: MIN(7, 30),
        freshSleepSummary: true,
        workoutFinishedMinAgo: 5,
        eligible: [],
      })
    );
    expect(out).toEqual([]);
  });

  it("is deterministic — the same signals always give the same order", () => {
    const s = signals({ minutesOfDay: MIN(20), checkInDone: false });
    expect(rankNowCards(s)).toEqual(rankNowCards(s));
  });
});

describe("profile-timezone windows (#1186/#450)", () => {
  // The ranker takes a minute-of-day, so the tz discipline lives in HOW the caller
  // derives it. This is the UTC-vs-profile boundary fixture: one instant, two
  // profiles, opposite answers — and the strip must follow the PROFILE, not UTC.
  const instant = new Date("2026-07-25T13:30:00Z");

  it("the same instant is mid-afternoon in UTC but breakfast time in Honolulu", () => {
    const utcMin = hhmmToMinutes(zonedDateParts("UTC", instant).hhmm);
    const honoluluMin = hhmmToMinutes(
      zonedDateParts("Pacific/Honolulu", instant).hhmm
    );
    expect(utcMin).toBe(MIN(13, 30));
    expect(honoluluMin).toBe(MIN(3, 30));

    const wake = { wakeMinutes: MIN(7), freshSleepSummary: true };
    // In UTC that instant is well past the wake window…
    expect(
      rankNowCards(signals({ ...wake, minutesOfDay: utcMin }))
    ).not.toContain("sleep-last-night");
    // …and in Honolulu it is 3:30am, which is BEFORE wake — also not "just woke".
    expect(
      rankNowCards(signals({ ...wake, minutesOfDay: honoluluMin }))
    ).not.toContain("sleep-last-night");
  });

  it("a profile whose local clock is inside the wake window gets the sleep card from the very same instant", () => {
    // 13:30Z is 07:30 in Denver (UTC-6 in July) — squarely just-woke.
    const denverMin = hhmmToMinutes(
      zonedDateParts("America/Denver", instant).hhmm
    );
    expect(denverMin).toBe(MIN(7, 30));
    expect(
      rankNowCards(
        signals({
          minutesOfDay: denverMin,
          wakeMinutes: MIN(7),
          freshSleepSummary: true,
        })
      )
    ).toContain("sleep-last-night");
  });
});
