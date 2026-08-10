import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rangeBadgeFlag } from "@/lib/reference-range";
import {
  optimalShareRows,
  type NamedBiomarkerReading,
} from "@/lib/longevity-pillars";
import type { CanonicalBiomarker } from "@/lib/types";

// Biomarker rows render the CANONICAL name, and lead with the value (#1501).
//
// `medical_records` carries two names: `name` (the raw string the lab/CCD
// delivered — often shouting case, "URIC ACID") and `canonical_name` (the raw name
// snapped onto the controlled vocabulary, which is already clean, deliberately-cased
// display text: "Uric Acid", "eGFR", "hs-CRP", "Lipoprotein(a)"). The canonical name
// therefore IS the display name — nothing needs re-casing, and re-casing it would
// MANGLE the vocabulary's deliberate casing. The bug was purely a rendering-site
// one: surfaces that held the canonical name and printed the raw one.
//
// The scan below is the standing guard (the notes-text.test.ts shape): a .tsx that
// holds a `canonical_name`/`canonicalName` and yet renders a BARE `{x.name}` is the
// exact signature of that defect. The three allowlisted sites are the deliberate
// exceptions — the no-canonical fallback branch, and the provenance/edit surfaces
// where showing what the document literally said is the whole point.
//
// The filter is deliberately the canonical_name/canonicalName IDENTIFIER, not the
// looser word "canonical": widening it sweeps in every `{profile.name}`,
// `{eq.name}` and `{c.name}` in any file that merely mentions canonical anything,
// and a 13-entry allowlist of non-analyte names is noise that hides the next real
// one. One known raw site sits outside that reach by naming its variable
// `canonical` — the biomarker detail page's "Reported as" column
// (app/(app)/biomarkers/view/page.tsx) — and it is a DELIBERATE provenance surface
// too, so the guard's blind spot and its exemption coincide.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

// A `.name` rendered as the direct child of a JSX expression container, optionally
// with a quoted `?? ""` fallback. `{r.canonicalName ?? r.name}` (the correct
// pattern), a prop (`name={r.name}`) and a template (`${r.name}`) don't match.
const BARE_NAME =
  /(?<![=$])\{\s*[A-Za-z_$][\w$]*\.name\s*(?:\?\?\s*(['"]).*?\1)?\s*\}/;

// Each entry: the file, and WHY rendering the raw name there is correct.
const ALLOWED: Record<string, string> = {
  "components/BiomarkersTable.tsx":
    "the no-canonical fallback branch (guarded by `if (!r.canonical_name)`) — the correct precedent",
  "components/ExtractedRecords.tsx":
    "import-review provenance: the row must show what the document actually said",
  "components/EditableRecordRow.tsx":
    "the edit surface: you edit the raw stored name, so it renders raw",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("canonical-name rendering guard (#1501)", () => {
  it("no canonical-aware surface renders a bare raw {x.name}", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(REPO, dir))) {
        const src = fs.readFileSync(file, "utf8");
        // Only surfaces that KNOW about canonical names — those are the ones that
        // hold the clean string and could be printing the raw one instead.
        if (!src.includes("canonical_name") && !src.includes("canonicalName"))
          continue;
        const rel = path.relative(REPO, file).split(path.sep).join("/");
        if (rel in ALLOWED) continue;
        src.split("\n").forEach((line, i) => {
          if (BARE_NAME.test(line))
            offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(
      offenders,
      `Render the canonical name: \`{x.canonical_name ?? x.name}\` (see components/BiomarkersTable.tsx).\n` +
        `A provenance/edit surface that must show the raw string goes on this test's ALLOWED list with a reason.\n` +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("the allowlisted exceptions still exist (so a stale entry can't hide a new defect)", () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(fs.existsSync(path.join(REPO, rel)), rel).toBe(true);
    }
  });
});

// ── The value-led row model (#1501-B) ───────────────────────────────────────

describe("rangeBadgeFlag: the badge → MedicalValue flag translation", () => {
  it("maps each judged badge to its directional flag; optimal announces nothing", () => {
    expect(rangeBadgeFlag("high")).toBe("high");
    expect(rangeBadgeFlag("low")).toBe("low");
    expect(rangeBadgeFlag("above-optimal")).toBe("non-optimal-high");
    expect(rangeBadgeFlag("below-optimal")).toBe("non-optimal-low");
    expect(rangeBadgeFlag("optimal")).toBeNull();
    expect(rangeBadgeFlag("unknown")).toBeNull();
  });

  it("never produces the legacy directionless flag (it would drop the caret)", () => {
    const badges = [
      "optimal",
      "above-optimal",
      "below-optimal",
      "high",
      "low",
      "unknown",
    ] as const;
    for (const b of badges) expect(rangeBadgeFlag(b)).not.toBe("non-optimal");
  });
});

function cb(partial: Partial<CanonicalBiomarker>): CanonicalBiomarker {
  return partial as unknown as CanonicalBiomarker;
}

const totalChol = cb({
  name: "Total Cholesterol",
  unit: "mg/dL",
  direction: "lower_better",
  ref_low: 125,
  ref_high: 200,
  optimal_low: null,
  optimal_high: 180,
});

const vitD = cb({
  name: "Vitamin D, 25-OH",
  unit: "ng/mL",
  direction: "higher_better",
  ref_low: 30,
  ref_high: 100,
  optimal_low: 40,
  optimal_high: 80,
});

describe("optimalShareRows carries the reading, not just a verdict", () => {
  const readings: NamedBiomarkerReading[] = [
    {
      // The raw lab string is shouting case; the canonical is the clean one.
      name: "TOTAL CHOLESTEROL",
      canonicalName: "Total Cholesterol",
      value_num: 195,
      unit: "mg/dL",
      cb: totalChol,
    },
    {
      name: "VITAMIN D, 25-OH",
      canonicalName: "Vitamin D, 25-OH",
      value_num: 55,
      unit: "ng/mL",
      cb: vitD,
    },
  ];

  it("keeps BOTH names so the surface can render the canonical and link by it", () => {
    const rows = optimalShareRows(readings);
    const chol = rows.find((r) => r.canonicalName === "Total Cholesterol");
    expect(chol?.name).toBe("TOTAL CHOLESTEROL");
    expect(chol?.canonicalName).toBe("Total Cholesterol");
  });

  it("carries the value/unit and a flag derived from THIS row's badge", () => {
    const rows = optimalShareRows(readings);
    const chol = rows.find((r) => r.canonicalName === "Total Cholesterol");
    expect(chol?.value).toBe("195");
    expect(chol?.unit).toBe("mg/dL");
    expect(chol?.badge).toBe("above-optimal");
    expect(chol?.flag).toBe("non-optimal-high");

    const d = rows.find((r) => r.canonicalName === "Vitamin D, 25-OH");
    expect(d?.badge).toBe("optimal");
    expect(d?.flag).toBeNull(); // an optimal reading announces no severity
  });

  it("formats the curated optimal band, one-sided bands included", () => {
    const rows = optimalShareRows(readings);
    expect(
      rows.find((r) => r.canonicalName === "Total Cholesterol")?.optimalText
    ).toBe("≤180");
    expect(
      rows.find((r) => r.canonicalName === "Vitamin D, 25-OH")?.optimalText
    ).toBe("40–80");
  });

  it("omits the band when the reading's unit isn't the canonical one", () => {
    // 5.05 mmol/L converts to ~195 mg/dL for the judgment, but printing the
    // mg/dL band beside a mmol/L value would be a false comparison.
    const [row] = optimalShareRows([
      {
        name: "Total Cholesterol",
        canonicalName: "Total Cholesterol",
        value_num: 5.05,
        unit: "mmol/L",
        cb: totalChol,
      },
    ]);
    expect(row.value).toBe("5.05");
    expect(row.unit).toBe("mmol/L");
    expect(row.optimalText).toBeNull();
  });

  it("trims float noise off a displayed value", () => {
    const [row] = optimalShareRows([
      {
        name: "Vitamin D, 25-OH",
        canonicalName: "Vitamin D, 25-OH",
        value_num: 55.000000000000004,
        unit: "ng/mL",
        cb: vitD,
      },
    ]);
    expect(row.value).toBe("55");
  });
});
