// DB INTEGRATION TIER — the still-going nudge records the minute it promised, and
// marks the question asked, ONLY WHEN SOMEBODY RECEIVED IT (#5194, twelfth pass).
//
// `runStillGoingSuggest` writes both inside `if (results.some((r) => r.delivered))`.
// The shape ABOVE that gate — a profile with no channel at all, `results.length === 0`
// — is pinned by detected-workout-end.test.ts ("records nothing when the nudge reached
// no channel"). The shape the gate itself exists for was pinned nowhere: a LIVE channel
// that delivered to nobody. Replacing the gate with `if (true)` therefore reddened
// nothing in the tree, and the central mechanism of #5194 could be deleted green.
//
// The reachable production shape is Web Push with every subscription answering
// 404/410 Gone: each is pruned without counting a success or an error, so the channel
// never throws and reports `ok: true` / `delivered: false`. It is the only shape this
// family can reach — the nudge is `kind: "other"`, `other` is NON_CONFIGURABLE, so no
// per-kind gate can empty its audience, and the email channel does not count itself
// configured with no recipients.
//
// ITS OWN FILE because it needs `web-push` mocked, and a `vi.mock` in a spec routes
// that spec to the isolated project (vitest.isolation.ts). detected-workout-end.test.ts,
// where the rest of this story lives, drives the tier's SHARED Telegram spies and
// cannot follow it there.
//
// Every value is synthetic.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Every endpoint here ends `/gone`, so every browser answers 410 and the channel
// prunes its whole audience without a single failure to report.
vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: () => ({
      publicKey: "vapid-public-0001",
      privateKey: "vapid-private-0001",
    }),
    setVapidDetails: () => {},
    sendNotification: vi.fn(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith("/ok")) return;
      throw Object.assign(new Error("push 410"), { statusCode: 410 });
    }),
  },
}));

import webpush from "web-push";
import { db, today } from "@/lib/db";
import { getProfileSetting, setTimezone } from "@/lib/settings";
import { getNotifyError } from "@/lib/notifications";
import {
  countPushSubscriptionsForLogin,
  ensureVapidKeys,
  savePushSubscription,
} from "@/lib/notifications/push";
import {
  runStillGoingSuggest,
  stillGoingEpisodes,
  stillGoingMarkerKey,
} from "@/lib/notifications/still-going";
import { readWorkoutEndProposal } from "@/lib/workout-end-proposal";
import { finishWorkoutSession } from "@/lib/workout-finish";
import { utcSqlString } from "@/lib/date";

const sendPush = vi.mocked(webpush.sendNotification);

const SENT = new Date("2026-07-17T17:20:00Z");
const TAP = new Date("2026-07-17T18:30:00Z");

// The fixture shape detected-workout-end.test.ts uses, and for the same reasons: a
// NAMED zone rather than the host's (#5338), a resting range of the profile's own
// (#4775), and a draft with a set on it (a husk is the draft expiry's, not this
// sweep's). Kept minimal — only what this one case needs.
function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

function seedRestingHr(profileId: number, bpm: number): void {
  const ins = db.prepare(
    "INSERT INTO body_metrics (profile_id, date, resting_hr) VALUES (?, ?, ?)"
  );
  for (let i = 1; i <= 10; i++) {
    const d = new Date(
      Date.parse(`${today(profileId)}T00:00:00Z`) - i * 86_400_000
    );
    ins.run(profileId, d.toISOString().slice(0, 10), bpm);
  }
}

function seedRange(
  profileId: number,
  fromHhmm: string,
  toHhmm: string,
  bpm: number
): void {
  const day = today(profileId);
  const ins = db.prepare(
    "INSERT INTO hr_minutes (profile_id, ts, bpm, n, source) VALUES (?, ?, ?, 1, 'health-connect')"
  );
  let t = Date.parse(`${day}T${fromHhmm}:00Z`);
  const end = Date.parse(`${day}T${toHhmm}:00Z`);
  while (t < end) {
    ins.run(profileId, new Date(t).toISOString().slice(0, 16), bpm);
    t += 60_000;
  }
}

function seedOpenWorkout(
  profileId: number,
  startHhmm: string,
  touchedAt: Date
): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, start_time, updated_at)
         VALUES (?, ?, 'strength', 'Session', ?, ?)`
      )
      .run(profileId, today(profileId), startHhmm, utcSqlString(touchedAt))
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, 'Back Squat', 1, 60, 5)`
  ).run(id);
  return id;
}

function newLogin(): number {
  return Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, 'x', 'member')"
      )
      .run(`gone-${Math.random().toString(36).slice(2)}`).lastInsertRowid
  );
}

function rowOf(id: number): {
  end_time: string | null;
  duration_min: number | null;
} {
  return db
    .prepare("SELECT end_time, duration_min FROM activities WHERE id = ?")
    .get(id) as { end_time: string | null; duration_min: number | null };
}

describe("a healthy channel that reached nobody promises nothing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SENT);
    sendPush.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("records no minute and burns no marker when every browser is Gone", async () => {
    const p = newProfile("StillGoingAllGone");
    seedRestingHr(p, 60);
    // Elevated 16:00→16:35, quiet after: the trace names 16:35, so there IS a promise
    // to be made here and the assertions below are about delivery, not about a nudge
    // with nothing to say.
    seedRange(p, "16:00", "16:35", 140);
    seedRange(p, "16:35", "17:00", 55);
    const id = seedOpenWorkout(p, "16:00", new Date("2026-07-17T16:30:00Z"));
    expect(
      stillGoingEpisodes(p, SENT).find((e) => e.rowId === id)?.detectedEnd
    ).toBe("16:35");

    // Their only channel: two browsers that have both unsubscribed. Push is the whole
    // audience — no Telegram chat, no mail — so `delivered` has nowhere else to come
    // from.
    ensureVapidKeys();
    const login = newLogin();
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(login, p);
    for (const i of [0, 1])
      savePushSubscription(login, {
        endpoint: `https://push.example/${login}-${i}/gone`,
        p256dh: "p256dh-0001",
        auth: "auth-0001",
      });

    const { failed } = await runStillGoingSuggest(p, "Ada", SENT);

    // THE CONTROLS INSIDE THE CASE, which are what make this the gate's own shape and
    // not the "no channel at all" one a `continue` already handles: the channel was
    // configured and really tried both browsers, both were GONE rather than merely
    // quiet, and nothing failed — `ok: true`, `delivered: false`, no delivery-health
    // error to show anyone.
    expect(sendPush).toHaveBeenCalledTimes(2);
    expect(countPushSubscriptionsForLogin(login)).toBe(0);
    expect(failed).toBe(false);
    expect(getNotifyError()).toBeNull();

    // No browser is holding a Finish button, so no minute was promised to anybody...
    expect(readWorkoutEndProposal(p, id)).toBeNull();
    // ...and the question was never actually asked, so a later tick may still ask it.
    expect(
      getProfileSetting(p, stillGoingMarkerKey("workout", id))
    ).toBeUndefined();

    // And the absence has a visible consequence for a person. An evening walk voids
    // the reading, so the request-path Finish reads the trace once and stamps its own
    // instant — where a record would have stamped 16:35 and thirty-five minutes for a
    // message nobody ever received.
    seedRange(p, "17:45", "18:00", 100);
    vi.setSystemTime(TAP);
    expect(finishWorkoutSession(p, id).kind).toBe("finished");
    expect(rowOf(id)).toEqual({ end_time: "18:30", duration_min: 150 });
  });
});
