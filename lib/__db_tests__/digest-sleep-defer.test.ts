// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #2102 — the morning digest fired before last night's sleep arrived.
//
// The measured shape, from a real Health Connect profile over 11 nights: typical
// wake 05:40, and the sleep row lands a median of 69 minutes later (06:02 … 07:49).
// At hour 6 — what `auto` resolved to — the digest had last night in hand on 0 of
// 11 mornings, BY CONSTRUCTION, because it was scheduled for the wake hour and the
// data is systematically behind waking.
//
// This suite drives the tick's real digest gate over that fixture at moved clock
// hours. `tickDigest` below mirrors scripts/notify.ts's digest conditional exactly
// (the same four terms in the same order) — the pattern workout-presence-gate.test
// established for the tick's slot loop, since scripts/notify.ts runs main() on
// import and cannot be imported by a test.
//
// The two halves stay separate on purpose: this decides WHEN the digest sends,
// #2099 decides WHAT it prints. A digest that reaches the end of its window with no
// sleep in hand simply has no Sleep section — already correct behavior, asserted
// here so it stays that way.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { hourInTz, shiftDateStr } from "@/lib/date";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import {
  getNotifySchedule,
  getProfileSetting,
  setProfileSetting,
  setTelegramBotConfig,
  setTimezone,
} from "@/lib/settings";
import {
  deferDigestForSleep,
  digestSleepPending,
  runDigest,
} from "@/lib/notifications/digest-data";
import { DIGEST_MARKER_KEY } from "@/lib/notifications/send-markers";
import { slotDue } from "@/lib/notifications/schedule";
import { seedLoginTelegram } from "./fixtures";

// The frozen morning every fixture is anchored on. A Wednesday; nothing in the
// digest's scheduling depends on the weekday, but a fixed one keeps the recap out
// of the way.
const FROZEN_DAY = "2026-07-22";
const at = (hhmm: string) => new Date(`${FROZEN_DAY}T${hhmm}:00Z`);

// Wake 05:40 — 340 minutes, the measured median. round(340/60) is 6: the old
// resolution, and the whole first defect.
const WAKE_HHMM = "05:40";
const WAKE_MINUTE = 5 * 60 + 40;
// A 22:30 → 05:40 night: 430 minutes.
const NIGHT_MIN = 430;
// The eleven measured arrival lags, in minutes after the wake instant:
// 06:02, 06:06, 06:15, 06:27, 06:50, 07:05, 07:11, 07:26, 07:26, 07:42, 07:49.
const MEASURED_LAGS = [22, 26, 35, 47, 70, 85, 91, 106, 106, 122, 129];
// What that distribution resolves the auto digest hour to.
const RESOLVED_HOUR = 8;

let seq = 0;

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`${name}${++seq}`)
      .lastInsertRowid
  );
  setTimezone(id, "UTC"); // profile-local hour == the frozen UTC hour
  return id;
}

const session = (wakeDay: string): NormMetricSample => ({
  metric: "sleep_min",
  date: wakeDay,
  start_time: `${shiftDateStr(wakeDay, -1)}T22:30:00Z`,
  end_time: `${wakeDay}T${WAKE_HHMM}:00Z`,
  value: NIGHT_MIN,
});

function syncEventId(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO integration_sync_events (profile_id, provider, at, ok)
         VALUES (?, 'health-connect', ?, 1)`
      )
      .run(profileId, `${FROZEN_DAY} 04:00:00`).lastInsertRowid
  );
}

// Record that this night's row ARRIVED `lagMin` minutes after the wake instant —
// the provenance join (integration_sync_rows → metric_samples) the resolution reads.
function recordArrival(
  profileId: number,
  eventId: number,
  wakeDay: string,
  lagMin: number
): void {
  const start = `${shiftDateStr(wakeDay, -1)}T22:30:00Z`;
  const row = db
    .prepare(
      `SELECT id FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min' AND start_time = ?`
    )
    .get(profileId, start) as { id: number } | undefined;
  if (!row) throw new Error(`no sleep sample for ${wakeDay}`);
  const arrived = new Date(
    new Date(`${wakeDay}T${WAKE_HHMM}:00Z`).getTime() + lagMin * 60_000
  )
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  db.prepare(
    `INSERT INTO integration_sync_rows
       (event_id, target_table, target_id, disposition, created_at)
     VALUES (?, 'metric_samples', ?, 'inserted', ?)`
  ).run(eventId, row.id, arrived);
}

function seedNight(profileId: number, wakeDay: string): void {
  upsertMetricSamples(profileId, [session(wakeDay)], "health-connect");
}

// The measured profile: 20 nights of history ending the night BEFORE last night,
// with the eleven measured arrivals on the eleven most recent of them. Last night
// itself is deliberately absent — that is the state every morning starts in.
function seedMeasuredProfile(name: string): number {
  const p = newProfile(name);
  const eventId = syncEventId(p);
  for (let back = 1; back <= 20; back++)
    seedNight(p, shiftDateStr(FROZEN_DAY, -back));
  MEASURED_LAGS.forEach((lag, i) =>
    recordArrival(p, eventId, shiftDateStr(FROZEN_DAY, -(i + 1)), lag)
  );
  // Ordinary content, so the digest has something to say in every branch and the
  // "sent without the section" case is a real message rather than an empty one.
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min)
     VALUES (?, ?, 'strength', 'Session', 45)`
  ).run(p, shiftDateStr(FROZEN_DAY, -1));
  setProfileSetting(p, "notify_digest_hour", "auto");
  configureTelegram(p);
  return p;
}

function configureTelegram(profileId: number): void {
  setTelegramBotConfig({
    telegramBotToken: "digest-defer-token",
    telegramMode: "poll",
  });
  seedLoginTelegram(profileId, `2102${profileId}`);
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

const sentBody = (mock: ReturnType<typeof vi.fn>, n = 0): string =>
  String(JSON.parse(mock.mock.calls[n][1].body as string).text);

type TickOutcome = "not-due" | "already-sent" | "deferred" | "sent";

// scripts/notify.ts's digest conditional, term for term:
//
//   sched.digestHour != null &&
//   slotDue(sched.digestHour, hour) &&
//   getProfileSetting(profile.id, DIGEST_MARKER_KEY) !== date &&
//   !deferDigestForSleep(profile.id, sched.digestHour, hour, sched.digestAuto)
//     → runDigest(...)
async function tickDigest(
  profileId: number,
  name: string
): Promise<TickOutcome> {
  const hour = hourInTz("UTC", new Date());
  const date = today(profileId);
  const sched = getNotifySchedule(profileId);
  if (sched.digestHour == null || !slotDue(sched.digestHour, hour))
    return "not-due";
  if (getProfileSetting(profileId, DIGEST_MARKER_KEY) === date)
    return "already-sent";
  if (deferDigestForSleep(profileId, sched.digestHour, hour, sched.digestAuto))
    return "deferred";
  await runDigest(profileId, name, date);
  return "sent";
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("08:00"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the `auto` digest hour resolves past the arrivals (#2102 defect 1)", () => {
  it("lands after every measured arrival instead of on the wake hour", () => {
    const p = seedMeasuredProfile("AutoResolve");
    const sched = getNotifySchedule(p);

    // The old answer was 6 — round(340/60) — which is before ALL eleven arrivals.
    expect(Math.round(WAKE_MINUTE / 60)).toBe(6);
    expect(sched.digestHour).toBe(RESOLVED_HOUR);
    expect(sched.digestAuto).toBe(true);
    for (const lag of MEASURED_LAGS)
      expect(WAKE_MINUTE + lag).toBeLessThan(RESOLVED_HOUR * 60);
  });

  it("leaves the `auto` Morning intake hour on the WAKE hour", () => {
    // Constraint 4: the Morning slot needs you awake, not your tracker synced, so
    // the wake hour is the correct answer for it. The arrival lag is the digest's
    // alone and must not leak into the shared helper.
    const p = seedMeasuredProfile("MorningUntouched");
    const sched = getNotifySchedule(p);
    expect(sched.supplementHours.Morning).toBe(6);
    expect(sched.morningAuto).toBe(true);
    expect(sched.digestHour).toBe(RESOLVED_HOUR);
  });

  it("falls back to the wake hour when the arrival sample is too thin", () => {
    // No provenance rows at all — a manually logged sleeper, or an instance whose
    // integration_sync_rows retention has aged out. The deferral is the safety net
    // for this profile, not a percentile built on nothing.
    const p = newProfile("ThinSample");
    for (let back = 1; back <= 20; back++)
      seedNight(p, shiftDateStr(FROZEN_DAY, -back));
    setProfileSetting(p, "notify_digest_hour", "auto");
    expect(getNotifySchedule(p).digestHour).toBe(6);
  });
});

describe("the digest defers ONCE for a pending night (#2102 defect 2)", () => {
  it("declines at its hour, then sends at hour+1 WITH the Sleep section", async () => {
    const p = seedMeasuredProfile("DeferThenArrive");
    const td = today(p);
    const fetchMock = stubFetch();

    // 08:00 — last night has not landed. The digest declines; nothing is sent and,
    // crucially, nothing is MARKED, so the retry hour still sees the day as open.
    expect(digestSleepPending(p)).toBe(true);
    expect(await tickDigest(p, "DeferThenArrive")).toBe("deferred");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getProfileSetting(p, DIGEST_MARKER_KEY)).toBeUndefined();

    // The tracker pushes at 08:20, inside the window.
    seedNight(p, FROZEN_DAY);
    expect(digestSleepPending(p)).toBe(false);

    // 09:00 — the retry hour sends, and last night is in the message.
    vi.setSystemTime(at("09:00"));
    expect(await tickDigest(p, "DeferThenArrive")).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody(fetchMock)).toContain("😴 Last night: 7h 10m");
    expect(getProfileSetting(p, DIGEST_MARKER_KEY)).toBe(td);
  });

  it("sends at the end of the window when the night never arrives — without the section", async () => {
    // The defer-ONCE bound. One pending section must never hold the rest of the
    // digest hostage, and the two-hour window enforces that structurally.
    const p = seedMeasuredProfile("NeverArrives");
    const fetchMock = stubFetch();

    expect(await tickDigest(p, "NeverArrives")).toBe("deferred");

    vi.setSystemTime(at("09:00"));
    expect(await tickDigest(p, "NeverArrives")).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = sentBody(fetchMock);
    expect(body).not.toContain("😴 Last night:");
    expect(body).toContain("Session"); // the rest of the digest went out as usual
  });

  it("sends exactly ONE digest across the whole window, however often the tick runs", async () => {
    const p = seedMeasuredProfile("RepeatedTicks");
    const fetchMock = stubFetch();

    // Two ticks inside the slot hour: both decline, neither marks.
    expect(await tickDigest(p, "RepeatedTicks")).toBe("deferred");
    expect(await tickDigest(p, "RepeatedTicks")).toBe("deferred");

    seedNight(p, FROZEN_DAY);
    vi.setSystemTime(at("09:00"));
    expect(await tickDigest(p, "RepeatedTicks")).toBe("sent");
    // Everything after is the per-day marker's job, exactly as before this change.
    expect(await tickDigest(p, "RepeatedTicks")).toBe("already-sent");
    vi.setSystemTime(at("10:00"));
    expect(await tickDigest(p, "RepeatedTicks")).toBe("not-due");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves a MANUALLY set hour alone", async () => {
    // Constraint 1: a manual hour is user-owned timing. Deferring it silently would
    // make the user's own setting untrue.
    const p = seedMeasuredProfile("ManualHour");
    setProfileSetting(p, "notify_digest_hour", String(RESOLVED_HOUR));
    const fetchMock = stubFetch();

    const sched = getNotifySchedule(p);
    expect(sched.digestAuto).toBe(false);
    expect(sched.digestHour).toBe(RESOLVED_HOUR);
    // Same pending night, same hour — and it sends anyway.
    expect(digestSleepPending(p)).toBe(true);
    expect(await tickDigest(p, "ManualHour")).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody(fetchMock)).not.toContain("😴 Last night:");
  });
});

describe("never wait for something that is not coming", () => {
  it("a profile with no sleep data at all never defers", async () => {
    const p = newProfile("NoSleepSource");
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, ?, 'strength', 'Session', 45)`
    ).run(p, shiftDateStr(FROZEN_DAY, -1));
    setProfileSetting(p, "notify_digest_hour", String(8));
    configureTelegram(p);
    const fetchMock = stubFetch();

    expect(digestSleepPending(p)).toBe(false);
    expect(await tickDigest(p, "NoSleepSource")).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an ABANDONED tracker never defers, however healthy its connection looks", async () => {
    // The case the connection-side staleness signal cannot see: the phone keeps
    // syncing (ok events, non-zero inserts) and only the sleep rows stopped. Without
    // the data-side predicate, "no last night yet" is true every morning forever and
    // this profile would defer its digest daily.
    const p = seedMeasuredProfile("Abandoned");
    // Four nights of nothing: the last recorded night is FROZEN_DAY − 5.
    for (const back of [1, 2, 3, 4]) {
      db.prepare(
        `DELETE FROM metric_samples
          WHERE profile_id = ? AND metric = 'sleep_min' AND date = ?`
      ).run(p, shiftDateStr(FROZEN_DAY, -back));
    }
    const fetchMock = stubFetch();

    expect(digestSleepPending(p)).toBe(false);
    expect(await tickDigest(p, "Abandoned")).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("one skipped night still defers — a forgotten charge is not abandonment", () => {
    const p = seedMeasuredProfile("OneSkipped");
    db.prepare(
      `DELETE FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min' AND date = ?`
    ).run(p, shiftDateStr(FROZEN_DAY, -1));
    expect(digestSleepPending(p)).toBe(true);
  });

  it("a profile that turned the Sleep section OFF never defers for it", async () => {
    const p = seedMeasuredProfile("SectionOff");
    setProfileSetting(p, "digest_sleep_enabled", "0");
    const fetchMock = stubFetch();

    expect(digestSleepPending(p)).toBe(false);
    expect(await tickDigest(p, "SectionOff")).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
