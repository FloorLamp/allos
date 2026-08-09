// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #2211 — the digest's two modes, driven through the tick's REAL gate.
//
// THE MEASURED DEFECT this replaces. On the 13-night sample below, against a
// configured 07:00 digest, 7 of 13 sleep rows arrived AFTER 07:00 — so the digest
// shipped without last night on 7 of 13 mornings and never said so. Two causes:
// a manually set time never waited (`shouldDeferDigest` opened with
// `if (!input.auto) return false`), and when a time did wait it waited a full hour
// for a two-minute question, because #2102 borrowed the failure backoff band as its
// landing zone.
//
// The two modes answer the two real wishes without the cross-product:
//   STATIC  — same time every day. Complete or not. TODAY'S BEHAVIOR, UNCHANGED.
//   DYNAMIC — as soon as it's ready. Not before the floor, and by the deadline.
//
// `tickDigest` below mirrors scripts/notify.ts's digest block exactly (the same
// terms in the same order) — the pattern workout-presence-gate.test established for
// the tick's slot loop, since scripts/notify.ts runs main() on import and cannot be
// imported by a test.
//
// The two halves stay separate on purpose: this decides WHEN the digest sends,
// #2099 decides WHAT it prints. A digest that reaches its deadline with no sleep in
// hand simply has no Sleep section — already correct behavior, asserted here so it
// stays that way.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import {
  minuteOfDayInTz,
  shiftDateStr,
  utcInstant,
  zonedWallTimeToUtc,
} from "@/lib/date";
import {
  getNotifySchedule,
  getProfileSetting,
  setProfileSetting,
  setTelegramBotConfig,
  setTimezone,
} from "@/lib/settings";
import {
  digestSleepPending,
  planProfileDigestTick,
  recordDigestAttempt,
  runDigest,
} from "@/lib/notifications/digest-data";
import {
  DIGEST_ATTEMPT_KEY,
  DIGEST_MARKER_KEY,
} from "@/lib/notifications/send-markers";
import { DIGEST_MODE_KEY } from "@/lib/settings/notifications";
import { DEADLINE_MARGIN_MIN } from "@/lib/notifications/digest-schedule";
import {
  beginNotifyRun,
  clearNotifyLog,
  endNotifyRun,
  readNotifyEvents,
} from "@/lib/notify-log";
import { classifyNotifyLine, type NotifyEvent } from "@/lib/notify-log-format";
import { seedLoginTelegram } from "./fixtures";

// The frozen morning. Its own night (2026-08-06) is deliberately ABSENT — that is
// the state every morning starts in.
const FROZEN_DAY = "2026-08-06";
const PROVIDER = "health-connect";
const TZ = "UTC"; // profile-local minute == the frozen UTC minute
const FLOOR = 7 * 60;
// The observed cadence every case is driven at: the 15-minute sidecar, which is what
// makes "wait for the next tick" mean anything at all.
const TICK_MINUTES = 15;
// #2214's arrival p90 over the fixture, and the deadline #2211 derives from it:
// 07:40 + DEADLINE_MARGIN_MIN. NOT floor + 60 (08:00) — that separation is the point.
const DEADLINE = 8 * 60 + 10;
// The minute the deadline actually FIRES on: the first 15-minute tick at or after it,
// the same quantisation every slot has had since #2121.
const DEADLINE_TICK = 8 * 60 + 15;

const at = (hhmm: string) => new Date(`${FROZEN_DAY}T${hhmm}:00Z`);
const clock = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// #2214's measured 13 nights: the clock time last night's row landed at, and how far
// behind the session's end that was.
const MEASURED: { date: string; arrival: number; lag: number }[] = [
  { date: "2026-07-24", arrival: 6 * 60 + 2, lag: 30 },
  { date: "2026-07-25", arrival: 6 * 60 + 6, lag: 35 },
  { date: "2026-07-26", arrival: 6 * 60 + 14, lag: 40 },
  { date: "2026-07-27", arrival: 6 * 60 + 26, lag: 45 },
  { date: "2026-07-28", arrival: 6 * 60 + 47, lag: 64 },
  { date: "2026-07-29", arrival: 6 * 60 + 50, lag: 55 },
  { date: "2026-07-30", arrival: 7 * 60 + 4, lag: 86 },
  { date: "2026-07-31", arrival: 7 * 60 + 11, lag: 86 },
  { date: "2026-08-01", arrival: 7 * 60 + 26, lag: 105 },
  { date: "2026-08-02", arrival: 7 * 60 + 26, lag: 80 },
  { date: "2026-08-03", arrival: 7 * 60 + 30, lag: 70 },
  { date: "2026-08-04", arrival: 7 * 60 + 42, lag: 65 },
  { date: "2026-08-05", arrival: 7 * 60 + 48, lag: 50 },
];

let seq = 0;

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`${name}${++seq}`)
      .lastInsertRowid
  );
  setTimezone(id, TZ);
  return id;
}

/** A synced overnight session ending `lagMin` before its provenance row landed. */
function night(
  profileId: number,
  date: string,
  arrivalMinute: number,
  lagMin: number,
  minutes = 420
): void {
  // The helper builds the clock itself, so it always resolves (#2245).
  const arrivedAt = zonedWallTimeToUtc(TZ, date, clock(arrivalMinute))!;
  const end = new Date(arrivedAt.getTime() - lagMin * 60_000);
  const start = new Date(end.getTime() - minutes * 60_000);
  const sampleId = Number(
    db
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, origin, metric, date, start_time, end_time, value)
         VALUES (?, ?, NULL, 'sleep_min', ?, ?, ?, ?)`
      )
      .run(
        profileId,
        PROVIDER,
        date,
        utcInstant(start),
        utcInstant(end),
        minutes
      ).lastInsertRowid
  );
  const eventId = Number(
    db
      .prepare(
        `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted)
         VALUES (?, ?, ?, 1, 1)`
      )
      .run(profileId, PROVIDER, utcInstant(arrivedAt)).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO integration_sync_rows
       (event_id, target_table, target_id, disposition, created_at)
     VALUES (?, 'metric_samples', ?, 'inserted', ?)`
  ).run(eventId, sampleId, utcInstant(arrivedAt));
}

function configureTelegram(profileId: number): void {
  setTelegramBotConfig({
    telegramBotToken: "digest-mode-token",
    telegramMode: "poll",
  });
  seedLoginTelegram(profileId, `2211${profileId}`);
}

/**
 * The measured profile: the 13 arrival-carrying nights, last night deliberately
 * absent, ordinary content so the digest has something to say in every branch, and a
 * configured digest at `mode`/07:00.
 */
function seedProfile(name: string, mode: "static" | "dynamic"): number {
  const p = newProfile(name);
  for (const n of MEASURED) night(p, n.date, n.arrival, n.lag);
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min)
     VALUES (?, ?, 'strength', 'Session', 45)`
  ).run(p, shiftDateStr(FROZEN_DAY, -1));
  setProfileSetting(p, "notify_digest_hour", clock(FLOOR));
  setProfileSetting(p, DIGEST_MODE_KEY, mode);
  configureTelegram(p);
  return p;
}

/** Last night finally lands, at `arrivalMinute` profile-local. */
function lastNightArrives(profileId: number, arrivalMinute: number): void {
  night(profileId, FROZEN_DAY, arrivalMinute, 90);
}

/** This profile's persisted digest-tick decision line, or undefined if it wrote none. */
function declineTrace(profileId: number): NotifyEvent | undefined {
  return readNotifyEvents().events.find(
    (e) => e.profileId === profileId && e.decision != null
  );
}

function stubFetch(ok = true): ReturnType<typeof vi.fn> {
  const mock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok, result: {}, description: "nope" }), {
        status: ok ? 200 : 500,
        headers: { "content-type": "application/json" },
      })
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

const sentBody = (mock: ReturnType<typeof vi.fn>, n = 0): string =>
  String(JSON.parse(mock.mock.calls[n][1].body as string).text);

type TickOutcome = "already-sent" | "idle" | "declined" | "sent" | "failed";

// scripts/notify.ts's digest block, term for term:
//
//   if (getProfileSetting(profile.id, DIGEST_MARKER_KEY) !== date) {
//     if (planProfileDigestTick(...) === "send") {
//       const dg = await runDigest(...);
//       if (dg.failed) {
//         if (sched.digestMode === "dynamic") recordDigestAttempt(...);
//         ...
//       }
//     }
//   }
async function tickDigest(
  profileId: number,
  name: string
): Promise<TickOutcome> {
  const minute = minuteOfDayInTz(TZ, new Date());
  const date = today(profileId);
  if (getProfileSetting(profileId, DIGEST_MARKER_KEY) === date)
    return "already-sent";
  const sched = getNotifySchedule(profileId);
  const action = planProfileDigestTick(
    profileId,
    sched,
    minute,
    TICK_MINUTES,
    date
  );
  if (action === "wait") return "declined";
  if (action === "idle") return "idle";
  const dg = await runDigest(profileId, name, date);
  if (dg.failed) {
    // ONLY Dynamic anchors its retry to the attempt, so only Dynamic writes the
    // record. Static's two attempts are `slotAttempt`'s slot-anchored bands and it
    // never reads this key.
    if (sched.digestMode === "dynamic")
      recordDigestAttempt(profileId, date, minute);
    return "failed";
  }
  return "sent";
}

/**
 * Run every 15-minute tick from 06:00 to 10:00 and return the minutes on which the
 * digest actually sent. `arrivalMinute` is when last night lands, or null for never.
 */
async function runMorning(
  profileId: number,
  name: string,
  arrivalMinute: number | null
): Promise<number[]> {
  const sent: number[] = [];
  for (let m = 6 * 60; m <= 10 * 60; m += TICK_MINUTES) {
    if (arrivalMinute != null && m >= arrivalMinute) {
      const already = db
        .prepare(
          `SELECT 1 FROM metric_samples WHERE profile_id = ? AND metric = 'sleep_min' AND date = ?`
        )
        .get(profileId, FROZEN_DAY);
      if (!already) lastNightArrives(profileId, arrivalMinute);
    }
    vi.setSystemTime(at(clock(m)));
    if ((await tickDigest(profileId, name)) === "sent") sent.push(m);
  }
  return sent;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("06:00"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Static — today's behavior, to the minute (the regression that must never land)", () => {
  it("sends at its configured minute, sleep pending or not", async () => {
    for (const arrival of [null, 7 * 60 + 26] as const) {
      const p = seedProfile("Static", "static");
      const fetchMock = stubFetch();
      if (arrival === null) expect(digestSleepPending(p)).toBe(true);
      expect(await runMorning(p, "Static", arrival)).toEqual([FLOOR]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getProfileSetting(p, DIGEST_MARKER_KEY)).toBe(FROZEN_DAY);
    }
  });

  it("never writes an attempt record — its retry stays slot-anchored", async () => {
    const p = seedProfile("StaticNoState", "static");
    stubFetch();
    await runMorning(p, "StaticNoState", null);
    expect(getProfileSetting(p, DIGEST_ATTEMPT_KEY)).toBeUndefined();
  });

  it("ships without the Sleep section rather than waiting for it", async () => {
    // The digest is user-timed. Silently sliding someone's 07:00 to 08:10 would make
    // their own setting untrue — the person who wants completeness picks Dynamic.
    const p = seedProfile("StaticIncomplete", "static");
    const fetchMock = stubFetch();
    await runMorning(p, "StaticIncomplete", null);
    const body = sentBody(fetchMock);
    expect(body).not.toContain("😴 <b>Last night:");
    expect(body).toContain("Session");
  });
});

describe("Dynamic — sends the moment last night lands", () => {
  it("sends on the NEXT TICK after a 07:26 arrival, not at 08:15", async () => {
    // The measured waste, in one case: 07:26 → next tick 07:30, and the old
    // deferral's landing zone was 08:15. 45 minutes of avoidable delay, gone.
    const p = seedProfile("Dynamic", "dynamic");
    const fetchMock = stubFetch();
    expect(await runMorning(p, "Dynamic", 7 * 60 + 26)).toEqual([7 * 60 + 30]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody(fetchMock)).toContain("😴 <b>Last night:");
    expect(getProfileSetting(p, DIGEST_MARKER_KEY)).toBe(FROZEN_DAY);
  });

  it("sends at the floor when last night is already in hand", async () => {
    const p = seedProfile("DynamicEarly", "dynamic");
    stubFetch();
    lastNightArrives(p, 6 * 60 + 30);
    expect(digestSleepPending(p)).toBe(false);
    expect(await runMorning(p, "DynamicEarly", null)).toEqual([FLOOR]);
  });

  it("sends at the DEADLINE — 08:10, not floor + 60 — when the night never arrives", async () => {
    // Constraint 2, never later than today, and constraint 1 of the design: one
    // pending section never holds activity, upcoming and biomarkers hostage. The
    // deadline derives from the arrival distribution (#2214), which is why it is not
    // the 08:00 the retry band would have given.
    const p = seedProfile("DynamicDeadline", "dynamic");
    const fetchMock = stubFetch();
    expect(await runMorning(p, "DynamicDeadline", null)).toEqual([
      DEADLINE_TICK,
    ]);
    expect(DEADLINE_TICK).toBe(
      Math.ceil(DEADLINE / TICK_MINUTES) * TICK_MINUTES
    );
    const body = sentBody(fetchMock);
    expect(body).not.toContain("😴 <b>Last night:");
    expect(body).toContain("Session");
  });

  it("sends at the deadline for a night that lands after it, with no Sleep section", async () => {
    const p = seedProfile("DynamicLate", "dynamic");
    const fetchMock = stubFetch();
    expect(await runMorning(p, "DynamicLate", 8 * 60 + 30)).toEqual([
      DEADLINE_TICK,
    ]);
    expect(sentBody(fetchMock)).not.toContain("😴 <b>Last night:");
  });

  it("admits exactly ONE send either way, however often the tick runs", async () => {
    for (const arrival of [7 * 60 + 26, null] as const) {
      const p = seedProfile("DynamicOnce", "dynamic");
      const fetchMock = stubFetch();
      const sent = await runMorning(p, "DynamicOnce", arrival);
      expect(sent).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Every later tick is the per-day marker's job, exactly as before.
      vi.setSystemTime(at("11:00"));
      expect(await tickDigest(p, "DynamicOnce")).toBe("already-sent");
      expect(getProfileSetting(p, DIGEST_MARKER_KEY)).toBe(FROZEN_DAY);
    }
  });

  it("declines without writing anything — the decline is not an attempt", async () => {
    const p = seedProfile("DynamicDecline", "dynamic");
    stubFetch();
    vi.setSystemTime(at(clock(FLOOR)));
    expect(await tickDigest(p, "DynamicDecline")).toBe("declined");
    expect(getProfileSetting(p, DIGEST_MARKER_KEY)).toBeUndefined();
    expect(getProfileSetting(p, DIGEST_ATTEMPT_KEY)).toBeUndefined();
  });

  it("leaves the #2209 trace, declared as a decline and naming its evidence", async () => {
    // Writing no SEND state does not mean writing no EVIDENCE (#2209, persisted by
    // #2220): the decision carries `decision: "declined"` so the operator page
    // classifies it by what the tick decided rather than by parsing message text, and
    // it carries the same predicate inputs the decision itself consumed.
    clearNotifyLog();
    beginNotifyRun();
    const p = seedProfile("DeclineTrace", "dynamic");
    stubFetch();
    vi.setSystemTime(at(clock(FLOOR)));
    expect(await tickDigest(p, "DeclineTrace")).toBe("declined");
    endNotifyRun();

    const line = declineTrace(p);
    expect(line).toBeDefined();
    expect(line?.decision).toBe("declined");
    expect(classifyNotifyLine(line!)).toBe("decline");
    const d = line?.detail ?? "";
    // The predicate half: the section is on and last night is genuinely outstanding.
    expect(d).toContain('"sleepSection":true');
    expect(d).toContain('"hasLastNight":false');
    expect(d).toContain('"tracking":true');
    // The arrival half, from #2214's statistic — never the composition it replaced.
    expect(d).toContain(`"arrivalNights":${MEASURED.length}`);
    expect(d).toContain(`"expectedByMin":${DEADLINE - DEADLINE_MARGIN_MIN}`);
    // And the countdown this decline is running against.
    expect(d).toContain(`"deadlineMinute":${DEADLINE}`);
  });

  it("a PROCEEDING re-check is logged too, so 'it considered waiting' is answerable", async () => {
    clearNotifyLog();
    beginNotifyRun();
    const p = seedProfile("ProceedTrace", "dynamic");
    stubFetch();
    lastNightArrives(p, FLOOR);
    vi.setSystemTime(at(clock(FLOOR)));
    expect(await tickDigest(p, "ProceedTrace")).toBe("sent");
    endNotifyRun();

    const line = declineTrace(p);
    expect(line?.decision).toBe("proceeded");
    expect(line?.detail).toContain('"hasLastNight":true');
  });

  it("STATIC never asks the question, so it writes no trace at all", async () => {
    clearNotifyLog();
    beginNotifyRun();
    const p = seedProfile("StaticNoTrace", "static");
    stubFetch();
    vi.setSystemTime(at(clock(FLOOR)));
    expect(await tickDigest(p, "StaticNoTrace")).toBe("sent");
    endNotifyRun();

    expect(declineTrace(p)).toBeUndefined();
  });

  it("collapses to 'send at the floor' with the Sleep section off", async () => {
    // With `digest_sleep_enabled = 0` there is nothing to wait for, so Dynamic IS
    // Static for that profile — every morning, not just the ones where sleep landed.
    const p = seedProfile("DynamicNoSleep", "dynamic");
    setProfileSetting(p, "digest_sleep_enabled", "0");
    stubFetch();
    expect(digestSleepPending(p)).toBe(false);
    expect(await runMorning(p, "DynamicNoSleep", null)).toEqual([FLOOR]);
  });
});

describe("a failed send backs off from the ATTEMPT, not from the floor", () => {
  it("records the attempt and retries an hour after it, once", async () => {
    // Rule 2. A Dynamic send fires at whatever tick the data landed on, so a
    // floor-anchored retry band would already be in the past and this send would
    // silently get no retry at all.
    const p = seedProfile("DynamicFail", "dynamic");
    stubFetch(false);
    lastNightArrives(p, 7 * 60 + 20);

    vi.setSystemTime(at("07:30"));
    expect(await tickDigest(p, "DynamicFail")).toBe("failed");
    expect(getProfileSetting(p, DIGEST_ATTEMPT_KEY)).toBe(
      `${FROZEN_DAY}|1|${7 * 60 + 30}`
    );
    expect(getProfileSetting(p, DIGEST_MARKER_KEY)).toBeUndefined();

    // The floor-anchored band (08:00) is NOT a retry, and neither is any tick before
    // the attempt-anchored one.
    for (const m of [7 * 60 + 45, 8 * 60, 8 * 60 + 15]) {
      vi.setSystemTime(at(clock(m)));
      expect(await tickDigest(p, "DynamicFail"), clock(m)).toBe("idle");
    }

    // 08:30 — attempt + SLOT_RETRY_DELAY_MIN.
    vi.setSystemTime(at("08:30"));
    expect(await tickDigest(p, "DynamicFail")).toBe("failed");
    expect(getProfileSetting(p, DIGEST_ATTEMPT_KEY)).toBe(
      `${FROZEN_DAY}|2|${8 * 60 + 30}`
    );

    // And that is the budget: two attempts a day, at every tick rate (#2121 item 3).
    for (let m = 8 * 60 + 45; m <= 23 * 60; m += TICK_MINUTES) {
      vi.setSystemTime(at(clock(m)));
      expect(await tickDigest(p, "DynamicFail"), clock(m)).toBe("idle");
    }
  });

  it("a STATIC failure writes no attempt record — its bands are slot-anchored", async () => {
    // The record exists to move Dynamic's retry anchor. Static's two attempts are
    // `slotAttempt`'s slot-anchored bands and it never reads the key, so writing one
    // would leave a `profile_settings` row nothing consults — and would make the
    // SEND_MARKER_REGISTRY entry's "Static never writes it" untrue.
    const p = seedProfile("StaticFail", "static");
    stubFetch(false);

    vi.setSystemTime(at(clock(FLOOR)));
    expect(await tickDigest(p, "StaticFail")).toBe("failed");
    expect(getProfileSetting(p, DIGEST_ATTEMPT_KEY)).toBeUndefined();
    expect(getProfileSetting(p, DIGEST_MARKER_KEY)).toBeUndefined();

    // Its retry is still the slot's second band, an hour after the SLOT.
    vi.setSystemTime(at(clock(FLOOR + 60)));
    expect(await tickDigest(p, "StaticFail")).toBe("failed");
    expect(getProfileSetting(p, DIGEST_ATTEMPT_KEY)).toBeUndefined();
  });
});

describe("never wait for something that is not coming", () => {
  it("a profile with no sleep data at all never waits", async () => {
    const p = newProfile("NoSleepSource");
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, ?, 'strength', 'Session', 45)`
    ).run(p, shiftDateStr(FROZEN_DAY, -1));
    setProfileSetting(p, "notify_digest_hour", clock(FLOOR));
    setProfileSetting(p, DIGEST_MODE_KEY, "dynamic");
    configureTelegram(p);
    stubFetch();

    expect(digestSleepPending(p)).toBe(false);
    expect(await runMorning(p, "NoSleepSource", null)).toEqual([FLOOR]);
  });

  it("an ABANDONED tracker never waits, however healthy its connection looks", async () => {
    // The case the connection-side staleness signal cannot see: the phone keeps
    // syncing and only the sleep rows stopped. Without the data-side predicate, "no
    // last night yet" is true every morning forever.
    const p = seedProfile("Abandoned", "dynamic");
    for (const n of MEASURED.slice(-4)) {
      db.prepare(
        `DELETE FROM metric_samples
          WHERE profile_id = ? AND metric = 'sleep_min' AND date = ?`
      ).run(p, n.date);
    }
    stubFetch();
    expect(digestSleepPending(p)).toBe(false);
    expect(await runMorning(p, "Abandoned", null)).toEqual([FLOOR]);
  });

  it("one skipped night still waits — a forgotten charge is not abandonment", () => {
    const p = seedProfile("OneSkipped", "dynamic");
    db.prepare(
      `DELETE FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min' AND date = ?`
    ).run(p, MEASURED[MEASURED.length - 1].date);
    expect(digestSleepPending(p)).toBe(true);
  });
});
