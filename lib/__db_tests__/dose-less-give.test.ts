// DB INTEGRATION TIER — the Give door on a medication that has NO dose row (#5981).
//
// The item the "Also for" copy lands when no amount can be derived: active, PRN,
// and with zero `intake_item_doses` rows. The quick-log gather still offers it, so
// the panel draws a live Give chip; before this change the only thing that chip
// could produce was "may have been removed".
//
// This tier is where the whole write is visible: the first dose row and the
// administration are one transaction, so "exactly one row each, or neither" is a
// statement about the database rather than about a return value.

import { describe, it, expect, vi } from "vitest";
import { db, writeTx } from "@/lib/db";
import { createIntakeItemCore } from "@/lib/intake-item-create";
import { alsoForDoseSeeds } from "@/lib/intake-also-for";
import { logAdministration, getPrnMedicationsForQuickLog } from "@/lib/queries";
import { prnRowStatus } from "@/lib/redose-format";

// The item as the copy writes it when the label chart refused an amount: PRN,
// active, and dose-less. `doses: []` is exactly what `lib/queries/intake/also-for.ts`
// passes `createIntakeItemCore` on that path — see the seeds assertion below.
function seedDoseLessPrnMed(): { profileId: number; itemId: number } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Dose-less fixture')").run()
      .lastInsertRowid
  );
  const created = writeTx(() =>
    createIntakeItemCore(profileId, {
      name: "Acetaminophen - Kids",
      kind: "medication",
      provenance: { source: "manual" },
      obligation: "may",
      condition: "daily",
      product: "Children's oral suspension (160 mg / 5 mL)",
      doses: [],
      course: { kind: "open", startedOn: null },
    })
  );
  if (!created.ok) throw new Error(created.error);
  return { profileId, itemId: created.id };
}

// The same seed at any other kind/obligation, which is what the #5983 falsifying
// pass hand-crafted a post for. `food` is not an `IntakeItemKind` the item form can
// write, so it is set on the column the way that post reached it.
function seedDoseLessItem(
  kind: string,
  obligation: "may" | "must"
): {
  profileId: number;
  itemId: number;
} {
  const { profileId, itemId } = seedDoseLessPrnMed();
  db.prepare(
    "UPDATE intake_items SET kind = ?, obligation = ? WHERE id = ?"
  ).run(kind, obligation, itemId);
  return { profileId, itemId };
}

function doseRows(itemId: number): { id: number; amount: string | null }[] {
  return db
    .prepare(
      "SELECT id, amount FROM intake_item_doses WHERE item_id = ? ORDER BY id"
    )
    .all(itemId) as { id: number; amount: string | null }[];
}

function adminRows(
  itemId: number
): { dose_id: number; amount: string | null; status: string }[] {
  return db
    .prepare(
      "SELECT dose_id, amount, status FROM intake_item_logs WHERE item_id = ? ORDER BY id"
    )
    .all(itemId) as {
    dose_id: number;
    amount: string | null;
    status: string;
  }[];
}

describe("a PRN medication with no dose row (#5981)", () => {
  it("the copy's seeds are empty when no amount was derived, and the item lands dose-less", () => {
    // The premise the issue rests on, asked of the code rather than taken on trust.
    expect(
      alsoForDoseSeeds(
        [
          {
            amount: "400 mg",
            time_of_day: null,
            food_timing: "any",
            weekdays: null,
            start_date: null,
            end_date: null,
          },
        ],
        { kind: "none", reason: "Recorded weight is 22 lb." },
        "2026-09-18"
      )
    ).toEqual([]);
    const { profileId, itemId } = seedDoseLessPrnMed();
    expect(doseRows(itemId)).toEqual([]);
    // And the gather still offers it, which is what draws the live Give chip. It
    // states no amount at all — the fact the panel reads to ask for one.
    const offered = getPrnMedicationsForQuickLog(profileId).find(
      (m) => m.id === itemId
    );
    expect(offered).toBeDefined();
    expect("amount" in offered! && offered!.amount).toBe(undefined);
  });

  // THE REPRODUCTION, TURNED GREEN. On the base commit this is `stale-item` with
  // nothing written — the whole defect, in the tier where the write lives.
  it("the first Give borns the dose row and logs the administration together", () => {
    const { profileId, itemId } = seedDoseLessPrnMed();
    const outcome = logAdministration(
      profileId,
      itemId,
      "page",
      undefined,
      null,
      "160 mg"
    );
    expect(outcome).toMatchObject({ kind: "logged", count: 1 });
    // EXACTLY ONE OF EACH. The row is the item form's PRN row: an amount, no time of
    // day, no calendar — and not retired.
    expect(doseRows(itemId)).toEqual([
      { id: expect.any(Number), amount: "160 mg" },
    ]);
    const [row] = db
      .prepare(
        `SELECT time_of_day, food_timing, weekdays, start_date, end_date,
                retired, created_at
           FROM intake_item_doses WHERE item_id = ?`
      )
      .all(itemId) as Record<string, unknown>[];
    expect(row).toMatchObject({
      time_of_day: null,
      food_timing: "any",
      weekdays: null,
      start_date: null,
      end_date: null,
      retired: 0,
    });
    // Born properly (#430/#1973): stamped, and carrying its first schedule version,
    // because it went through the same insert the item form uses.
    expect(row!.created_at).toBeTruthy();
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM intake_dose_schedule_versions v
               JOIN intake_item_doses d ON d.id = v.dose_id
              WHERE d.item_id = ?`
          )
          .get(itemId) as { c: number }
      ).c
    ).toBe(1);
    const logs = adminRows(itemId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ amount: "160 mg", status: "taken" });
    expect(logs[0]!.dose_id).toBe(doseRows(itemId)[0]!.id);
  });

  it("a second Give logs against the row the first one borned", () => {
    const { profileId, itemId } = seedDoseLessPrnMed();
    logAdministration(profileId, itemId, "page", undefined, null, "160 mg");
    // A second tap well outside the double-tap window, from a panel that no longer
    // asks — so no amount rides along. The clock moves BACKWARD rather than forward
    // because this tier freezes at 23:50 UTC, and a forward step would file the two
    // administrations under different profile-local days.
    vi.setSystemTime(new Date(Date.now() - 2 * 3600_000));
    expect(logAdministration(profileId, itemId, "page").kind).toBe("logged");
    expect(doseRows(itemId)).toHaveLength(1);
    expect(adminRows(itemId)).toHaveLength(2);
  });

  // An amount posted onto an item that grew a dose row under the open panel writes no
  // second schedule: the administration lands against the row that exists.
  it("spends the posted amount only on an item that still has no row", () => {
    const { profileId, itemId } = seedDoseLessPrnMed();
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '400 mg', NULL, 'any', 0)`
    ).run(itemId);
    expect(
      logAdministration(profileId, itemId, "page", undefined, null, "160 mg")
        .kind
    ).toBe("logged");
    expect(doseRows(itemId).map((d) => d.amount)).toEqual(["400 mg"]);
    expect(adminRows(itemId)[0]).toMatchObject({ amount: "400 mg" });
  });

  it("a refused time creates NEITHER the row nor the administration", () => {
    const { profileId, itemId } = seedDoseLessPrnMed();
    expect(
      logAdministration(
        profileId,
        itemId,
        "page",
        new Date(Date.now() + 26 * 3600_000),
        null,
        "160 mg"
      ).kind
    ).toBe("invalid-time");
    expect(doseRows(itemId)).toEqual([]);
    expect(adminRows(itemId)).toEqual([]);
  });

  it("a door that states no amount answers needs-dose, not a deletion", () => {
    const { profileId, itemId } = seedDoseLessPrnMed();
    expect(logAdministration(profileId, itemId, "page").kind).toBe(
      "needs-dose"
    );
    expect(doseRows(itemId)).toEqual([]);
    expect(adminRows(itemId)).toEqual([]);
  });

  it("still answers stale-item for an item that is genuinely gone", () => {
    const { profileId, itemId } = seedDoseLessPrnMed();
    db.prepare("DELETE FROM intake_items WHERE id = ?").run(itemId);
    expect(
      logAdministration(profileId, itemId, "page", undefined, null, "160 mg")
        .kind
    ).toBe("stale-item");
    // …and for another profile's item, which is the other half of "isn't yours".
    const { itemId: theirs } = seedDoseLessPrnMed();
    expect(
      logAdministration(profileId, theirs, "page", undefined, null, "160 mg")
        .kind
    ).toBe("stale-item");
    expect(doseRows(theirs)).toEqual([]);
  });

  it("refuses a paused dose-less item without writing a row", () => {
    const { profileId, itemId } = seedDoseLessPrnMed();
    db.prepare("UPDATE intake_items SET active = 0 WHERE id = ?").run(itemId);
    expect(
      logAdministration(profileId, itemId, "page", undefined, null, "160 mg")
        .kind
    ).toBe("inactive");
    expect(doseRows(itemId)).toEqual([]);
  });

  // THE BOUNDARY THE ARMING MATH MIGHT NOT HAVE BEEN WRITTEN FOR: the item's
  // first-ever dose row and first-ever administration, arriving together. The chip
  // that renders next is an ordinary PRN chip — the amount is its payload — and the
  // redose line counts the dose that just landed.
  it("renders as an ordinary PRN chip afterwards, with the redose line counting it", () => {
    const { profileId, itemId } = seedDoseLessPrnMed();
    db.prepare(
      "UPDATE intake_items SET min_interval_hours = 4, max_daily_count = 5 WHERE id = ?"
    ).run(itemId);
    logAdministration(profileId, itemId, "page", undefined, null, "160 mg");
    const med = getPrnMedicationsForQuickLog(profileId).find(
      (m) => m.id === itemId
    )!;
    expect(med.amount).toBe("160 mg");
    expect(med.count).toBe(1);
    expect(med.familyCount).toBe(1);
    expect(med.familyArming.kind).toBe("placed");
    const status = prnRowStatus(med, "UTC", new Date());
    expect(status.redoseLine).toContain("1 of 5");
  });
});

// THE DOOR IS NO WIDER THAN THE OFFER (#5985). #5981's write path asked whether the
// item had a dose row, never what kind of thing it was borning one on, so a
// hand-crafted post naming any dose-less item this login may already write borned a
// dose row on it. On the base commit each case below answered
// `{kind:"logged",count:1}` with one dose row of "160 mg" and one administration.
describe("borning a first dose row is scoped to as-needed medications (#5985)", () => {
  const refused: [string, string, "may" | "must"][] = [
    ["a food item", "food", "may"],
    ["a supplement", "supplement", "may"],
    ["a scheduled (must) medication", "medication", "must"],
  ];
  it.each(refused)(
    "%s writes neither a dose row nor an administration",
    (_label, kind, obligation) => {
      const { profileId, itemId } = seedDoseLessItem(kind, obligation);
      expect(
        logAdministration(profileId, itemId, "page", undefined, null, "160 mg")
          .kind
      ).toBe("not-prn-medication");
      expect(doseRows(itemId)).toEqual([]);
      expect(adminRows(itemId)).toEqual([]);
    }
  );

  // The refusal is about the AMOUNT this door may spend, not about logging: a post
  // that states no amount still gets the answer it got before, for every kind.
  it("a door that states no amount still answers needs-dose on a refused kind", () => {
    const { profileId, itemId } = seedDoseLessItem("supplement", "may");
    expect(logAdministration(profileId, itemId, "page").kind).toBe(
      "needs-dose"
    );
    expect(doseRows(itemId)).toEqual([]);
  });

  // …and a refused kind that HAS a dose row is untouched: kind-neutral logging
  // against an existing row is #797's behaviour and not what this scoping is about.
  it("logs against an existing row on a refused kind", () => {
    const { profileId, itemId } = seedDoseLessItem("supplement", "may");
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '400 mg', NULL, 'any', 0)`
    ).run(itemId);
    expect(
      logAdministration(profileId, itemId, "page", undefined, null, "160 mg")
        .kind
    ).toBe("logged");
    expect(doseRows(itemId).map((d) => d.amount)).toEqual(["400 mg"]);
  });
});
