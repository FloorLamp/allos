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

  it("logs each offered group once from a repeated or forged list", async () => {
    const { profile, anchor } = seedUsualMorning("usual-forged");
    const res = await logUsualRoutine(
      fd({
        meal_slot: "Morning",
        // Repeating an offered group must not add a serving; unoffered keys
        // must not expand the bundle.
        groups: "berries,fermented,berries,alcohol,red_meat,not_a_group",
      })
    );

    expect(servings(profile.id).filter((r) => r.date === anchor)).toEqual([
      { date: anchor, group_key: "berries", servings: 1 },
      { date: anchor, group_key: "fermented", servings: 1 },
    ]);
    expect(res.ok && res.groups.map((g) => g.groupKey)).toEqual([
      "berries",
      "fermented",
    ]);
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

// ── THE BUNDLE CARRIES THE BAR'S STATED EATING TIME (#4438, ruled 2026-09-02) ──
//
// #4438 item 2 asked the composed tap to carry the nutrition bar's sticky eating-time
// statement, and the owner ruled that it does — on the WEB. The Telegram composed tap
// still states no hour, because there the button's label ("Your usual Morning") is the
// only thing naming the window; here the bar's own note names the window the statement
// files under, out loud, before the tap.
//
// Asserted at the ACTION tier with the exact FormData `FoodLogBar.logUsual()` builds,
// because the contract spans the whole path: the posted wall time, the gate that judges
// it against the row's day, and the placement every member of the bundle then takes.
// The rows are the evidence — `occurred_at`, `time_source` and `meal_slot` on
// `food_log_events` — never the answer text.
//
// WHAT THIS REPLACES. An earlier reading of the same issue asserted the opposite: that
// the bundle drops the statement, on the reasoning that a stated hour outside the
// labelled window leaves the offer standing and lets a repeat tap write again. That
// consequence is real and is asserted below rather than removed — what changed is that
// the owner ruled it acceptable on a surface that announces it, and unacceptable on one
// that cannot.
describe("the composed bundle and the bar's stated eating time (#4438)", () => {
  const BAR_POST = { meal_slot: "Morning", groups: "berries,fermented" };

  function events(profileId: number, date: string) {
    return db
      .prepare(
        `SELECT group_key, meal_slot, occurred_at, time_source FROM food_log_events
          WHERE profile_id = ? AND date = ? ORDER BY group_key`
      )
      .all(profileId, date) as {
      group_key: string;
      meal_slot: string | null;
      occurred_at: string | null;
      time_source: string | null;
    }[];
  }

  // THE DEFAULT, AND THE HALF #5618 RULING 7 STANDS ON: no statement in force posts no
  // field, and every member of the bundle is written untimed under the declared window.
  it("writes the declared window and no eating instant when the bar states no hour", async () => {
    const { profile, anchor } = seedUsualMorning("usual-untimed");
    expect((await logUsualRoutine(fd(BAR_POST))).ok).toBe(true);
    expect(events(profile.id, anchor)).toEqual([
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
    // The offer reduces and the second tap refuses — the anti-double-log property, on
    // the path every other host of this bundle takes.
    expect(getUsualFoodOffer(profile.id, "Morning", anchor)).toEqual([]);
    expect((await logUsualRoutine(fd(BAR_POST))).ok).toBe(false);
  });

  // THE STATEMENT, ON EVERY MEMBER INCLUDING THE SCOOP. One tap is one act, so a reader
  // must not find half of it timed and half of it filed under a tab — which is what two
  // writers disagreeing about the placement produced before #4729 made it one value.
  it("lands the stated hour on every member of the bundle, scoop included", async () => {
    const { profile, anchor } = seedUsualMorning("usual-stated-hour");
    for (let d = 1; d <= 12; d++)
      db.prepare(
        `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
         VALUES (?, '__protein__', ?, ?)`
      ).run(
        profile.id,
        shiftDateStr(anchor, -d),
        `${shiftDateStr(anchor, -d)}T08:10:00Z`
      );
    const res = await logUsualRoutine(
      fd({ ...BAR_POST, protein_grams: "30", occurred_at: "08:00" })
    );
    expect(res.ok).toBe(true);
    // A STATEMENT STORES THE INSTANT AND NO SLOT (#2269): the meal DERIVES from the hour,
    // so a later correction moves the meal along with the time instead of leaving a
    // frozen tab echo contradicting it.
    const at = `${anchor}T08:00:00Z`;
    expect(events(profile.id, anchor)).toEqual([
      {
        group_key: "__protein__",
        meal_slot: null,
        occurred_at: at,
        time_source: "stated",
      },
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
    // 08:00 derives BACK to Morning, so the window the label promised is still the
    // window the ledger holds: the offer reduces and the tap cannot repeat.
    expect(getUsualFoodOffer(profile.id, "Morning", anchor)).toEqual([]);
    expect((await logUsualRoutine(fd(BAR_POST))).ok).toBe(false);
  });

  // THE RULED TRADEOFF, ASSERTED RATHER THAN HIDDEN. The bar's statement is per-DAY, so
  // setting 19:00 for dinner and then tapping "Your usual Morning" is ordinary use — and
  // the servings then file where the HOUR says, leaving the Morning offer standing. The
  // bar says exactly this before the tap ("recorded as eaten at 19:00 and land in
  // Evening"), which is why the ruling allows it here and forbids it on the Telegram tap,
  // whose label is the only thing naming the window. Do not "fix" this by dropping the
  // statement; that is the answer the ruling of 2026-09-02 replaced.
  it("files an hour outside the labelled window where the hour says, and the offer stays", async () => {
    const { profile, anchor } = seedUsualMorning("usual-cross-window");
    expect(
      (await logUsualRoutine(fd({ ...BAR_POST, occurred_at: "19:00" }))).ok
    ).toBe(true);
    expect(events(profile.id, anchor).map((r) => r.occurred_at)).toEqual([
      `${anchor}T19:00:00Z`,
      `${anchor}T19:00:00Z`,
    ]);
    // The window the ledger now holds is the hour's, not the label's, so the Morning
    // offer is untouched — the visible cost of the statement, named by the surface.
    expect(getUsualFoodOffer(profile.id, "Morning", anchor).sort()).toEqual([
      "berries",
      "fermented",
    ]);
  });

  // VALIDATE, NEVER DROP — and never silently (#2296). The tier's clock sits at 23:50
  // UTC, so 23:59 is past the acceptance skew: the statement is refused, the servings
  // land under the declaration they named, and the answer carries the reason so the bar
  // can say the minute went missing on the same sentence.
  it("keeps the declaration and reports the reason when the stated hour is refused", async () => {
    const { profile, anchor } = seedUsualMorning("usual-refused-hour");
    const res = await logUsualRoutine(
      fd({ ...BAR_POST, occurred_at: "23:59" })
    );
    expect(res).toMatchObject({ ok: true, statedTimeRefused: "future" });
    expect(events(profile.id, anchor)).toEqual([
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
  });
});
