// SERVER-ACTION TIER — the quick-log sheet's subject chip (#4932), the write half.
//
// The sheet's title-row chip lets a caregiver pick a household member other than the
// acting profile, and every form it hosts must then write THAT member — re-gated
// server-side through `gateItemProfile`, exactly like a record correction (#4009).
// Five of the ten forms had no such arm before this issue: `addMeasurements`,
// `resolveDayDoses` (#4429), `uploadMedicalDocument`, `logStoolForm` and
// `logSubstanceUnitAction` all resolved their profile from the SESSION alone, so a
// posted `profile_id` was silently ignored and every tap landed on the acting
// profile regardless of what the chip said. This is the acceptance criterion in its
// own words: "a DB-tier test per form asserts the stored row's profile_id is the
// chosen subject and that a read-only member is refused."
//
// Table-driven over the five, on the SAME two positions #4009's own table uses: an
// UNGRANTED and a READ-ONLY-granted profile must both refuse with nothing written,
// and a WRITE-granted profile must LAND — on the subject, not the acting profile.
// The other five sheet forms (food, mood, practice, cycle's own doors, symptom) took
// this gate before this issue and are proven by their own existing suites
// (food-log.actions.test.ts, mood.actions.test.ts, practice.actions.test.ts,
// symptom-log.actions.test.ts); duplicating their coverage here would be the second
// copy the line-budget ruling warns against.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { addMeasurements } from "@/app/(app)/trends/measurement-actions";
import { resolveDayDoses } from "@/app/(app)/nutrition/intake-actions";
import { uploadMedicalDocument } from "@/app/(app)/medical/document-actions";
import { logStoolForm } from "@/app/(app)/stool-actions";
import { logSubstanceUnitAction } from "@/app/(app)/medical/substance-use/actions";
import { BRISTOL_STOOL_METRIC } from "@/lib/bristol-stool";
import { createLogin, createProfile, actAs, fd } from "./harness";

function bodyWeightOf(profileId: number, date: string): number | null {
  const row = db
    .prepare(
      "SELECT weight_kg FROM body_metrics WHERE profile_id = ? AND date = ?"
    )
    .get(profileId, date) as { weight_kg: number } | undefined;
  return row?.weight_kg ?? null;
}

function seedPendingDose(profileId: number): { doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, condition, obligation, active, source)
         VALUES (?, 'Vitamin D', 'daily', 'should', 1, 'manual')`
      )
      .run(profileId).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '2000 IU', '08:00', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { doseId };
}

function doseLogStatusOf(profileId: number, doseId: number): string | null {
  const row = db
    .prepare(
      `SELECT l.status FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
        WHERE d.id = ? AND l.item_id IN
          (SELECT id FROM intake_items WHERE profile_id = ?)`
    )
    .get(doseId, profileId) as { status: string } | undefined;
  return row?.status ?? null;
}

function documentRowsOf(profileId: number): { filename: string }[] {
  return db
    .prepare(
      "SELECT filename FROM medical_documents WHERE profile_id = ? ORDER BY id"
    )
    .all(profileId) as { filename: string }[];
}

function uploadForm(profileId: number | null): FormData {
  const form = new FormData();
  if (profileId != null) form.set("profile_id", String(profileId));
  form.set(
    "file",
    new File(
      ["metric,value,unit,date\nGlucose,95,mg/dL,2026-01-01\n"],
      "labs.csv",
      { type: "text/csv" }
    )
  );
  return form;
}

function bristolCountOf(profileId: number, date: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = ? AND metric = ? AND date = ?"
      )
      .get(profileId, BRISTOL_STOOL_METRIC, date) as { n: number }
  ).n;
}

function substanceUnitsOf(
  profileId: number,
  date: string,
  substance: string
): number {
  const row = db
    .prepare(
      "SELECT units FROM substance_daily_totals WHERE profile_id = ? AND date = ? AND substance = ?"
    )
    .get(profileId, date, substance) as { units: number } | undefined;
  return row?.units ?? 0;
}

// Each kind: a subject-scoped ADD, and the one reader that answers "did the
// SUBJECT's own row change". `write` builds the FormData a real sheet submit would
// post, INCLUDING `profile_id` when `subjectId` is given — every kind falls back to
// the acting profile when it is omitted, which the fallback case below exercises
// once rather than per kind (the existing acting-profile suites already cover it
// per form).
const KINDS = [
  {
    name: "measurements",
    seed: (_profileId: number) => ({}) as { doseId?: number },
    write: (subjectId: number | null, date: string, _seeded: { doseId?: number }) =>
      addMeasurements(
        fd({
          date,
          weight: "70",
          weight_unit: "kg",
          ...(subjectId != null ? { profile_id: subjectId } : {}),
        })
      ),
    landed: (profileId: number, date: string, _seeded: { doseId?: number }) =>
      bodyWeightOf(profileId, date) === 70,
    untouched: (profileId: number, date: string, _seeded: { doseId?: number }) =>
      bodyWeightOf(profileId, date) === null,
  },
  {
    name: "dose (resolveDayDoses, #4429)",
    seed: (profileId: number) => seedPendingDose(profileId) as { doseId?: number },
    write: (
      subjectId: number | null,
      date: string,
      seeded: { doseId?: number }
    ) =>
      resolveDayDoses(
        fd({
          date,
          status: "taken",
          dose_ids: String(seeded.doseId),
          ...(subjectId != null ? { profile_id: subjectId } : {}),
        })
      ),
    landed: (profileId: number, _date: string, seeded: { doseId?: number }) =>
      seeded.doseId != null &&
      doseLogStatusOf(profileId, seeded.doseId) === "taken",
    untouched: (
      profileId: number,
      _date: string,
      seeded: { doseId?: number }
    ) =>
      seeded.doseId == null ||
      doseLogStatusOf(profileId, seeded.doseId) === null,
  },
  {
    name: "document upload",
    seed: (_profileId: number) => ({}) as { doseId?: number },
    write: (
      subjectId: number | null,
      _date: string,
      _seeded: { doseId?: number }
    ) => uploadMedicalDocument(uploadForm(subjectId)),
    landed: (profileId: number, _date: string, _seeded: { doseId?: number }) =>
      documentRowsOf(profileId).some((r) => r.filename === "labs.csv"),
    untouched: (
      profileId: number,
      _date: string,
      _seeded: { doseId?: number }
    ) => documentRowsOf(profileId).length === 0,
  },
  {
    name: "stool",
    seed: (_profileId: number) => ({}) as { doseId?: number },
    write: (subjectId: number | null, date: string, _seeded: { doseId?: number }) =>
      logStoolForm(
        fd({
          type: 4,
          date,
          ...(subjectId != null ? { profile_id: subjectId } : {}),
        })
      ),
    landed: (profileId: number, date: string, _seeded: { doseId?: number }) =>
      bristolCountOf(profileId, date) === 1,
    untouched: (profileId: number, date: string, _seeded: { doseId?: number }) =>
      bristolCountOf(profileId, date) === 0,
  },
  {
    name: "substance",
    seed: (_profileId: number) => ({}) as { doseId?: number },
    write: (subjectId: number | null, _date: string, _seeded: { doseId?: number }) =>
      logSubstanceUnitAction(
        fd({
          substance: "cannabis",
          ...(subjectId != null ? { profile_id: subjectId } : {}),
        })
      ),
    landed: (profileId: number, date: string, _seeded: { doseId?: number }) =>
      substanceUnitsOf(profileId, date, "cannabis") === 1,
    untouched: (profileId: number, date: string, _seeded: { doseId?: number }) =>
      substanceUnitsOf(profileId, date, "cannabis") === 0,
  },
] as const;

describe("the quick-log sheet's subject chip gates each form's write to the CHOSEN subject (#4932)", () => {
  describe.each(KINDS)("$name", (kind) => {
    it("refuses an ungranted and a read-only subject, writing nothing", async () => {
      const login = createLogin({ role: "member" });
      const acting = createProfile(`acting ${kind.name}`, login.id);
      const ungranted = createProfile(`ungranted ${kind.name}`);
      const readOnly = createProfile(`readonly ${kind.name}`);
      db.prepare(
        "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'read')"
      ).run(login.id, readOnly.id);
      actAs(login, acting);

      for (const target of [ungranted, readOnly]) {
        const date = today(target.id);
        const seeded = kind.seed(target.id);
        await expect(kind.write(target.id, date, seeded)).rejects.toThrow();
        expect(kind.untouched(target.id, date, seeded)).toBe(true);
      }
    });

    it("lands on a WRITE-granted subject, not the acting profile", async () => {
      const login = createLogin({ role: "member" });
      const acting = createProfile(`acting-2 ${kind.name}`, login.id);
      const target = createProfile(`target ${kind.name}`, login.id);
      actAs(login, acting);
      const date = today(target.id);
      const seeded = kind.seed(target.id);

      await kind.write(target.id, date, seeded);

      expect(kind.landed(target.id, date, seeded)).toBe(true);
      // THE CAPABILITY HALF'S OWN TWIN: a write ignoring the posted subject and
      // landing on the acting profile instead would still pass "landed" above by
      // accident for a kind whose reader takes no profile filter — so also assert
      // the ACTING profile shows nothing for this same date/seed, re-querying (never
      // re-seeding) so this checks the ONE write above, not a fresh row.
      expect(kind.untouched(acting.id, date, seeded)).toBe(true);
    });
  });

  // WITHOUT A SUBJECT, NOTHING MOVED — every pre-#4932 mount posts no `profile_id`
  // and must keep landing on the acting profile exactly as it always has.
  describe.each(KINDS)("$name falls back to the acting profile", (kind) => {
    it("writes the acting profile when no subject is posted", async () => {
      const login = createLogin({ role: "member" });
      const acting = createProfile(`fallback ${kind.name}`, login.id);
      actAs(login, acting);
      const date = today(acting.id);
      const seeded = kind.seed(acting.id);

      await kind.write(null, date, seeded);

      expect(kind.landed(acting.id, date, seeded)).toBe(true);
    });
  });
});
