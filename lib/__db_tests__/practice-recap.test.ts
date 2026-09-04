// DB INTEGRATION TIER — the practice finish message (#4775 §3), the one send in this
// app that waits for its own evidence before it exists.
//
// The gate under test runs the other way from every other send here: NO PHYSIOLOGY, NO
// SEND. So the cases that matter are the silences —
//   • a tap whose window the stream has not covered yet → nothing, and the one-shot
//     marker is NOT burned, because the marker records a send that happened;
//   • two hours later, still uncovered → still nothing, and still no marker;
//   • coverage arriving in between → exactly one send, then never again.
// Plus the Start-now duration ruling (owner, 2026-09-02) that gives a live row a
// window at all.
//
// Every value is synthetic (a fake HA webhook URL; no phones).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, today } from "@/lib/db";
import {
  getProfileSetting,
  setProfileHomeAssistant,
  setProfileSetting,
} from "@/lib/settings";
import { runPracticeRecaps } from "@/lib/notifications/practice-recap-dispatch";
import { practiceRecapMarkerKey } from "@/lib/notifications/practice-recap";
import {
  settleLivePracticeSessions,
  endLivePracticeSession,
  startLivePracticeSession,
} from "@/lib/practice-log";
import { getPracticeSession } from "@/lib/queries/wellness";
import { dispatch } from "@/lib/notifications";
import type {
  NotificationKind,
  NotificationMessage,
} from "@/lib/notifications/types";

const HA_URL = "http://homeassistant.local:8123/api/webhook/allos-practice";
// 18:00 UTC. The practice below runs 17:00 → 17:20, so at NOW it finished 40 min ago —
// inside the two-hour bound and past the pipeline's typical lag.
const NOW = new Date("2026-07-17T18:00:00Z");
const START_HHMM = "17:00";
const DURATION_MIN = 20;

function newProfile(
  name: string,
  disabledKinds: NotificationKind[] = []
): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setProfileSetting(id, "timezone", "UTC");
  setProfileSetting(id, "birthdate", "1986-06-01");
  const bm = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, resting_hr, source)
     VALUES (?, ?, ?, 'manual')`
  );
  bm.run(id, "2026-07-14", 52);
  bm.run(id, "2026-07-15", 54);
  bm.run(id, "2026-07-16", 53);
  setProfileHomeAssistant(id, {
    enabled: true,
    webhookUrl: HA_URL,
    secret: "",
    disabledKinds,
  });
  return id;
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function lastPayload(fetchMock: ReturnType<typeof vi.fn>): {
  title: string;
  body: string;
  kind: string;
} {
  const init = fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1] as {
    body: string;
  };
  return JSON.parse(init.body);
}

/** A finished practice row, filed the way the Just-finished tap files one. */
function seedPractice(
  profileId: number,
  date: string,
  practice = "Red light therapy",
  derivedWindow = 1
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO practice_logs
           (profile_id, practice, date, start_time, duration_min, live, derived_window)
         VALUES (?, ?, ?, ?, ?, 0, ?)`
      )
      .run(profileId, practice, date, START_HHMM, DURATION_MIN, derivedWindow)
      .lastInsertRowid
  );
}

/**
 * Minute HR from 17:00 for `count` minutes at `bpm`. `count` is HOW FAR THE PIPELINE
 * HAS DELIVERED, which is this file's one independent variable: 10 leaves the frontier
 * inside the session, 30 carries it past the end (the window is half-open, so covering
 * a 20-minute window takes a minute at or after 17:20).
 */
function seedHrMinutes(
  profileId: number,
  date: string,
  count: number,
  bpm = 95
): void {
  const insert = db.prepare(
    `INSERT INTO hr_minutes (profile_id, ts, bpm, n, source)
     VALUES (?, ?, ?, 1, 'health-connect')`
  );
  const start = Date.parse(`${date}T${START_HHMM}:00Z`);
  for (let i = 0; i < count; i++)
    insert.run(
      profileId,
      new Date(start + i * 60_000).toISOString().slice(0, 16),
      bpm
    );
}

/**
 * Earlier fully-covered sessions of the same practice, each 20 minutes at 80 bpm — a
 * usual rise of +27 over the fixture's 53 bpm baseline. The COUNT is the variable: the
 * usual is stated at three and withheld at two.
 */
function seedPriorSessions(
  profileId: number,
  at: readonly (readonly [string, string])[]
): void {
  const insertPrior = db.prepare(
    `INSERT INTO practice_logs
       (profile_id, practice, date, start_time, duration_min, live, derived_window)
     VALUES (?, 'Red light therapy', ?, ?, 20, 0, 1)`
  );
  const insertHr = db.prepare(
    `INSERT INTO hr_minutes (profile_id, ts, bpm, n, source)
     VALUES (?, ?, 80, 1, 'health-connect')`
  );
  for (const [day, hhmm] of at) {
    insertPrior.run(profileId, day, hhmm);
    const base = Date.parse(`${day}T${hhmm}:00Z`);
    for (let i = 0; i < 30; i++)
      insertHr.run(
        profileId,
        new Date(base + i * 60_000).toISOString().slice(0, 16)
      );
  }
}

async function tick(
  profileId: number,
  at: Date = NOW
): Promise<{ sent: number; failed: boolean }> {
  return runPracticeRecaps(
    profileId,
    async (msg: NotificationMessage) => {
      const results = await dispatch(profileId, msg);
      return {
        delivered: results.some((r) => r.ok),
        failed: results.some((r) => !r.ok),
      };
    },
    at
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db.prepare("DELETE FROM notify_lifecycle").run();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the practice finish message waits for the stream", () => {
  it("sends once coverage arrives, and never twice", async () => {
    const p = newProfile("PracCovered");
    const date = today(p);
    const rowId = seedPractice(p, date);
    seedHrMinutes(p, date, 30);
    const fetchMock = stubFetch();

    const first = await tick(p);
    expect(first.sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = lastPayload(fetchMock);
    expect(payload.kind).toBe("practice-recap");
    expect(payload.body).toContain("Red light therapy done");
    // Derived window (the tap stated a duration, not an end), so the length is hedged.
    expect(payload.body).toContain("about 20 min");
    // Mean 95 over a baseline of 53: a signed rise, no verdict word anywhere in it.
    expect(payload.body).toContain("HR 95 avg, +42 over resting");
    expect(getProfileSetting(p, practiceRecapMarkerKey(rowId))).toBe(date);

    const second = await tick(p);
    expect(second.sent).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // THE LAG CASE, and the one this file exists for.
  it("sends NOTHING while the frontier sits inside the window, and burns no marker", async () => {
    const p = newProfile("PracUncovered");
    const date = today(p);
    const rowId = seedPractice(p, date);
    seedHrMinutes(p, date, 10); // frontier 17:09, window ends 17:20
    const fetchMock = stubFetch();

    const r = await tick(p);
    expect(r.sent).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    // NOT burned: the row is still eligible for the rest of the bound.
    expect(
      getProfileSetting(p, practiceRecapMarkerKey(rowId)) ?? null
    ).toBeNull();
  });

  // The same row, one tick later, with the pipeline caught up.
  it("fires on the FIRST tick with coverage and not before", async () => {
    const p = newProfile("PracLate");
    const date = today(p);
    seedPractice(p, date);
    seedHrMinutes(p, date, 10);
    const fetchMock = stubFetch();

    expect((await tick(p)).sent).toBe(0);
    // The rest of the window lands in the next push.
    db.prepare("DELETE FROM hr_minutes WHERE profile_id = ?").run(p);
    seedHrMinutes(p, date, 30);
    expect((await tick(p)).sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // THE BOUND, and the fixture is FULLY COVERED on purpose: the bound is then the
  // ONLY thing keeping this row silent, so the case can actually fail if the bound
  // stops working. An uncovered fixture here would have stayed green with the bound
  // deleted — it was silent for the other reason — which is a test that cannot reach
  // the state it forbids.
  it("stops being eligible past the two-hour bound, still without a marker", async () => {
    const p = newProfile("PracExpired");
    const date = today(p);
    const rowId = seedPractice(p, date);
    seedHrMinutes(p, date, 30);
    const fetchMock = stubFetch();

    // Window ends 17:20; 19:21 is one minute past the bound.
    const r = await tick(p, new Date("2026-07-17T19:21:00Z"));
    expect(r.sent).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      getProfileSetting(p, practiceRecapMarkerKey(rowId)) ?? null
    ).toBeNull();
  });

  // The other side of the same boundary, so the bound is a bound and not a wall.
  it("is still eligible one minute INSIDE the bound", async () => {
    const p = newProfile("PracJustInside");
    const date = today(p);
    seedPractice(p, date);
    seedHrMinutes(p, date, 30);
    const fetchMock = stubFetch();
    // 19:19 is one minute short of two hours after the 17:20 end.
    expect((await tick(p, new Date("2026-07-17T19:19:00Z"))).sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is not eligible before the window has finished", async () => {
    const p = newProfile("PracRunning");
    const date = today(p);
    seedPractice(p, date);
    seedHrMinutes(p, date, 30);
    const fetchMock = stubFetch();
    // 17:10 — the session is still running, whatever the stream holds.
    expect((await tick(p, new Date("2026-07-17T17:10:00Z"))).sent).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing for a profile with no continuous stream at all", async () => {
    const p = newProfile("PracNoStream");
    const rowId = seedPractice(p, today(p));
    const fetchMock = stubFetch();
    expect((await tick(p)).sent).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      getProfileSetting(p, practiceRecapMarkerKey(rowId)) ?? null
    ).toBeNull();
  });

  it("contacts nobody when the kind is off on the delivery channel", async () => {
    const p = newProfile("PracKindOff", ["practice-recap"]);
    const date = today(p);
    const rowId = seedPractice(p, date);
    seedHrMinutes(p, date, 30);
    const fetchMock = stubFetch();

    await tick(p);
    // NOTHING LEAVES THE PROCESS. The kind×channel matrix is applied inside the
    // adapter, so the channel still reports a clean run and the one-shot is spent —
    // the same shape every other kind-gated send in this app has, and the right one:
    // re-offering the message on the next tick cannot change the answer, and a marker
    // that never burns is a row the tick reconsiders forever.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getProfileSetting(p, practiceRecapMarkerKey(rowId))).toBe(date);
  });

  it("states the profile's usual rise once it has three prior measured sessions", async () => {
    const p = newProfile("PracUsual");
    const date = today(p);
    // Three earlier sessions of the same practice on the two prior days, each 20 min
    // and each fully covered, all at 80 bpm ⇒ a usual rise of +27 over a 53 baseline.
    seedPriorSessions(p, [
      ["2026-07-15", "09:00"],
      ["2026-07-15", "11:00"],
      ["2026-07-16", "09:00"],
    ]);
    seedPractice(p, date);
    seedHrMinutes(p, date, 30);
    const fetchMock = stubFetch();

    await tick(p);
    expect(lastPayload(fetchMock).body).toContain("(usual +27)");
  });

  // TWO priors, not zero. Zero would be silent whatever the floor is, so it could not
  // fail if the floor moved; two is one short of it, which is the only fixture that
  // actually tests where the floor SITS.
  it("states the fact alone one prior event short of the floor", async () => {
    const p = newProfile("PracNoUsual");
    const date = today(p);
    seedPriorSessions(p, [
      ["2026-07-16", "09:00"],
      ["2026-07-16", "11:00"],
    ]);
    seedPractice(p, date);
    seedHrMinutes(p, date, 30);
    const fetchMock = stubFetch();
    await tick(p);
    expect(lastPayload(fetchMock).body).not.toContain("usual");
  });
});

describe("Start now stamps the practice's usual duration (owner ruling 2026-09-02)", () => {
  it("gives a live row a window, which the End tap then overwrites with the observed one", () => {
    const p = newProfile("PracLive");
    const date = today(p);
    // One prior session establishes the usual: 20 minutes.
    seedPractice(p, date, "Sauna");

    const started = startLivePracticeSession(p, "Sauna", "page");
    expect(started.kind).toBe("started");
    const liveId = started.kind === "started" ? started.session.id : 0;
    expect(getPracticeSession(p, liveId)).toMatchObject({
      duration_min: 20,
      derived_window: 1,
      live: 1,
    });

    // Five minutes later the person taps End: the observed length replaces the usual.
    vi.setSystemTime(new Date(NOW.getTime() + 5 * 60_000));
    expect(endLivePracticeSession(p, liveId).kind).toBe("ended");
    expect(getPracticeSession(p, liveId)).toMatchObject({
      duration_min: 5,
      live: 0,
    });
  });

  // WAS the abandoned derived row #4900 named: swept at the six-hour bound with a
  // duration and no end, still voting in the usual. #5091 made that row unreachable
  // for a practice that HAS a usual — it completed at start + 20, five and a half
  // hours before the bound could reach it — so the fixture asserts the absence.
  it("has no abandoned derived row left to sweep, only a completed one", () => {
    const p = newProfile("PracSwept");
    const date = today(p);
    seedPractice(p, date, "Sauna");
    const started = startLivePracticeSession(p, "Sauna", "page");
    const liveId = started.kind === "started" ? started.session.id : 0;

    vi.setSystemTime(new Date(NOW.getTime() + 7 * 60 * 60_000));
    expect(settleLivePracticeSessions(p)).toBe(1);
    expect(getPracticeSession(p, liveId)).toMatchObject({
      duration_min: 20,
      end_time: "18:20",
      derived_window: 1,
      live: 0,
    });
  });

  it("writes no duration for a practice with no recorded one — blank stays blank", () => {
    const p = newProfile("PracNoHistory");
    const started = startLivePracticeSession(p, "Breathwork", "page");
    const liveId = started.kind === "started" ? started.session.id : 0;
    expect(getPracticeSession(p, liveId)).toMatchObject({
      duration_min: null,
      live: 1,
    });
  });
});
