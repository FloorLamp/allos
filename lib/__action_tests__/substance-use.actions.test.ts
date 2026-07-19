// SERVER-ACTION TIER (#998) — the substance-use write paths. The instrument action
// derives the AUDIT-C total from the per-item 0..4 answers (server is the source of
// truth), refuses in-app administration of the total-only instruments (AUDIT /
// DAST-10 — their item text is deliberately not shipped), validates the outside-
// total bounds, and gates on requireWriteAccess. The drink log rides the shared
// food-log core into the `alcohol` group; the target actions upsert/clear the
// substance frequency_targets row (cap semantics, one row per substance).

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  recordSubstanceInstrumentAction,
  logDrinkAction,
  undoDrinkAction,
  setSubstanceTargetAction,
  clearSubstanceTargetAction,
} from "@/app/(app)/medical/substance-use/actions";
import { actAs, createLogin, createProfile, fd } from "./harness";

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

  it("refuses in-app administration of a total-only instrument (no baked item text)", async () => {
    const login = createLogin();
    const profile = createProfile("su-totalonly", login.id);
    actAs(login, profile);
    const r = await recordSubstanceInstrumentAction(
      fd({
        instrument: "DAST-10",
        mode: "administer",
        date: "2026-07-01",
        answers: JSON.stringify([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
      })
    );
    expect(r.ok).toBe(false);
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

describe("logDrinkAction / undoDrinkAction — the shared food-log ledger", () => {
  it("logs into the alcohol food_log group and reports the weekly count; undo reverses", async () => {
    const login = createLogin();
    const profile = createProfile("su-drink", login.id);
    actAs(login, profile);

    const one = await logDrinkAction();
    expect(one).toEqual({ ok: true, weekCount: 1 });
    const two = await logDrinkAction();
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

    const undone = await undoDrinkAction();
    expect(undone).toEqual({ ok: true, weekCount: 1 });
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
    expect(
      (await setSubstanceTargetAction(fd({ substance: "nicotine", cap: "3" })))
        .ok
    ).toBe(false);
  });
});
