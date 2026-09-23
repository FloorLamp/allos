import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Clinical-result rows render the CANONICAL name, and lead with the value (#1501).
//
// `medical_records` carries two names: `name` (the raw string the lab/CCD
// delivered — often shouting case, "URIC ACID") and `canonical_name` (the raw name
// snapped onto the controlled vocabulary, which is already clean, deliberately-cased
// display text: "Uric Acid", "eGFR", "hs-CRP", "Lipoprotein(a)"). The canonical name
// therefore IS the display name — nothing needs re-casing, and re-casing it would
// MANGLE the vocabulary's deliberate casing. The bug was purely a rendering-site
// one: surfaces that held the canonical name and printed the raw one.
//
// The scan below is the standing guard: a .tsx that
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
// (app/(app)/results/clinical-results/view/page.tsx) — and it is a DELIBERATE provenance surface
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
  "components/ClinicalResultsTable.tsx":
    "the no-canonical fallback branch (guarded by `if (!r.canonical_name)`) — the correct precedent",
  "components/ExtractedObservations.tsx":
    "import-review provenance: the row must show what the document actually said",
  "components/EditableResultRow.tsx":
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
      `Render the canonical name: \`{x.canonical_name ?? x.name}\` (see components/ClinicalResultsTable.tsx).\n` +
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
