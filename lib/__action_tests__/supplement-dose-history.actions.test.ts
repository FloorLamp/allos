// SERVER-ACTION TIER — the historical-dose actions, now shared by both intake
// surfaces (#1933). The cores' own behavior is pinned in
// lib/__db_tests__/supplement-dose-history.test.ts; what these cases own is the
// BOUNDARY: the auth gate, the wall-time parse, the typed outcome each refusal is
// rendered as, and the audit row a retroactive correction leaves behind.
//
// The refusal mapping matters as much as the success path. A supplement dose used to
// come back "That dose is no longer available" from a core that had simply refused its
// kind — a typed outcome misdescribing its own reason. It must now succeed, while a
// dose that genuinely doesn't exist keeps saying exactly that.

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { now as clockNow } from "@/lib/clock";
import { shiftDateStr, zonedDateParts } from "@/lib/date";
import { getTimezone } from "@/lib/settings";
import { getIntakeDoseHistory } from "@/lib/queries";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import {
  deleteAdministration,
  logHistoricalDose,
  updateHistoricalDose,
} from "@/app/(app)/nutrition/supplement-actions";
import { actAs, createLogin, createProfile, fd, seedActor } from "./harness";

let unique = 0;

function seedSupplement(
  profileId: number,
  opts: { onHand?: number | null } = {}
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation,
            quantity_on_hand, qty_per_dose)
         VALUES (?, ?, 1, 'supplement', 'daily', 'must', ?, 1)`
      )
      .run(
        profileId,
        `Zinc ${++unique}`,
        opts.onHand === undefined ? 10 : opts.onHand
      ).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '15 mg', 'morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

function auditRows(
  profileId: number
): { action: string; target: string | null; detail: string | null }[] {
  return db
    .prepare(
      `SELECT action, target, detail FROM audit_events
        WHERE active_profile_id = ? AND action LIKE 'dose-log.%'
        ORDER BY id`
    )
    .all(profileId) as {
    action: string;
    target: string | null;
    detail: string | null;
  }[];
}

describe("logHistoricalDose action — supplements", () => {
  it("backfills a supplement dose, snapshots the amount, and audits it", async () => {
    const { profile } = seedActor();
    const { itemId, doseId } = seedSupplement(profile.id);
    const date = shiftDateStr(today(profile.id), -12);

    const result = await logHistoricalDose(
      fd({
        id: itemId,
        dose_id: doseId,
        date,
        time: "08:30",
        amount: "30 mg",
        adjust_supply: "1",
      })
    );
    expect(result.ok).toBe(true);

    const history = getIntakeDoseHistory(profile.id, itemId, "0001-01-01");
    expect(history).toHaveLength(1);
    expect(history[0].amount).toBe("30 mg");
    expect(
      (
        db
          .prepare(
            "SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?"
          )
          .get(itemId) as { q: number }
      ).q
    ).toBe(9);

    expect(auditRows(profile.id)).toEqual([
      {
        action: AUDIT_ACTIONS.doseLogBackfill,
        target: String(itemId),
        detail: date,
      },
    ]);
  });

  it("a dose that genuinely doesn't exist still reports stale", async () => {
    const { profile } = seedActor();
    const { itemId } = seedSupplement(profile.id);
    const result = await logHistoricalDose(
      fd({
        id: itemId,
        dose_id: 987_654,
        date: shiftDateStr(today(profile.id), -1),
        time: "08:30",
      })
    );
    expect(result).toEqual({
      ok: false,
      error: "That dose is no longer available. Refresh and try again.",
    });
    expect(auditRows(profile.id)).toEqual([]);
  });

  it("refuses a future date and a malformed time", async () => {
    const { profile } = seedActor();
    const { itemId, doseId } = seedSupplement(profile.id);

    expect(
      await logHistoricalDose(
        fd({
          id: itemId,
          dose_id: doseId,
          date: shiftDateStr(today(profile.id), 3),
          time: "08:30",
        })
      )
    ).toEqual({
      ok: false,
      error: "Choose a date and time that are not in the future.",
    });

    expect(
      await logHistoricalDose(
        fd({
          id: itemId,
          dose_id: doseId,
          date: shiftDateStr(today(profile.id), -1),
          time: "8:3",
        })
      )
    ).toEqual({ ok: false, error: "Enter a valid dose date and time." });
    expect(getIntakeDoseHistory(profile.id, itemId, "0001-01-01")).toEqual([]);
  });

  it("refuses a second backfill on a day the scheduled dose already has", async () => {
    const { profile } = seedActor();
    const { itemId, doseId } = seedSupplement(profile.id);
    const date = shiftDateStr(today(profile.id), -2);
    await logHistoricalDose(
      fd({ id: itemId, dose_id: doseId, date, time: "08:00" })
    );
    expect(
      await logHistoricalDose(
        fd({ id: itemId, dose_id: doseId, date, time: "19:00" })
      )
    ).toEqual({
      ok: false,
      error: "That scheduled dose is already recorded for this date.",
    });
  });

  it("names a scheduled dose that was already skipped on that date", async () => {
    const { profile } = seedActor();
    const { itemId, doseId } = seedSupplement(profile.id);
    const date = shiftDateStr(today(profile.id), -2);
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
       VALUES (?, ?, ?, 'skipped')`
    ).run(doseId, itemId, date);

    expect(
      await logHistoricalDose(
        fd({ id: itemId, dose_id: doseId, date, time: "08:00" })
      )
    ).toEqual({
      ok: false,
      error: "That scheduled dose is marked skipped for this date.",
    });
    expect(auditRows(profile.id)).toEqual([]);
  });

  it("refuses a read-only acting session", async () => {
    const login = createLogin({});
    const profile = createProfile(`sdh-ro-${++unique}`, login.id);
    const { itemId, doseId } = seedSupplement(profile.id);
    actAs(login, profile, "read");
    await expect(
      logHistoricalDose(
        fd({
          id: itemId,
          dose_id: doseId,
          date: shiftDateStr(today(profile.id), -1),
          time: "08:00",
        })
      )
    ).rejects.toThrow();
    expect(getIntakeDoseHistory(profile.id, itemId, "0001-01-01")).toEqual([]);
  });
});

describe("updateHistoricalDose action — supplements", () => {
  it("amends a supplement's recorded dose and audits it", async () => {
    const { profile } = seedActor();
    const { itemId, doseId } = seedSupplement(profile.id);
    const date = shiftDateStr(today(profile.id), -5);
    await logHistoricalDose(
      fd({ id: itemId, dose_id: doseId, date, time: "08:00", amount: "15 mg" })
    );
    const logId = getIntakeDoseHistory(profile.id, itemId, "0001-01-01")[0].id;

    const result = await updateHistoricalDose(
      fd({ id: itemId, log_id: logId, date, time: "20:15", amount: "45 mg" })
    );
    expect(result.ok).toBe(true);
    const row = getIntakeDoseHistory(profile.id, itemId, "0001-01-01")[0];
    expect(row.amount).toBe("45 mg");
    // The stated time lands in the event column (#2228 decision 1); recorded_at is
    // record history for the amend path and keeps the backfill's stamp.
    expect(row.occurred_at).toContain("20:15");
    expect(row.recorded_at).toContain("08:00");

    expect(auditRows(profile.id).map((r) => r.action)).toEqual([
      AUDIT_ACTIONS.doseLogBackfill,
      AUDIT_ACTIONS.doseLogAmend,
    ]);
  });

  // #2031: the write cores judge a recorded_at against the CLOCK SEAM's now, not the
  // wall clock. Under a frozen clock that LEADS real time — exactly what #1464's
  // forward nudge produces for ~30 minutes before UTC midnight — an entry at the
  // app's own now is in the real future, and judging it on the wall clock refused
  // the app's own timestamps. This pins the wiring (the call site's clock choice),
  // where lib/__tests__/dose-log-window-clock.test.ts pins the predicate.
  it("accepts an entry at the app's own now while the frozen clock leads real time", async () => {
    const previous = process.env.ALLOS_TEST_NOW;
    // ~52 min ahead: the skew an in-band nudge to next-midnight+30 produces at 23:38Z.
    process.env.ALLOS_TEST_NOW = new Date(
      Date.now() + 52 * 60_000
    ).toISOString();
    try {
      const { profile } = seedActor();
      const { itemId, doseId } = seedSupplement(profile.id);
      const { date, hhmm } = zonedDateParts(
        getTimezone(profile.id),
        clockNow()
      );

      const logged = await logHistoricalDose(
        fd({ id: itemId, dose_id: doseId, date, time: hhmm, amount: "15 mg" })
      );
      expect(logged.ok).toBe(true);
      const logId = getIntakeDoseHistory(profile.id, itemId, "0001-01-01")[0]
        .id;

      const amended = await updateHistoricalDose(
        fd({ id: itemId, log_id: logId, date, time: hhmm, amount: "45 mg" })
      );
      expect(amended.ok).toBe(true);
      expect(
        getIntakeDoseHistory(profile.id, itemId, "0001-01-01")[0].amount
      ).toBe("45 mg");

      // The #797 forgery rule still bites, measured on that same app clock.
      expect(
        await updateHistoricalDose(
          fd({
            id: itemId,
            log_id: logId,
            date: shiftDateStr(date, 1),
            time: hhmm,
          })
        )
      ).toEqual({
        ok: false,
        error: "Choose a date and time that are not in the future.",
      });
    } finally {
      if (previous === undefined) delete process.env.ALLOS_TEST_NOW;
      else process.env.ALLOS_TEST_NOW = previous;
    }
  });

  it("reports stale for a log this profile doesn't own", async () => {
    const { profile } = seedActor();
    const { itemId, doseId } = seedSupplement(profile.id);
    const date = shiftDateStr(today(profile.id), -5);
    await logHistoricalDose(
      fd({ id: itemId, dose_id: doseId, date, time: "08:00" })
    );
    const logId = getIntakeDoseHistory(profile.id, itemId, "0001-01-01")[0].id;

    const other = seedActor();
    const foreign = seedSupplement(other.profile.id);
    expect(
      await updateHistoricalDose(
        fd({ id: foreign.itemId, log_id: logId, date, time: "09:00" })
      )
    ).toEqual({
      ok: false,
      error: "That dose is no longer available. Refresh and try again.",
    });
  });

  it("refuses a read-only acting session", async () => {
    const login = createLogin({});
    const profile = createProfile(`sdh-ro2-${++unique}`, login.id);
    const { itemId, doseId } = seedSupplement(profile.id);
    const date = shiftDateStr(today(profile.id), -3);
    actAs(login, profile, "write");
    await logHistoricalDose(
      fd({ id: itemId, dose_id: doseId, date, time: "08:00", amount: "15 mg" })
    );
    const logId = getIntakeDoseHistory(profile.id, itemId, "0001-01-01")[0].id;

    actAs(login, profile, "read");
    await expect(
      updateHistoricalDose(
        fd({ id: itemId, log_id: logId, date, time: "22:00", amount: "99 mg" })
      )
    ).rejects.toThrow();
    expect(
      getIntakeDoseHistory(profile.id, itemId, "0001-01-01")[0].amount
    ).toBe("15 mg");
  });
});

describe("deleteAdministration action — supplements", () => {
  it("removes a supplement's dose log, hands back an undo token, and audits it", async () => {
    const { profile } = seedActor();
    const { itemId, doseId } = seedSupplement(profile.id);
    const date = shiftDateStr(today(profile.id), -7);
    await logHistoricalDose(
      fd({ id: itemId, dose_id: doseId, date, time: "08:00" })
    );
    const logId = getIntakeDoseHistory(profile.id, itemId, "0001-01-01")[0].id;

    const result = await deleteAdministration(fd({ log_id: logId }));
    expect(typeof result.undoId).toBe("number");
    expect(getIntakeDoseHistory(profile.id, itemId, "0001-01-01")).toEqual([]);
    expect(auditRows(profile.id).at(-1)).toEqual({
      action: AUDIT_ACTIONS.doseLogDelete,
      target: String(itemId),
      detail: date,
    });
  });

  it("offers no undo — and writes no audit row — for a log that isn't the profile's", async () => {
    const owner = seedActor();
    const { itemId, doseId } = seedSupplement(owner.profile.id);
    const date = shiftDateStr(today(owner.profile.id), -4);
    await logHistoricalDose(
      fd({ id: itemId, dose_id: doseId, date, time: "08:00" })
    );
    const logId = getIntakeDoseHistory(
      owner.profile.id,
      itemId,
      "0001-01-01"
    )[0].id;

    const stranger = seedActor();
    expect(await deleteAdministration(fd({ log_id: logId }))).toEqual({
      undoId: null,
    });
    expect(auditRows(stranger.profile.id)).toEqual([]);
    // The owner's row is untouched.
    expect(
      getIntakeDoseHistory(owner.profile.id, itemId, "0001-01-01")
    ).toHaveLength(1);
  });

  it("refuses a read-only acting session", async () => {
    const login = createLogin({});
    const profile = createProfile(`sdh-ro3-${++unique}`, login.id);
    const { itemId, doseId } = seedSupplement(profile.id);
    const date = shiftDateStr(today(profile.id), -3);
    actAs(login, profile, "write");
    await logHistoricalDose(
      fd({ id: itemId, dose_id: doseId, date, time: "08:00" })
    );
    const logId = getIntakeDoseHistory(profile.id, itemId, "0001-01-01")[0].id;

    actAs(login, profile, "read");
    await expect(deleteAdministration(fd({ log_id: logId }))).rejects.toThrow();
    expect(getIntakeDoseHistory(profile.id, itemId, "0001-01-01")).toHaveLength(
      1
    );
  });
});
