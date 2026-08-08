// SERVER-ACTION TIER — the offline replay route's PROFILE ATTRIBUTION (issue #599).
// The route is a cookie-authed Route Handler, not a Server Action, but it resolves
// the acting identity through the SAME lib/auth chokepoint the action tests mock
// (getCurrentSession / getAccessibleProfiles / accessForProfile, all faithful against
// the real temp DB), so this tier drives it end-to-end with a real login→profile grant
// matrix. It proves the fix for the cross-profile write:
//   (a) a stamped intent for profile B, replayed while acting as A with a WRITE grant
//       to B, lands on B — never on the active profile A;
//   (b) a stamped intent for a profile the login can't write is REJECTED, nothing
//       written (no silent reroute onto the active profile);
//   (c) the dose flow still applies, and its ownership check still rejects a dose that
//       isn't owned by the stamped profile;
//   (d) a LEGACY unstamped intent falls back to the active profile (backward compat).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { POST } from "@/app/api/offline-replay/route";
import { createLogin, createProfile, actAs } from "./harness";
import {
  shiftDateStr,
  utcInstant,
  utcSqlString,
  zonedDateParts,
  zonedWallTimeToUtc,
} from "@/lib/date";
import { getTimezone } from "@/lib/settings";
import { isCompletedSessionRow } from "@/lib/workout-presence";
import {
  STALE_QUEUED_DOSE_REASON,
  type QueuedIntent,
} from "@/lib/offline/queue";

let keySeq = 0;
function uniqueKey(): string {
  return `replay-test-${Date.now()}-${++keySeq}`;
}

async function replay(intents: unknown[]): Promise<{
  status: number;
  body: {
    ok: boolean;
    results?: {
      key: string;
      status: string;
      reason?: string;
      // #2296: set on a `done` result whose write kept the row but refused a stated
      // time. The mirror image of `reason`, which only ever accompanies a rejection.
      timeNotice?: string;
    }[];
  };
}> {
  const res = await POST(
    new Request("http://x/api/offline-replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intents }),
    })
  );
  return { status: res.status, body: await res.json() };
}

function bodyMetricIntent(
  profileId: number | undefined,
  notes: string
): QueuedIntent {
  return {
    key: uniqueKey(),
    flow: "body-metric",
    date: "2026-07-10",
    capturedAt: "2026-07-10T09:00:00.000Z",
    payload: {
      weight: "82",
      weightUnit: "kg",
      bodyFatPct: null,
      restingHr: null,
      notes,
    },
    ...(profileId === undefined ? {} : { profileId }),
    attempts: 0,
  };
}

function bodyMetricsFor(profileId: number, notes: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM body_metrics WHERE profile_id = ? AND notes = ?"
      )
      .get(profileId, notes) as { n: number }
  ).n;
}

describe("offline replay — profile attribution (issue #599)", () => {
  it("(a) applies a stamped intent to its CAPTURED profile, not the active one", async () => {
    // A caregiver member granted BOTH A and B (write), currently acting as A.
    const member = createLogin({ role: "member" });
    const profileA = createProfile("Replay A", member.id);
    const profileB = createProfile("Replay B", member.id);
    actAs(member, profileA);

    const notes = uniqueKey();
    const { status, body } = await replay([
      bodyMetricIntent(profileB.id, notes),
    ]);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.results?.[0].status).toBe("done");
    // The B-captured metric landed on B — and NOTHING landed on the active profile A.
    expect(bodyMetricsFor(profileB.id, notes)).toBe(1);
    expect(bodyMetricsFor(profileA.id, notes)).toBe(0);
  });

  it("(b) REJECTS a stamped intent for a profile the login can't write — nothing written", async () => {
    // Member granted ONLY A. B exists but is NOT theirs.
    const member = createLogin({ role: "member" });
    const profileA = createProfile("RejectA", member.id);
    const profileB = createProfile("RejectB"); // ungranted to this member
    actAs(member, profileA);

    const notes = uniqueKey();
    const { status, body } = await replay([
      bodyMetricIntent(profileB.id, notes),
    ]);

    expect(status).toBe(200); // per-intent honesty, not a blanket 4xx
    expect(body.results?.[0].status).toBe("rejected");
    expect(body.results?.[0].reason).toMatch(/permission/i);
    // Not applied to B (no access) AND not silently rerouted onto the active A.
    expect(bodyMetricsFor(profileB.id, notes)).toBe(0);
    expect(bodyMetricsFor(profileA.id, notes)).toBe(0);
  });

  it("(b2) REJECTS a stamped intent when the grant on the target is read-only", async () => {
    const member = createLogin({ role: "member" });
    const profileA = createProfile("RoA", member.id);
    const profileB = createProfile("RoB", member.id);
    // Downgrade the member's grant on B to read-only.
    db.prepare(
      "UPDATE login_profiles SET access = 'read' WHERE login_id = ? AND profile_id = ?"
    ).run(member.id, profileB.id);
    actAs(member, profileA);

    const notes = uniqueKey();
    const { body } = await replay([bodyMetricIntent(profileB.id, notes)]);
    expect(body.results?.[0].status).toBe("rejected");
    expect(bodyMetricsFor(profileB.id, notes)).toBe(0);
  });

  it("(c) applies a stamped DOSE intent to its captured profile, and ownership still gates it", async () => {
    const member = createLogin({ role: "member" });
    const profileA = createProfile("DoseA", member.id);
    const profileB = createProfile("DoseB", member.id);
    actAs(member, profileA);

    // A dose owned by B.
    const itemB = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind)
           VALUES (?, 'Item B', 1, 'supplement')`
        )
        .run(profileB.id).lastInsertRowid
    );
    const doseB = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, retired)
           VALUES (?, '1 cap', 'morning', 'any', 0, 0)`
        )
        .run(itemB).lastInsertRowid
    );

    // Today-anchored: the dose write cores bound how far a log may land from the
    // profile's today (#614), and since #1427 the replay rides those same cores.
    const date = today(profileB.id);
    const { body } = await replay([
      {
        key: uniqueKey(),
        flow: "dose",
        date,
        capturedAt: `${date}T09:00:00.000Z`,
        payload: { doseId: doseB },
        profileId: profileB.id,
        attempts: 0,
      },
    ]);
    expect(body.results?.[0].status).toBe("done");
    const logged = db
      .prepare("SELECT id FROM intake_item_logs WHERE dose_id = ? AND date = ?")
      .get(doseB, date);
    expect(logged).toBeTruthy();

    // A dose stamped to B but belonging to A is rejected by the ownership check even
    // though the login CAN write B.
    const itemA = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind)
           VALUES (?, 'Item A', 1, 'supplement')`
        )
        .run(profileA.id).lastInsertRowid
    );
    const doseA = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, retired)
           VALUES (?, '1 cap', 'morning', 'any', 0, 0)`
        )
        .run(itemA).lastInsertRowid
    );
    const { body: body2 } = await replay([
      {
        key: uniqueKey(),
        flow: "dose",
        date,
        capturedAt: `${date}T09:00:00.000Z`,
        payload: { doseId: doseA },
        profileId: profileB.id,
        attempts: 0,
      },
    ]);
    expect(body2.results?.[0].status).toBe("rejected");
  });

  it("(d) a LEGACY unstamped intent falls back to the active profile (backward compat)", async () => {
    const member = createLogin({ role: "member" });
    const profileA = createProfile("LegacyA", member.id);
    actAs(member, profileA);

    const notes = uniqueKey();
    const { body } = await replay([bodyMetricIntent(undefined, notes)]);
    expect(body.results?.[0].status).toBe("done");
    expect(bodyMetricsFor(profileA.id, notes)).toBe(1);
  });
});

// ── #1427: the queued dose confirm rides the SHARED write core ────────────────
//
// Driven end-to-end through the route (cookie-authed, real grant matrix, real DB),
// because the whole point of the change is that the replay is no longer a private
// offline writer: it goes through markDoseTaken, so it inherits that core's typed
// refusals (retired dose, PAUSED item, the other resolution already standing) and
// its per-(dose,date) idempotency — and those refusals must reach the client with a
// reason, never be reported as synced.
describe("offline replay — dose confirms (issue #1427)", () => {
  function seedItem(
    profileId: number,
    opts: { active?: number; quantityOnHand?: number | null } = {}
  ): number {
    return Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, quantity_on_hand, qty_per_dose)
           VALUES (?, ?, ?, 'medication', ?, 1)`
        )
        .run(
          profileId,
          `Replay Med ${uniqueKey()}`,
          opts.active ?? 1,
          opts.quantityOnHand ?? null
        ).lastInsertRowid
    );
  }

  function seedDose(itemId: number, retired = 0): number {
    return Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, retired)
           VALUES (?, '1 tab', 'morning', 'any', 0, ?)`
        )
        .run(itemId, retired).lastInsertRowid
    );
  }

  function doseIntent(
    doseId: number,
    profileId: number,
    date: string,
    clientTakenAt?: string
  ) {
    return {
      key: uniqueKey(),
      flow: "dose" as const,
      date,
      capturedAt: new Date().toISOString(),
      payload: { doseId, ...(clientTakenAt ? { clientTakenAt } : {}) },
      profileId,
      attempts: 0,
    };
  }

  function logFor(doseId: number, date: string) {
    return db
      .prepare(
        "SELECT status, amount, recorded_at FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      )
      .get(doseId, date) as
      | { status: string; amount: string | null; recorded_at: string | null }
      | undefined;
  }

  it("lands the confirm stamped with the CAPTURED tap time, not the replay time", async () => {
    const admin = createLogin();
    const profile = createProfile(`TakenAt ${uniqueKey()}`);
    actAs(admin, profile);
    const itemId = seedItem(profile.id, { quantityOnHand: 12 });
    const doseId = seedDose(itemId);
    const date = today(profile.id);
    // Local midnight of the log's own day: inside the day in the profile timezone and
    // (bar the first instant of the day) hours before the replay, so a stored recorded_at
    // matching it could not have come from the server's own clock.
    const tapped = zonedWallTimeToUtc(getTimezone(profile.id), date, "00:00")!;

    const { body } = await replay([
      doseIntent(doseId, profile.id, date, tapped.toISOString()),
    ]);
    expect(body.results?.[0].status).toBe("done");

    const log = logFor(doseId, date);
    expect(log?.status).toBe("taken");
    expect(log?.amount).toBe("1 tab"); // amount snapshotted from the dose row at replay
    expect(log?.recorded_at).toBe(utcSqlString(tapped));
    // Supply moved through the same core, exactly once.
    expect(
      (
        db
          .prepare(
            "SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?"
          )
          .get(itemId) as { q: number }
      ).q
    ).toBe(11);
  });

  it("surfaces the PAUSED-item refusal instead of silently confirming", async () => {
    const admin = createLogin();
    const profile = createProfile(`Paused ${uniqueKey()}`);
    actAs(admin, profile);
    const itemId = seedItem(profile.id, { active: 0, quantityOnHand: 5 });
    const doseId = seedDose(itemId);
    const date = today(profile.id);

    const { body } = await replay([doseIntent(doseId, profile.id, date)]);
    expect(body.results?.[0].status).toBe("rejected");
    expect(body.results?.[0].reason).toMatch(/paused/i);
    expect(logFor(doseId, date)).toBeUndefined();
    expect(
      (
        db
          .prepare(
            "SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?"
          )
          .get(itemId) as { q: number }
      ).q
    ).toBe(5);
  });

  it("surfaces the retired-dose refusal with a reason", async () => {
    const admin = createLogin();
    const profile = createProfile(`Retired ${uniqueKey()}`);
    actAs(admin, profile);
    const doseId = seedDose(seedItem(profile.id), 1);
    const date = today(profile.id);

    const { body } = await replay([doseIntent(doseId, profile.id, date)]);
    expect(body.results?.[0].status).toBe("rejected");
    expect(body.results?.[0].reason).toMatch(/no longer on the schedule/i);
    expect(logFor(doseId, date)).toBeUndefined();
  });

  it("resolves an already-confirmed dose as already-done, never a second log", async () => {
    const admin = createLogin();
    const profile = createProfile(`Idempotent ${uniqueKey()}`);
    actAs(admin, profile);
    const itemId = seedItem(profile.id, { quantityOnHand: 9 });
    const doseId = seedDose(itemId);
    const date = today(profile.id);

    const first = doseIntent(doseId, profile.id, date);
    expect((await replay([first])).body.results?.[0].status).toBe("done");
    // The SAME idempotency key (a racing flush / Background Sync) → duplicate.
    expect((await replay([first])).body.results?.[0].status).toBe("duplicate");
    // A DIFFERENT key for the same dose+day (a re-tap queued while still offline) is
    // already-done: settled, not dead-lettered, and not a duplicate log row.
    const { body } = await replay([doseIntent(doseId, profile.id, date)]);
    expect(body.results?.[0].status).toBe("done");
    expect(body.results?.[0].reason).toBeUndefined();

    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM intake_item_logs WHERE dose_id = ? AND date = ?"
          )
          .get(doseId, date) as { n: number }
      ).n
    ).toBe(1);
    expect(
      (
        db
          .prepare(
            "SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?"
          )
          .get(itemId) as { q: number }
      ).q
    ).toBe(8);
  });

  it("refuses to overwrite a deliberate skip, and says why", async () => {
    const admin = createLogin();
    const profile = createProfile(`Skipped ${uniqueKey()}`);
    actAs(admin, profile);
    const itemId = seedItem(profile.id);
    const doseId = seedDose(itemId);
    const date = today(profile.id);
    db.prepare(
      "INSERT INTO intake_item_logs (dose_id, item_id, date, amount, status) VALUES (?,?,?,NULL,'skipped')"
    ).run(doseId, itemId, date);

    const { body } = await replay([doseIntent(doseId, profile.id, date)]);
    expect(body.results?.[0].status).toBe("rejected");
    expect(body.results?.[0].reason).toMatch(/already recorded as skipped/i);
    expect(logFor(doseId, date)?.status).toBe("skipped");
  });

  it("rejects a dose id belonging to ANOTHER profile, writing nothing", async () => {
    const admin = createLogin();
    const mine = createProfile(`Mine ${uniqueKey()}`);
    const theirs = createProfile(`Theirs ${uniqueKey()}`);
    actAs(admin, mine);
    const foreignDose = seedDose(seedItem(theirs.id));
    const date = today(mine.id);

    // Stamped to MY profile, but the dose is someone else's — the core's ownership
    // check (via the dose row's own item) refuses it.
    const { body } = await replay([doseIntent(foreignDose, mine.id, date)]);
    expect(body.results?.[0].status).toBe("rejected");
    expect(logFor(foreignDose, date)).toBeUndefined();
  });

  it("dead-letters an entry that outlived the dose-log window rather than backdating it", async () => {
    const admin = createLogin();
    const profile = createProfile(`Stale ${uniqueKey()}`);
    actAs(admin, profile);
    const doseId = seedDose(seedItem(profile.id));
    const longAgo = shiftDateStr(today(profile.id), -30);

    const { body } = await replay([doseIntent(doseId, profile.id, longAgo)]);
    expect(body.results?.[0].status).toBe("rejected");
    expect(body.results?.[0].reason).toBe(STALE_QUEUED_DOSE_REASON);
    expect(logFor(doseId, longAgo)).toBeUndefined();
  });
});

// ── #1596: the queued workout session rides the SHARED activity core ──────────
//
// Driven end-to-end through the route (cookie-authed, real DB) because the point
// is that the replay is not a private writer: applySetIntent rebuilds the form's
// own submit fields and runs saveActivityCore — the same implementation the live
// auto-save posts to — so a replayed session inherits the identical validation
// (title/date guard, captured-unit conversion, per-set canonicalization) and the
// replayed_keys ledger makes it exactly-once across racing flushes.
describe("offline replay — workout sessions (issue #1596)", () => {
  function setIntent(
    profileId: number,
    title: string,
    date: string,
    extraFields: Record<string, string> = {}
  ): QueuedIntent {
    return {
      key: uniqueKey(),
      flow: "set",
      date,
      capturedAt: `${date}T18:05:00.000Z`,
      payload: {
        fields: {
          type: "strength",
          title,
          date,
          weight_unit: "lb",
          distance_unit: "km",
          components: JSON.stringify([
            {
              name: "Back Squat",
              type: "strength",
              distance: null,
              duration_min: null,
            },
          ]),
          sets: JSON.stringify([
            {
              exercise: "Back Squat",
              weight: 225,
              reps: 5,
              weightRight: null,
              repsRight: null,
              durationSec: null,
              durationSecRight: null,
              equipmentId: null,
            },
            {
              exercise: "Back Squat",
              weight: 225,
              reps: 3,
              weightRight: null,
              repsRight: null,
              durationSec: null,
              durationSecRight: null,
              equipmentId: null,
              warmup: true,
            },
          ]),
          ...extraFields,
        },
      },
      profileId,
      attempts: 0,
    };
  }

  function activityRows(profileId: number, title: string) {
    return db
      .prepare(
        "SELECT id, date, type FROM activities WHERE profile_id = ? AND title = ?"
      )
      .all(profileId, title) as { id: number; date: string; type: string }[];
  }

  it("creates the session + its sets exactly once, converting the CAPTURED unit", async () => {
    const admin = createLogin();
    const profile = createProfile(`SetReplay ${uniqueKey()}`);
    actAs(admin, profile);
    const title = `Offline squats ${uniqueKey()}`;
    const date = today(profile.id);

    const intent = setIntent(profile.id, title, date);
    expect((await replay([intent])).body.results?.[0].status).toBe("done");
    // The SAME idempotency key (racing flush triggers) is a no-op duplicate…
    expect((await replay([intent])).body.results?.[0].status).toBe("duplicate");

    // …so exactly ONE activity row exists, with its two sets in submitted order.
    const rows = activityRows(profile.id, title);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe(date);
    expect(rows[0].type).toBe("strength");
    const sets = db
      .prepare(
        "SELECT set_number, weight_kg, reps, warmup FROM exercise_sets WHERE activity_id = ? ORDER BY set_number"
      )
      .all(rows[0].id) as {
      set_number: number;
      weight_kg: number;
      reps: number;
      warmup: number;
    }[];
    expect(sets.map((s) => s.set_number)).toEqual([1, 2]);
    expect(sets.map((s) => s.reps)).toEqual([5, 3]);
    expect(sets.map((s) => s.warmup)).toEqual([0, 1]);
    // 225 lb converted with the unit CAPTURED in the payload (#630), not a pref.
    expect(sets[0].weight_kg).toBeCloseTo(102.1, 1);
  });

  it("is CREATE-ONLY: a smuggled `id` field cannot retarget an existing row", async () => {
    const admin = createLogin();
    const profile = createProfile(`SetCreateOnly ${uniqueKey()}`);
    actAs(admin, profile);
    const date = today(profile.id);
    const victimTitle = `Victim session ${uniqueKey()}`;
    const victimId = Number(
      db
        .prepare(
          "INSERT INTO activities (date, type, title, profile_id) VALUES (?, 'strength', ?, ?)"
        )
        .run(date, victimTitle, profile.id).lastInsertRowid
    );

    const title = `Smuggler ${uniqueKey()}`;
    const intent = setIntent(profile.id, title, date, { id: String(victimId) });
    expect((await replay([intent])).body.results?.[0].status).toBe("done");

    // The victim row is untouched; the replay inserted a NEW session.
    expect(activityRows(profile.id, victimTitle)).toHaveLength(1);
    expect(activityRows(profile.id, title)).toHaveLength(1);
    expect(activityRows(profile.id, title)[0].id).not.toBe(victimId);
  });

  it("lands on the intent's CAPTURED date, not the fields' (the #28 stamp is authoritative)", async () => {
    const admin = createLogin();
    const profile = createProfile(`SetDate ${uniqueKey()}`);
    actAs(admin, profile);
    const captured = shiftDateStr(today(profile.id), -2);
    const title = `Two days ago ${uniqueKey()}`;
    const intent = setIntent(profile.id, title, captured, {
      date: today(profile.id), // a fields/date mismatch loses to the stamp
    });
    expect((await replay([intent])).body.results?.[0].status).toBe("done");
    expect(activityRows(profile.id, title)[0].date).toBe(captured);
  });

  it("replays as a COMPLETED session — never the live-draft signature the dock resurrects", async () => {
    // The create form defaults start_time to the open moment, and an
    // offline-abandoned session has no end and no duration. Replayed verbatim
    // that is the live-draft signature (started, unended, duration-less):
    // workout presence (#921) would read the row as an ACTIVE workout at
    // reconnect and the app-wide dock + stale-workout nag would haunt every
    // page for up to 90 minutes (observed as cross-spec dock contamination on
    // CI). The replay must stamp the CAPTURE instant — the moment the editor
    // closed — as the end, in the profile's timezone.
    const admin = createLogin();
    const profile = createProfile(`SetCompleted ${uniqueKey()}`);
    actAs(admin, profile);
    // Yesterday, so the intent's capturedAt (`${date}T18:05:00.000Z`) is always
    // in the past — resolveCapturedInstant refuses a future capture instant.
    const date = shiftDateStr(today(profile.id), -1);
    const title = `Abandoned offline ${uniqueKey()}`;
    const intent = setIntent(profile.id, title, date, { start_time: "13:15" });
    // capturedAt is the close moment (setIntent stamps `${date}T18:05:00.000Z`).
    expect((await replay([intent])).body.results?.[0].status).toBe("done");

    const row = db
      .prepare(
        `SELECT start_time, end_time, duration_min FROM activities
          WHERE profile_id = ? AND title = ?`
      )
      .get(profile.id, title) as {
      start_time: string | null;
      end_time: string | null;
      duration_min: number | null;
    };
    expect(row.start_time).toBe("13:15");
    // The end is the capturedAt instant's wall clock in the profile's timezone.
    const expectedEnd = zonedDateParts(
      getTimezone(profile.id),
      new Date(`${date}T18:05:00.000Z`)
    ).hhmm;
    expect(row.end_time).toBe(expectedEnd);
    // The ONE shared answer to "is this row finished?" (#221) — the same
    // predicate the presence matrix and the post-workout dispatch consult.
    expect(isCompletedSessionRow(row)).toBe(true);
  });

  it("leaves a captured end time / duration untouched — the stamp is a fallback, not a rewrite", async () => {
    const admin = createLogin();
    const profile = createProfile(`SetEndKept ${uniqueKey()}`);
    actAs(admin, profile);
    const date = today(profile.id);

    // An explicit end survives verbatim.
    const ended = `Ended offline ${uniqueKey()}`;
    await replay([
      setIntent(profile.id, ended, date, {
        start_time: "13:15",
        end_time: "13:58",
      }),
    ]);
    const endedRow = db
      .prepare(
        "SELECT end_time FROM activities WHERE profile_id = ? AND title = ?"
      )
      .get(profile.id, ended) as { end_time: string | null };
    expect(endedRow.end_time).toBe("13:58");

    // A start-less capture (an untimed retroactive log) is already completed —
    // no end is invented for it.
    const untimed = `Untimed offline ${uniqueKey()}`;
    await replay([setIntent(profile.id, untimed, date)]);
    const untimedRow = db
      .prepare(
        "SELECT start_time, end_time, duration_min FROM activities WHERE profile_id = ? AND title = ?"
      )
      .get(profile.id, untimed) as {
      start_time: string | null;
      end_time: string | null;
      duration_min: number | null;
    };
    expect(untimedRow.start_time).toBeNull();
    expect(untimedRow.end_time).toBeNull();
    expect(isCompletedSessionRow(untimedRow)).toBe(true);
  });

  it("dead-letters an invalid payload with the typed reason — never a silent drop", async () => {
    const admin = createLogin();
    const profile = createProfile(`SetInvalid ${uniqueKey()}`);
    actAs(admin, profile);
    const date = today(profile.id);
    const intent = setIntent(profile.id, "", date); // empty title → invalid
    const { body } = await replay([intent]);
    expect(body.results?.[0].status).toBe("rejected");
    expect(body.results?.[0].reason).toMatch(/couldn't be validated/i);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM activities WHERE profile_id = ?")
          .get(profile.id) as { n: number }
      ).n
    ).toBe(0);
  });
});

// ── #1596: the queued food/protein quick-adds ride the SHARED nutrition cores ──
describe("offline replay — food quick-adds (issue #1596)", () => {
  function servingIntent(
    profileId: number,
    date: string,
    groupKey: string,
    mealSlot: string | null,
    capturedAt: string,
    eatenAt?: string | null
  ): QueuedIntent {
    return {
      key: uniqueKey(),
      flow: "food",
      date,
      capturedAt,
      payload: { entry: "serving", groupKey, mealSlot, grams: null, eatenAt },
      profileId,
      attempts: 0,
    };
  }

  function eventTimes(profileId: number, date: string, group: string) {
    return db
      .prepare(
        `SELECT eaten_at, time_source FROM food_log_events
          WHERE profile_id = ? AND date = ? AND group_key = ? ORDER BY id`
      )
      .all(profileId, date, group) as {
      eaten_at: string | null;
      time_source: string | null;
    }[];
  }

  function proteinIntent(
    profileId: number,
    date: string,
    grams: number
  ): QueuedIntent {
    return {
      key: uniqueKey(),
      flow: "food",
      date,
      capturedAt: `${date}T08:12:00.000Z`,
      payload: { entry: "protein", groupKey: null, mealSlot: null, grams },
      profileId,
      attempts: 0,
    };
  }

  function servingsFor(profileId: number, date: string, group: string): number {
    const row = db
      .prepare(
        "SELECT servings FROM food_log WHERE profile_id = ? AND date = ? AND group_key = ?"
      )
      .get(profileId, date, group) as { servings: number } | undefined;
    return row?.servings ?? 0;
  }

  it("logs one serving exactly once per intent, stamping the CAPTURED tap instant + meal slot", async () => {
    const admin = createLogin();
    const profile = createProfile(`FoodReplay ${uniqueKey()}`);
    actAs(admin, profile);
    const date = shiftDateStr(today(profile.id), -1);
    const capturedAt = `${date}T07:45:00.000Z`;

    const first = servingIntent(
      profile.id,
      date,
      "leafy_greens",
      "Morning",
      capturedAt
    );
    expect((await replay([first])).body.results?.[0].status).toBe("done");
    // Same key (a racing flush) → duplicate; the count must NOT move.
    expect((await replay([first])).body.results?.[0].status).toBe("duplicate");
    expect(servingsFor(profile.id, date, "leafy_greens")).toBe(1);

    // A DIFFERENT key is a second real tap → the day's count increments.
    const second = servingIntent(
      profile.id,
      date,
      "leafy_greens",
      "Morning",
      capturedAt
    );
    expect((await replay([second])).body.results?.[0].status).toBe("done");
    expect(servingsFor(profile.id, date, "leafy_greens")).toBe(2);

    // The ledger events carry the captured tap instant + asserted meal window,
    // so slot frecency ranks the tap where the user actually made it.
    const events = db
      .prepare(
        "SELECT logged_at, meal_slot FROM food_log_events WHERE profile_id = ? AND date = ? AND group_key = 'leafy_greens'"
      )
      .all(profile.id, date) as { logged_at: string; meal_slot: string }[];
    expect(events).toHaveLength(2);
    expect(events[0].logged_at).toBe(capturedAt);
    expect(events[0].meal_slot).toBe("Morning");
  });

  // ── #2053: the eating-time statement threads through REPLAY ──────────────────
  //
  // The chosen instant has to survive the queue, because the whole point of the chips is
  // to say WHEN, and a kitchen-moment tap is exactly the one most likely to be offline.
  // It is validated rather than trusted (judgeEatenAt) for the same reason a queued
  // dose's tap instant is: it came off an untrusted client wall clock.
  it("carries a stated eating instant through replay as time_source='stated'", async () => {
    const admin = createLogin();
    const profile = createProfile(`FoodEaten ${uniqueKey()}`);
    actAs(admin, profile);
    const date = today(profile.id);
    // Local midnight on the intent's own day: always past, always that day.
    // The canonical stored instant (#2205) — the shape food_log_events.eaten_at
    // actually holds, so the round-trip assertion below is an identity and not a
    // comparison between two serializations.
    const eatenAt = utcInstant(
      zonedWallTimeToUtc(getTimezone(profile.id), date, "00:00")!
    );

    const intent = servingIntent(
      profile.id,
      date,
      "leafy_greens",
      "Morning",
      `${date}T09:00:00.000Z`,
      eatenAt
    );
    expect((await replay([intent])).body.results?.[0].status).toBe("done");

    expect(eventTimes(profile.id, date, "leafy_greens")).toEqual([
      { eaten_at: eatenAt, time_source: "stated" },
    ]);
    // #2269: the stated time WON — the captured tab slot travels but is not stored,
    // because the core is the one chokepoint and the replay inherits the same
    // declaration-or-override rule as the web action. The meal derives from the
    // instant, so a later correction moves it instead of fighting a frozen echo.
    const [row] = db
      .prepare(
        `SELECT meal_slot FROM food_log_events
          WHERE profile_id = ? AND date = ? AND group_key = 'leafy_greens'`
      )
      .all(profile.id, date) as { meal_slot: string | null }[];
    expect(row.meal_slot).toBeNull();
  });

  it("an intent with no statement replays with no eating time, as before", async () => {
    const admin = createLogin();
    const profile = createProfile(`FoodNoTime ${uniqueKey()}`);
    actAs(admin, profile);
    const date = today(profile.id);

    const intent = servingIntent(
      profile.id,
      date,
      "leafy_greens",
      "Morning",
      `${date}T09:00:00.000Z`
    );
    expect((await replay([intent])).body.results?.[0].status).toBe("done");

    expect(eventTimes(profile.id, date, "leafy_greens")).toEqual([
      { eaten_at: null, time_source: null },
    ]);
  });

  // #2296 — the owner ruling: KEEP the five-minute tolerance, LOSE the silence. This
  // was the reproduction. A device clock running fast is not a forgery and not a bad
  // tap, and the serving must still land; what could not stand is that the minute
  // vanished with nothing anywhere saying it had. The replay now answers `done` AND a
  // `timeNotice` naming which rule fired, which is what the reconnect toast reads.
  it("an unusable client instant costs the STATEMENT, never the serving — and says so", async () => {
    const admin = createLogin();
    const profile = createProfile(`FoodBadTime ${uniqueKey()}`);
    actAs(admin, profile);
    const date = today(profile.id);
    const tz = getTimezone(profile.id);

    // A phone hours ahead, an instant sitting on the wrong day, and unreadable junk —
    // the three failures the gate exists for, each with its own explanation. All three
    // replay as a logged serving with no eating time, because losing the minute is
    // cosmetic and losing the food log is not.
    const future = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
    const wrongDay = zonedWallTimeToUtc(
      tz,
      shiftDateStr(date, -1),
      "12:00"
    )!.toISOString();
    const cases = [
      { bad: future, reason: "future" },
      { bad: wrongDay, reason: "other-day" },
      { bad: "not-an-instant", reason: "malformed" },
    ] as const;
    for (const { bad, reason } of cases) {
      const res = await replay([
        servingIntent(
          profile.id,
          date,
          "berries",
          "Morning",
          `${date}T09:00:00.000Z`,
          bad
        ),
      ]);
      expect(res.body.results?.[0].status).toBe("done");
      expect(res.body.results?.[0].timeNotice).toBe(reason);
    }
    const times = eventTimes(profile.id, date, "berries");
    expect(times).toHaveLength(3);
    expect(
      times.every((t) => t.eaten_at === null && t.time_source === null)
    ).toBe(true);
    expect(servingsFor(profile.id, date, "berries")).toBe(3);
  });

  // The other half of the ruling, and the one a "just add a toast" fix gets wrong: a
  // replay with NOTHING to report must report nothing. `unstated` is not `refused`.
  it("reports no notice when the statement survived, or when there never was one", async () => {
    const admin = createLogin();
    const profile = createProfile(`FoodQuietTime ${uniqueKey()}`);
    actAs(admin, profile);
    const date = today(profile.id);
    const good = utcInstant(
      zonedWallTimeToUtc(getTimezone(profile.id), date, "00:00")!
    );

    for (const stated of [good, undefined]) {
      const res = await replay([
        servingIntent(
          profile.id,
          date,
          "legumes",
          "Morning",
          `${date}T09:00:00.000Z`,
          stated
        ),
      ]);
      expect(res.body.results?.[0].status).toBe("done");
      expect(res.body.results?.[0].timeNotice).toBeUndefined();
    }
  });

  it("dead-letters an unknown food group with a reason, writing nothing", async () => {
    const admin = createLogin();
    const profile = createProfile(`FoodUnknown ${uniqueKey()}`);
    actAs(admin, profile);
    const date = today(profile.id);
    const { body } = await replay([
      servingIntent(
        profile.id,
        date,
        "unobtainium",
        null,
        `${date}T09:00:00.000Z`
      ),
    ]);
    expect(body.results?.[0].status).toBe("rejected");
    expect(body.results?.[0].reason).toMatch(/no longer available/i);
    expect(servingsFor(profile.id, date, "unobtainium")).toBe(0);
  });

  it("sums protein grams exactly once per intent, and rejects an off-bounds amount", async () => {
    const admin = createLogin();
    const profile = createProfile(`ProteinReplay ${uniqueKey()}`);
    actAs(admin, profile);
    const date = today(profile.id);

    const intent = proteinIntent(profile.id, date, 30);
    expect((await replay([intent])).body.results?.[0].status).toBe("done");
    expect((await replay([intent])).body.results?.[0].status).toBe("duplicate");
    const gramsRow = () =>
      (
        db
          .prepare(
            "SELECT grams FROM protein_log WHERE profile_id = ? AND date = ?"
          )
          .get(profile.id, date) as { grams: number } | undefined
      )?.grams ?? 0;
    expect(gramsRow()).toBe(30);

    // A second real tap sums; an over-cap amount dead-letters with its reason.
    expect(
      (await replay([proteinIntent(profile.id, date, 25)])).body.results?.[0]
        .status
    ).toBe("done");
    expect(gramsRow()).toBe(55);

    const { body } = await replay([proteinIntent(profile.id, date, 5000)]);
    expect(body.results?.[0].status).toBe("rejected");
    expect(body.results?.[0].reason).toMatch(/protein amount/i);
    expect(gramsRow()).toBe(55);
  });
});
