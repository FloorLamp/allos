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
      { action: AUDIT_ACTIONS.usualBackfill, target: "Morning", detail: target },
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
});
