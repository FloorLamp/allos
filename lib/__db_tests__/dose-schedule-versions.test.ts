// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #1973 — effective-dated dose schedules. The pure tier
// (lib/__tests__/dose-schedule-versions.test.ts) pins the resolver and the two
// non-retroactivity directions over literals. These pin the halves only a real
// database can show:
//
//   1. MIGRATION 151's seed reproduces today's behaviour for an un-edited dose —
//      byte-for-byte the same dueness answers, over the same window, before and after
//      the version rows exist. That is the whole safety argument for shipping it.
//   2. The missed-dose / adherence-pattern builder no longer loses an edited dose's
//      PRE-EDIT window, which is the consumer with real blast radius (the issue names
//      lib/rule-findings.ts, where the window used to be filtered at `updated_at`).
//   3. Bedtime attribution reads the slot in force ON THE NIGHT, which closes the
//      residual #1972 stated and could not fix alone.
//
// Runs via `npm run test:db` (vitest.db.config.ts). The `db` singleton is pointed at a
// throwaway per-file temp DB by lib/__db_tests__/setup.ts.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr, lastNDates } from "@/lib/date";
import { up as migrate151 } from "@/lib/migrations/versions/151-dose-schedule-versions";
import { buildAdherencePatternFindings } from "@/lib/rule-findings";
import {
  weekdayMissSignalKey,
  ADHERENCE_PATTERN_DAYS,
} from "@/lib/adherence-patterns";
import {
  getDoseScheduleVersions,
  getSleepMoodData,
  getSupplementDoses,
  getSupplements,
  invalidateDoseScheduleVersions,
} from "@/lib/queries";
import { upsertMetricSamples } from "@/lib/integrations/normalize";
import { setTimezone } from "@/lib/settings";
import { doseBucketOn, doseDueOn } from "@/lib/supplement-schedule";

// Anchors on the profile's today, which is what most tests here want: they assert a
// SHAPE, so which weekday it happens to be cannot change the answer.
function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  return { profileId, anchor: today(profileId) };
}

// An anchor for a test that COUNTS occurrences of one weekday, guaranteed not to be
// that weekday itself.
//
// `ADHERENCE_PATTERN_DAYS` is 56 = 8x7, so the window holds exactly eight of every
// weekday — but the finding excludes the anchor DAY (today is not over, so it carries
// no missed dose yet). Anchor on a Friday and the Friday count is 7, not 8. A
// hard-coded 8 therefore passes six days a week and fails on the seventh, which is
// worse than failing every day: it reddens whatever happens to be open that morning,
// long after the change that introduced it. This one reddened every open PR on
// 2026-08-07, a Friday.
//
// Stepping back one day is the whole fix — it moves off the counted weekday and keeps
// the window reaching up to the present, which the pattern builder requires: a fixed
// historical anchor yields no findings at all and would assert nothing.
function anchorAvoidingFriday(profileId: number): string {
  const t = today(profileId);
  return isFriday(t) ? shiftDateStr(t, -1) : t;
}

function isFriday(dateISO: string): boolean {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`)).getUTCDay() === 5;
}

interface DoseSpec {
  time_of_day: string;
  weekdays?: string | null;
  start_date?: string | null;
  end_date?: string | null;
}

// Seed one active daily supplement with one dose, inserted RAW — the shape every
// importer, seed and pre-#1973 row has, carrying no schedule history.
function seedItemWithDose(
  profileId: number,
  name: string,
  createdAt: string,
  dose: DoseSpec
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation, created_at)
         VALUES (?, ?, 1, 'supplement', 'daily', 'should', ?)`
      )
      .run(profileId, name, createdAt).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort, created_at,
            weekdays, start_date, end_date)
         VALUES (?, '1 cap', ?, 'any', 0, ?, ?, ?, ?)`
      )
      .run(
        itemId,
        dose.time_of_day,
        createdAt,
        dose.weekdays ?? null,
        dose.start_date ?? null,
        dose.end_date ?? null
      ).lastInsertRowid
  );
  return { itemId, doseId };
}

// The dueness answer for every day of the pattern window — the observable behaviour
// the migration must not change.
function duenessOverWindow(profileId: number, anchor: string): string {
  const items = new Map(getSupplements(profileId).map((s) => [s.id, s]));
  const doses = getSupplementDoses(profileId);
  return lastNDates(anchor, ADHERENCE_PATTERN_DAYS)
    .map((date) =>
      doses
        .map((d) =>
          doseDueOn(items.get(d.item_id)!, d, {
            date,
            isWorkoutDay: false,
            activeSituations: new Set<string>(),
          })
            ? "1"
            : "0"
        )
        .join("")
    )
    .join("");
}

// ---- 1. The migration seed preserves behaviour ------------------------------

describe("migration 151 — seeding an existing dose changes nothing (#1973)", () => {
  it("reproduces the un-edited dose's dueness exactly, before and after seeding", () => {
    const { profileId, anchor } = makeProfile("dose-versions-seed");
    const born = `${shiftDateStr(anchor, -90)} 09:00:00`;
    // Three shapes, so the seed is exercised across the whole versioned vocabulary:
    // a plain daily dose, a weekday-restricted one, and one inside a validity window.
    seedItemWithDose(profileId, "Plain D3", born, { time_of_day: "morning" });
    seedItemWithDose(profileId, "Weekly MTX", born, {
      time_of_day: "evening",
      weekdays: "1",
    });
    seedItemWithDose(profileId, "Tapered Pred", born, {
      time_of_day: "morning",
      start_date: shiftDateStr(anchor, -30),
      end_date: shiftDateStr(anchor, -10),
    });

    // These rows were inserted AFTER boot ran the migration, so they carry no history
    // yet — exactly the state a production database is in the instant before 151 runs.
    expect(
      db
        .prepare("SELECT COUNT(*) AS c FROM intake_dose_schedule_versions")
        .get() as { c: number }
    ).toEqual({ c: 0 });
    const before = duenessOverWindow(profileId, anchor);

    // Replaying the migration is a pure no-op on already-seeded rows and seeds these.
    migrate151(db);

    const versions = db
      .prepare(
        `SELECT v.dose_id, v.effective_from, v.time_of_day, v.weekdays,
                v.start_date, v.end_date, d.created_at AS dose_created,
                d.time_of_day AS row_time, d.weekdays AS row_weekdays,
                d.start_date AS row_start, d.end_date AS row_end
           FROM intake_dose_schedule_versions v
           JOIN intake_item_doses d ON d.id = v.dose_id
          ORDER BY v.dose_id`
      )
      .all() as Record<string, string | null>[];

    // EXACTLY one version per dose, holding the row's current schedule, effective from
    // the dose's own birth.
    expect(versions).toHaveLength(3);
    for (const v of versions) {
      expect(v.effective_from).toBe(v.dose_created!.slice(0, 10));
      expect(v.time_of_day).toBe(v.row_time);
      expect(v.weekdays).toBe(v.row_weekdays);
      expect(v.start_date).toBe(v.row_start);
      expect(v.end_date).toBe(v.row_end);
    }

    // The behavioural claim: every day of the window answers identically. The memo
    // (#2066) is dropped first — the `before` read primed it with the historyless
    // state, and a claim about what the SEEDED rows answer must be measured against
    // the seeded rows rather than against a cache that predates them. Production never
    // hits this: the migration runs at boot, before any read.
    invalidateDoseScheduleVersions(profileId);
    expect(duenessOverWindow(profileId, anchor)).toBe(before);

    // And a replay adds nothing (the NOT EXISTS guard), so the non-version-gated
    // migrate() wrapper can run it twice.
    migrate151(db);
    expect(
      db
        .prepare("SELECT COUNT(*) AS c FROM intake_dose_schedule_versions")
        .get() as { c: number }
    ).toEqual({ c: 3 });
  });
});

// ---- 2. The pattern builder keeps an edited dose's pre-edit window -----------

describe("buildAdherencePatternFindings — an edit no longer voids the past (#1973)", () => {
  it("keeps the pre-edit window of a re-timed dose, and still flags its pattern", () => {
    // This test COUNTS Fridays, so it must not anchor on one — see
    // anchorAvoidingFriday.
    const seed = makeProfile("dose-versions-window");
    const profileId = seed.profileId;
    const anchor = anchorAvoidingFriday(profileId);
    const born = `${shiftDateStr(anchor, -90)} 09:00:00`;
    const reTimedOn = shiftDateStr(anchor, -5);

    // A long-lived dose that MISSES most Fridays, re-timed evening → morning five days
    // ago. Before #1973 the window was filtered at `updated_at`, leaving five days —
    // far below MIN_APPLICABLE_DAYS — so the pattern silently vanished the moment the
    // user touched the schedule.
    const { itemId, doseId } = seedItemWithDose(profileId, "Magnesium", born, {
      time_of_day: "morning",
    });
    db.prepare(`UPDATE intake_item_doses SET updated_at = ? WHERE id = ?`).run(
      `${reTimedOn} 09:00:00`,
      doseId
    );
    const addVersion = db.prepare(
      `INSERT INTO intake_dose_schedule_versions
         (dose_id, effective_from, time_of_day, weekdays, start_date, end_date, created_at)
       VALUES (?,?,?,NULL,NULL,NULL,?)`
    );
    addVersion.run(doseId, born.slice(0, 10), "evening", born);
    addVersion.run(doseId, reTimedOn, "morning", `${reTimedOn} 09:00:00`);

    const logTaken = db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status) VALUES (?, ?, ?, 'taken')`
    );
    for (let i = ADHERENCE_PATTERN_DAYS - 1; i >= 0; i--) {
      const date = shiftDateStr(anchor, -i);
      if (isFriday(date)) continue;
      logTaken.run(doseId, itemId, date);
    }

    const findings = buildAdherencePatternFindings(profileId, anchor);
    const yr = anchor.slice(0, 4);

    // THE PIN: the Friday pattern survives the edit. Its evidence is the pre-edit
    // window — the days the dose sat in its OLD slot — which is precisely what the
    // clamp used to discard.
    expect(findings).toHaveLength(1);
    expect(findings[0].dedupeKey).toBe(weekdayMissSignalKey(doseId, 5, yr));
    // The detail counts the WHOLE window's Fridays (8 in 56 days), not the one or two
    // that fall after the re-time.
    expect(findings[0].detail).toMatch(/8 of the last 8/);

    // …but the "move it earlier in the day" advice is withheld, because the person
    // already moved it inside this window (#430's real harm, without erasing history).
    expect(findings[0].detail).not.toMatch(/moving it earlier/i);
    expect(findings[0].detail).toMatch(/a reminder on those days might help/i);
  });

  it("judges each day by the slot in force then, so a taper's old days stay due", () => {
    const { profileId, anchor } = makeProfile("dose-versions-cadence");
    const born = `${shiftDateStr(anchor, -90)} 09:00:00`;
    const narrowedOn = shiftDateStr(anchor, -7);

    // A daily dose narrowed to Mondays a week ago. Judging the earlier days by TODAY's
    // Mondays-only rule would retroactively forgive every missed weekday — the
    // rewriting direction of the same bug.
    const { itemId, doseId } = seedItemWithDose(profileId, "Warfarin", born, {
      time_of_day: "evening",
      weekdays: "1",
    });
    const addVersion = db.prepare(
      `INSERT INTO intake_dose_schedule_versions
         (dose_id, effective_from, time_of_day, weekdays, start_date, end_date, created_at)
       VALUES (?,?,?,?,NULL,NULL,?)`
    );
    addVersion.run(doseId, born.slice(0, 10), "evening", null, born);
    addVersion.run(
      doseId,
      narrowedOn,
      "evening",
      "1",
      `${narrowedOn} 09:00:00`
    );

    const items = new Map(getSupplements(profileId).map((s) => [s.id, s]));
    const dose = getSupplementDoses(profileId).find((d) => d.id === doseId)!;
    const due = (date: string) =>
      doseDueOn(items.get(itemId)!, dose, {
        date,
        isWorkoutDay: false,
        activeSituations: new Set<string>(),
      });

    // The history is attached by the query layer, not re-fetched per call.
    expect(dose.versions).toHaveLength(2);

    // Before the narrowing, every day was due — including non-Mondays.
    const oldWednesday = lastNDates(shiftDateStr(anchor, -20), 7).find(
      (d) => new Date(Date.parse(`${d}T00:00:00Z`)).getUTCDay() === 3
    )!;
    expect(due(oldWednesday)).toBe(true);

    // After it, only Mondays are.
    const newWednesday = lastNDates(anchor, 7).find(
      (d) => new Date(Date.parse(`${d}T00:00:00Z`)).getUTCDay() === 3
    )!;
    const newMonday = lastNDates(anchor, 7).find(
      (d) => new Date(Date.parse(`${d}T00:00:00Z`)).getUTCDay() === 1
    )!;
    expect(due(newWednesday)).toBe(false);
    expect(due(newMonday)).toBe(true);
  });
});

// ---- 3. Closing the residual #1972 named ------------------------------------

describe("bedtime attribution reads the slot in force that night (#1973/#1972)", () => {
  it("stops a dose re-timed INTO bedtime from claiming an earlier night", () => {
    // #1972 fixed the fact side — a logged night survives a later dose edit — but
    // stated a residual it could not fix alone: with no record of a PAST slot, a dose
    // moved INTO the bedtime slot retroactively claimed every earlier log as a bedtime
    // log. Versions are that record, so both directions now resolve.
    const historyProfileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('RetimedIntoBed')").run()
        .lastInsertRowid
    );
    setTimezone(historyProfileId, "UTC");
    const wakeDay = today(historyProfileId);
    const sleepDate = shiftDateStr(wakeDay, -1);
    upsertMetricSamples(
      historyProfileId,
      [
        {
          metric: "sleep_min",
          date: wakeDay,
          start_time: `${sleepDate}T23:00:00Z`,
          end_time: `${wakeDay}T06:00:00Z`,
          value: 420,
        },
      ],
      "health-connect"
    );

    const createdAt = `${shiftDateStr(sleepDate, -7)} 00:00:00`;
    // Two supplements, both logged taken on the night in question, both sitting in the
    // Before-sleep slot TODAY. The only difference is when each arrived there.
    const settled = seedItemWithDose(
      historyProfileId,
      "Always bedtime",
      createdAt,
      { time_of_day: "Before sleep" }
    );
    const movedIn = seedItemWithDose(
      historyProfileId,
      "Moved into bedtime",
      createdAt,
      { time_of_day: "Before sleep" }
    );

    const addVersion = db.prepare(
      `INSERT INTO intake_dose_schedule_versions
         (dose_id, effective_from, time_of_day, weekdays, start_date, end_date, created_at)
       VALUES (?,?,?,NULL,NULL,NULL,?)`
    );
    addVersion.run(
      settled.doseId,
      createdAt.slice(0, 10),
      "Before sleep",
      createdAt
    );
    // The mover was a MORNING dose on the night being summarized, and only became a
    // bedtime dose today.
    addVersion.run(
      movedIn.doseId,
      createdAt.slice(0, 10),
      "Morning",
      createdAt
    );
    addVersion.run(
      movedIn.doseId,
      wakeDay,
      "Before sleep",
      `${wakeDay} 12:00:00`
    );
    db.prepare(`UPDATE intake_item_doses SET updated_at = ? WHERE id = ?`).run(
      `${wakeDay} 12:00:00`,
      movedIn.doseId
    );

    const insertLog = db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
       VALUES (?, ?, ?, 'taken')`
    );
    insertLog.run(settled.doseId, settled.itemId, sleepDate);
    insertLog.run(movedIn.doseId, movedIn.itemId, sleepDate);

    // Only the dose that actually WAS a bedtime dose that night is counted. Without
    // versions both would be, because today's row says "Before sleep" for each.
    expect(
      getSleepMoodData(historyProfileId, 7).history.find(
        (row) => row.date === wakeDay
      )?.bedtimeSupplements
    ).toMatchObject({ due: 1, taken: 1, state: "taken" });
  });
});

// ---- 4. The history read is memoized, and answers identically (#2066) -------
//
// `withScheduleVersions` runs on EVERY current-schedule read, and both the hourly tick
// and a single page render fan `getSupplementDoses` out across several consumers — each
// of which was re-joining the same profile's whole history. The memo collapses that to
// one join per profile per request/tick. Its correctness argument has exactly two
// halves, and both are pinned here: the answers never change, and a write is never read
// back stale.

describe("#2066 — memoizing the history join changes no answer", () => {
  it("attaches the same history on every read, and re-joins after an invalidation", () => {
    const { profileId, anchor } = makeProfile("dose-versions-memo");
    const born = `${shiftDateStr(anchor, -60)} 09:00:00`;
    const movedOn = shiftDateStr(anchor, -10);
    const { doseId } = seedItemWithDose(profileId, "Memo Melatonin", born, {
      time_of_day: "morning",
    });
    const addVersion = db.prepare(
      `INSERT INTO intake_dose_schedule_versions
         (dose_id, effective_from, time_of_day, weekdays, start_date, end_date, created_at)
       VALUES (?,?,?,NULL,NULL,NULL,?)`
    );
    addVersion.run(doseId, born.slice(0, 10), "morning", born);
    addVersion.run(doseId, movedOn, "evening", `${movedOn} 09:00:00`);

    const readBucket = (date: string) =>
      doseBucketOn(
        getSupplementDoses(profileId).find((d) => d.id === doseId)!,
        date
      );
    const before = shiftDateStr(movedOn, -1);
    // The uncached reader is the reference answer; the memoized attach must agree with
    // it on the FIRST read (the miss) and on every read after (the hits).
    expect(getDoseScheduleVersions(profileId).get(doseId)).toHaveLength(2);
    expect(readBucket(before)).toBe("Morning");
    expect(readBucket(before)).toBe("Morning");
    expect(readBucket(anchor)).toBe("Evening");

    // A version written behind the memo's back — the shape a restore or another process
    // produces. Inside the TTL the reader is entitled to its cached answer …
    addVersion.run(doseId, anchor, "midday", `${anchor} 09:00:00`);
    expect(readBucket(anchor)).toBe("Evening");
    // … and the invalidation the write paths call is what makes it current again.
    invalidateDoseScheduleVersions(profileId);
    expect(readBucket(anchor)).toBe("Midday");
    // The earlier days are untouched by any of it: a memo is not allowed to be a second
    // opinion about history.
    expect(readBucket(before)).toBe("Morning");
  });

  it("keeps each profile's history to itself", () => {
    const mine = makeProfile("dose-versions-memo-mine");
    const theirs = makeProfile("dose-versions-memo-theirs");
    const born = `${shiftDateStr(mine.anchor, -60)} 09:00:00`;
    const movedOn = shiftDateStr(mine.anchor, -10);
    const a = seedItemWithDose(mine.profileId, "Mine", born, {
      time_of_day: "morning",
    });
    const b = seedItemWithDose(theirs.profileId, "Theirs", born, {
      time_of_day: "morning",
    });
    db.prepare(
      `INSERT INTO intake_dose_schedule_versions
         (dose_id, effective_from, time_of_day, weekdays, start_date, end_date, created_at)
       VALUES (?,?,'evening',NULL,NULL,NULL,?)`
    ).run(a.doseId, movedOn, `${movedOn} 09:00:00`);

    // Reading mine first primes the memo; the other profile must not be answered from
    // it — keyed per profile, and the join it runs is still scoped through the parent.
    expect(
      getSupplementDoses(mine.profileId).find((d) => d.id === a.doseId)!
        .versions
    ).toHaveLength(1);
    const other = getSupplementDoses(theirs.profileId).find(
      (d) => d.id === b.doseId
    )!;
    expect(other.versions).toBeUndefined();
    expect(doseBucketOn(other, mine.anchor)).toBe("Morning");
  });
});
