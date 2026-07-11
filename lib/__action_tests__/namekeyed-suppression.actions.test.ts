// SERVER-ACTION TIER — name-keyed suppression lifecycle (issue #203).
//
// upcoming_dismissals and starred_biomarkers are keyed by REUSABLE strings (a
// biomarker's canonical name, a vaccine code), so a row left behind when its
// subject is deleted/renamed silently re-attaches to a later subject that reuses
// the key. These tests drive the real write paths against the throwaway temp DB and
// assert the stores are cleared/re-keyed at each seam:
//   1. delete every reading of a biomarker → its retest dismissal is cleared
//   2. delete the last dose of a vaccine   → its due-nudge dismissal is cleared
//   3. rename a reading's canonical name   → its star migrates to the new name
//   4. rename a reading's canonical name   → its retest dismissal re-keys too

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  addRecord,
  updateRecord,
  deleteRecord,
} from "@/app/(app)/medical/actions";
import {
  addImmunization,
  updateImmunization,
  deleteImmunization,
} from "@/app/(app)/immunizations/actions";
import {
  deleteDatasetRows,
  deleteAllDatasetRows,
} from "@/app/(app)/data/manage-actions";
import { dismissFinding } from "@/lib/queries";
import { seedActor, createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

function dismissalKeys(profileId: number): string[] {
  return (
    db
      .prepare(
        "SELECT signal_key FROM upcoming_dismissals WHERE profile_id = ? ORDER BY signal_key"
      )
      .all(profileId) as { signal_key: string }[]
  ).map((r) => r.signal_key);
}
function starNames(profileId: number): string[] {
  return (
    db
      .prepare(
        "SELECT canonical_name FROM starred_biomarkers WHERE profile_id = ? ORDER BY canonical_name"
      )
      .all(profileId) as { canonical_name: string }[]
  ).map((r) => r.canonical_name);
}
function star(profileId: number, canonical: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO starred_biomarkers (profile_id, canonical_name) VALUES (?, ?)"
  ).run(profileId, canonical);
}
function recordId(profileId: number, canonical: string): number {
  return (
    db
      .prepare(
        "SELECT id FROM medical_records WHERE profile_id = ? AND canonical_name = ? ORDER BY id DESC LIMIT 1"
      )
      .get(profileId, canonical) as { id: number }
  ).id;
}
function immId(profileId: number, vaccine: string): number {
  return (
    db
      .prepare(
        "SELECT id FROM immunizations WHERE profile_id = ? AND vaccine = ? ORDER BY id DESC LIMIT 1"
      )
      .get(profileId, vaccine) as { id: number }
  ).id;
}

describe("manifestation 1 — biomarker retest dismissal outlives the data", () => {
  it("clears the retest dismissal when the last reading is deleted, so a re-add re-nudges", async () => {
    const { profile } = seedActor();
    await addRecord(
      fd({
        date: "2020-01-01",
        category: "lab",
        name: "Glucose",
        value: "95",
        canonical_name: "Glucose",
      })
    );
    // The user dismisses the glucose retest nudge (keyed by canonical name).
    dismissFinding(profile.id, "biomarker:glucose");
    expect(dismissalKeys(profile.id)).toContain("biomarker:glucose");

    // Deleting the only glucose reading must sweep the now-orphaned dismissal.
    await deleteRecord(fd({ id: recordId(profile.id, "Glucose") }));
    expect(dismissalKeys(profile.id)).not.toContain("biomarker:glucose");

    // Re-adding glucose later does not resurrect the stale dismissal — the new
    // nudge is free to fire.
    await addRecord(
      fd({
        date: "2026-06-01",
        category: "lab",
        name: "Glucose",
        value: "96",
        canonical_name: "Glucose",
      })
    );
    expect(dismissalKeys(profile.id)).not.toContain("biomarker:glucose");
  });

  it("keeps the dismissal while another reading of the same biomarker survives", async () => {
    const { profile } = seedActor();
    await addRecord(
      fd({
        date: "2020-01-01",
        category: "lab",
        name: "Glucose",
        value: "95",
        canonical_name: "Glucose",
      })
    );
    await addRecord(
      fd({
        date: "2021-01-01",
        category: "lab",
        name: "Glucose",
        value: "97",
        canonical_name: "Glucose",
      })
    );
    dismissFinding(profile.id, "biomarker:glucose");

    // Delete just one of the two readings — the biomarker still has data, so the
    // dismissal stays put.
    await deleteRecord(fd({ id: recordId(profile.id, "Glucose") }));
    expect(dismissalKeys(profile.id)).toContain("biomarker:glucose");
  });
});

describe("manifestation 2 — immunization dismissal outlives the dose", () => {
  it("clears the due-nudge dismissal when the last dose of the vaccine is deleted", async () => {
    const { profile } = seedActor();
    await addImmunization(fd({ date: "2001-06-01", vaccine: "MMR" }));
    dismissFinding(profile.id, "immunization:mmr");
    expect(dismissalKeys(profile.id)).toContain("immunization:mmr");

    await deleteImmunization(fd({ id: immId(profile.id, "mmr") }));
    expect(dismissalKeys(profile.id)).not.toContain("immunization:mmr");
  });

  it("keeps the dismissal while another dose still credits the code", async () => {
    const { profile } = seedActor();
    await addImmunization(fd({ date: "2001-06-01", vaccine: "MMR" }));
    await addImmunization(fd({ date: "2005-06-01", vaccine: "MMR" }));
    dismissFinding(profile.id, "immunization:mmr");

    await deleteImmunization(fd({ id: immId(profile.id, "mmr") }));
    expect(dismissalKeys(profile.id)).toContain("immunization:mmr");
  });
});

describe("manifestation 2b — immunization dismissal outlives an edit re-code (#376)", () => {
  it("clears the OLD code's dismissal when a dose is re-coded to a different vaccine", async () => {
    const { profile } = seedActor();
    // One dose recorded as HepB; the user dismisses its due-nudge (key immunization:hepb).
    await addImmunization(fd({ date: "2001-06-01", vaccine: "Hep B" }));
    dismissFinding(profile.id, "immunization:hepb");
    expect(dismissalKeys(profile.id)).toContain("immunization:hepb");

    // Correcting a mis-extraction: re-code the same dose HepB -> Hib. HepB now has
    // no backing dose, so its orphaned dismissal must be swept (a later real HepB
    // dose would otherwise stay silenced forever).
    await updateImmunization(
      fd({ id: immId(profile.id, "hepb"), date: "2001-06-01", vaccine: "Hib" })
    );
    expect(dismissalKeys(profile.id)).not.toContain("immunization:hepb");
  });

  it("keeps the dismissal when the edit does not change the code set", async () => {
    const { profile } = seedActor();
    await addImmunization(fd({ date: "2001-06-01", vaccine: "MMR" }));
    dismissFinding(profile.id, "immunization:mmr");

    // Edit only the date — the code stays 'mmr', so the dismissal is untouched.
    await updateImmunization(
      fd({ id: immId(profile.id, "mmr"), date: "2002-06-01", vaccine: "MMR" })
    );
    expect(dismissalKeys(profile.id)).toContain("immunization:mmr");
  });

  it("keeps the dismissal while a sibling dose still credits the re-coded code", async () => {
    const { profile } = seedActor();
    await addImmunization(fd({ date: "2001-06-01", vaccine: "MMR" }));
    await addImmunization(fd({ date: "2005-06-01", vaccine: "MMR" }));
    dismissFinding(profile.id, "immunization:mmr");

    // Re-code only one of the two mmr doses; the other still backs 'mmr'.
    await updateImmunization(
      fd({ id: immId(profile.id, "mmr"), date: "2005-06-01", vaccine: "Hib" })
    );
    expect(dismissalKeys(profile.id)).toContain("immunization:mmr");
  });
});

describe("manifestation 2c — immunization dismissal outlives a Data → Manage bulk delete (#376)", () => {
  it("clears the code's dismissal when its last dose is bulk-deleted by id", async () => {
    const { profile } = seedActor();
    await addImmunization(fd({ date: "2001-06-01", vaccine: "MMR" }));
    dismissFinding(profile.id, "immunization:mmr");
    expect(dismissalKeys(profile.id)).toContain("immunization:mmr");

    const res = await deleteDatasetRows("immunizations", [
      immId(profile.id, "mmr"),
    ]);
    expect(res.ok).toBe(true);
    expect(dismissalKeys(profile.id)).not.toContain("immunization:mmr");
  });

  it("keeps a never-recorded vaccine's dismissal through a bulk delete", async () => {
    const { profile } = seedActor();
    await addImmunization(fd({ date: "2001-06-01", vaccine: "MMR" }));
    // 'hpv' has NO backing dose ever — a lasting dismissal, not orphaned by this delete.
    dismissFinding(profile.id, "immunization:mmr");
    dismissFinding(profile.id, "immunization:hpv");

    await deleteDatasetRows("immunizations", [immId(profile.id, "mmr")]);
    const keys = dismissalKeys(profile.id);
    expect(keys).not.toContain("immunization:mmr"); // un-backed by the delete
    expect(keys).toContain("immunization:hpv"); // never backed — preserved
  });

  it("clears every un-backed code on a delete-all", async () => {
    const { profile } = seedActor();
    await addImmunization(fd({ date: "2001-06-01", vaccine: "MMR" }));
    await addImmunization(fd({ date: "2010-06-01", vaccine: "Hep B" }));
    dismissFinding(profile.id, "immunization:mmr");
    dismissFinding(profile.id, "immunization:hepb");
    dismissFinding(profile.id, "immunization:hpv"); // never recorded

    await deleteAllDatasetRows("immunizations");
    const keys = dismissalKeys(profile.id);
    expect(keys).not.toContain("immunization:mmr");
    expect(keys).not.toContain("immunization:hepb");
    expect(keys).toContain("immunization:hpv"); // no backing dose ever — kept
  });
});

describe("manifestation 3 & 4 — canonical rename migrates star + dismissal", () => {
  it("carries the pinned star and the retest snooze to the new canonical name", async () => {
    const { profile } = seedActor();
    await addRecord(
      fd({
        date: "2026-01-01",
        category: "lab",
        name: "Vitamin D",
        value: "40",
        canonical_name: "Vitamin D",
      })
    );
    star(profile.id, "Vitamin D");
    dismissFinding(profile.id, "biomarker:vitamin d");

    // Snap the canonical name to the fuller vocab entry — exactly what the app
    // encourages — via the single-record edit path.
    await updateRecord(
      fd({
        id: recordId(profile.id, "Vitamin D"),
        date: "2026-01-01",
        category: "lab",
        name: "Vitamin D",
        value: "40",
        canonical_name: "Vitamin D, 25-Hydroxy",
      })
    );

    // Star followed the subject: pinned under the new name, no dead old star.
    expect(starNames(profile.id)).toEqual(["Vitamin D, 25-Hydroxy"]);
    // Dismissal re-keyed the same way: the snooze the user set still attaches.
    expect(dismissalKeys(profile.id)).toEqual([
      "biomarker:vitamin d, 25-hydroxy",
    ]);
  });

  it("does not migrate on a plain value/date edit (no rename)", async () => {
    const { profile } = seedActor();
    await addRecord(
      fd({
        date: "2026-01-01",
        category: "lab",
        name: "LDL",
        value: "120",
        canonical_name: "LDL Cholesterol",
      })
    );
    star(profile.id, "LDL Cholesterol");
    dismissFinding(profile.id, "biomarker:ldl cholesterol");

    await updateRecord(
      fd({
        id: recordId(profile.id, "LDL Cholesterol"),
        date: "2026-02-01",
        category: "lab",
        name: "LDL",
        value: "115",
        canonical_name: "LDL Cholesterol",
      })
    );

    expect(starNames(profile.id)).toEqual(["LDL Cholesterol"]);
    expect(dismissalKeys(profile.id)).toEqual(["biomarker:ldl cholesterol"]);
  });

  it("drops a leftover old star when the new name is already pinned (collision)", async () => {
    const { profile } = seedActor();
    await addRecord(
      fd({
        date: "2026-01-01",
        category: "lab",
        name: "Vitamin D",
        value: "40",
        canonical_name: "Vitamin D",
      })
    );
    // Both the old and the new names are already starred.
    star(profile.id, "Vitamin D");
    star(profile.id, "Vitamin D, 25-Hydroxy");

    await updateRecord(
      fd({
        id: recordId(profile.id, "Vitamin D"),
        date: "2026-01-01",
        category: "lab",
        name: "Vitamin D",
        value: "40",
        canonical_name: "Vitamin D, 25-Hydroxy",
      })
    );

    // The re-key is ignored (new name already pinned); the orphan sweep then drops
    // the now-backless old star — no duplicate, no dead pin.
    expect(starNames(profile.id)).toEqual(["Vitamin D, 25-Hydroxy"]);
  });
});

describe("per-profile scoping", () => {
  it("a delete under one profile never sweeps another profile's dismissals", async () => {
    const login = createLogin({ role: "admin" });
    const a = createProfile("NK-A", login.id);
    const b = createProfile("NK-B", login.id);

    // Profile B dismisses its glucose nudge and has no glucose reading (a bare
    // dismissal). Profile A deletes its own glucose reading.
    dismissFinding(b.id, "biomarker:glucose");

    actAs(login, a);
    await addRecord(
      fd({
        date: "2026-01-01",
        category: "lab",
        name: "Glucose",
        value: "95",
        canonical_name: "Glucose",
      })
    );
    await deleteRecord(fd({ id: recordId(a.id, "Glucose") }));

    // B's dismissal is untouched — the sweep is profile-scoped.
    expect(dismissalKeys(b.id)).toEqual(["biomarker:glucose"]);
  });
});
