// SERVER-ACTION TIER (#998, #1078, #1085) — the substance-use write paths. The
// instrument action derives the in-app totals from the per-item answers (server is
// the source of truth — AUDIT-C's 0..4 options and, since #1085, DAST-10's 0/1
// yes/no options incl. the flipped reverse-scored item), refuses in-app
// administration of the total-only AUDIT (its item text is deliberately not
// shipped), validates the outside-total bounds, and gates on requireWriteAccess.
// The unit log dispatches per substance (#1078): alcohol through the shared
// food-log core into the `alcohol` group, nicotine/cannabis through the
// substance_log core; the target actions upsert/clear the substance
// frequency_targets row (cap semantics, one row per substance).

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import {
  recordSubstanceInstrumentAction,
  logSubstanceUnitAction,
  undoSubstanceUnitAction,
  setSubstanceTargetAction,
  clearSubstanceTargetAction,
  addSubstanceDailyTotalAction,
  updateSubstanceDailyTotalAction,
  deleteSubstanceDailyTotalAction,
} from "@/app/(app)/medical/substance-use/actions";
import { undoDelete } from "@/app/(app)/undo-actions";
import { actAs, createLogin, createProfile, fd } from "./harness";
import { setProfileSetting } from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";
import {
  getAllSubstanceDailyTotals,
  getSubstanceDailyTotals,
  getSubstanceWeekState,
} from "@/lib/queries";

function scoreRow(profileId: number, canon: string) {
  return db
    .prepare(
      `SELECT value_num FROM medical_records
       WHERE profile_id = ? AND canonical_name = ? ORDER BY id DESC LIMIT 1`
    )
    .get(profileId, canon) as { value_num: number } | undefined;
}

function targetRow(profileId: number) {
  return db
    .prepare(
      `SELECT per_week FROM frequency_targets
       WHERE profile_id = ? AND scope_kind = 'substance' AND scope_value = 'alcohol'`
    )
    .get(profileId) as { per_week: number } | undefined;
}

describe("recordSubstanceInstrumentAction", () => {
  it("administers an AUDIT-C in-app: total derived from the 0..4 answers, answers stored", async () => {
    const login = createLogin();
    const profile = createProfile("su-admin", login.id);
    actAs(login, profile);

    const r = await recordSubstanceInstrumentAction(
      fd({
        instrument: "AUDIT-C",
        mode: "administer",
        date: "2026-07-01",
        answers: JSON.stringify([2, 1, 4]), // sum = 7 → increasing risk
      })
    );
    expect(r.ok).toBe(true);
    expect(scoreRow(profile.id, "AUDIT-C")?.value_num).toBe(7);
    const respCount = db
      .prepare(
        "SELECT COUNT(*) AS n FROM instrument_responses WHERE profile_id = ?"
      )
      .get(profile.id) as { n: number };
    expect(respCount.n).toBe(3);
  });

  it("rejects an answer outside the item's own option set", async () => {
    const login = createLogin();
    const profile = createProfile("su-badanswer", login.id);
    actAs(login, profile);
    const r = await recordSubstanceInstrumentAction(
      fd({
        instrument: "AUDIT-C",
        mode: "administer",
        date: "2026-07-01",
        answers: JSON.stringify([2, 1, 5]), // 5 is not an AUDIT-C option
      })
    );
    expect(r.ok).toBe(false);
  });

  it("administers a DAST-10 in-app (#1085): total derived server-side from the 10 yes/no answers", async () => {
    const login = createLogin();
    const profile = createProfile("su-dast-admin", login.id);
    actAs(login, profile);

    // Items 1–2 "Yes" (1 each), item 3 "No" (the reverse-scored item — its "No"
    // option VALUE is 1), the rest "No"/lowest (0) → total 3, Moderate band.
    const r = await recordSubstanceInstrumentAction(
      fd({
        instrument: "DAST-10",
        mode: "administer",
        date: "2026-07-01",
        answers: JSON.stringify([1, 1, 1, 0, 0, 0, 0, 0, 0, 0]),
      })
    );
    expect(r.ok).toBe(true);
    expect(scoreRow(profile.id, "DAST-10")?.value_num).toBe(3);
    const respCount = db
      .prepare(
        "SELECT COUNT(*) AS n FROM instrument_responses WHERE profile_id = ?"
      )
      .get(profile.id) as { n: number };
    expect(respCount.n).toBe(10);
  });

  it("rejects a wrong-length or out-of-option DAST-10 answer set", async () => {
    const login = createLogin();
    const profile = createProfile("su-dast-bad", login.id);
    actAs(login, profile);
    for (const answers of [
      [1, 1, 1], // wrong length
      [1, 1, 1, 0, 0, 0, 0, 0, 0, 2], // 2 is not a 0/1 yes-no option value
    ]) {
      const r = await recordSubstanceInstrumentAction(
        fd({
          instrument: "DAST-10",
          mode: "administer",
          date: "2026-07-01",
          answers: JSON.stringify(answers),
        })
      );
      expect(r.ok, JSON.stringify(answers)).toBe(false);
    }
  });

  it("refuses in-app administration of the total-only AUDIT (no baked item text)", async () => {
    const login = createLogin();
    const profile = createProfile("su-totalonly", login.id);
    actAs(login, profile);
    const r = await recordSubstanceInstrumentAction(
      fd({
        instrument: "AUDIT",
        mode: "administer",
        date: "2026-07-01",
        answers: JSON.stringify([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
      })
    );
    expect(r.ok).toBe(false);
  });

  it("still accepts an outside DAST-10 total (#1085 keeps the #998 total path working)", async () => {
    const login = createLogin();
    const profile = createProfile("su-dast-outside", login.id);
    actAs(login, profile);
    const r = await recordSubstanceInstrumentAction(
      fd({
        instrument: "DAST-10",
        mode: "outside",
        date: "2026-07-01",
        total: "4",
      })
    );
    expect(r.ok).toBe(true);
    // Same canonical_name series as an in-app administration — one identity.
    expect(scoreRow(profile.id, "DAST-10")?.value_num).toBe(4);
  });

  it("accepts an outside AUDIT total and bounds it to 0..40", async () => {
    const login = createLogin();
    const profile = createProfile("su-outside", login.id);
    actAs(login, profile);
    const ok = await recordSubstanceInstrumentAction(
      fd({
        instrument: "AUDIT",
        mode: "outside",
        date: "2026-07-01",
        total: "18",
      })
    );
    expect(ok.ok).toBe(true);
    expect(scoreRow(profile.id, "AUDIT")?.value_num).toBe(18);

    const oob = await recordSubstanceInstrumentAction(
      fd({
        instrument: "AUDIT",
        mode: "outside",
        date: "2026-07-01",
        total: "41",
      })
    );
    expect(oob.ok).toBe(false);
  });

  it("rejects an unknown instrument (incl. a mental-health key on this action)", async () => {
    const login = createLogin();
    const profile = createProfile("su-bad", login.id);
    actAs(login, profile);
    for (const instrument of ["BOGUS", "PHQ-9"]) {
      const r = await recordSubstanceInstrumentAction(
        fd({ instrument, mode: "outside", date: "2026-07-01", total: "1" })
      );
      expect(r.ok).toBe(false);
    }
  });
});

describe("logSubstanceUnitAction / undoSubstanceUnitAction — per-substance ledger dispatch", () => {
  it("alcohol logs into the food_log group and reports the weekly count; undo reverses", async () => {
    const login = createLogin();
    const profile = createProfile("su-drink", login.id);
    actAs(login, profile);

    const one = await logSubstanceUnitAction(fd({ substance: "alcohol" }));
    expect(one).toEqual({ ok: true, weekCount: 1 });
    const two = await logSubstanceUnitAction(fd({ substance: "alcohol" }));
    expect(two).toEqual({ ok: true, weekCount: 2 });

    // The SAME store Nutrition's one-tap bar reads (one ledger, two surfaces).
    const row = db
      .prepare(
        `SELECT servings FROM food_log WHERE profile_id = ? AND group_key = 'alcohol'`
      )
      .get(profile.id) as { servings: number };
    expect(row.servings).toBe(2);
    const events = db
      .prepare(
        `SELECT COUNT(*) AS n FROM food_log_events WHERE profile_id = ? AND group_key = 'alcohol'`
      )
      .get(profile.id) as { n: number };
    expect(events.n).toBe(2);
    // Nothing leaked into the non-food ledger.
    const sub = db
      .prepare(`SELECT COUNT(*) AS n FROM substance_log WHERE profile_id = ?`)
      .get(profile.id) as { n: number };
    expect(sub.n).toBe(0);

    const undone = await undoSubstanceUnitAction(fd({ substance: "alcohol" }));
    expect(undone).toEqual({ ok: true, weekCount: 1 });
  });

  it("nicotine logs into substance_log (#1078) and reports the weekly count; undo reverses", async () => {
    const login = createLogin();
    const profile = createProfile("su-nicotine", login.id);
    actAs(login, profile);

    const one = await logSubstanceUnitAction(fd({ substance: "nicotine" }));
    expect(one).toEqual({ ok: true, weekCount: 1 });
    const two = await logSubstanceUnitAction(fd({ substance: "nicotine" }));
    expect(two).toEqual({ ok: true, weekCount: 2 });

    const row = db
      .prepare(
        `SELECT units FROM substance_log WHERE profile_id = ? AND substance = 'nicotine'`
      )
      .get(profile.id) as { units: number };
    expect(row.units).toBe(2);
    // The food ledger is untouched — no nutrition pollution (#1078).
    const food = db
      .prepare(`SELECT COUNT(*) AS n FROM food_log WHERE profile_id = ?`)
      .get(profile.id) as { n: number };
    expect(food.n).toBe(0);

    const undone = await undoSubstanceUnitAction(fd({ substance: "nicotine" }));
    expect(undone).toEqual({ ok: true, weekCount: 1 });
  });

  it("rejects an unknown substance", async () => {
    const login = createLogin();
    const profile = createProfile("su-bogus-substance", login.id);
    actAs(login, profile);
    const r = await logSubstanceUnitAction(fd({ substance: "caffeine" }));
    expect(r.ok).toBe(false);
  });
});

describe("setSubstanceTargetAction / clearSubstanceTargetAction", () => {
  it("sets a weekly cap, updates it in place (one row per substance), and clears it", async () => {
    const login = createLogin();
    const profile = createProfile("su-target", login.id);
    actAs(login, profile);

    const set = await setSubstanceTargetAction(
      fd({ substance: "alcohol", cap: "7" })
    );
    expect(set.ok).toBe(true);
    expect(targetRow(profile.id)?.per_week).toBe(7);

    // Re-setting updates the cap rather than duplicating the row.
    await setSubstanceTargetAction(fd({ substance: "alcohol", cap: "5" }));
    const rows = db
      .prepare(
        `SELECT COUNT(*) AS n FROM frequency_targets
         WHERE profile_id = ? AND scope_kind = 'substance'`
      )
      .get(profile.id) as { n: number };
    expect(rows.n).toBe(1);
    expect(targetRow(profile.id)?.per_week).toBe(5);

    const cleared = await clearSubstanceTargetAction(
      fd({ substance: "alcohol" })
    );
    expect(cleared.ok).toBe(true);
    expect(targetRow(profile.id)).toBeUndefined();
  });

  it("accepts cap 0 (an alcohol-free week) and rejects negatives, fractions, and over-cap", async () => {
    const login = createLogin();
    const profile = createProfile("su-cap-bounds", login.id);
    actAs(login, profile);

    expect(
      (await setSubstanceTargetAction(fd({ substance: "alcohol", cap: "0" })))
        .ok
    ).toBe(true);
    expect(targetRow(profile.id)?.per_week).toBe(0);

    for (const cap of ["-1", "2.5", "71", "abc"]) {
      const r = await setSubstanceTargetAction(
        fd({ substance: "alcohol", cap })
      );
      expect(r.ok, `cap ${cap} should be rejected`).toBe(false);
    }
    // Nicotine/cannabis targets are first-class since #1078 (the target layer was
    // already substance-parameterized); an unknown substance still bounces.
    expect(
      (await setSubstanceTargetAction(fd({ substance: "nicotine", cap: "3" })))
        .ok
    ).toBe(true);
    expect(
      (await setSubstanceTargetAction(fd({ substance: "cannabis", cap: "0" })))
        .ok
    ).toBe(true);
    expect(
      (await setSubstanceTargetAction(fd({ substance: "caffeine", cap: "3" })))
        .ok
    ).toBe(false);
  });
});

describe("substance consumption history actions (#2009)", () => {
  it("adds a past alcohol day, edits date/amount/notes, deletes with undo, and weekly state follows", async () => {
    const login = createLogin();
    const profile = createProfile("su-history-alcohol", login.id);
    actAs(login, profile);
    const td = today(profile.id);
    const past = shiftDateStr(td, -30);

    const added = await addSubstanceDailyTotalAction(
      fd({
        substance: "alcohol",
        date: past,
        amount: "2",
        notes: "Dinner with friends",
      })
    );
    expect(added.kind).toBe("added");
    if (added.kind !== "added") throw new Error("entry was not added");
    expect(getSubstanceDailyTotals(profile.id, "alcohol")).toEqual([
      {
        id: added.id,
        substance: "alcohol",
        date: past,
        amount: 2,
        notes: "Dinner with friends",
      },
    ]);

    const updated = await updateSubstanceDailyTotalAction(
      fd({
        id: String(added.id),
        substance: "alcohol",
        date: td,
        amount: "3",
        notes: "Corrected amount",
      })
    );
    expect(updated).toEqual({ kind: "updated", id: added.id });
    expect(getSubstanceWeekState(profile.id, "alcohol").count).toBe(3);
    const eventCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM food_log_events
         WHERE profile_id = ? AND group_key = 'alcohol' AND date = ?`
      )
      .get(profile.id, td) as { n: number };
    expect(eventCount.n).toBe(3);

    const deleted = await deleteSubstanceDailyTotalAction(
      fd({ id: String(added.id), substance: "alcohol" })
    );
    expect(deleted.kind).toBe("deleted");
    expect(getSubstanceWeekState(profile.id, "alcohol").count).toBe(0);
    if (deleted.kind !== "deleted") throw new Error("entry was not deleted");
    expect(await undoDelete(deleted.undoId)).toEqual({ ok: true });
    expect(getSubstanceWeekState(profile.id, "alcohol").count).toBe(3);
    expect(getSubstanceDailyTotals(profile.id, "alcohol")[0]).toMatchObject({
      date: td,
      amount: 3,
      notes: "Corrected amount",
    });
  });

  it("presents alcohol and non-food rows through one ordered shape with no store field", async () => {
    const login = createLogin();
    const profile = createProfile("su-history-unified", login.id);
    actAs(login, profile);
    const td = today(profile.id);
    const yesterday = shiftDateStr(td, -1);

    await addSubstanceDailyTotalAction(
      fd({ substance: "alcohol", date: yesterday, amount: "2" })
    );
    await addSubstanceDailyTotalAction(
      fd({
        substance: "nicotine",
        date: td,
        amount: "4",
        notes: "Pouches",
      })
    );

    const history = getAllSubstanceDailyTotals(profile.id);
    expect(history.map((entry) => entry.substance)).toEqual([
      "nicotine",
      "alcohol",
    ]);
    expect(history[0]).toMatchObject({
      date: td,
      amount: 4,
      notes: "Pouches",
    });
    for (const entry of history) {
      expect(entry).not.toHaveProperty("store");
      expect(entry).not.toHaveProperty("ledger");
    }
  });

  it("returns typed conflict/not-found outcomes instead of overwriting another day", async () => {
    const login = createLogin();
    const profile = createProfile("su-history-outcomes", login.id);
    actAs(login, profile);
    const td = today(profile.id);

    const first = await addSubstanceDailyTotalAction(
      fd({ substance: "cannabis", date: td, amount: "1" })
    );
    expect(first.kind).toBe("added");
    expect(
      await addSubstanceDailyTotalAction(
        fd({ substance: "cannabis", date: td, amount: "2" })
      )
    ).toEqual({ kind: "date-conflict" });
    expect(
      await updateSubstanceDailyTotalAction(
        fd({ id: "999999", substance: "cannabis", date: td, amount: "2" })
      )
    ).toEqual({ kind: "not-found" });
  });

  it("rejects future-dated history instead of counting it in the current week", async () => {
    const login = createLogin();
    const profile = createProfile("su-history-future", login.id);
    actAs(login, profile);
    const future = shiftDateStr(today(profile.id), 1);

    expect(
      await addSubstanceDailyTotalAction(
        fd({ substance: "nicotine", date: future, amount: "2" })
      )
    ).toEqual({ kind: "invalid-date" });
    expect(getSubstanceDailyTotals(profile.id, "nicotine")).toEqual([]);
    expect(getSubstanceWeekState(profile.id, "nicotine").count).toBe(0);
  });

  it("undo merges a deleted aggregate with a same-day row recreated meanwhile", async () => {
    const login = createLogin();
    const profile = createProfile("su-history-undo-collision", login.id);
    actAs(login, profile);
    const td = today(profile.id);

    for (const substance of ["alcohol", "nicotine"] as const) {
      const added = await addSubstanceDailyTotalAction(
        fd({
          substance,
          date: td,
          amount: "2",
          notes: `${substance} restored note`,
        })
      );
      if (added.kind !== "added") throw new Error("entry was not added");
      const deleted = await deleteSubstanceDailyTotalAction(
        fd({ id: String(added.id), substance })
      );
      if (deleted.kind !== "deleted") throw new Error("entry was not deleted");

      expect(await logSubstanceUnitAction(fd({ substance }))).toMatchObject({
        ok: true,
      });
      expect(await undoDelete(deleted.undoId)).toEqual({ ok: true });
      expect(getSubstanceDailyTotals(profile.id, substance)).toEqual([
        expect.objectContaining({
          substance,
          date: td,
          amount: 3,
          notes: `${substance} restored note`,
        }),
      ]);
    }

    const alcoholEvents = db
      .prepare(
        `SELECT COUNT(*) AS n FROM food_log_events
         WHERE profile_id = ? AND group_key = 'alcohol' AND date = ?`
      )
      .get(profile.id, td) as { n: number };
    expect(alcoholEvents.n).toBe(3);
  });
});

// #2072 — the edit/delete pair takes a ROW ID from the client, so "this id belongs
// to the acting profile" is the whole boundary between a correction and reading or
// destroying someone else's substance-use history. Every statement in the write
// core carries `AND profile_id = ?`, but a profile filter is one WHERE clause away
// from being dropped by a later refactor, so it is pinned behaviorally here rather
// than by inspection: one ledger each, asserting the typed `not-found` AND that the
// victim's row (and, for alcohol, its per-tap events) is byte-identical afterwards.
describe("substance history actions refuse another profile's row (#2072)", () => {
  it("alcohol (food-log ledger): update and delete are not-found, the row and its taps survive", async () => {
    const owner = createLogin();
    const ownerProfile = createProfile("su-history-owner-alcohol", owner.id);
    actAs(owner, ownerProfile);
    const td = today(ownerProfile.id);
    const added = await addSubstanceDailyTotalAction(
      fd({ substance: "alcohol", date: td, amount: "2", notes: "Owner note" })
    );
    if (added.kind !== "added") throw new Error("entry was not added");

    const intruder = createLogin();
    const intruderProfile = createProfile(
      "su-history-intruder-alcohol",
      intruder.id
    );
    actAs(intruder, intruderProfile);

    expect(
      await updateSubstanceDailyTotalAction(
        fd({
          id: String(added.id),
          substance: "alcohol",
          date: td,
          amount: "9",
          notes: "Rewritten by another profile",
        })
      )
    ).toEqual({ kind: "not-found" });
    expect(
      await deleteSubstanceDailyTotalAction(
        fd({ id: String(added.id), substance: "alcohol" })
      )
    ).toMatchObject({ kind: "not-found", undoId: null });

    // The owner's day is untouched: same amount, same notes, same per-tap events
    // (a reconcile that ran on the wrong profile would have rewritten them).
    expect(getSubstanceDailyTotals(ownerProfile.id, "alcohol")).toEqual([
      {
        id: added.id,
        substance: "alcohol",
        date: td,
        amount: 2,
        notes: "Owner note",
      },
    ]);
    const ownerEvents = db
      .prepare(
        `SELECT COUNT(*) AS n FROM food_log_events
         WHERE profile_id = ? AND group_key = 'alcohol' AND date = ?`
      )
      .get(ownerProfile.id, td) as { n: number };
    expect(ownerEvents.n).toBe(2);
    // …and nothing was created under the acting profile as a consolation write.
    expect(getSubstanceDailyTotals(intruderProfile.id, "alcohol")).toEqual([]);
    expect(getSubstanceWeekState(intruderProfile.id, "alcohol").count).toBe(0);
  });

  it("nicotine (substance-log ledger): update and delete are not-found, the row survives", async () => {
    const owner = createLogin();
    const ownerProfile = createProfile("su-history-owner-nicotine", owner.id);
    actAs(owner, ownerProfile);
    const td = today(ownerProfile.id);
    const added = await addSubstanceDailyTotalAction(
      fd({ substance: "nicotine", date: td, amount: "3", notes: "Owner note" })
    );
    if (added.kind !== "added") throw new Error("entry was not added");

    const intruder = createLogin();
    const intruderProfile = createProfile(
      "su-history-intruder-nicotine",
      intruder.id
    );
    actAs(intruder, intruderProfile);

    expect(
      await updateSubstanceDailyTotalAction(
        fd({
          id: String(added.id),
          substance: "nicotine",
          date: td,
          amount: "9",
          notes: "Rewritten by another profile",
        })
      )
    ).toEqual({ kind: "not-found" });
    expect(
      await deleteSubstanceDailyTotalAction(
        fd({ id: String(added.id), substance: "nicotine" })
      )
    ).toMatchObject({ kind: "not-found", undoId: null });

    expect(getSubstanceDailyTotals(ownerProfile.id, "nicotine")).toEqual([
      {
        id: added.id,
        substance: "nicotine",
        date: td,
        amount: 3,
        notes: "Owner note",
      },
    ]);
    expect(getSubstanceDailyTotals(intruderProfile.id, "nicotine")).toEqual([]);
    expect(getSubstanceWeekState(intruderProfile.id, "nicotine").count).toBe(0);
  });
});

// #1279 — the life-stage (minor) gate lives on the SURFACE (hidden nav + page
// redirect, #1174), but Server Actions are independently POST-callable, so each
// write path must re-check age at the auth boundary. These drive every action
// DIRECTLY against a known-minor profile (bypassing the page) and assert refusal —
// the layer the #1174 e2e (nav-hidden + redirect) structurally can't see. An
// adult/unknown-age profile is unaffected (the many passing tests above).
describe("substance-use actions refuse a known minor (#1279)", () => {
  function minorActor(slug: string) {
    const login = createLogin();
    const profile = createProfile(slug, login.id);
    // Stored-age fallback = 15 → isMinor(getProfileAge) true (no birthdate needed).
    setProfileSetting(profile.id, "age", "15");
    actAs(login, profile);
    return profile;
  }

  it("recordSubstanceInstrumentAction refuses (in-app administer AND outside total)", async () => {
    const profile = minorActor("su-minor-instrument");
    const administered = await recordSubstanceInstrumentAction(
      fd({
        instrument: "AUDIT-C",
        mode: "administer",
        date: "2026-07-01",
        answers: JSON.stringify([2, 1, 4]),
      })
    );
    expect(administered.ok).toBe(false);
    const outside = await recordSubstanceInstrumentAction(
      fd({
        instrument: "AUDIT",
        mode: "outside",
        date: "2026-07-01",
        total: "10",
      })
    );
    expect(outside.ok).toBe(false);
    // Nothing was written for the minor.
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ?")
      .get(profile.id) as { n: number };
    expect(n.n).toBe(0);
  });

  it("logSubstanceUnitAction / undoSubstanceUnitAction refuse (alcohol + nicotine ledgers)", async () => {
    minorActor("su-minor-log");
    for (const substance of ["alcohol", "nicotine"]) {
      expect((await logSubstanceUnitAction(fd({ substance }))).ok).toBe(false);
      expect((await undoSubstanceUnitAction(fd({ substance }))).ok).toBe(false);
    }
  });

  it("setSubstanceTargetAction / clearSubstanceTargetAction refuse", async () => {
    const profile = minorActor("su-minor-target");
    expect(
      (await setSubstanceTargetAction(fd({ substance: "alcohol", cap: "7" })))
        .ok
    ).toBe(false);
    expect(
      (await clearSubstanceTargetAction(fd({ substance: "alcohol" }))).ok
    ).toBe(false);
    const rows = db
      .prepare(
        "SELECT COUNT(*) AS n FROM frequency_targets WHERE profile_id = ?"
      )
      .get(profile.id) as { n: number };
    expect(rows.n).toBe(0);
  });

  it("historical add/edit/delete actions refuse", async () => {
    const profile = minorActor("su-minor-history");
    expect(
      await addSubstanceDailyTotalAction(
        fd({ substance: "alcohol", date: "2026-07-01", amount: "2" })
      )
    ).toEqual({ kind: "not-found" });
    expect(
      await updateSubstanceDailyTotalAction(
        fd({
          id: "1",
          substance: "alcohol",
          date: "2026-07-01",
          amount: "2",
        })
      )
    ).toEqual({ kind: "not-found" });
    expect(
      await deleteSubstanceDailyTotalAction(
        fd({ id: "1", substance: "alcohol" })
      )
    ).toMatchObject({ kind: "not-found", undoId: null });
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM food_log WHERE profile_id = ?")
      .get(profile.id) as { n: number };
    expect(rows.n).toBe(0);
  });
});
