// DB INTEGRATION TIER — historical dose correction for SUPPLEMENTS (#1933).
//
// The write cores were kind-gated: `s.kind = 'medication'` on the backfill and the
// delete, `s.obligation = 'may'` on the amend. Supplements therefore had no backfill,
// no correction, and no delete — and the refusal LIED about why, answering `stale-dose`
// ("that dose doesn't exist") to a dose that plainly did.
//
// These cases pin the ungated behavior against a real SQLite handle, because every
// claim in the issue is a claim about rows: which row moved, which counter changed,
// which marker got stamped, and which rows did NOT change. Telegram is exercised
// through the same fetch seam notify-orchestrators.test.ts uses (a real channel, a
// stubbed network), so "sends nothing" is observed rather than asserted about a plan.
// Every value here is synthetic.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  createSharedSupply,
  deleteAdministrationLog,
  getIntakeDoseHistory,
  getIntakeDoseHistoryForItems,
  linkItemToPool,
  logHistoricalDose,
  markDoseTaken,
  restoreAdministrationLog,
  updateAdministrationLog,
  updateHistoricalDose,
} from "@/lib/queries";
import {
  getNotifySchedule,
  getProfileSetting,
  setProfileSetting,
  setTelegramBotConfig,
} from "@/lib/settings";
import { runEscalations } from "@/lib/notifications/escalate";
import { escalationMarkerKey } from "@/lib/notifications/escalation-keys";
import { seedLoginTelegram } from "./fixtures";

let unique = 0;

function newProfile(): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`sdh${++unique}`)
      .lastInsertRowid
  );
}

// A scheduled daily supplement with one morning dose and tracked supply.
function seedSupplement(
  profileId: number,
  opts: { onHand?: number | null; qtyPerDose?: number; critical?: 0 | 1 } = {}
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation,
            quantity_on_hand, qty_per_dose, critical)
         VALUES (?, ?, 1, 'supplement', 'daily', 'must', ?, ?, ?)`
      )
      .run(
        profileId,
        `Magnesium ${++unique}`,
        opts.onHand === undefined ? 10 : opts.onHand,
        opts.qtyPerDose ?? 1,
        opts.critical ?? 0
      ).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '400 mg', 'morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

function onHand(itemId: number): number | null {
  return (
    db
      .prepare("SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?")
      .get(itemId) as { q: number | null }
  ).q;
}

function poolOnHand(supplyId: number): number | null {
  return (
    db
      .prepare("SELECT quantity_on_hand AS q FROM shared_supplies WHERE id = ?")
      .get(supplyId) as { q: number | null }
  ).q;
}

// Every column of the dose SCHEDULE row, so a test can assert an edit left it alone.
function doseRow(doseId: number): Record<string, unknown> {
  return db
    .prepare("SELECT * FROM intake_item_doses WHERE id = ?")
    .get(doseId) as Record<string, unknown>;
}

// A profile-local instant: `date` at `hh:mm` UTC. Every profile here uses the default
// timezone, so the wall time and the stored UTC agree.
function at(date: string, hhmm: string): Date {
  return new Date(`${date}T${hhmm}:00.000Z`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("supplement dose history — the ungated shared cores", () => {
  it("backfills, amends, deletes, and restores one supplement's dose log", () => {
    const p = newProfile();
    const { itemId, doseId } = seedSupplement(p);
    const date = shiftDateStr(today(p), -10);

    // BACKFILL. Before #1933 this answered `stale-dose` for every supplement.
    const logged = logHistoricalDose(
      p,
      itemId,
      doseId,
      at(date, "08:30"),
      "800 mg",
      true
    );
    expect(logged).toEqual({ kind: "logged", date });

    // The amount is SNAPSHOTTED onto the row exactly as a live confirm snapshots it.
    const history = getIntakeDoseHistory(p, itemId, "0001-01-01");
    expect(history).toHaveLength(1);
    expect(history[0].amount).toBe("800 mg");
    expect(history[0].date).toBe(date);
    const logId = history[0].id;

    // AMEND: a new wall time and a corrected amount, same day.
    expect(
      updateHistoricalDose(p, itemId, logId, at(date, "21:15"), "400 mg")
    ).toEqual({ kind: "logged", date });
    const amended = getIntakeDoseHistory(p, itemId, "0001-01-01")[0];
    expect(amended.amount).toBe("400 mg");
    expect(amended.given_at).toContain("21:15");

    // DELETE with undo, then RESTORE — the row comes back with a new id.
    const removed = deleteAdministrationLog(p, logId);
    expect(removed?.itemId).toBe(itemId);
    expect(removed?.date).toBe(date);
    expect(getIntakeDoseHistory(p, itemId, "0001-01-01")).toHaveLength(0);

    expect(restoreAdministrationLog(p, removed!.undoId)).toBe(true);
    const restored = getIntakeDoseHistory(p, itemId, "0001-01-01");
    expect(restored).toHaveLength(1);
    expect(restored[0].amount).toBe("400 mg");
    expect(restored[0].id).not.toBe(logId);
  });

  it("a genuinely missing dose still reports stale — the refusal stopped lying", () => {
    const p = newProfile();
    const { itemId } = seedSupplement(p);
    const date = shiftDateStr(today(p), -3);
    // A dose id that belongs to nothing.
    expect(
      logHistoricalDose(p, itemId, 999_999, at(date, "09:00"), null, false)
    ).toEqual({ kind: "stale-dose" });

    // And another profile's dose is still invisible to this one.
    const other = newProfile();
    const foreign = seedSupplement(other);
    expect(
      logHistoricalDose(
        p,
        foreign.itemId,
        foreign.doseId,
        at(date, "09:00"),
        null,
        false
      )
    ).toEqual({ kind: "stale-dose" });
  });

  it("supply decrements on backfill and is credited back on delete", () => {
    const p = newProfile();
    const { itemId, doseId } = seedSupplement(p, { onHand: 10, qtyPerDose: 2 });
    const date = shiftDateStr(today(p), -2);

    expect(
      logHistoricalDose(p, itemId, doseId, at(date, "07:00"), null, true)
    ).toEqual({ kind: "logged", date });
    expect(onHand(itemId)).toBe(8);

    const logId = getIntakeDoseHistory(p, itemId, "0001-01-01")[0].id;
    const removed = deleteAdministrationLog(p, logId);
    expect(onHand(itemId)).toBe(10);

    // Restore re-applies the exact same movement — the two are inverses.
    expect(restoreAdministrationLog(p, removed!.undoId)).toBe(true);
    expect(onHand(itemId)).toBe(8);
  });

  it("a backfill logged WITHOUT a supply adjustment gives nothing back on delete", () => {
    const p = newProfile();
    const { itemId, doseId } = seedSupplement(p, { onHand: 10 });
    const date = shiftDateStr(today(p), -2);
    logHistoricalDose(p, itemId, doseId, at(date, "07:00"), null, false);
    expect(onHand(itemId)).toBe(10);

    const logId = getIntakeDoseHistory(p, itemId, "0001-01-01")[0].id;
    deleteAdministrationLog(p, logId);
    // The row never took a unit, so removing it must not INVENT one.
    expect(onHand(itemId)).toBe(10);
  });

  it("an amount edit re-diffs supply exactly once", () => {
    const p = newProfile();
    const { itemId, doseId } = seedSupplement(p, { onHand: 10 });
    const date = shiftDateStr(today(p), -4);
    logHistoricalDose(p, itemId, doseId, at(date, "08:00"), "400 mg", true);
    expect(onHand(itemId)).toBe(9);

    const logId = getIntakeDoseHistory(p, itemId, "0001-01-01")[0].id;
    // Three separate amendments — of the amount, of the time, and of both. The
    // counter moves in UNITS and this is still one administration, so the diff each
    // amendment applies is zero: total movement stays the ONE the backfill made,
    // never a second (last-write-wins would re-apply it) and never a rollback.
    updateHistoricalDose(p, itemId, logId, at(date, "08:00"), "800 mg");
    expect(onHand(itemId)).toBe(9);
    updateHistoricalDose(p, itemId, logId, at(date, "19:45"), "800 mg");
    expect(onHand(itemId)).toBe(9);
    updateHistoricalDose(p, itemId, logId, at(date, "06:05"), "200 mg");
    expect(onHand(itemId)).toBe(9);

    // …and the one movement is still fully reversible afterwards.
    deleteAdministrationLog(p, logId);
    expect(onHand(itemId)).toBe(10);
  });

  it("a pooled supplement moves the household bottle, not a private counter", () => {
    const p = newProfile();
    const { itemId, doseId } = seedSupplement(p, { onHand: 12, qtyPerDose: 3 });
    const supplyId = createSharedSupply(
      {
        name: `Bottle ${++unique}`,
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      60
    );
    linkItemToPool(p, itemId, supplyId);
    // Linking hands the item's own count to the pool; the item keeps none.
    expect(onHand(itemId)).toBeNull();

    const before = poolOnHand(supplyId)!;
    const date = shiftDateStr(today(p), -1);
    logHistoricalDose(p, itemId, doseId, at(date, "08:00"), null, true);
    expect(poolOnHand(supplyId)).toBe(before - 3);
    expect(onHand(itemId)).toBeNull();

    const logId = getIntakeDoseHistory(p, itemId, "0001-01-01")[0].id;
    deleteAdministrationLog(p, logId);
    expect(poolOnHand(supplyId)).toBe(before);
    expect(onHand(itemId)).toBeNull();
  });

  it("editing a log whose dose is retired — or whose item is paused — succeeds", () => {
    const p = newProfile();
    const { itemId, doseId } = seedSupplement(p);
    const date = shiftDateStr(today(p), -6);
    logHistoricalDose(p, itemId, doseId, at(date, "08:00"), "400 mg", false);
    const logId = getIntakeDoseHistory(p, itemId, "0001-01-01")[0].id;

    // The schedule is retired and the item paused AFTER the dose was really taken.
    db.prepare("UPDATE intake_item_doses SET retired = 1 WHERE id = ?").run(
      doseId
    );
    db.prepare("UPDATE intake_items SET active = 0 WHERE id = ?").run(itemId);

    expect(
      updateHistoricalDose(p, itemId, logId, at(date, "12:30"), "600 mg")
    ).toEqual({ kind: "logged", date });
    expect(getIntakeDoseHistory(p, itemId, "0001-01-01")[0].amount).toBe(
      "600 mg"
    );
    // Removing it is allowed for the same reason: the row is history, not schedule.
    expect(deleteAdministrationLog(p, logId)).not.toBeNull();

    // Creating a NEW backfill against the retired dose is still refused — that one
    // asks to put a dose back on the schedule.
    expect(
      logHistoricalDose(p, itemId, doseId, at(date, "08:00"), null, false)
    ).toEqual({ kind: "stale-dose" });
  });

  it("no log edit ever writes the dose schedule", () => {
    const p = newProfile();
    const { itemId, doseId } = seedSupplement(p);
    const before = doseRow(doseId);
    const date = shiftDateStr(today(p), -5);

    logHistoricalDose(p, itemId, doseId, at(date, "08:00"), "999 mg", true);
    expect(doseRow(doseId)).toEqual(before);

    const logId = getIntakeDoseHistory(p, itemId, "0001-01-01")[0].id;
    updateHistoricalDose(p, itemId, logId, at(date, "22:00"), "111 mg");
    expect(doseRow(doseId)).toEqual(before);

    updateAdministrationLog(p, logId, date, at(date, "23:30"), "222 mg");
    expect(doseRow(doseId)).toEqual(before);

    const removed = deleteAdministrationLog(p, logId);
    expect(doseRow(doseId)).toEqual(before);
    restoreAdministrationLog(p, removed!.undoId);
    expect(doseRow(doseId)).toEqual(before);
  });

  it("updateAdministrationLog no longer refuses a scheduled (non-`may`) item", () => {
    const p = newProfile();
    const { itemId, doseId } = seedSupplement(p);
    const date = shiftDateStr(today(p), -2);
    logHistoricalDose(p, itemId, doseId, at(date, "08:00"), "400 mg", false);
    const logId = getIntakeDoseHistory(p, itemId, "0001-01-01")[0].id;

    expect(
      updateAdministrationLog(p, logId, date, at(date, "17:00"), "450 mg")
    ).toBe(true);
    const row = getIntakeDoseHistory(p, itemId, "0001-01-01")[0];
    expect(row.amount).toBe("450 mg");
    expect(row.given_at).toContain("17:00");
  });

  it("batches recent history for many items in one read", () => {
    const p = newProfile();
    const a = seedSupplement(p);
    const b = seedSupplement(p);
    const inWindow = shiftDateStr(today(p), -3);
    const tooOld = shiftDateStr(today(p), -60);
    logHistoricalDose(
      p,
      a.itemId,
      a.doseId,
      at(inWindow, "08:00"),
      null,
      false
    );
    logHistoricalDose(
      p,
      b.itemId,
      b.doseId,
      at(inWindow, "09:00"),
      null,
      false
    );
    logHistoricalDose(p, b.itemId, b.doseId, at(tooOld, "09:00"), null, false);

    const since = shiftDateStr(today(p), -30);
    const map = getIntakeDoseHistoryForItems(p, [a.itemId, b.itemId], since);
    expect(map.get(a.itemId)).toHaveLength(1);
    expect(map.get(b.itemId)).toHaveLength(1);
    expect(map.get(b.itemId)![0].date).toBe(inWindow);
    expect(getIntakeDoseHistoryForItems(p, [], since).size).toBe(0);
  });
});

describe("a retroactive un-mark never re-arms an escalation", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM notify_lifecycle").run();
  });

  // A critical `must` supplement whose Morning reminder went out today: the exact
  // shape runEscalations chases. Returns everything the assertions need.
  function escalationFixture(): {
    profileId: number;
    itemId: number;
    doseId: number;
    date: string;
  } {
    const profileId = newProfile();
    const { itemId, doseId } = seedSupplement(profileId, { critical: 1 });
    const date = today(profileId);
    setProfileSetting(profileId, "notify_last_supp_Morning", date);
    setTelegramBotConfig({
      telegramBotToken: "rearm-test-token",
      telegramMode: "poll",
    });
    seedLoginTelegram(profileId, `5550${++unique}`);
    return { profileId, itemId, doseId, date };
  }

  function stubFetch(): ReturnType<typeof vi.fn> {
    const mock = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 1 } })
    );
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  // Morning slot hour 8 + the 120-minute default wait → anything from 10:00 escalates.
  const LATE_HOUR = 12;

  it("the fixture really does escalate when the dose is simply unconfirmed", async () => {
    const { profileId, doseId, date } = escalationFixture();
    const fetchMock = stubFetch();

    const res = await runEscalations(
      profileId,
      "Rearm",
      date,
      LATE_HOUR,
      getNotifySchedule(profileId)
    );
    expect(res.failed).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
    expect(getProfileSetting(profileId, escalationMarkerKey(doseId))).toBe(
      date
    );
  });

  it("deleting today's dose log sends nothing", async () => {
    const { profileId, itemId, doseId, date } = escalationFixture();
    // The dose WAS taken and confirmed today, so nothing was ever chased.
    expect(markDoseTaken(profileId, doseId, itemId, date)).toBe("logged");
    const logId = getIntakeDoseHistory(profileId, itemId, "0001-01-01")[0].id;

    // The user removes the entry — a bookkeeping correction, not a request to be
    // chased. The dose is now unconfirmed for today.
    expect(deleteAdministrationLog(profileId, logId)).not.toBeNull();
    expect(getProfileSetting(profileId, escalationMarkerKey(doseId))).toBe(
      date
    );

    const fetchMock = stubFetch();
    const res = await runEscalations(
      profileId,
      "Rearm",
      date,
      LATE_HOUR,
      getNotifySchedule(profileId)
    );
    expect(res.failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("moving today's dose log onto another date sends nothing", async () => {
    const { profileId, itemId, doseId, date } = escalationFixture();
    expect(markDoseTaken(profileId, doseId, itemId, date)).toBe("logged");
    const logId = getIntakeDoseHistory(profileId, itemId, "0001-01-01")[0].id;

    const earlier = shiftDateStr(date, -2);
    expect(
      updateHistoricalDose(profileId, itemId, logId, at(earlier, "08:00"), null)
    ).toEqual({ kind: "logged", date: earlier });
    expect(getProfileSetting(profileId, escalationMarkerKey(doseId))).toBe(
      date
    );

    const fetchMock = stubFetch();
    await runEscalations(
      profileId,
      "Rearm",
      date,
      LATE_HOUR,
      getNotifySchedule(profileId)
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an amendment that stays on the same day leaves the marker alone", () => {
    const { profileId, itemId, doseId, date } = escalationFixture();
    expect(markDoseTaken(profileId, doseId, itemId, date)).toBe("logged");
    const logId = getIntakeDoseHistory(profileId, itemId, "0001-01-01")[0].id;

    // Nothing was un-marked, so nothing is suppressed: the dose is still confirmed
    // today, and a marker stamped here would silence a LATER genuine miss.
    updateHistoricalDose(profileId, itemId, logId, at(date, "09:30"), "500 mg");
    expect(
      getProfileSetting(profileId, escalationMarkerKey(doseId))
    ).toBeUndefined();
  });

  it("suppression is per-DATE: an older correction can't silence today", async () => {
    const { profileId, itemId, doseId, date } = escalationFixture();
    const threeDaysAgo = shiftDateStr(date, -3);
    logHistoricalDose(
      profileId,
      itemId,
      doseId,
      at(threeDaysAgo, "08:00"),
      null,
      false
    );
    const logId = getIntakeDoseHistory(profileId, itemId, "0001-01-01")[0].id;
    deleteAdministrationLog(profileId, logId);
    expect(getProfileSetting(profileId, escalationMarkerKey(doseId))).toBe(
      threeDaysAgo
    );

    // Today's dose is genuinely unconfirmed and genuinely missed — the marker names
    // another day, so the chase still happens. The rule only ever reduces contact for
    // the ONE day a correction vacated.
    const fetchMock = stubFetch();
    await runEscalations(
      profileId,
      "Rearm",
      date,
      LATE_HOUR,
      getNotifySchedule(profileId)
    );
    expect(fetchMock).toHaveBeenCalled();
  });
});
