// SERVER-ACTION TIER — the PRN quick-log write path (logMedicationAdministration,
// #797). Drives the real Server Action (its auth gate + offset parsing) against the
// in-memory DB, mirroring the harness auth mock. Covers: a "now" log, the custom
// same-day time path (the shared when-control's wire, #2236 — the relative 30m/1h
// offsets are retired), the double-tap dedup, and the invalid-custom-time /
// stale-item error returns. The core's own semantics (multiples, supply, window
// guard) are pinned in the DB tier; this tier proves the ACTION wires the offset →
// recorded_at → core correctly and returns the right FormResult.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { shiftDateStr, zonedWallTimeToUtc } from "@/lib/date";
import { getTimezone, setProfileBirthdate } from "@/lib/settings";
import { logHistoricalDose } from "@/lib/queries";
import { logMedicationAdministration } from "@/app/(app)/medications/actions";
import { seedActor, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => {
  revalidate.mockClear();
});

// A PRN medication (as_needed=1) with one dose + tracked supply, owned by `profileId`.
function seedPrnMed(
  profileId: number,
  amount = "400 mg",
  quantityOnHand = 10
): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, quantity_on_hand, qty_per_dose)
         VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'may', ?, 1)`
      )
      .run(profileId, quantityOnHand).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, ?, 'any', 'any', 0)`
  ).run(itemId, amount);
  return itemId;
}

function adminRows(itemId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM intake_item_logs WHERE item_id = ? AND status = 'taken'"
      )
      .get(itemId) as { c: number }
  ).c;
}

function onHand(itemId: number): number | null {
  return (
    db
      .prepare("SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?")
      .get(itemId) as { q: number | null }
  ).q;
}

/** The recorded amount on this item's most recent administration. */
function loggedAmount(itemId: number): string | null {
  return (
    db
      .prepare(
        "SELECT amount FROM intake_item_logs WHERE item_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(itemId) as { amount: string | null }
  ).amount;
}

/** A child of `ageMonths` with one recorded weight on `date`. */
function seedChild(
  profileId: number,
  ageMonths: number,
  kg: number,
  date: string
) {
  const birth = new Date(`${date}T00:00:00Z`);
  birth.setUTCMonth(birth.getUTCMonth() - ageMonths);
  setProfileBirthdate(profileId, birth.toISOString().slice(0, 10));
  db.prepare(
    "INSERT INTO body_metrics (profile_id, date, weight_kg, source) VALUES (?, ?, ?, 'manual')"
  ).run(profileId, date, kg);
}

describe("logMedicationAdministration action (#797)", () => {
  it("logs a 'now' administration, decrements supply, and revalidates", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id);
    const res = await logMedicationAdministration(
      fd({ id: itemId, offset: "now" })
    );
    expect(res).toEqual({ ok: true, outcome: "logged" });
    expect(adminRows(itemId)).toBe(1);
    expect(onHand(itemId)).toBe(9);
    expect(revalidate).toHaveBeenCalledWith("/medications");
    expect(revalidate).toHaveBeenCalledWith("/");
  });

  it("logs a stated earlier time as a distinct administration (#2236)", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id);
    // Frozen at midday so "now" and the stated 00:01 are hours apart — a real run
    // straddling midnight could otherwise land both inside the dedup window.
    const prev = process.env.ALLOS_TEST_NOW;
    process.env.ALLOS_TEST_NOW = `${today(profile.id)}T12:00:00Z`;
    try {
      expect(
        (await logMedicationAdministration(fd({ id: itemId, offset: "now" })))
          .ok
      ).toBe(true);
      expect(
        (
          await logMedicationAdministration(
            fd({ id: itemId, offset: "custom", time: "00:01" })
          )
        ).ok
      ).toBe(true);
    } finally {
      if (prev == null) delete process.env.ALLOS_TEST_NOW;
      else process.env.ALLOS_TEST_NOW = prev;
    }
    expect(adminRows(itemId)).toBe(2);
    expect(onHand(itemId)).toBe(8);
  });

  it("a legacy relative offset is no vocabulary: it resolves as 'now' (#2236)", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id);
    // The rendered page states absolute times; "30m" no longer names an offset, so
    // a stale client submitting one gets the default "now" semantics — and a second
    // one inside the dedup window collapses instead of minting a back-dated row.
    await logMedicationAdministration(fd({ id: itemId, offset: "now" }));
    const legacy = await logMedicationAdministration(
      fd({ id: itemId, offset: "30m" })
    );
    expect(legacy).toEqual({ ok: true, outcome: "duplicate" });
    expect(adminRows(itemId)).toBe(1);
    expect(onHand(itemId)).toBe(9);
  });

  it("logs a custom same-day time via the wall-time → instant conversion", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id);
    // 00:01 today is always in the past (guard-safe) regardless of when the test runs.
    const res = await logMedicationAdministration(
      fd({ id: itemId, offset: "custom", time: "00:01" })
    );
    expect(res.ok).toBe(true);
    const row = db
      .prepare(
        "SELECT occurred_at FROM intake_item_logs WHERE item_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(itemId) as { occurred_at: string };
    // Stored as a canonical UTC instant (not the raw wall string).
    expect(row.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("rejects a malformed custom time without writing", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id);
    const res = await logMedicationAdministration(
      fd({ id: itemId, offset: "custom", time: "not-a-time" })
    );
    expect(res.ok).toBe(false);
    expect(adminRows(itemId)).toBe(0);
  });

  it("collapses an immediate double-submit (now) to one administration", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id);
    // Two "now" submits in quick succession are within the dedup window.
    await logMedicationAdministration(fd({ id: itemId, offset: "now" }));
    const second = await logMedicationAdministration(
      fd({ id: itemId, offset: "now" })
    );
    expect(second).toEqual({ ok: true, outcome: "duplicate" });
    expect(adminRows(itemId)).toBe(1);
    expect(onHand(itemId)).toBe(9); // decremented once
  });

  // THE STATEMENT'S DAY REACHES THE WRITE (#4691). The action used to resolve every
  // custom time against `today(profileId)`, so a row rendered under a Yesterday
  // toggle wrote today anyway and no cockpit path could reach last night's dose. The
  // parity assertion is against the DEEP DOOR's own row for the same instant: the
  // clinical content a reader sees — the day, the administration instant, the dose
  // it hangs off and its snapshotted amount — is identical whichever door it came
  // through. (`logged_via` and `supply_adjusted` differ by construction: they RECORD
  // which door and whether the caregiver asked for a supply move.)
  it("writes the stated past day, matching the deep door's row for the same instant", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id);
    const yesterday = shiftDateStr(today(profile.id), -1);
    const res = await logMedicationAdministration(
      fd({ id: itemId, offset: "custom", time: "19:15", date: yesterday })
    );
    expect(res).toEqual({ ok: true, outcome: "logged" });

    const doseId = (
      db
        .prepare("SELECT id FROM intake_item_doses WHERE item_id = ?")
        .get(itemId) as { id: number }
    ).id;
    const viaDeepDoor = logHistoricalDose(
      profile.id,
      itemId,
      doseId,
      zonedWallTimeToUtc(getTimezone(profile.id), yesterday, "15:00")!,
      null,
      false,
      "page"
    );
    expect(viaDeepDoor).toEqual({ kind: "logged", date: yesterday });

    const rows = db
      .prepare(
        `SELECT date, occurred_at, dose_id, amount FROM intake_item_logs
          WHERE item_id = ? AND status = 'taken' ORDER BY id`
      )
      .all(itemId) as {
      date: string;
      occurred_at: string;
      dose_id: number;
      amount: string | null;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows[0].date).toBe(yesterday);
    expect({ ...rows[0], occurred_at: "" }).toEqual({
      ...rows[1],
      occurred_at: "",
    });
    // …and each instant is the minute that was STATED, not a "now" (the two are
    // hours apart so the shared administration dedup window cannot collapse them).
    expect(rows[0].occurred_at).toMatch(/T19:15:00Z$/);
    expect(rows[1].occurred_at).toMatch(/T15:00:00Z$/);
  });

  // THE SCREENSHOT'S CASE (#5489). A dose tapped on a cockpit standing on Yesterday
  // used to post `offset=now` with NO day, and the action stamped the server's today —
  // a wrong-day administration record, and the instant that arms the redose clock and
  // the trailing-24h ceiling. Both arms now state the day, and "now" on a day that has
  // ended has nothing honest to resolve to, so it is refused rather than stamped: the
  // surface asks for the minute instead (#4686).
  it("refuses a 'now' carrying a day that has ended, without writing", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id);
    const res = await logMedicationAdministration(
      fd({
        id: itemId,
        offset: "now",
        date: shiftDateStr(today(profile.id), -1),
      })
    );
    expect(res.ok).toBe(false);
    expect(adminRows(itemId)).toBe(0);
  });

  // …and the SAME tap on the card's own today is the one-tap it always was: the day
  // rides along, and the core still stamps the current instant.
  it("stamps now when the stated day IS today", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id);
    const res = await logMedicationAdministration(
      fd({ id: itemId, offset: "now", date: today(profile.id) })
    );
    expect(res).toEqual({ ok: true, outcome: "logged" });
    expect(adminRows(itemId)).toBe(1);
  });

  it("refuses a day the tap's reach does not cover, without writing", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id);
    const res = await logMedicationAdministration(
      fd({
        id: itemId,
        offset: "custom",
        time: "19:15",
        date: shiftDateStr(today(profile.id), -30),
      })
    );
    expect(res.ok).toBe(false);
    expect(adminRows(itemId)).toBe(0);
  });

  it("returns an error for a missing / other-profile item", async () => {
    const { profile } = seedActor();
    seedPrnMed(profile.id);
    const res = await logMedicationAdministration(
      fd({ id: 999999, offset: "now" })
    );
    expect(res.ok).toBe(false);
  });

  // THE BAND NEVER REACHES THE RECORD (#4713, after the falsifying pass on #5512).
  // The dose row STATES the label band for a child beside the dose; the administration
  // still stores the item's own amount, because `intake_item_doses.amount` records the
  // dose and not its provenance — a lookup cannot tell a stale band figure from a
  // prescriber's, and #798's line 15 forbids applying the band without the confirm
  // that distinction would need. The clinician-set toddler dose is the case to rank
  // on: the ibuprofen chart says 100 mg for 12 kg, and 50 mg is what was prescribed.
  it.each([
    {
      subject: "a clinician-set toddler dose",
      stored: "50 mg",
      ageMonths: 24,
      kg: 12,
    },
    {
      subject: "a teenager's prescribed dose",
      stored: "600 mg",
      ageMonths: 192,
      kg: 60,
    },
    {
      // The issue's own scenario, from the other side: the child has GROWN past the
      // band the item was saved with (20 kg is 44.1 lb, one band up at 150 mg). The
      // row says so; the record still states the dose that was actually given.
      subject: "a dose the child has outgrown",
      stored: "100 mg",
      ageMonths: 72,
      kg: 20,
    },
  ])("records $subject unchanged", async ({ stored, ageMonths, kg }) => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id, stored);
    seedChild(profile.id, ageMonths, kg, today(profile.id));
    expect(
      (await logMedicationAdministration(fd({ id: itemId, offset: "now" }))).ok
    ).toBe(true);
    expect(loggedAmount(itemId)).toBe(stored);
  });

  // THE ADULT PATH IS UNTOUCHED, and it is an acceptance criterion rather than a
  // formality: the same action, the same item, no birthdate — the stored amount.
  it("stores the item's own amount for a profile with no child context", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id);
    expect(
      (await logMedicationAdministration(fd({ id: itemId, offset: "now" }))).ok
    ).toBe(true);
    expect(loggedAmount(itemId)).toBe("400 mg");
  });
});
