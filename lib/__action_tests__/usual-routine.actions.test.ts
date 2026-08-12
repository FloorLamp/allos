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

const revalidate = vi.mocked(revalidatePath);

function servings(profileId: number, date: string) {
  return db
    .prepare(
      `SELECT group_key, servings FROM food_log
        WHERE profile_id = ? AND date = ? ORDER BY group_key`
    )
    .all(profileId, date) as { group_key: string; servings: number }[];
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
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
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
  });

  it("is NO CONTROL once the food half is logged, even with the doses still pending", () => {
    const { profile, anchor } = seedMorning("routine-food-gate");
    tap(profile.id, "fermented", anchor, "08:00:00");
    tap(profile.id, "berries", anchor, "08:01:00");
    expect(getUsualRoutineOffer(profile.id, "Morning", anchor)).toBeNull();
  });
});

describe("logUsualRoutine", () => {
  it("logs the servings and confirms the doses in one tap, then collapses", async () => {
    const { profile, anchor, doses } = seedMorning("routine-happy");
    const res = await logUsualRoutine(
      fd({
        meal_slot: "Morning",
        groups: "berries,fermented",
        dose_ids: `${doses.creatine},${doses.collagen}`,
      })
    );

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
    expect(servings(profile.id, anchor)).toEqual([
      { group_key: "berries", servings: 1 },
      { group_key: "fermented", servings: 1 },
    ]);
    expect(doseLogs(profile.id, anchor)).toEqual([
      { dose_id: doses.creatine, status: "taken" },
      { dose_id: doses.collagen, status: "taken" },
    ]);
    expect(getUsualRoutineOffer(profile.id, "Morning", anchor)).toBeNull();
    expect(revalidate).toHaveBeenCalledWith("/");
    expect(revalidate).toHaveBeenCalledWith("/medications");
  });

  it("a STALE second tap refuses — never a second breakfast and never a fourth creatine", async () => {
    const { profile, anchor, doses } = seedMorning("routine-repeat");
    const form = () =>
      fd({
        meal_slot: "Morning",
        groups: "berries,fermented",
        dose_ids: `${doses.creatine},${doses.collagen}`,
      });
    await logUsualRoutine(form());
    const again = await logUsualRoutine(form());

    expect(again.ok).toBe(false);
    expect(servings(profile.id, anchor)).toEqual([
      { group_key: "berries", servings: 1 },
      { group_key: "fermented", servings: 1 },
    ]);
    expect(doseLogs(profile.id, anchor)).toHaveLength(2);
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
      `INSERT INTO intake_item_logs (dose_id, date, status, taken_at, recorded_at)
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
