// SERVER-ACTION TIER — the composed morning one-tap (issue #2458).
//
// The composed button is where a stale tap gets EXPENSIVE: five writes instead of one,
// three of them against a supply ledger. So this tier pins the same invariant #2380's
// tier pins, on BOTH axes at once — THE FORM IS AN UPPER BOUND, NEVER AN INSTRUCTION —
// plus the two properties only the composition can have: that a dose refusal does not
// unwind breakfast, and that membership rides declaration + dueness rather than
// obligation (a `may` item is absent because it has no dueness, not because anything
// filtered it out).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { logUsualRoutine } from "@/app/(app)/actions";
import { getUsualRoutineOffer } from "@/lib/queries/usual-routine";
import { createLogin, createProfile, actAs, fd } from "./harness";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { USUAL_BACKFILL_WINDOW_DAYS } from "@/lib/food-regularity";

const revalidate = vi.mocked(revalidatePath);

function servings(profileId: number, date: string) {
  return db
    .prepare(
      `SELECT group_key, servings FROM food_daily_totals
        WHERE profile_id = ? AND date = ? ORDER BY group_key`
    )
    .all(profileId, date) as { group_key: string; servings: number }[];
}

// The dose row's provenance, its supply crossing, and whether its stated administration
// instant CONTRADICTS the day the row is filed under — the pair rule (`judgeStatedAt`):
// an instant outside its own row's day is corruption, and "not stated" is a real answer
// that satisfies it. Asserted as the PROPERTY rather than as a per-writer expected
// value, so neither writer can satisfy it by being enumerated. Every fixture here is
// UTC, so `date()` is the profile-local day.
function doseRow(profileId: number, doseId: number, date: string) {
  return db
    .prepare(
      `SELECT l.logged_via, l.supply_adjusted,
              (l.occurred_at IS NULL OR date(l.occurred_at) = l.date) AS instantOnItsOwnDay
         FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND l.dose_id = ? AND l.date = ?`
    )
    .get(profileId, doseId, date);
}

// The administration instant the row actually carries, as stored. `doseRow` above asks
// the PAIR question (is this instant on its own day?) and a NULL satisfies it, so it
// cannot tell an untimed row from a timed one — which is the whole subject of #5618
// ruling 7 and needs its own reader.
function doseInstant(
  profileId: number,
  doseId: number,
  date: string
): string | null | undefined {
  return (
    db
      .prepare(
        `SELECT l.occurred_at
           FROM intake_item_logs l
           JOIN intake_item_doses d ON d.id = l.dose_id
           JOIN intake_items s ON s.id = d.item_id
          WHERE s.profile_id = ? AND l.dose_id = ? AND l.date = ?`
      )
      .get(profileId, doseId, date) as
      { occurred_at: string | null } | undefined
  )?.occurred_at;
}

// Every serving the day holds, as the two columns a placement reduces to.
function servingPlacements(profileId: number, date: string) {
  return db
    .prepare(
      `SELECT group_key, meal_slot, occurred_at, time_source FROM food_log_events
        WHERE profile_id = ? AND date = ? ORDER BY group_key`
    )
    .all(profileId, date);
}

function itemOf(doseId: number): number {
  return (
    db
      .prepare(`SELECT item_id FROM intake_item_doses WHERE id = ?`)
      .get(doseId) as { item_id: number }
  ).item_id;
}

function doseLogs(profileId: number, date: string) {
  return db
    .prepare(
      `SELECT l.dose_id, l.status FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND l.date = ? ORDER BY l.dose_id`
    )
    .all(profileId, date) as { dose_id: number; status: string }[];
}

// The composed action each dose row records having been written by (#4328). Distinct,
// not listed: the claim is that ONE tap left ONE bundle across its rows.
function doseBundles(profileId: number, date: string): (string | null)[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT l.bundle_id FROM intake_item_logs l
           JOIN intake_item_doses d ON d.id = l.dose_id
           JOIN intake_items s ON s.id = d.item_id
          WHERE s.profile_id = ? AND l.date = ?`
      )
      .all(profileId, date) as { bundle_id: string | null }[]
  ).map((r) => r.bundle_id);
}

function tap(profileId: number, group: string, date: string, hhmmss: string) {
  db.prepare(
    `INSERT INTO food_daily_totals (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
       ON CONFLICT(profile_id, date, group_key)
       DO UPDATE SET servings = servings + 1`
  ).run(profileId, date, group);
  db.prepare(
    `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, group, date, `${date}T${hhmmss}Z`);
}

// One intake item + one dose row, returning the dose id.
function seedItem(
  profileId: number,
  name: string,
  opts: {
    timeOfDay?: string;
    obligation?: string;
    active?: number;
    condition?: string;
  } = {}
): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active, obligation, condition)
         VALUES (?, ?, 'supplement', ?, ?, ?)`
      )
      .run(
        profileId,
        name,
        opts.active ?? 1,
        opts.obligation ?? "should",
        opts.condition ?? "daily"
      ).lastInsertRowid
  );
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 scoop', ?, 'any', 0)`
      )
      .run(itemId, opts.timeOfDay ?? "morning").lastInsertRowid
  );
}

// The #2458 ledger shape in miniature: twelve mornings of fermented + berries, three
// Morning-declared `should` doses, and nothing logged today.
function seedMorning(name: string) {
  const login = createLogin();
  const profile = createProfile(name, login.id);
  actAs(login, profile);
  setTimezone(profile.id, "UTC");
  const anchor = today(profile.id);
  for (let d = 1; d <= 12; d++) {
    const date = shiftDateStr(anchor, -d);
    tap(profile.id, "fermented", date, "08:00:00");
    tap(profile.id, "berries", date, "08:05:00");
  }
  const doses = {
    creatine: seedItem(profile.id, "Creatine", { timeOfDay: "morning" }),
    collagen: seedItem(profile.id, "Collagen", { timeOfDay: "morning" }),
  };
  return { login, profile, anchor, doses };
}

beforeEach(() => revalidate.mockClear());

describe("the offer the action answers", () => {
  it("names both halves, and the dose half rides declaration + dueness", () => {
    const { profile, anchor, doses } = seedMorning("routine-offer");
    // A `may` item declared for the same window is ABSENT — through dueness, which is
    // what #2419 requires; nothing here reads obligation.
    seedItem(profile.id, "Magnesium", {
      timeOfDay: "morning",
      obligation: "may",
    });
    // A bedtime-declared dose is absent for a different reason: it is not this window.
    seedItem(profile.id, "Melatonin", { timeOfDay: "before sleep" });
    // A paused item is absent through `conditionAppliesOn`.
    seedItem(profile.id, "Zinc", { timeOfDay: "morning", active: 0 });

    const offer = getUsualRoutineOffer(profile.id, "Morning", anchor);
    expect(offer?.groups).toEqual(["berries", "fermented"]);
    expect(offer?.doses.map((d) => d.name)).toEqual(["Creatine", "Collagen"]);
    expect(offer?.doses.map((d) => d.doseId)).toEqual([
      doses.creatine,
      doses.collagen,
    ]);

    // Once the food half lands, the offer collapses even with doses still pending.
    tap(profile.id, "fermented", anchor, "08:00:00");
    tap(profile.id, "berries", anchor, "08:01:00");
    expect(getUsualRoutineOffer(profile.id, "Morning", anchor)).toBeNull();
  });
});

describe("logUsualRoutine", () => {
  it("logs the servings and confirms the doses in one tap, then collapses", async () => {
    const { profile, anchor, doses } = seedMorning("routine-happy");
    const form = () =>
      fd({
        meal_slot: "Morning",
        groups: "berries,fermented",
        dose_ids: `${doses.creatine},${doses.collagen}`,
      });
    const res = await logUsualRoutine(form());

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.groups).toEqual([
      { groupKey: "berries", servings: 1, mealServings: 1 },
      { groupKey: "fermented", servings: 1, mealServings: 1 },
    ]);
    expect(res.doses).toEqual([
      { doseId: doses.creatine, name: "Creatine", outcome: "logged" },
      { doseId: doses.collagen, name: "Collagen", outcome: "logged" },
    ]);
    expect(getUsualRoutineOffer(profile.id, "Morning", anchor)).toBeNull();

    // A stale second tap must not duplicate either half of the composed write.
    expect((await logUsualRoutine(form())).ok).toBe(false);
    expect(servings(profile.id, anchor)).toEqual([
      { group_key: "berries", servings: 1 },
      { group_key: "fermented", servings: 1 },
    ]);
    expect(doseLogs(profile.id, anchor)).toEqual([
      { dose_id: doses.creatine, status: "taken" },
      { dose_id: doses.collagen, status: "taken" },
    ]);
    expect(revalidate).toHaveBeenCalledWith("/");
    expect(revalidate).toHaveBeenCalledWith("/medications");
  });

  // #4328 — THE TAP RECORDS ITSELF. The Day ledger used to read a composed write off a
  // shared write minute, which two independent confirms can also produce. This is the
  // write half of the replacement: the rows one tap wrote carry ONE bundle between them,
  // and it is a value, not the absence the individual path leaves.
  it("stamps one bundle across every dose row the tap wrote", async () => {
    const { profile, anchor, doses } = seedMorning("routine-bundle");
    await logUsualRoutine(
      fd({
        meal_slot: "Morning",
        groups: "berries,fermented",
        dose_ids: `${doses.creatine},${doses.collagen}`,
      })
    );
    // Two rows, asserted separately from the bundle: a tap that wrote one row would
    // satisfy "one distinct bundle" without composing anything.
    expect(doseLogs(profile.id, anchor)).toHaveLength(2);
    const bundles = doseBundles(profile.id, anchor);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).not.toBeNull();
  });

  it("writes only the intersection — a forged group, a forged dose id and another profile's dose land nothing", async () => {
    const { profile, anchor, doses } = seedMorning("routine-forged");
    const other = createProfile("routine-forged-other", createLogin().id);
    const foreign = seedItem(other.id, "Someone else's creatine", {
      timeOfDay: "morning",
    });

    const res = await logUsualRoutine(
      fd({
        meal_slot: "Morning",
        // An out-of-window group, a nonsense slug, and the two that stand.
        groups: "red_meat,not_a_group,berries,fermented",
        dose_ids: `999999,${foreign},${doses.creatine}`,
      })
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.groups.map((g) => g.groupKey)).toEqual(["berries", "fermented"]);
    expect(res.doses.map((d) => d.doseId)).toEqual([doses.creatine]);
    expect(servings(profile.id, anchor)).toEqual([
      { group_key: "berries", servings: 1 },
      { group_key: "fermented", servings: 1 },
    ]);
    // The other profile's ledger is untouched, and nothing leaked about its dose.
    expect(doseLogs(other.id, anchor)).toEqual([]);
  });

  it("a dose refusal does NOT unwind breakfast — the food set commits and the answer names the partial", async () => {
    const { profile, anchor, doses } = seedMorning("routine-partial");
    // The collagen is confirmed from another surface between render and tap. It is no
    // longer in the standing bundle, so it drops out of the write entirely — the
    // servings still land and the answer names only what it actually did.
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, date, status, recorded_at, occurred_at)
       VALUES (?, ?, 'taken', ?, ?)`
    ).run(doses.collagen, anchor, `${anchor}T07:00:00Z`, `${anchor}T07:00:00Z`);

    const res = await logUsualRoutine(
      fd({
        meal_slot: "Morning",
        groups: "berries,fermented",
        dose_ids: `${doses.creatine},${doses.collagen}`,
      })
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.groups).toHaveLength(2);
    expect(res.doses.map((d) => d.doseId)).toEqual([doses.creatine]);
    expect(servings(profile.id, anchor)).toEqual([
      { group_key: "berries", servings: 1 },
      { group_key: "fermented", servings: 1 },
    ]);
  });

  it("logs the dose half alone when only the food went stale, rather than refusing the tap", async () => {
    const { profile, anchor, doses } = seedMorning("routine-food-stale");
    tap(profile.id, "fermented", anchor, "08:00:00");
    tap(profile.id, "berries", anchor, "08:01:00");

    const res = await logUsualRoutine(
      fd({
        meal_slot: "Morning",
        groups: "berries,fermented",
        dose_ids: `${doses.creatine},${doses.collagen}`,
      })
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.groups).toEqual([]);
    expect(res.doses).toHaveLength(2);
    // The food half's all-or-nothing semantics are untouched: one serving each, from
    // the two taps above and nothing from this one.
    expect(servings(profile.id, anchor)).toEqual([
      { group_key: "berries", servings: 1 },
      { group_key: "fermented", servings: 1 },
    ]);
  });

  it("refuses read-only access", async () => {
    const { login, profile } = seedMorning("routine-readonly");
    actAs(login, profile, "read");
    await expect(
      logUsualRoutine(fd({ meal_slot: "Morning", groups: "berries,fermented" }))
    ).rejects.toThrow();
  });

  it("refuses an unknown window and an empty submission", async () => {
    seedMorning("routine-shape");
    expect(
      await logUsualRoutine(fd({ meal_slot: "Brunch", groups: "berries" }))
    ).toEqual({ ok: false, error: "Unknown meal window." });
    expect(
      await logUsualRoutine(fd({ meal_slot: "Morning", groups: "" }))
    ).toEqual({ ok: false, error: "Nothing to log." });
  });
});

// ── THE DATED COMPOSED TAP (#4118) ───────────────────────────────────────────
describe("logUsualRoutine on a past day", () => {
  function auditRows(profileId: number) {
    return db
      .prepare(
        `SELECT action, target, detail FROM audit_events
          WHERE active_profile_id = ? AND action LIKE 'usual-routine.%'
          ORDER BY id`
      )
      .all(profileId) as {
      action: string;
      target: string | null;
      detail: string | null;
    }[];
  }

  // The habit with a HOLE at day 2 back, so a real offer stands on that day and the
  // dose half is still inside its own ±2 window.
  function seedWithHole(name: string, hole: number) {
    const login = createLogin();
    const profile = createProfile(name, login.id);
    actAs(login, profile);
    setTimezone(profile.id, "UTC");
    const anchor = today(profile.id);
    for (let d = 1; d <= 13; d++) {
      if (d === hole) continue;
      const date = shiftDateStr(anchor, -d);
      tap(profile.id, "fermented", date, "08:00:00");
      tap(profile.id, "berries", date, "08:05:00");
    }
    const creatine = seedItem(profile.id, "Creatine", {
      timeOfDay: "morning",
    });
    // AGE THE ITEM BEHIND THE LIFETIME BOUND. A freshly inserted row defaults to
    // `created_at = now`, and `pendingDayDoses` is date-resolved on the dose's lifetime
    // (#430/#1442) — so a dose born today is owed on NO past day and every assertion
    // below would have been green about an empty set. This fixture is not about that
    // boundary, so it sits well behind it (the same treatment
    // past-dose-day.actions.test.ts gives its own).
    const born = `${shiftDateStr(anchor, -60)} 09:00:00`;
    db.prepare(
      `UPDATE intake_items SET created_at = ?
        WHERE id = (SELECT item_id FROM intake_item_doses WHERE id = ?)`
    ).run(born, creatine);
    db.prepare(`UPDATE intake_item_doses SET created_at = ? WHERE id = ?`).run(
      born,
      creatine
    );
    return { login, profile, anchor, creatine };
  }

  it("writes BOTH halves onto the target day and audits the backfill", async () => {
    const { profile, anchor, creatine } = seedWithHole("routine-dated", 2);
    const target = shiftDateStr(anchor, -2);
    const res = await logUsualRoutine(
      fd({
        meal_slot: "Morning",
        groups: "berries,fermented",
        dose_ids: String(creatine),
        date: target,
      })
    );

    expect(res.ok).toBe(true);
    expect(servings(profile.id, target)).toEqual([
      { group_key: "berries", servings: 1 },
      { group_key: "fermented", servings: 1 },
    ]);
    expect(doseLogs(profile.id, target)).toEqual([
      { dose_id: creatine, status: "taken" },
    ]);
    // ONE TAP IS ONE TAP THROUGH THE DEEP DOOR TOO (#4328): a day past the ±2 window
    // routes the dose half to `logHistoricalDose`, and which writer the day picks is not
    // a fact about how many taps happened — so the row still records its bundle.
    expect(doseBundles(profile.id, target)[0]).not.toBeNull();
    // Nothing on today, which is what a silent fallback would have produced.
    expect(servings(profile.id, anchor)).toEqual([]);
    expect(doseLogs(profile.id, anchor)).toEqual([]);

    // ONE TAP IS ONE TAP: both ledgers carry the same stamp.
    expect(
      db
        .prepare(
          `SELECT DISTINCT logged_via FROM food_log_events
            WHERE profile_id = ? AND date = ?`
        )
        .all(profile.id, target)
    ).toEqual([{ logged_via: "usual-backfill" }]);
    expect(
      db
        .prepare(
          `SELECT DISTINCT l.logged_via FROM intake_item_logs l
             JOIN intake_item_doses d ON d.id = l.dose_id
             JOIN intake_items s ON s.id = d.item_id
            WHERE s.profile_id = ? AND l.date = ?`
        )
        .all(profile.id, target)
    ).toEqual([{ logged_via: "usual-backfill" }]);

    // AUDITED like `logHistoricalDose`: identifiers and the affected date only.
    expect(auditRows(profile.id)).toEqual([
      {
        action: AUDIT_ACTIONS.usualBackfill,
        target: "Morning",
        detail: target,
      },
    ]);

    // The contemporaneous converse stays unaudited and keeps its posted surface.
    const todayResult = await logUsualRoutine(
      fd({
        meal_slot: "Morning",
        groups: "berries,fermented",
        dose_ids: String(creatine),
        logged_via: "dashboard-widget",
      })
    );
    expect(todayResult.ok).toBe(true);
    expect(auditRows(profile.id)).toEqual([
      {
        action: AUDIT_ACTIONS.usualBackfill,
        target: "Morning",
        detail: target,
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT DISTINCT logged_via FROM food_log_events
            WHERE profile_id = ? AND date = ?`
        )
        .all(profile.id, anchor)
    ).toEqual([{ logged_via: "dashboard-widget" }]);
  });

  // ── THE WHOLE MORNING, THE WHOLE WAY BACK (#4305) ──────────────────────────
  //
  // Every day the FOOD half reaches, both halves reach. Days 1-2 are `markDoseTaken`'s;
  // days 3-6 are `logHistoricalDose`'s. Asserted across the whole span rather than at
  // one point, because the defect this closes lived on exactly one side of an edge that
  // is invisible from either end — and day 6 is the last day in reach, so a regression
  // that narrowed the food half too would red here as well.
  it.each([1, 2, 3, 4, 5, USUAL_BACKFILL_WINDOW_DAYS] as const)(
    "%i days back: one tap lands the servings AND the dose",
    async (back) => {
      const { profile, anchor, creatine } = seedWithHole(
        `routine-span-${back}`,
        back
      );
      const target = shiftDateStr(anchor, -back);
      const res = await logUsualRoutine(
        fd({
          meal_slot: "Morning",
          groups: "berries,fermented",
          dose_ids: String(creatine),
          date: target,
        })
      );
      expect(res.ok).toBe(true);
      expect(servings(profile.id, target)).toEqual([
        { group_key: "berries", servings: 1 },
        { group_key: "fermented", servings: 1 },
      ]);
      expect(doseLogs(profile.id, target)).toEqual([
        { dose_id: creatine, status: "taken" },
      ]);
      expect(res.ok && res.doses.map((d) => d.outcome)).toEqual(["logged"]);
      // WHICHEVER WRITER RAN, THE ROW SAYS THE SAME THINGS: stamped `usual-backfill` so
      // the evidence guard can see it, supply moved, and its stated administration
      // instant does not contradict the day it is filed under.
      expect(doseRow(profile.id, creatine, target)).toEqual({
        logged_via: "usual-backfill",
        supply_adjusted: 1,
        instantOnItsOwnDay: 1,
      });
    }
  );

  it("a dated bundle is audited on every day it reaches", async () => {
    // The audit is the DAY's property, not the writer's: a caller must not be able to
    // pick a day that writes rows and leaves no trail. Day 4 is the one the ±2 window
    // never reached, so this is the case #4305 created.
    const { profile, anchor, creatine } = seedWithHole("routine-audit-4", 4);
    const target = shiftDateStr(anchor, -4);
    await logUsualRoutine(
      fd({
        meal_slot: "Morning",
        groups: "berries,fermented",
        dose_ids: String(creatine),
        date: target,
      })
    );
    expect(auditRows(profile.id)).toEqual([
      {
        action: AUDIT_ACTIONS.usualBackfill,
        target: "Morning",
        detail: target,
      },
    ]);
  });

  it("a medication whose course does not cover the day says so, and writes nothing", async () => {
    // The ONE refusal only the dated writer can produce. `logHistoricalDose` is bounded
    // by the item's recorded courses, and `pendingDayDoses` — which decides what the
    // bundle may name — does not consult them, so a medication stopped four days ago is
    // genuinely offerable and genuinely unwritable on that day. It is reported as
    // `outside-course` rather than folded into `stale-dose`, because "that dose doesn't
    // exist" is a different and false thing to say. The FOOD half still lands: a dose
    // refusal never unwinds breakfast (#2458).
    const { profile, anchor, creatine } = seedWithHole("routine-course", 4);
    const target = shiftDateStr(anchor, -4);
    const stopped = shiftDateStr(anchor, -30);
    db.prepare(`UPDATE intake_items SET kind = 'medication' WHERE id = ?`).run(
      itemOf(creatine)
    );
    db.prepare(
      `INSERT INTO medication_courses (item_id, started_on, stopped_on)
       VALUES (?, ?, ?)`
    ).run(itemOf(creatine), shiftDateStr(anchor, -60), stopped);
    const res = await logUsualRoutine(
      fd({
        meal_slot: "Morning",
        groups: "berries,fermented",
        dose_ids: String(creatine),
        date: target,
      })
    );
    expect(res.ok && res.doses.map((d) => d.outcome)).toEqual([
      "outside-course",
    ]);
    expect(doseLogs(profile.id, target)).toEqual([]);
    expect(servings(profile.id, target)).toEqual([
      { group_key: "berries", servings: 1 },
      { group_key: "fermented", servings: 1 },
    ]);
  });

  it.each([
    ["a day past the food reach", -7],
    ["tomorrow", 1],
  ] as const)(
    "refuses %s, writing neither half anywhere",
    async (why, delta) => {
      const { profile, anchor, creatine } = seedWithHole(
        `routine-out${delta}`,
        99
      );
      const target = shiftDateStr(anchor, delta);
      const before = servings(profile.id, target);
      const res = await logUsualRoutine(
        fd({
          meal_slot: "Morning",
          groups: "berries,fermented",
          dose_ids: String(creatine),
          date: target,
        })
      );
      expect(res, why).toEqual({
        ok: false,
        error: "That day is out of range.",
      });
      // The target day already carries the seeded habit on the past-day case, so the
      // claim is that it is UNCHANGED — asserting "empty" there would be false about a
      // correct tree, and asserting only the target day would miss a fallback landing
      // somewhere else.
      expect(servings(profile.id, target)).toEqual(before);
      expect(servings(profile.id, anchor)).toEqual([]);
      expect(doseLogs(profile.id, target)).toEqual([]);
      expect(doseLogs(profile.id, anchor)).toEqual([]);
      expect(auditRows(profile.id)).toEqual([]);
    }
  );

  // ── A DATED BUNDLE NEVER INVENTS A TIME (#5618 ruling 7) ──────────────────
  //
  // "The chart is the prompt." The record's offers line posts the window the chart is
  // showing on the one `occurred_at` field this action already reads, and the act is
  // written at it — ON EVERY MEMBER, servings and doses alike, because one tap is one
  // act. With no window nothing states a time and nothing invents one.
  //
  // ASSERTED ON BOTH DOSE WRITERS. Day 2 is `markDoseTaken`'s and day 3 is
  // `logHistoricalDose`'s, and which writer a day routes to (#4305) is not a fact about
  // what time the person stated — a ruling satisfied on one side of that edge and not
  // the other is the defect this issue was filed about, one edge over.
  describe("the act's stated time, and the wall clock it replaces", () => {
    const WINDOW = "07:30";

    function tapBundle(
      profile: number,
      target: string,
      dose: number,
      at?: string
    ) {
      return logUsualRoutine(
        fd({
          meal_slot: "Morning",
          groups: "berries,fermented",
          dose_ids: String(dose),
          date: target,
          occurred_at: at,
        })
      );
    }

    it.each([2, 3] as const)(
      "%i days back: the chart's window lands on every member, food and dose",
      async (back) => {
        const { profile, anchor, creatine } = seedWithHole(
          `ruling7-window-${back}`,
          back
        );
        const target = shiftDateStr(anchor, -back);
        const res = await tapBundle(profile.id, target, creatine, WINDOW);
        expect(res.ok).toBe(true);
        expect(res.ok && res.doses.map((d) => d.outcome)).toEqual(["logged"]);

        const at = `${target}T07:30:00Z`;
        // A STATEMENT STORES THE INSTANT AND NO SLOT (#2269) on the food half; the dose
        // half has only the instant to store.
        expect(servingPlacements(profile.id, target)).toEqual([
          {
            group_key: "berries",
            meal_slot: null,
            occurred_at: at,
            time_source: "stated",
          },
          {
            group_key: "fermented",
            meal_slot: null,
            occurred_at: at,
            time_source: "stated",
          },
        ]);
        expect(doseInstant(profile.id, creatine, target)).toBe(at);
      }
    );

    it.each([2, 3] as const)(
      "%i days back: with no window the whole bundle is untimed",
      async (back) => {
        // The dose's own declared time is "morning" — a bucket word, not a clock — so
        // before this ruling day 3 filed THE WALL CLOCK OF THE TAP onto a day three days
        // back, while day 2 was already untimed. One rule now, on both.
        const { profile, anchor, creatine } = seedWithHole(
          `ruling7-untimed-${back}`,
          back
        );
        const target = shiftDateStr(anchor, -back);
        const res = await tapBundle(profile.id, target, creatine);
        expect(res.ok && res.doses.map((d) => d.outcome)).toEqual(["logged"]);
        expect(servingPlacements(profile.id, target)).toEqual([
          {
            group_key: "berries",
            meal_slot: "Morning",
            occurred_at: null,
            time_source: null,
          },
          {
            group_key: "fermented",
            meal_slot: "Morning",
            occurred_at: null,
            time_source: null,
          },
        ]);
        expect(doseInstant(profile.id, creatine, target)).toBeNull();
      }
    );

    // WHAT A BUNDLE'S DOSE MAY DECLARE, and it is narrower than it looks — established
    // here rather than assumed, because the two cases below are vacuous if it is wrong.
    // A dose is in a food window's bundle only while `timeBucket` reads its declared
    // text as that window's WORD, and `parseClockHhmm` only accepts a whole clock. A
    // bare "08:00" therefore buckets to Anytime and is never in any bundle; "8:00 am"
    // carries both — the word the bucket needs and the clock the writer can read — and
    // is the shape the declared-clock branch actually serves.
    const DECLARED = "8:00 am";

    function seedAgedDose(profileId: number, name: string, timeOfDay: string) {
      const born = `${shiftDateStr(today(profileId), -60)} 09:00:00`;
      const dose = seedItem(profileId, name, { timeOfDay });
      db.prepare(
        `UPDATE intake_items SET created_at = ?
          WHERE id = (SELECT item_id FROM intake_item_doses WHERE id = ?)`
      ).run(born, dose);
      db.prepare(
        `UPDATE intake_item_doses SET created_at = ? WHERE id = ?`
      ).run(born, dose);
      return dose;
    }

    it("keeps a dose's OWN declared clock when nobody framed a window", async () => {
      // The converse, and the half the ruling does NOT reverse: the clock on the dose
      // row is a statement somebody made, not one this write invented, so the dated
      // writer still files the row at it. Without this case, deleting the whole hhmm
      // derivation would look like a correct implementation of the ruling.
      const { profile, anchor } = seedWithHole("ruling7-declared", 3);
      const target = shiftDateStr(anchor, -3);
      const dosed = seedAgedDose(profile.id, "Magnesium", DECLARED);

      const res = await tapBundle(profile.id, target, dosed);
      expect(res.ok && res.doses.map((d) => d.outcome)).toEqual(["logged"]);
      expect(doseInstant(profile.id, dosed, target)).toBe(
        `${target}T08:00:00Z`
      );
    });

    it("lets the framed window outrank the dose's own declared clock", async () => {
      // A minute somebody framed on the trace is about THIS act on THIS day; a declared
      // time-of-day is what a dose says in the abstract. The same precedence the kind
      // chips' dose form already takes (#4950: "the window's start beats the
      // vocabulary's default").
      const { profile, anchor } = seedWithHole("ruling7-outranks", 3);
      const target = shiftDateStr(anchor, -3);
      const dosed = seedAgedDose(profile.id, "Magnesium", DECLARED);

      await tapBundle(profile.id, target, dosed, WINDOW);
      expect(doseInstant(profile.id, dosed, target)).toBe(
        `${target}T07:30:00Z`
      );
    });
  });
});
