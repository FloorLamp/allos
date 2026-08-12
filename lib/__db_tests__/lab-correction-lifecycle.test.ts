// DB INTEGRATION TIER — the lab correction lifecycle (#1404).
//
// THE DEFECT: a source-owned reading is keyed by external_id, and the sync upsert
// UPDATEs it in place. A lab that re-issues a value — a corrected potassium, an
// amended differential — therefore replaced a number the user had already read, with
// no record that it ever changed and no way to see what it was.
//
// What only a real DB can prove is the whole lifecycle at once: the prior value is
// preserved BEFORE the overwrite, in the same transaction; the reading keeps its id
// (so every link, star and dismissal pointing at it survives); an idempotent re-send
// of the rolling window still writes nothing; a hand-edited row is still never
// clobbered; the preserved value is NOT an observation (it never joins the series);
// and a delete/undo of the reading carries its lineage with it.
//
// All values are SYNTHETIC (no PHI).

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { upsertVitals, type NormVital } from "@/lib/integrations/normalize";
import {
  getBiomarkerSeries,
  getClinicalObservations,
  getObservationRevisions,
  getRevisionsByObservation,
} from "@/lib/queries";
import { captureDelete, restoreDeletedRow } from "@/lib/undo-delete-db";
import { seedProfile, type SeededProfile } from "./fixtures";

const SOURCE = "e2e-lab-feed";
const EXT = "e2e-lab-feed:potassium:2026-01-09";

let subject: SeededProfile;

// One incoming potassium result from a source that keys its rows by external_id.
function reading(over: Partial<NormVital> = {}): NormVital {
  return {
    external_id: EXT,
    date: "2026-01-09",
    category: "lab",
    name: "Potassium",
    canonical: "Potassium",
    value_num: 5.2,
    unit: "mmol/L",
    result_status: "final",
    ...over,
  };
}

function liveRow(id: number) {
  return db
    .prepare(
      `SELECT id, value, value_num, unit, result_status, date
         FROM medical_records WHERE id = ? AND profile_id = ?`
    )
    .get(id, subject.profileId) as {
    id: number;
    value: string | null;
    value_num: number | null;
    unit: string | null;
    result_status: string | null;
    date: string;
  };
}

beforeEach(() => {
  subject = seedProfile("LabCorrection");
});

describe("a re-issued result preserves what it replaces", () => {
  it("keeps the reading's id and archives the prior value, once", () => {
    const first = upsertVitals(subject.profileId, [reading()], SOURCE);
    const id = first.ids[0];
    expect(first.counts.inserted).toBe(1);
    expect(getObservationRevisions(subject.profileId, id)).toEqual([]);

    // The lab re-issues the draw with a different number, marked corrected.
    const second = upsertVitals(
      subject.profileId,
      [reading({ value_num: 4.4, result_status: "corrected" })],
      SOURCE
    );
    expect(second.counts.updated).toBe(1);
    // SAME row — the reading's identity (and every link to it) survives.
    expect(second.ids).toEqual([id]);

    const live = liveRow(id);
    expect(live.value_num).toBe(4.4);
    expect(live.result_status).toBe("corrected");

    const revs = getObservationRevisions(subject.profileId, id);
    expect(revs).toHaveLength(1);
    expect(revs[0].value_num).toBe(5.2);
    expect(revs[0].value).toBe("5.2");
    expect(revs[0].unit).toBe("mmol/L");
    expect(revs[0].result_status).toBe("final");
    // What replaced it, and what the source called that re-issue.
    expect(revs[0].superseded_by_status).toBe("corrected");
    expect(revs[0].source).toBe(SOURCE);
  });

  it("preserves EVERY correction, in newest-first order", () => {
    const id = upsertVitals(subject.profileId, [reading()], SOURCE).ids[0];
    upsertVitals(subject.profileId, [reading({ value_num: 4.4 })], SOURCE);
    upsertVitals(
      subject.profileId,
      [reading({ value_num: 4.1, result_status: "amended" })],
      SOURCE
    );
    const revs = getObservationRevisions(subject.profileId, id);
    expect(revs.map((r) => r.value_num)).toEqual([4.4, 5.2]);
    expect(liveRow(id).value_num).toBe(4.1);
  });

  it("records a status-only correction of an unchanged value", () => {
    const id = upsertVitals(subject.profileId, [reading()], SOURCE).ids[0];
    // Same number, re-issued as corrected: the value was re-stated after review,
    // which is exactly the fact the user is owed.
    const again = upsertVitals(
      subject.profileId,
      [reading({ result_status: "corrected" })],
      SOURCE
    );
    expect(again.counts.updated).toBe(1);
    expect(getObservationRevisions(subject.profileId, id)).toHaveLength(1);
  });

  it("writes NOTHING for an idempotent re-send of the rolling window", () => {
    const id = upsertVitals(subject.profileId, [reading()], SOURCE).ids[0];
    const again = upsertVitals(subject.profileId, [reading()], SOURCE);
    expect(again.counts).toMatchObject({ unchanged: 1, updated: 0 });
    expect(getObservationRevisions(subject.profileId, id)).toEqual([]);
  });

  it("does not manufacture a correction for a re-FILING that changed no value", () => {
    const id = upsertVitals(subject.profileId, [reading()], SOURCE).ids[0];
    // The source re-canonicalizes the analyte's name. The reading says exactly what
    // it said before — how it is FILED changed, not what it reported.
    const renamed = upsertVitals(
      subject.profileId,
      [reading({ name: "Potassium, Serum", canonical: "Potassium" })],
      SOURCE
    );
    expect(renamed.counts.updated).toBe(1);
    expect(getObservationRevisions(subject.profileId, id)).toEqual([]);
  });

  it("still never clobbers a hand-edited imported reading (#133/#659)", () => {
    const id = upsertVitals(subject.profileId, [reading()], SOURCE).ids[0];
    db.prepare(
      "UPDATE medical_records SET edited = 1, value = '4.9', value_num = 4.9 WHERE id = ? AND profile_id = ?"
    ).run(id, subject.profileId);

    const resync = upsertVitals(
      subject.profileId,
      [reading({ value_num: 4.4, result_status: "corrected" })],
      SOURCE
    );
    expect(resync.counts.edited).toBe(1);
    // The user's correction stands, and the edit lock is not a supersession — there
    // was no overwrite, so there is nothing to preserve.
    expect(liveRow(id).value_num).toBe(4.9);
    expect(getObservationRevisions(subject.profileId, id)).toEqual([]);
  });
});

describe("a preserved value is provenance, never an observation", () => {
  it("never joins the series, the record list, or the current reading", () => {
    const id = upsertVitals(subject.profileId, [reading()], SOURCE).ids[0];
    upsertVitals(
      subject.profileId,
      [reading({ value_num: 4.4, result_status: "corrected" })],
      SOURCE
    );

    const series = getBiomarkerSeries(subject.profileId, "Potassium");
    expect(series.map((r) => r.value_num)).toEqual([4.4]);
    const rows = getClinicalObservations(subject.profileId, {}).filter(
      (r) => r.name === "Potassium"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].result_status).toBe("corrected");
  });

  it("is profile-scoped through its parent reading", () => {
    const id = upsertVitals(subject.profileId, [reading()], SOURCE).ids[0];
    upsertVitals(subject.profileId, [reading({ value_num: 4.4 })], SOURCE);
    const other = seedProfile("LabCorrectionOther");
    expect(getObservationRevisions(other.profileId, id)).toEqual([]);
    expect(getRevisionsByObservation(other.profileId, [id]).size).toBe(0);
    expect(
      getRevisionsByObservation(subject.profileId, [id]).get(id)
    ).toHaveLength(1);
  });

  it("getRevisionsByObservation groups a set and short-circuits an empty one", () => {
    const id = upsertVitals(subject.profileId, [reading()], SOURCE).ids[0];
    upsertVitals(subject.profileId, [reading({ value_num: 4.4 })], SOURCE);
    // Derived readings carry synthetic NEGATIVE ids and have no lineage.
    const byRecord = getRevisionsByObservation(subject.profileId, [id, -7]);
    expect([...byRecord.keys()]).toEqual([id]);
    expect(getRevisionsByObservation(subject.profileId, []).size).toBe(0);
  });
});

describe("row operations carry the lineage", () => {
  it("a delete removes it and an undo brings it back", () => {
    const id = upsertVitals(subject.profileId, [reading()], SOURCE).ids[0];
    upsertVitals(
      subject.profileId,
      [reading({ value_num: 4.4, result_status: "corrected" })],
      SOURCE
    );
    expect(getObservationRevisions(subject.profileId, id)).toHaveLength(1);

    const undoId = captureDelete("biomarker-record", subject.profileId, id);
    db.prepare(
      "DELETE FROM medical_records WHERE id = ? AND profile_id = ?"
    ).run(id, subject.profileId);
    // ON DELETE CASCADE took the child rows with the reading.
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM medical_record_revisions WHERE record_id = ?"
          )
          .get(id) as { n: number }
      ).n
    ).toBe(0);

    expect(undoId).not.toBeNull();
    expect(restoreDeletedRow(subject.profileId, undoId!)).toBe(true);
    const restored = getClinicalObservations(subject.profileId, {}).find(
      (r) => r.name === "Potassium"
    )!;
    // The reading is back WITH its correction history — an undo that dropped the
    // lineage would quietly destroy what the delete was supposed to be reversible
    // about.
    const revs = getObservationRevisions(subject.profileId, restored.id);
    expect(revs).toHaveLength(1);
    expect(revs[0].value_num).toBe(5.2);
  });
});
