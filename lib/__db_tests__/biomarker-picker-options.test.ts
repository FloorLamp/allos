// DB INTEGRATION TIER — the shared biomarker picker options builder (#1675). The pure
// ordering rules live in lib/__tests__/biomarker-rank.test.ts and
// lib/__tests__/series-picker-options.test.ts; this pins the SQL half: which of the
// profile's own rows become each ranking signal, that the reads are profile-scoped
// (one household member's overdue HbA1c never reorders another's picker), and that
// `listCompareOptions` keeps its age gates now that its biomarker half is ranked.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  getRankedBiomarkerOptions,
  reconcileFlags,
  toggleBiomarkerSaved,
} from "@/lib/queries";
import { listCompareOptions } from "@/lib/trends-series";
import { biomarkerRankKey } from "@/lib/biomarker-rank";
import { setUserBirthdate } from "@/lib/settings";

// The Combobox shows 8 rows and an empty query keeps source order, so the head is
// what "leads the picker" actually means for a user.
const PICKER_ROWS = 8;

// Fictional analytes never appear in the curated vocabulary; the real names below are
// the ones the ranking signals attach to.
const OVERDUE = "Hemoglobin A1c"; // RETEST_DAYS 90
const FLAGGED = "LDL Cholesterol";
const STARRED = "Ferritin";
const MEASURED = "Albumin";

let profileId: number;
let otherProfileId: number;
let todayStr: string;

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addReading(
  pid: number,
  canonical: string,
  date: string,
  value: number,
  unit: string
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?)`
  ).run(pid, date, canonical, String(value), unit, canonical, value);
}

function groupOf(rows: { name: string; group: string }[], name: string) {
  return rows.find((r) => biomarkerRankKey(r.name) === biomarkerRankKey(name))
    ?.group;
}

beforeAll(() => {
  profileId = makeProfile("PICKER");
  otherProfileId = makeProfile("PICKER OTHER");
  todayStr = today(profileId);

  // Overdue: HbA1c is a 90-day cadence, so a reading 400 days old is stale.
  addReading(profileId, OVERDUE, shiftDateStr(todayStr, -400), 5.4, "%");
  // Flagged: an LDL well above the canonical band, drawn recently so its retest is
  // NOT also due — the group it lands in must come from the flag alone.
  addReading(profileId, FLAGGED, shiftDateStr(todayStr, -10), 210, "mg/dL");
  // Measured but unremarkable, and recent enough not to be retest-due.
  addReading(profileId, MEASURED, shiftDateStr(todayStr, -10), 4.5, "g/dL");
  // Starred WITHOUT any reading: a star is a declaration of interest, and the picker
  // must honour it before the profile has ever measured the analyte.
  toggleBiomarkerSaved(profileId, STARRED);
  reconcileFlags(profileId);

  // The other member's rows exist and must not leak into this profile's order.
  addReading(
    otherProfileId,
    "Uric Acid",
    shiftDateStr(todayStr, -900),
    7.9,
    "mg/dL"
  );
});

describe("getRankedBiomarkerOptions over a profile's own facts", () => {
  it("leads with the overdue analyte and the flagged one, ahead of ~200 alphabetical peers", () => {
    const rows = getRankedBiomarkerOptions(profileId, todayStr);
    expect(rows.length).toBeGreaterThan(50); // the full canonical vocabulary

    const head = rows.slice(0, PICKER_ROWS).map((r) => r.name);
    expect(head).toContain(OVERDUE);
    expect(head).toContain(FLAGGED);
    expect(groupOf(rows, OVERDUE)).toBe("due-relevant");
    expect(groupOf(rows, FLAGGED)).toBe("due-relevant");

    // The retest signal is the stronger one, so the overdue draw leads the flag.
    expect(rows.findIndex((r) => r.name === OVERDUE)).toBeLessThan(
      rows.findIndex((r) => r.name === FLAGGED)
    );
  });

  it("puts starred and measured markers in Your markers, ahead of the untouched body", () => {
    const rows = getRankedBiomarkerOptions(profileId, todayStr);
    expect(groupOf(rows, STARRED)).toBe("your-markers");
    expect(groupOf(rows, MEASURED)).toBe("your-markers");

    const firstUntouched = rows.findIndex((r) => r.group === "all-biomarkers");
    expect(firstUntouched).toBeGreaterThan(0);
    for (const name of [OVERDUE, FLAGGED, STARRED, MEASURED]) {
      expect(rows.findIndex((r) => r.name === name)).toBeLessThan(
        firstUntouched
      );
    }
  });

  it("emits each analyte once and never drops one — a picker ranks, it does not filter", () => {
    const rows = getRankedBiomarkerOptions(profileId, todayStr);
    const keys = rows.map((r) => biomarkerRankKey(r.name));
    expect(new Set(keys).size).toBe(keys.length);
    // Every group boundary is represented, so nothing fell out of the split.
    expect(new Set(rows.map((r) => r.group))).toEqual(
      new Set(["due-relevant", "your-markers", "all-biomarkers"])
    );
  });

  it("is profile-scoped: another member's overdue analyte does not reorder this picker", () => {
    const mine = getRankedBiomarkerOptions(profileId, todayStr);
    const theirs = getRankedBiomarkerOptions(otherProfileId, todayStr);
    expect(groupOf(mine, "Uric Acid")).toBe("all-biomarkers");
    expect(groupOf(theirs, "Uric Acid")).toBe("due-relevant");
    expect(groupOf(theirs, OVERDUE)).toBe("all-biomarkers");
  });

  it("honours a scoped candidate list rather than widening it", () => {
    const rows = getRankedBiomarkerOptions(profileId, todayStr, [
      MEASURED,
      OVERDUE,
    ]);
    expect(rows.map((r) => r.name)).toEqual([OVERDUE, MEASURED]);
  });
});

describe("listCompareOptions after #1675", () => {
  it("returns its biomarker half relevance-ordered and group-tagged", () => {
    const options = listCompareOptions(profileId, false);
    const names = options.biomarkers.map((o) => o.label);
    // Only analytes with stored readings are offered at all — membership unchanged.
    expect(names).toContain(OVERDUE);
    expect(names).toContain(FLAGGED);
    expect(names).not.toContain("Uric Acid");
    expect(names[0]).toBe(OVERDUE);
    expect(options.biomarkers[0].group).toBe("due-relevant");
    expect(options.biomarkers.every((o) => o.kind === "biomarker")).toBe(true);
    // Metrics carry no biomarker group — they are their own picker section.
    expect(options.metrics.every((o) => o.group == null)).toBe(true);
  });

  it("keeps the age gates: a gated metric is neither tile nor option", () => {
    // A ten-year-old profile: body fat is withheld by the growth-metrics gate, and a
    // training-restricted read drops training volume. Ranking must not reintroduce
    // either — it reorders what membership already decided.
    const child = makeProfile("PICKER CHILD");
    setUserBirthdate(child, shiftDateStr(todayStr, -3650));
    const gated = listCompareOptions(child, true);
    const keys = gated.metrics.map((o) => o.key);
    expect(keys).not.toContain("metric:bodyfat");
    expect(keys).not.toContain("metric:volume");
    expect(gated.biomarkers).toEqual([]);
  });
});
