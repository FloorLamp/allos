// SERVER-ACTION TIER — the child dose-band update offer (issue #5538).
//
// A growing child crosses a label weight band and the item's STORED dose goes stale:
// the row states the current band while every tap still records the old figure. The
// ruling is to follow the current weight and ASK, on the dose row — accepting rewrites
// the stored amount ONCE so every later tap records the new figure, declining writes no
// health data and no dose amount at all, only the decline itself.
//
// What this tier proves, and why each is here rather than in the DB tier: the two taps
// are the only paths through which either write happens, and the offer's own recurrence
// is part of the behaviour. The ANCHOR is the load-bearing choice — the decline is keyed
// on the band figure it was given for, so the offer comes back when the band moves again
// and stays away while it has not.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { setProfileBirthdate } from "@/lib/settings";
import {
  getPediatricFormContext,
  standingDoseUpdateOffer,
} from "@/lib/queries";
import {
  acceptDoseBandUpdate,
  declineDoseBandUpdate,
  logMedicationAdministration,
} from "@/app/(app)/medications/actions";
import { doseBandUpdateKey } from "@/lib/dismissal-keys";
import { seedActor, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => {
  revalidate.mockClear();
});

// The ibuprofen label chart: 24 lb → 100 mg, 36 lb → 150 mg, 48 lb → 200 mg.
const IN_100_BAND_KG = 11.5; // 25.4 lb
const IN_150_BAND_KG = 17; // 37.5 lb
const IN_200_BAND_KG = 22.5; // 49.6 lb

function seedPrnMed(profileId: number, amount: string): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'may')`
      )
      .run(profileId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, ?, 'any', 'any', 0)`
  ).run(itemId, amount);
  return itemId;
}

/** A six-year-old weighed today at `kg`. */
function seedChild(profileId: number, kg: number): void {
  const date = today(profileId);
  const birth = new Date(`${date}T00:00:00Z`);
  birth.setUTCMonth(birth.getUTCMonth() - 72);
  setProfileBirthdate(profileId, birth.toISOString().slice(0, 10));
  weigh(profileId, kg);
}

function weigh(profileId: number, kg: number): void {
  db.prepare("DELETE FROM body_metrics WHERE profile_id = ?").run(profileId);
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
     VALUES (?, ?, ?, 'manual')`
  ).run(profileId, today(profileId), kg);
}

/** The item's stored dose — the figure every dose surface offers and records. */
function storedAmount(itemId: number): string | null {
  return (
    db
      .prepare(
        `SELECT amount FROM intake_item_doses
          WHERE item_id = ? AND retired = 0 ORDER BY sort, id LIMIT 1`
      )
      .get(itemId) as { amount: string | null }
  ).amount;
}

function suppressionKeys(profileId: number): string[] {
  return (
    db
      .prepare(
        "SELECT signal_key FROM upcoming_dismissals WHERE profile_id = ?"
      )
      .all(profileId) as { signal_key: string }[]
  ).map((r) => r.signal_key);
}

function healthRowCounts(profileId: number, itemId: number) {
  const one = (sql: string, ...args: unknown[]) =>
    (db.prepare(sql).get(...args) as { c: number }).c;
  return {
    administrations: one(
      "SELECT COUNT(*) AS c FROM intake_item_logs WHERE item_id = ?",
      itemId
    ),
    weights: one(
      "SELECT COUNT(*) AS c FROM body_metrics WHERE profile_id = ?",
      profileId
    ),
  };
}

describe("the child dose-band update offer (#5538)", () => {
  it("stands when the current weight's band differs from the stored dose", () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id, "100 mg");
    seedChild(profile.id, IN_150_BAND_KG);
    expect(standingDoseUpdateOffer(profile.id, itemId)).toMatchObject({
      key: doseBandUpdateKey(itemId, 150),
      storedAmount: "100 mg",
      bandAmount: "150 mg",
      question: "Ibuprofen is set to 100 mg. Update it to 150 mg?",
      yes: "Update to 150 mg",
      no: "Keep 100 mg",
    });
  });

  it("stands down when the stored dose already is the band figure", () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id, "100 mg");
    seedChild(profile.id, IN_100_BAND_KG);
    expect(standingDoseUpdateOffer(profile.id, itemId)).toBeNull();
  });

  it("accepting rewrites the item's stored dose to the band figure", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id, "100 mg");
    seedChild(profile.id, IN_150_BAND_KG);

    const res = await acceptDoseBandUpdate(
      fd({ dedupe_key: doseBandUpdateKey(itemId, 150) })
    );

    expect(res.ok).toBe(true);
    expect(storedAmount(itemId)).toBe("150 mg");
    // ONCE, AND EVERY LATER TAP RECORDS IT: the offer is spent because the stored dose
    // and the band now agree, and the administration path — untouched by this issue —
    // writes the item's stored amount, which is now the current band's.
    expect(standingDoseUpdateOffer(profile.id, itemId)).toBeNull();
    await logMedicationAdministration(fd({ id: itemId, offset: "now" }));
    expect(
      (
        db
          .prepare(
            "SELECT amount FROM intake_item_logs WHERE item_id = ? ORDER BY id DESC LIMIT 1"
          )
          .get(itemId) as { amount: string | null }
      ).amount
    ).toBe("150 mg");
  });

  it("accepting revalidates every reader of the stored amount", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id, "100 mg");
    seedChild(profile.id, IN_150_BAND_KG);

    await acceptDoseBandUpdate(
      fd({ dedupe_key: doseBandUpdateKey(itemId, 150) })
    );

    // The Today panel and the medications list row print the same stored amount from
    // different queries; the medicine's own page prints it a third time. Revalidating
    // only the block the offer sits in would leave a caregiver tapping "Take 100 mg"
    // one line under "updated to 150 mg".
    for (const route of [
      "/medications",
      `/medications/${itemId}`,
      "/nutrition",
      "/",
    ])
      expect(revalidate).toHaveBeenCalledWith(route);
  });

  it("declining writes no health data and no dose amount", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id, "100 mg");
    seedChild(profile.id, IN_150_BAND_KG);
    const before = healthRowCounts(profile.id, itemId);

    const res = await declineDoseBandUpdate(
      fd({ dedupe_key: doseBandUpdateKey(itemId, 150) })
    );

    expect(res.ok).toBe(true);
    expect(storedAmount(itemId)).toBe("100 mg");
    expect(healthRowCounts(profile.id, itemId)).toEqual(before);
  });

  it("records the decline on the suppression bus so the offer stops returning", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id, "100 mg");
    seedChild(profile.id, IN_150_BAND_KG);

    await declineDoseBandUpdate(
      fd({ dedupe_key: doseBandUpdateKey(itemId, 150) })
    );

    // An UNRECORDED decline is byte-identical to never having asked, so the offer
    // would return on the very next page load, forever.
    expect(suppressionKeys(profile.id)).toEqual([
      doseBandUpdateKey(itemId, 150),
    ]);
    expect(standingDoseUpdateOffer(profile.id, itemId)).toBeNull();
    expect(getPediatricFormContext(profile.id).declinedDoseUpdates).toEqual([
      doseBandUpdateKey(itemId, 150),
    ]);
  });

  it("re-opens the offer when the band moves again", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id, "100 mg");
    seedChild(profile.id, IN_150_BAND_KG);
    await declineDoseBandUpdate(
      fd({ dedupe_key: doseBandUpdateKey(itemId, 150) })
    );
    expect(standingDoseUpdateOffer(profile.id, itemId)).toBeNull();

    // THE ANCHOR IS THE WHOLE MECHANISM. The decline is keyed on the figure it was
    // given for, so growing into the next band mints a different key and the offer
    // arrives un-silenced. An id-keyed decline would silence it forever, which is the
    // opposite of the ruling.
    weigh(profile.id, IN_200_BAND_KG);

    expect(standingDoseUpdateOffer(profile.id, itemId)).toMatchObject({
      key: doseBandUpdateKey(itemId, 200),
      bandAmount: "200 mg",
    });
  });

  it("refuses an answer the current band no longer agrees with", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id, "100 mg");
    seedChild(profile.id, IN_150_BAND_KG);
    // A card left open while the child was weighed again: the key it renders proposes
    // a figure nobody is being shown any more.
    weigh(profile.id, IN_200_BAND_KG);

    const res = await acceptDoseBandUpdate(
      fd({ dedupe_key: doseBandUpdateKey(itemId, 150) })
    );

    expect(res.ok).toBe(false);
    expect(storedAmount(itemId)).toBe("100 mg");
  });

  it("refuses a key naming another profile's item", async () => {
    const other = seedActor();
    const itemId = seedPrnMed(other.profile.id, "100 mg");
    seedChild(other.profile.id, IN_150_BAND_KG);
    seedActor();

    const res = await acceptDoseBandUpdate(
      fd({ dedupe_key: doseBandUpdateKey(itemId, 150) })
    );

    expect(res.ok).toBe(false);
    expect(storedAmount(itemId)).toBe("100 mg");
  });
});
