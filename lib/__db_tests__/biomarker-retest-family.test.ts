// DB INTEGRATION TIER — the biomarker retest signal groups the 25-hydroxy
// vitamin-D variants (total, D2, D3) into ONE retest family (bug: an old D2/D3
// breakdown was flagged overdue even though a recent total vitamin D exists).
// Proves end-to-end against the real query layer that a fresh reading of any
// family member satisfies the retest for the whole family, while a genuinely
// distinct analyte (1,25-dihydroxy) is treated as its OWN family — never folded
// into the 25-OH retest (it's an incidental one-off dropped by the #587 worthiness
// gate, not silenced by a fresh 25-OH reading).

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { collectUpcoming } from "@/lib/queries";
import { seedProfile, type SeededProfile } from "./fixtures";
import { biomarkerRetestDetail } from "@/lib/biomarker-retest-copy";
import { itemDetailText } from "@/lib/upcoming-aggregate";

let p: SeededProfile;
let oldDate: string;
let recentDate: string;

function addReading(canonical: string, date: string, value: number) {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num, panel)
     VALUES (?, ?, 'lab', ?, ?, 'ng/mL', ?, ?, 'Vitamin D')`
  ).run(p.profileId, date, canonical, String(value), canonical, value);
}

function biomarkerKeys(): string[] {
  return collectUpcoming(p.profileId, p.todayStr)
    .filter((i) => i.domain === "biomarker")
    .map((i) => i.key);
}

beforeAll(() => {
  p = seedProfile("VITD");
  oldDate = shiftDateStr(p.todayStr, -1825); // ~5 years ago → past the 365d window
  recentDate = shiftDateStr(p.todayStr, -30); // within the retest window
});

describe("vitamin-D 25-hydroxy retest family", () => {
  it("a recent total satisfies the retest for old D2/D3 isoforms", () => {
    db.prepare(
      "DELETE FROM medical_records WHERE profile_id = ? AND panel = 'Vitamin D'"
    ).run(p.profileId);
    addReading("Vitamin D2, 25-Hydroxy", oldDate, 8);
    addReading("Vitamin D3, 25-Hydroxy", oldDate, 22);
    addReading("Vitamin D, 25-Hydroxy", recentDate, 34);

    const keys = biomarkerKeys();
    // The whole family is keyed by the ONE #482 family identity now — a recent
    // member satisfies it, so it never surfaces.
    expect(keys).not.toContain("biomarker:family:vitamin-d-25-hydroxy");
  });

  it("with no recent member, the family surfaces exactly one retest item", () => {
    db.prepare(
      "DELETE FROM medical_records WHERE profile_id = ? AND panel = 'Vitamin D'"
    ).run(p.profileId);
    addReading("Vitamin D2, 25-Hydroxy", oldDate, 8);
    addReading("Vitamin D3, 25-Hydroxy", shiftDateStr(p.todayStr, -1800), 22);

    const keys = biomarkerKeys().filter((k) => k.includes("vitamin-d"));
    // One item for the whole family, keyed by the stable #482 family identity (not
    // the newest member's name), so a dismiss on it silences the family and the key
    // doesn't drift as which isoform is newest changes.
    expect(keys).toEqual(["biomarker:family:vitamin-d-25-hydroxy"]);
  });

  it("the active 1,25-dihydroxy metabolite is a separate (non-worthy) family", () => {
    db.prepare(
      "DELETE FROM medical_records WHERE profile_id = ? AND panel = 'Vitamin D'"
    ).run(p.profileId);
    // Fresh total 25-OH, plus an old active metabolite. The active 1,25 test is a
    // DISTINCT family (never folded into / satisfied by the 25-OH retest — the point
    // of #482) but is itself an incidental one-off, not routine monitoring, so after
    // the #587 worthiness gate it's excluded from the retest nudge entirely rather
    // than nagging overdue. Neither the (recent) 25-OH family nor the 1,25 metabolite
    // surfaces here — proving 1,25 didn't inherit the 25-OH clock in either direction.
    addReading("Vitamin D, 25-Hydroxy", recentDate, 34);
    addReading("Vitamin D, 1,25-Dihydroxy", oldDate, 40);

    const keys = biomarkerKeys();
    expect(keys).not.toContain("biomarker:family:vitamin-d-25-hydroxy");
    expect(keys).not.toContain("biomarker:vitamin d, 1,25-dihydroxy");
  });
});

// #3526 — THE LOGIN-LESS HALF, pinned where the generator actually runs. This layer
// has no login, so the sentence it composes keeps the RAW ISO day: the digest and the
// Telegram builders read `detail` verbatim and have no prefs to resolve. The row also
// carries the same facts structurally, so a surface WITH a login re-composes the same
// sentence with the day in the viewer's shape — and the two must be the SAME facts, or
// the page and the digest would quietly state different days.
describe("the retest row carries its facts and keeps the raw ISO day", () => {
  it("composes `detail` from the carried facts, in ISO, and re-renders through prefs", () => {
    db.prepare(
      "DELETE FROM medical_records WHERE profile_id = ? AND panel = 'Vitamin D'"
    ).run(p.profileId);
    addReading("Vitamin D, 25-Hydroxy", oldDate, 20);

    const item = collectUpcoming(p.profileId, p.todayStr).find(
      (i) => i.domain === "biomarker"
    )!;
    expect(item.retest).toBeDefined();
    expect(item.retest!.effectiveDate).toBe(oldDate);
    expect(item.retest!.intervalMonths).toBeGreaterThan(0);
    expect(item.detail).toContain(`Last tested ${oldDate} (`);
    expect(item.detail).toBe(biomarkerRetestDetail(item.retest!, oldDate));

    // The same row through the render boundary: same facts, the login's day shape.
    // A day-first login reads "29 May 2025", never the ISO run of digits.
    const [year, , day] = oldDate.split("-");
    const rendered = itemDetailText(item, p.todayStr, {
      dateFormat: "dmy",
      timeFormat: "24h",
    })!;
    expect(rendered).toContain(`Last tested ${Number(day)} `);
    expect(rendered).toContain(` ${year} (`);
    expect(rendered).not.toContain(oldDate);
  });
});
