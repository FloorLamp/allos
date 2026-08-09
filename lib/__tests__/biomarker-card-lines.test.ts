import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATE_AGE_SEPARATOR,
  STALE_AGE_TITLE,
  readingDateLine,
} from "@/lib/reading-date-line";
import { activeFacetCount, filterTriggerLabel } from "@/lib/record-facets";

// What a biomarker reading spends its card lines on (issue #2316).
//
// One reading cost roughly 300px on a phone — eight lines, four of which carried
// nothing the reader could not already see: `PANEL Lipids` under a group header
// reading "Lipids", `CATEGORY lab` on a row whose whole panel is lab, and a DATE
// stack printing the same instant twice with a provenance link stapled underneath.
//
// Two halves are pinned here. The SLOT half is a source scan: which cells claim a
// card line is declared in the JSX, at the cell, and a scan is what reads a
// declaration (the pure suite is DOM-free — components/BiomarkersTable.tsx is a
// client component wired to Server Actions and cannot be rendered here). The
// COMPOSITION half is the pure lib/ modules the cells now render through.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TABLE = path.join(REPO, "components/BiomarkersTable.tsx");

interface CellTag {
  label: string | null;
  slot: string | null;
}

// Every `<Td …>` opening tag in the table, reduced to (label, slot). Opening tags
// in this file contain no `>` before their own — the attribute values are strings
// and simple `{…}` expressions — so the scan can stop at the first one.
function cellTags(): CellTag[] {
  const src = fs.readFileSync(TABLE, "utf8");
  const out: CellTag[] = [];
  const re = /<Td\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const end = src.indexOf(">", m.index);
    const tag = src.slice(m.index, end);
    out.push({
      label: tag.match(/label="([^"]+)"/)?.[1] ?? null,
      slot: tag.match(/slot="([^"]+)"/)?.[1] ?? null,
    });
  }
  return out;
}

function tagsLabelled(label: string): CellTag[] {
  return cellTags().filter((t) => t.label === label);
}

// A `<th>` whose only content is this column's name.
function hasHeader(label: string): boolean {
  const src = fs.readFileSync(TABLE, "utf8");
  return new RegExp(`<th[^>]*>\\s*${label}\\s*</th>`).test(src);
}

describe("Panel and Category are desktop-only detail (#2316)", () => {
  it("the Panel cells keep their column and claim no card slot", () => {
    const tags = tagsLabelled("Panel");
    // Two: the resolved-taxonomy cell and the un-canonicalized fallback. Asserting
    // they exist keeps the slot check below from passing vacuously.
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t.slot).toBeNull();
    // The column itself is untouched — it is still there at `md` and up, with the
    // filter link that makes a facet in a narrow column worth having.
    expect(hasHeader("Panel")).toBe(true);
  });

  it("the Category cells keep their column and claim no card slot", () => {
    const tags = tagsLabelled("Category");
    // Two: the stored row's filter-linked tag and the derived index's plain one.
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t.slot).toBeNull();
    expect(hasHeader("Category")).toBe(true);
  });

  it("the Notes cell still claims one — notes differ per reading", () => {
    const tags = tagsLabelled("Notes");
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t.slot).toBe("meta");
    expect(hasHeader("Notes")).toBe(true);
  });

  it("the Date cell still claims one — it is now the row's only date line", () => {
    const tags = tagsLabelled("Date");
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t.slot).toBe("meta");
  });
});

describe("readingDateLine (#2316)", () => {
  const TODAY = "2026-08-09";

  it("is ONE line carrying the ISO date and the compact age", () => {
    const line = readingDateLine(
      { date: "2026-06-03", category: "lab" },
      TODAY,
      true
    );
    expect(line.date).toBe("2026-06-03");
    // The #1216 formatter's own bucket — not a second rounding of the same span.
    expect(line.age).toBe("2mo");
    expect(`${line.date}${DATE_AGE_SEPARATOR}${line.age}`).toBe(
      "2026-06-03 · 2mo"
    );
    expect(line.stale).toBe(false);
    expect(line.ageTitle).toBeNull();
  });

  it("puts the amber treatment and its title on the AGE token when stale", () => {
    const line = readingDateLine(
      { date: "2024-01-05", category: "lab" },
      TODAY,
      true
    );
    expect(line.stale).toBe(true);
    expect(line.age).toBe("3y");
    expect(line.ageClassName).toContain("amber");
    expect(line.ageTitle).toBe(STALE_AGE_TITLE);
  });

  it("a current reading's age is not amber", () => {
    const line = readingDateLine(
      { date: "2026-07-30", category: "lab" },
      TODAY,
      true
    );
    expect(line.ageClassName).not.toContain("amber");
    expect(line.ageTitle).toBeNull();
  });

  it("a category with no retest clock never goes amber, however old", () => {
    // `reference` (blood type and friends) is exempt in the biomarker freshness
    // adapter — the value cannot change, so nothing about it is overdue.
    const line = readingDateLine(
      { date: "2004-01-05", category: "reference" },
      TODAY,
      true
    );
    expect(line.stale).toBe(false);
    expect(line.ageClassName).not.toContain("amber");
  });

  it("an older reading in a run prints its date alone", () => {
    const line = readingDateLine(
      { date: "2024-01-05", category: "lab" },
      TODAY,
      false
    );
    expect(line.age).toBeNull();
    expect(line.stale).toBe(false);
    expect(line.ageTitle).toBeNull();
  });
});

describe("the collapsed filter block's active count (#2316)", () => {
  it("counts only the facets that are behind the disclosure", () => {
    expect(activeFacetCount({})).toBe(0);
    expect(activeFacetCount({ category: "lab", panel: "lipids" })).toBe(2);
    expect(
      activeFacetCount({
        category: "lab",
        panel: "lipids",
        range: "oor",
        current: true,
      })
    ).toBe(4);
  });

  it("does not count the search field, which stays visible", () => {
    // `q` is not a facet here: it is the one control the phone keeps out, so it can
    // never be a hidden filter and must not inflate a count about hidden ones.
    expect(activeFacetCount({ current: false })).toBe(0);
  });

  it("the trigger states the count only when there is one", () => {
    expect(filterTriggerLabel(0)).toBe("Filters");
    expect(filterTriggerLabel(2)).toBe("Filters · 2");
  });
});
