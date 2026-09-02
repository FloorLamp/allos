// SERVER-ACTION TIER — the "log my usual <window>" offer (issue #2380).
//
// The invariant this tier exists to pin is the one that keeps a regularity-derived
// shortcut honest: THE FORM IS AN UPPER BOUND, NEVER AN INSTRUCTION. The action
// validates shape; the auth-blind core re-derives the offer from fresh server state and
// writes only the intersection, so a forged, replayed or merely stale submission can
// never write outside the offer that currently stands — and never on a day the user is
// not living. Also proves the read-access refusal and the authoritative counts the bar
// adopts.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { logUsualRoutine } from "@/app/(app)/actions";
import { getUsualFoodOffer } from "@/lib/queries";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

function servings(profileId: number) {
  return db
    .prepare(
      `SELECT date, group_key, servings FROM food_daily_totals
        WHERE profile_id = ? ORDER BY date, group_key`
    )
    .all(profileId) as { date: string; group_key: string; servings: number }[];
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

// A profile whose last twelve mornings each hold fermented + berries, and nothing
// logged today — the #2380 ledger shape, in miniature.
function seedUsualMorning(name: string) {
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
  return { login, profile, anchor };
}

beforeEach(() => {
  revalidate.mockClear();
});

describe("logUsualRoutine, food half", () => {
  it("logs one serving of each offered group into the window, on today", async () => {
    const { profile, anchor } = seedUsualMorning("usual-happy");
    const res = await logUsualRoutine(
      fd({ meal_slot: "Morning", groups: "berries,fermented" })
    );

    expect(res).toMatchObject({
      ok: true,
      window: "Morning",
      groups: [
        { groupKey: "berries", servings: 1, mealServings: 1 },
        { groupKey: "fermented", servings: 1, mealServings: 1 },
      ],
      doses: [],
    });
    expect(servings(profile.id).filter((r) => r.date === anchor)).toEqual([
      { date: anchor, group_key: "berries", servings: 1 },
      { date: anchor, group_key: "fermented", servings: 1 },
    ]);
    // The window is a DECLARATION, and no eating time is invented (#2269).
    const written = db
      .prepare(
        `SELECT meal_slot, occurred_at FROM food_log_events
          WHERE profile_id = ? AND date = ?`
      )
      .all(profile.id, anchor) as {
      meal_slot: string | null;
      occurred_at: string | null;
    }[];
    expect(written).toHaveLength(2);
    expect(written.every((r) => r.meal_slot === "Morning")).toBe(true);
    expect(written.every((r) => r.occurred_at === null)).toBe(true);
    expect(revalidate).toHaveBeenCalledWith("/nutrition");
  });

  it("refuses a second tap rather than logging a second breakfast", async () => {
    const { profile, anchor } = seedUsualMorning("usual-repeat");
    await logUsualRoutine(
      fd({ meal_slot: "Morning", groups: "berries,fermented" })
    );
    const again = await logUsualRoutine(
      fd({ meal_slot: "Morning", groups: "berries,fermented" })
    );

    expect(again.ok).toBe(false);
    // Still one serving each — the offer is gone, so there is nothing to re-log.
    expect(servings(profile.id).filter((r) => r.date === anchor)).toEqual([
      { date: anchor, group_key: "berries", servings: 1 },
      { date: anchor, group_key: "fermented", servings: 1 },
    ]);
    expect(getUsualFoodOffer(profile.id, "Morning", anchor)).toEqual([]);
  });

  it("writes only the intersection with the standing offer — a forged list lands nothing extra", async () => {
    const { profile, anchor } = seedUsualMorning("usual-forged");
    const res = await logUsualRoutine(
      fd({
        meal_slot: "Morning",
        // Two groups that ARE offered, plus three that are not — a habitual group of
        // another window, a group with no history at all, and a nonsense slug.
        groups: "berries,fermented,alcohol,red_meat,not_a_group",
      })
    );

    expect(res.ok && res.groups.map((g) => g.groupKey)).toEqual([
      "berries",
      "fermented",
    ]);
    expect(
      servings(profile.id)
        .filter((r) => r.date === anchor)
        .map((r) => r.group_key)
    ).toEqual(["berries", "fermented"]);
  });

  it("refuses when nothing in the submitted list is still offered", async () => {
    const { profile, anchor } = seedUsualMorning("usual-stale");
    const res = await logUsualRoutine(
      fd({ meal_slot: "Morning", groups: "red_meat,alcohol" })
    );
    expect(res.ok).toBe(false);
    expect(servings(profile.id).filter((r) => r.date === anchor)).toEqual([]);
  });

  it("refuses a window with no habit", async () => {
    const { profile, anchor } = seedUsualMorning("usual-cold-window");
    const res = await logUsualRoutine(
      fd({ meal_slot: "Evening", groups: "berries,fermented" })
    );
    expect(res.ok).toBe(false);
    expect(servings(profile.id).filter((r) => r.date === anchor)).toEqual([]);
  });

  it("rejects a bad window and an empty group list without touching the ledger", async () => {
    const { profile, anchor } = seedUsualMorning("usual-shape");
    expect(
      (await logUsualRoutine(fd({ meal_slot: "Brunch", groups: "berries" }))).ok
    ).toBe(false);
    expect(
      (await logUsualRoutine(fd({ meal_slot: "Morning", groups: "  " }))).ok
    ).toBe(false);
    expect(servings(profile.id).filter((r) => r.date === anchor)).toEqual([]);
  });

  it("refuses a read-only grant", async () => {
    const { login, profile, anchor } = seedUsualMorning("usual-readonly");
    actAs(login, profile, "read");
    await expect(
      logUsualRoutine(fd({ meal_slot: "Morning", groups: "berries,fermented" }))
    ).rejects.toThrow();
    expect(servings(profile.id).filter((r) => r.date === anchor)).toEqual([]);
  });

  it("writes only to the acting profile", async () => {
    const { profile } = seedUsualMorning("usual-scope-a");
    const otherLogin = createLogin();
    const other = createProfile("usual-scope-b", otherLogin.id);
    await logUsualRoutine(
      fd({ meal_slot: "Morning", groups: "berries,fermented" })
    );
    expect(servings(other.id)).toEqual([]);
    expect(servings(profile.id).length).toBeGreaterThan(0);
  });
});

// ── THE DATED USUAL WRITE (#4118) ────────────────────────────────────────────
//
// The header above claims the action can "never [write] on a day the user is not
// living", which used to be true because no date crossed the wire at all. It is still
// true, and now for a stated reason instead of by omission: the day is posted, the CORE
// bounds it, and a day outside that bound is a REFUSAL rather than a silent fallback to
// today. That distinction is the whole test — a parse that quietly substituted today
// would look identical from the caller and would write a breakfast onto the wrong day.
describe("logUsualRoutine on a past day, food half", () => {
  function eventsOn(profileId: number, date: string) {
    return db
      .prepare(
        `SELECT group_key, meal_slot, occurred_at, logged_via FROM food_log_events
          WHERE profile_id = ? AND date = ? ORDER BY group_key`
      )
      .all(profileId, date) as {
      group_key: string;
      meal_slot: string | null;
      occurred_at: string | null;
      logged_via: string | null;
    }[];
  }

  it("writes the bundle onto the posted day, stamped so the measure cannot read it back", async () => {
    // The seeded habit occupies days 1-12 back, so day 13 is the empty day this is
    // about — and it is OUT of reach. Day 6 is in reach but occupied, so this profile
    // gets its hole at day 6 instead.
    const login = createLogin();
    const profile = createProfile("usual-dated", login.id);
    actAs(login, profile);
    setTimezone(profile.id, "UTC");
    const anchor = today(profile.id);
    for (let d = 1; d <= 13; d++) {
      if (d === 6) continue;
      const date = shiftDateStr(anchor, -d);
      tap(profile.id, "fermented", date, "08:00:00");
      tap(profile.id, "berries", date, "08:05:00");
    }
    const target = shiftDateStr(anchor, -6);

    const res = await logUsualRoutine(
      fd({ meal_slot: "Morning", groups: "berries,fermented", date: target })
    );
    expect(res.ok).toBe(true);

    // On the TARGET day, not today.
    expect(
      servings(profile.id)
        .filter((r) => r.date === target)
        .map((r) => r.group_key)
    ).toEqual(["berries", "fermented"]);
    expect(servings(profile.id).filter((r) => r.date === anchor)).toEqual([]);
    // Declared window, no invented eating time, and the backfill stamp.
    expect(eventsOn(profile.id, target)).toEqual([
      {
        group_key: "berries",
        meal_slot: "Morning",
        occurred_at: null,
        logged_via: "usual-backfill",
      },
      {
        group_key: "fermented",
        meal_slot: "Morning",
        occurred_at: null,
        logged_via: "usual-backfill",
      },
    ]);
  });

  it("stamps TODAY's tap with its own surface, not the backfill value", async () => {
    // The converse, and the reason it is here: a stamp applied to every usual write
    // would pass the assertion above and would silently delete the contemporaneous tap
    // from the evidence that makes the offer exist at all.
    const { profile, anchor } = seedUsualMorning("usual-dated-today");
    await logUsualRoutine(
      fd({
        meal_slot: "Morning",
        groups: "berries,fermented",
        date: anchor,
        logged_via: "dashboard-widget",
      })
    );
    expect(eventsOn(profile.id, anchor).map((r) => r.logged_via)).toEqual([
      "dashboard-widget",
      "dashboard-widget",
    ]);
  });

  it.each([
    ["a day past the reach", -7],
    ["a fortnight back", -14],
    ["tomorrow", 1],
    ["next year", 365],
  ] as const)("refuses %s and writes nothing at all", async (why, delta) => {
    const { profile, anchor } = seedUsualMorning(`usual-out-of-reach${delta}`);
    const target = shiftDateStr(anchor, delta);
    // The WHOLE ledger before and after, not just the target day: `seedUsualMorning`
    // already occupies the past week, so "nothing on that day" would be a false claim
    // there, and a bounded assertion would miss a fallback landing anywhere else.
    const before = servings(profile.id);
    const res = await logUsualRoutine(
      fd({ meal_slot: "Morning", groups: "berries,fermented", date: target })
    );
    expect(res.ok, why).toBe(false);
    expect(servings(profile.id)).toEqual(before);
    // Named separately because it is the failure a silent fallback to today produces,
    // and it is the one a reader will want to see asserted.
    expect(servings(profile.id).filter((r) => r.date === anchor)).toEqual([]);
  });

  it("a malformed date is TODAY, because it is an absent field and not a claim", async () => {
    // The parse's own rule, stated because it differs from the refusals above: a field
    // that is not a date at all was never a request for a day, so the action defaults —
    // exactly as `logFoodServing`'s and `addProteinGrams`' parses already do. A
    // WELL-FORMED day out of reach is a claim, and that is what gets refused.
    const { profile, anchor } = seedUsualMorning("usual-garbage-date");
    const res = await logUsualRoutine(
      fd({ meal_slot: "Morning", groups: "berries,fermented", date: "soon" })
    );
    expect(res.ok).toBe(true);
    expect(
      servings(profile.id)
        .filter((r) => r.date === anchor)
        .map((r) => r.group_key)
    ).toEqual(["berries", "fermented"]);
  });
});

// ── THE BUNDLE STATES NO HOUR, AND THAT IS WHAT KEEPS IT FROM DOUBLE-LOGGING ──
//
// #4438 item 2 asked the composed tap to carry the nutrition bar's sticky eating-time
// statement. It cannot, and the reason is a category error rather than a plumbing gap: a
// stated eating time is a statement about A SERVING, and a bundle is labelled by A
// WINDOW. Handing one to the other breaks the core's own headline contract.
//
// The mechanism, which is why this is asserted at the ACTION tier with the exact
// FormData `FoodLogBar.logUsual()` builds rather than at the core: the bar's statement is
// per-DAY, not per-slot — its own note says "a serving stating 19:00 from the Morning tab
// lands in Evening" — so setting 19:00 for dinner and then tapping "Your usual Morning"
// is ordinary use. With the time threaded, `logFoodServingCore` drops the declared window
// (a stated time wins, #2269) and the servings derive to Evening, while the offer is
// re-derived for MORNING and still stands. Every repeat tap then writes again, answering
// `ok: true` each time.
//
// Both directions are asserted because only the pair is the contract: the write lands
// (this is not "the bundle refuses everything"), and the SECOND one does not.
describe("the composed bundle and the bar's day-wide stated time (#4438)", () => {
  const BAR_POST = {
    meal_slot: "Morning",
    groups: "berries,fermented",
    // What the sticky WhenControl carries when the person set a dinner time earlier in
    // the day and never cleared it. The bar posts this on the SAME day, per day.
    occurred_at: "19:00",
  };

  it("reduces after one tap, and refuses the second", async () => {
    const { profile, anchor } = seedUsualMorning("usual-stated-time");
    const first = await logUsualRoutine(fd(BAR_POST));
    expect(first.ok).toBe(true);

    // THE OFFER IS GONE. This is the assertion the defect fails: the servings must land
    // where the bundle promised them, or the Morning offer never shrinks.
    expect(getUsualFoodOffer(profile.id, "Morning", anchor)).toEqual([]);

    const second = await logUsualRoutine(fd(BAR_POST));
    expect(second.ok).toBe(false);
    // One serving each, not two — the ledger is the evidence, not the answer.
    expect(servings(profile.id).filter((r) => r.date === anchor)).toEqual([
      { date: anchor, group_key: "berries", servings: 1 },
      { date: anchor, group_key: "fermented", servings: 1 },
    ]);
  });

  it("files the whole bundle under the window it named, in one meal section", async () => {
    const { profile, anchor } = seedUsualMorning("usual-stated-time-window");
    // The scoop is habitual here too, so the bundle carries a protein member and the
    // two writers are both exercised by one tap (#4379).
    for (let d = 1; d <= 12; d++)
      db.prepare(
        `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
         VALUES (?, '__protein__', ?, ?)`
      ).run(
        profile.id,
        shiftDateStr(anchor, -d),
        `${shiftDateStr(anchor, -d)}T08:10:00Z`
      );
    await logUsualRoutine(fd({ ...BAR_POST, protein_grams: "30" }));
    // ONE EVENT, ONE SECTION. The food half and the protein member are the same tap, so
    // a reader must not find half of it under Morning and half under Evening — which is
    // what two writers disagreeing about whether a stated time drops a declared window
    // produces (`logFoodServingCore` drops it; `addProteinGramsCore` keeps it).
    const rows = db
      .prepare(
        `SELECT group_key, meal_slot, occurred_at FROM food_log_events
          WHERE profile_id = ? AND date = ? ORDER BY group_key`
      )
      .all(profile.id, anchor) as {
      group_key: string;
      meal_slot: string | null;
      occurred_at: string | null;
    }[];
    expect(rows.map((r) => r.group_key)).toEqual([
      "__protein__",
      "berries",
      "fermented",
    ]);
    expect(rows.every((r) => r.meal_slot === "Morning")).toBe(true);
    // And no eating instant is invented for a bundle that states none.
    expect(rows.every((r) => r.occurred_at === null)).toBe(true);
  });
});
