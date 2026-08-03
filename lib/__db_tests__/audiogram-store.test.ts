// DB INTEGRATION TIER — the audiogram store round-trip (issue #1600).
//
// The whole point of this issue was the STORE decision, so the load-bearing assertions
// here are about WHERE the readings land: canonical `vitals` medical_records rows, in
// the same shape an imported reading has, flagging against the same curated ≤25 dB HL
// band. If a future change quietly moves them to a private table, these fail.
//
// Also covered: the observation-substrate contract on the write path (the
// inserted/updated/unchanged split from classifyUpsert/tallyUpsert, and the edit lock
// holding a sync off a hand-corrected row), and the payoff — the existing ototoxic
// crosscheck citing the newest baseline and naming a documented threshold shift.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no network.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  deleteAudiogram,
  getAudiogramReadings,
  getAudiograms,
  getHearingBaseline,
  hasAudiogramRows,
  recordAudiogram,
} from "@/lib/audiogram-records";
import { audiogramAnalyteName } from "@/lib/audiogram";
import { getOtotoxicWarnings } from "@/lib/queries";
import { ototoxicDetail, ototoxicHasShift } from "@/lib/ototoxic";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

describe("audiogram store — canonical medical_records rows (#1600)", () => {
  it("writes each threshold as a canonical vitals reading that flags like an imported one", () => {
    const profileId = makeProfile("audiogram-store");
    const outcome = recordAudiogram(profileId, {
      date: "2026-03-04",
      thresholds: [
        { ear: "right", hz: 1000, dbHl: 15 },
        { ear: "right", hz: 4000, dbHl: 40 },
        { ear: "left", hz: 4000, dbHl: 20 },
      ],
      notes: "annual monitoring audiogram",
    });
    expect(outcome.kind).toBe("saved");

    // THE STORE ASSERTION: medical_records, category vitals, canonical name, dB HL.
    const rows = db
      .prepare(
        `SELECT date, category, name, canonical_name, value, value_num, unit,
                reference_range, panel, source, flag, notes
           FROM medical_records WHERE profile_id = ? ORDER BY canonical_name`
      )
      .all(profileId) as {
      date: string;
      category: string;
      name: string;
      canonical_name: string;
      value: string;
      value_num: number;
      unit: string;
      reference_range: string;
      panel: string;
      source: string;
      flag: string | null;
      notes: string | null;
    }[];
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.category === "vitals")).toBe(true);
    expect(rows.every((r) => r.unit === "dB HL")).toBe(true);
    expect(rows.every((r) => r.panel === "hearing")).toBe(true);
    expect(rows.every((r) => r.source === "Audiogram")).toBe(true);
    expect(rows.map((r) => r.canonical_name)).toContain(
      audiogramAnalyteName("right", 4000)
    );
    // reconcileFlags ran with the curated ≤25 dB HL band, so 40 dB HL at 4 kHz is
    // flagged high and 15 dB HL is not — the manually entered reading behaves exactly
    // like an imported one on every downstream biomarker surface.
    const high = rows.find(
      (r) => r.canonical_name === audiogramAnalyteName("right", 4000)
    )!;
    const normal = rows.find(
      (r) => r.canonical_name === audiogramAnalyteName("right", 1000)
    )!;
    expect(high.flag).toBe("high");
    expect(normal.flag).not.toBe("high");
    expect(high.notes).toBe("annual monitoring audiogram");

    // …and reads back as one dated audiogram.
    const audiograms = getAudiograms(profileId);
    expect(audiograms).toHaveLength(1);
    expect(audiograms[0].date).toBe("2026-03-04");
    expect(audiograms[0].readings).toHaveLength(3);
    expect(hasAudiogramRows(profileId)).toBe(true);
  });

  it("re-saving a date corrects it in place, with an honest inserted/updated/unchanged split", () => {
    const profileId = makeProfile("audiogram-upsert");
    const first = recordAudiogram(profileId, {
      date: "2026-05-05",
      thresholds: [
        { ear: "right", hz: 2000, dbHl: 20 },
        { ear: "right", hz: 4000, dbHl: 30 },
      ],
    });
    expect(first).toMatchObject({
      kind: "saved",
      counts: { inserted: 2, updated: 0, unchanged: 0 },
    });

    // Same date again: one value corrected, one identical, one new frequency.
    const second = recordAudiogram(profileId, {
      date: "2026-05-05",
      thresholds: [
        { ear: "right", hz: 2000, dbHl: 20 }, // unchanged
        { ear: "right", hz: 4000, dbHl: 35 }, // updated
        { ear: "right", hz: 8000, dbHl: 50 }, // inserted
      ],
    });
    expect(second).toMatchObject({
      kind: "saved",
      counts: { inserted: 1, updated: 1, unchanged: 1 },
    });
    // No duplicate rows stacked up for the corrected frequency.
    expect(getAudiograms(profileId)).toHaveLength(1);
    expect(getAudiogramReadings(profileId)).toHaveLength(3);
    const corrected = getAudiogramReadings(profileId).find(
      (r) => r.hz === 4000
    )!;
    expect(corrected.dbHl).toBe(35);
  });

  it("an all-blank submit stores nothing and says so, instead of inventing readings", () => {
    const profileId = makeProfile("audiogram-empty");
    expect(
      recordAudiogram(profileId, { date: "2026-01-01", thresholds: [] })
    ).toEqual({ kind: "no-thresholds" });
    expect(hasAudiogramRows(profileId)).toBe(false);
  });

  it("a SYNC never overwrites a hand-corrected threshold (the isEditLocked contract)", () => {
    const profileId = makeProfile("audiogram-edit-lock");
    recordAudiogram(profileId, {
      date: "2026-02-02",
      thresholds: [{ ear: "left", hz: 4000, dbHl: 30 }],
    });
    // Make the row look integration-owned and hand-corrected, exactly as an imported
    // row edited in the biomarker editor would be.
    db.prepare(
      `UPDATE medical_records SET external_id = 'audiometry:e2e-1', edited = 1
        WHERE profile_id = ?`
    ).run(profileId);

    const synced = recordAudiogram(
      profileId,
      { date: "2026-02-02", thresholds: [{ ear: "left", hz: 4000, dbHl: 99 }] },
      "sync"
    );
    expect(synced).toMatchObject({
      kind: "saved",
      counts: { inserted: 0, updated: 0, unchanged: 0, edited: 1 },
    });
    expect(getAudiogramReadings(profileId)[0].dbHl).toBe(30);

    // The same write from the MANUAL surface is the person themself, so it lands.
    recordAudiogram(profileId, {
      date: "2026-02-02",
      thresholds: [{ ear: "left", hz: 4000, dbHl: 45 }],
    });
    expect(getAudiogramReadings(profileId)[0].dbHl).toBe(45);
  });

  it("deleting an audiogram removes exactly that date's thresholds", () => {
    const profileId = makeProfile("audiogram-delete");
    recordAudiogram(profileId, {
      date: "2024-01-01",
      thresholds: [{ ear: "right", hz: 1000, dbHl: 10 }],
    });
    recordAudiogram(profileId, {
      date: "2026-01-01",
      thresholds: [
        { ear: "right", hz: 1000, dbHl: 20 },
        { ear: "left", hz: 1000, dbHl: 25 },
      ],
    });
    expect(deleteAudiogram(profileId, "2026-01-01")).toEqual({
      kind: "deleted",
      removed: 2,
    });
    expect(getAudiograms(profileId).map((a) => a.date)).toEqual(["2024-01-01"]);
    expect(deleteAudiogram(profileId, "2030-09-09")).toEqual({
      kind: "not-found",
    });
  });

  it("scopes every read to the profile", () => {
    const mine = makeProfile("audiogram-mine");
    const theirs = makeProfile("audiogram-theirs");
    recordAudiogram(theirs, {
      date: "2026-07-07",
      thresholds: [{ ear: "right", hz: 4000, dbHl: 70 }],
    });
    expect(getAudiogramReadings(mine)).toEqual([]);
    expect(getHearingBaseline(mine)).toBeNull();
    expect(hasAudiogramRows(mine)).toBe(false);
  });
});

describe("the ototoxic crosscheck cites the hearing baseline (#1600)", () => {
  function addOtotoxicMed(profileId: number): number {
    return Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, obligation)
           VALUES (?, 'Gentamicin 80 mg', 1, 'medication', 'must')`
        )
        .run(profileId).lastInsertRowid
    );
  }

  it("says nothing extra when the profile has no audiogram on file", () => {
    const profileId = makeProfile("ototoxic-no-baseline");
    addOtotoxicMed(profileId);
    const [hit] = getOtotoxicWarnings(profileId);
    expect(hit.baseline).toBeNull();
    expect(ototoxicHasShift(hit)).toBe(false);
    expect(ototoxicDetail(hit)).not.toContain("Hearing baseline on file");
    // The pre-#1600 note is intact: still cited, still never prescriptive.
    expect(ototoxicDetail(hit)).toContain("discuss");
    expect(ototoxicDetail(hit)).toContain("Source:");
  });

  it("cites the newest audiogram when one exists", () => {
    const profileId = makeProfile("ototoxic-baseline");
    addOtotoxicMed(profileId);
    recordAudiogram(profileId, {
      date: "2026-04-01",
      thresholds: [
        { ear: "right", hz: 4000, dbHl: 35 },
        { ear: "left", hz: 4000, dbHl: 20 },
      ],
    });
    const [hit] = getOtotoxicWarnings(profileId);
    expect(hit.baseline).toMatchObject({
      latestDate: "2026-04-01",
      baselineDate: null,
    });
    const detail = ototoxicDetail(hit);
    expect(detail).toContain("Hearing baseline on file: audiogram 2026-04-01");
    expect(detail).toContain("35 dB HL at 4 kHz, right ear");
    // The guardrail still has the last word.
    expect(detail.indexOf("Hearing baseline")).toBeLessThan(
      detail.indexOf("Informational —")
    );
  });

  it("names the DOCUMENTED THRESHOLD SHIFT — the conjunction the crosscheck could not see", () => {
    const profileId = makeProfile("ototoxic-shift");
    addOtotoxicMed(profileId);
    recordAudiogram(profileId, {
      date: "2024-01-01",
      thresholds: [
        { ear: "right", hz: 4000, dbHl: 25 },
        { ear: "right", hz: 8000, dbHl: 30 },
      ],
    });
    recordAudiogram(profileId, {
      date: "2026-01-01",
      thresholds: [
        { ear: "right", hz: 4000, dbHl: 40 },
        { ear: "right", hz: 8000, dbHl: 45 },
      ],
    });
    const [hit] = getOtotoxicWarnings(profileId);
    expect(ototoxicHasShift(hit)).toBe(true);
    const detail = ototoxicDetail(hit);
    expect(detail).toContain("documented threshold shift since 2024-01-01");
    expect(detail).toContain("15 dB across 4 kHz and 8 kHz, right ear");
    // The finding's identity and reach are UNCHANGED by the hearing record — a
    // baseline makes the note more specific, it never turns it into a new send.
    expect(hit.dedupeKey).toBe(`ototoxic:${hit.medId}:aminoglycoside`);
  });
});
