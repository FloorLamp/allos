// SERVER-ACTION TIER (#998, #1078, #1085) — the substance-use write paths. The
// instrument action derives the in-app totals from the per-item answers (server is
// the source of truth — AUDIT-C's 0..4 options and, since #1085, DAST-10's 0/1
// yes/no options incl. the flipped reverse-scored item), refuses in-app
// administration of the total-only AUDIT (its item text is deliberately not
// shipped), validates the outside-total bounds, and gates on requireWriteAccess.
// The unit log dispatches per substance (#1078): alcohol through the shared
// food-log core into the `alcohol` group, nicotine/cannabis through the
// substance_daily_totals core; the target actions upsert/clear the substance
// frequency_targets row (cap semantics, one row per substance).

import { describe, expect, it, vi } from "vitest";
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
  trackSubstanceUseAction,
} from "@/app/(app)/medical/substance-use/actions";
import { undoDelete } from "@/app/(app)/undo-actions";
import { actAs, createLogin, createProfile, fd } from "./harness";
import { setProfileSetting } from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";
import {
  getAllSubstanceDailyTotals,
  getSubstanceDailyTotals,
  getSubstanceWeekState,
  getLoggedSubstanceKeys,
} from "@/lib/queries";
import { MAX_SUBSTANCE_NAME_LENGTH } from "@/lib/substance-use";

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
  it("derives AUDIT-C totals and rejects answers outside an item's options", async () => {
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

    const invalid = await recordSubstanceInstrumentAction(
      fd({
        instrument: "AUDIT-C",
        mode: "administer",
        date: "2026-07-01",
        answers: JSON.stringify([2, 1, 5]), // 5 is not an AUDIT-C option
      })
    );
    expect(invalid.ok).toBe(false);
    expect(scoreRow(profile.id, "AUDIT-C")?.value_num).toBe(7);
  });

  it("derives DAST-10 totals and validates answer length and options (#1085)", async () => {
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
    expect(scoreRow(profile.id, "DAST-10")?.value_num).toBe(3);
  });

  it("accepts bounded outside totals while refusing unsupported administrations and keys", async () => {
    const login = createLogin();
    const profile = createProfile("su-totalonly", login.id);
    actAs(login, profile);
    const totalOnly = await recordSubstanceInstrumentAction(
      fd({
        instrument: "AUDIT",
        mode: "administer",
        date: "2026-07-01",
        answers: JSON.stringify([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
      })
    );
    expect(totalOnly.ok).toBe(false);

    const dast = await recordSubstanceInstrumentAction(
      fd({
        instrument: "DAST-10",
        mode: "outside",
        date: "2026-07-01",
        total: "4",
      })
    );
    expect(dast.ok).toBe(true);
    // Same canonical_name series as an in-app administration — one identity.
    expect(scoreRow(profile.id, "DAST-10")?.value_num).toBe(4);

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

    for (const instrument of ["BOGUS", "PHQ-9"]) {
      const r = await recordSubstanceInstrumentAction(
        fd({ instrument, mode: "outside", date: "2026-07-01", total: "1" })
      );
      expect(r.ok).toBe(false);
    }
  });
});

describe("logSubstanceUnitAction / undoSubstanceUnitAction — per-substance ledger dispatch", () => {
  it("dispatches alcohol and nicotine to separate ledgers with symmetric undo", async () => {
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
        `SELECT servings FROM food_daily_totals WHERE profile_id = ? AND group_key = 'alcohol'`
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
      .prepare(
        `SELECT COUNT(*) AS n FROM substance_daily_totals WHERE profile_id = ?`
      )
      .get(profile.id) as { n: number };
    expect(sub.n).toBe(0);

    const undone = await undoSubstanceUnitAction(fd({ substance: "alcohol" }));
    expect(undone).toEqual({ ok: true, weekCount: 1 });

    const nicotineOne = await logSubstanceUnitAction(
      fd({ substance: "nicotine" })
    );
    expect(nicotineOne).toEqual({ ok: true, weekCount: 1 });
    const nicotineTwo = await logSubstanceUnitAction(
      fd({ substance: "nicotine" })
    );
    expect(nicotineTwo).toEqual({ ok: true, weekCount: 2 });

    const nicotineRow = db
      .prepare(
        `SELECT units FROM substance_daily_totals WHERE profile_id = ? AND substance = 'nicotine'`
      )
      .get(profile.id) as { units: number };
    expect(nicotineRow.units).toBe(2);
    // Nicotine added nothing to the food ledger: its only row remains alcohol.
    const food = db
      .prepare(
        `SELECT group_key FROM food_daily_totals WHERE profile_id = ? ORDER BY group_key`
      )
      .all(profile.id) as { group_key: string }[];
    expect(food).toEqual([{ group_key: "alcohol" }]);

    const nicotineUndone = await undoSubstanceUnitAction(
      fd({ substance: "nicotine" })
    );
    expect(nicotineUndone).toEqual({ ok: true, weekCount: 1 });
  });

  // #3279 MOVED THIS FIXTURE ACROSS ITS OWN BOUNDARY, DELIBERATELY. It used to post
  // "caffeine" as a stand-in for a key the app does not know, and that is no longer a
  // refusal: the vocabulary is open, so "caffeine" is a perfectly good custom substance
  // and posting it is how a person defines one. What survives as unloggable is text that
  // NAMES NOTHING — empty or whitespace-only — so the refusal assertion moves there and
  // keeps testing what it claimed. The old case becomes its positive twin below.
  it("refuses a substance that names nothing", async () => {
    const login = createLogin();
    const profile = createProfile("su-bogus-substance", login.id);
    actAs(login, profile);
    expect((await logSubstanceUnitAction(fd({ substance: "" }))).ok).toBe(
      false
    );
    expect((await logSubstanceUnitAction(fd({ substance: "   " }))).ok).toBe(
      false
    );
  });

  it("logs a CUSTOM substance the profile named itself, on the counter ledger", async () => {
    const login = createLogin();
    const profile = createProfile("su-custom-substance", login.id);
    actAs(login, profile);
    // Typed with stray whitespace: the action normalizes at its own boundary, so this
    // and a later clean "Kratom" are ONE ledger row, not two neighbours.
    expect(
      await logSubstanceUnitAction(fd({ substance: "  Kratom " }))
    ).toEqual({ ok: true, weekCount: 1 });
    expect(await logSubstanceUnitAction(fd({ substance: "Kratom" }))).toEqual({
      ok: true,
      weekCount: 2,
    });
    const row = db
      .prepare(
        `SELECT substance, units FROM substance_daily_totals WHERE profile_id = ?`
      )
      .all(profile.id) as { substance: string; units: number }[];
    expect(row).toEqual([{ substance: "Kratom", units: 2 }]);
    // A custom substance is EPISODIC and it is never a food: the nutrition ledger is
    // untouched (docs/internals/substances.md — nothing typed may pollute it).
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM food_daily_totals WHERE profile_id = ?`
        )
        .get(profile.id)
    ).toEqual({ n: 0 });
    // And it carries NO reduction framing, because no cap was ever set (#3279 ruling 1).
    expect(getSubstanceWeekState(profile.id, "Kratom").status).toBeNull();
  });
});

// #3326 — the entry point. There is no create step to test, because there is no
// create step: naming a substance and logging its first use are one act, and the
// substance exists afterwards because a ledger row does.
describe("trackSubstanceUseAction (#3326)", () => {
  it("names a substance and logs a use in one call, with no registration step", async () => {
    const login = createLogin();
    const profile = createProfile("su-track", login.id);
    actAs(login, profile);

    // Nothing registered it, and nothing had to.
    expect(getLoggedSubstanceKeys(profile.id)).toEqual([]);

    const result = await trackSubstanceUseAction(fd({ name: "  Kratom " }));
    expect(result).toEqual({
      ok: true,
      substance: "Kratom",
      label: "Kratom",
      weekCount: 1,
    });
    // It is on the ledger, on the substance store, and now part of what this
    // profile tracks — which is what makes it reachable from the quick sheet.
    expect(getLoggedSubstanceKeys(profile.id)).toEqual(["Kratom"]);
    expect(getSubstanceWeekState(profile.id, "Kratom").count).toBe(1);
    // And it carries no reduction framing, because nobody opted into a cap.
    expect(getSubstanceWeekState(profile.id, "Kratom").status).toBeNull();
  });

  it("refuses an over-long name instead of storing a shorter substance than the one typed", async () => {
    const login = createLogin();
    const profile = createProfile("su-track-long", login.id);
    actAs(login, profile);

    const tooLong = "x".repeat(MAX_SUBSTANCE_NAME_LENGTH + 1);
    const result = await trackSubstanceUseAction(fd({ name: tooLong }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(
      String(MAX_SUBSTANCE_NAME_LENGTH)
    );
    // The refusal is the POINT: nothing was written, so there is no truncated
    // near-miss substance sitting in the ledger for the person to find later. A
    // Server Action is independently POST-callable, so this cannot live only in
    // the form.
    expect(getLoggedSubstanceKeys(profile.id)).toEqual([]);
  });

  it("refuses a name that is only whitespace", async () => {
    const login = createLogin();
    const profile = createProfile("su-track-empty", login.id);
    actAs(login, profile);

    expect((await trackSubstanceUseAction(fd({ name: "   " }))).ok).toBe(false);
    expect(getLoggedSubstanceKeys(profile.id)).toEqual([]);
  });

  it("collapses a typed curated LABEL onto the curated key rather than opening a second ledger", async () => {
    const login = createLogin();
    const profile = createProfile("su-track-curated", login.id);
    actAs(login, profile);

    let scans = 0;
    const realPrepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (/FROM substance_daily_totals[\s\S]*GROUP BY substance/.test(sql))
        scans++;
      return realPrepare(sql);
    }) as typeof db.prepare);
    let result: Awaited<ReturnType<typeof trackSubstanceUseAction>>;
    try {
      result = await trackSubstanceUseAction(fd({ name: "Alcohol" }));
    } finally {
      spy.mockRestore();
    }
    expect(scans).toBe(0);
    expect(result).toEqual({
      ok: true,
      substance: "alcohol",
      label: "Alcohol",
      weekCount: 1,
    });
    // Alcohol's ledger is the food store, and this one typed name is the ONLY way
    // a typed name reaches it — because it resolved onto a CURATED key first.
    expect(getSubstanceDailyTotals(profile.id, "alcohol")).toHaveLength(1);
    expect(getLoggedSubstanceKeys(profile.id)).toEqual(["alcohol"]);
    // No second, custom "Alcohol" substance was minted alongside it.
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM substance_daily_totals WHERE profile_id = ?`
        )
        .get(profile.id)
    ).toEqual({ n: 0 });
  });

  it("keeps a typed name off the nutrition ledger whatever it is called", async () => {
    const login = createLogin();
    const profile = createProfile("su-track-not-food", login.id);
    actAs(login, profile);

    // A name that reads like a food is still not a food: nothing typed can be SHOWN
    // to be one, so it always rides substance_daily_totals (#860/#944).
    await trackSubstanceUseAction(fd({ name: "Kava tea" }));
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM food_daily_totals WHERE profile_id = ?`
        )
        .get(profile.id)
    ).toEqual({ n: 0 });
    expect(getLoggedSubstanceKeys(profile.id)).toEqual(["Kava tea"]);
  });

  it("preserves case, so the label is the person's own spelling", async () => {
    const login = createLogin();
    const profile = createProfile("su-track-case", login.id);
    actAs(login, profile);

    const result = await trackSubstanceUseAction(fd({ name: "MDMA" }));
    expect(result.ok && result.label).toBe("MDMA");
    // #3325 folded case for MATCHING and left it alone for DISPLAY. This fixture used
    // to pin the DEFECT — two casings, two substances — with a note that folding one
    // domain alone would re-fork the model. Both domains fold now, so the second
    // casing joins the first substance and the capitals survive.
    await trackSubstanceUseAction(fd({ name: "mdma" }));
    expect(getLoggedSubstanceKeys(profile.id)).toEqual(["MDMA"]);
  });

  it("folds three casings onto the first-seen spelling, and says which one took the log (#3325)", async () => {
    const login = createLogin();
    const profile = createProfile("su-track-fold", login.id);
    actAs(login, profile);

    await trackSubstanceUseAction(fd({ name: "Kratom" }));
    const lower = await trackSubstanceUseAction(fd({ name: "kratom" }));
    const upper = await trackSubstanceUseAction(fd({ name: "  KRATOM " }));

    // ONE substance, ONE label — and the result NAMES the card the use landed on, which
    // is what keeps the fold from being a silent redirect: the toast reads
    // "Kratom: 1 logged today" for somebody who typed "kratom".
    expect(lower).toMatchObject({
      ok: true,
      substance: "Kratom",
      label: "Kratom",
    });
    expect(upper).toMatchObject({
      ok: true,
      substance: "Kratom",
      label: "Kratom",
    });
    expect(getLoggedSubstanceKeys(profile.id)).toEqual(["Kratom"]);
    // Three uses on one ledger, not one use on three.
    expect(getSubstanceWeekState(profile.id, "Kratom").count).toBe(3);
    expect(getSubstanceDailyTotals(profile.id, "kratom")).toEqual([]);
  });

  it("does not fold across profiles — another profile's spelling is not mine", async () => {
    const loginA = createLogin();
    const profileA = createProfile("su-track-fold-a", loginA.id);
    actAs(loginA, profileA);
    await trackSubstanceUseAction(fd({ name: "Kratom" }));

    const loginB = createLogin();
    const profileB = createProfile("su-track-fold-b", loginB.id);
    actAs(loginB, profileB);
    const mine = await trackSubstanceUseAction(fd({ name: "kratom" }));

    // The vocabulary is the profile's own ledger, so B's card is spelled B's way.
    expect(mine).toMatchObject({ ok: true, substance: "kratom" });
    expect(getLoggedSubstanceKeys(profileB.id)).toEqual(["kratom"]);
    expect(getLoggedSubstanceKeys(profileA.id)).toEqual(["Kratom"]);
  });

  it("refuses for a known minor, like every other write on this surface", async () => {
    const login = createLogin();
    const profile = createProfile("su-track-minor", login.id);
    actAs(login, profile);
    setProfileSetting(profile.id, "age", "14");

    const result = await trackSubstanceUseAction(fd({ name: "Kratom" }));
    // The LIFE-STAGE refusal specifically, not merely some refusal — a name gate
    // firing here instead would pass this test while leaving the #1174 hole open.
    expect(result).toEqual({
      ok: false,
      error: "This isn't available for this profile.",
    });
    expect(getLoggedSubstanceKeys(profile.id)).toEqual([]);
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
    // already substance-parameterized); a substance naming nothing still bounces.
    expect(
      (await setSubstanceTargetAction(fd({ substance: "nicotine", cap: "3" })))
        .ok
    ).toBe(true);
    expect(
      (await setSubstanceTargetAction(fd({ substance: "cannabis", cap: "0" })))
        .ok
    ).toBe(true);
    // #3279: a cap on a CUSTOM substance is set the same way — the target table was
    // never keyed to the curated three. A target that names nothing still bounces.
    expect(
      (await setSubstanceTargetAction(fd({ substance: "Kratom", cap: "3" }))).ok
    ).toBe(true);
    expect(
      (await setSubstanceTargetAction(fd({ substance: "  ", cap: "3" }))).ok
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
  it("refuses every direct write path without changing any substance store", async () => {
    const login = createLogin();
    const profile = createProfile("su-minor-actions", login.id);
    // Stored-age fallback = 15 → isMinor(getProfileAge) true (no birthdate needed).
    setProfileSetting(profile.id, "age", "15");
    actAs(login, profile);

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

    for (const substance of ["alcohol", "nicotine"]) {
      expect((await logSubstanceUnitAction(fd({ substance }))).ok).toBe(false);
      expect((await undoSubstanceUnitAction(fd({ substance }))).ok).toBe(false);
    }

    expect(
      (await setSubstanceTargetAction(fd({ substance: "alcohol", cap: "7" })))
        .ok
    ).toBe(false);
    expect(
      (await clearSubstanceTargetAction(fd({ substance: "alcohol" }))).ok
    ).toBe(false);

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

    // The shared minor boundary stopped every action before any backing store moved.
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM medical_records WHERE profile_id = @profileId) AS records,
           (SELECT COUNT(*) FROM frequency_targets WHERE profile_id = @profileId) AS targets,
           (SELECT COUNT(*) FROM food_daily_totals WHERE profile_id = @profileId) AS food,
           (SELECT COUNT(*) FROM substance_daily_totals WHERE profile_id = @profileId) AS substances`
      )
      .get({ profileId: profile.id }) as {
      records: number;
      targets: number;
      food: number;
      substances: number;
    };
    expect(counts).toEqual({ records: 0, targets: 0, food: 0, substances: 0 });
  });
});
