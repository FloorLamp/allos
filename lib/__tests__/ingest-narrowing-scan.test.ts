import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// THE NARROWING LEDGER (issue #2243 decision 5, #2205 phase 0).
//
// ── WHAT THIS RATCHETS, AND WHY IT IS A LEDGER RATHER THAN A DATAFLOW SCAN ──
//
// The rule phase 0 establishes is: PRESERVE AT THE SOURCE'S OWN GRAIN; NARROW AT THE
// DESTINATION, per the grain that destination declares (lib/time-columns.ts). The
// failure it fixes was invisible precisely because it happened early — `hl7Date`
// truncated an HL7 v3 TS at its eighth character and `isoDate` did `v.slice(0, 10)`,
// three layers before any destination column was chosen, so 21% of production's
// clinical readings became day-grained without anyone deciding they should be.
//
// A scan CANNOT follow a value from a parser to a column, so it cannot prove that rule
// directly. What it can do is what this repo already does for hand-built instants
// (lib/__tests__/instant-writer-scan.test.ts's HANDBUILT_ALLOW), icon buttons and page
// widths: keep a REGISTRY of the places that still narrow, each with a stated reason
// and a frozen count that may only shrink. A new narrowing in the clinical-ingest
// surface fails; converting one must lower its count in the same change.
//
// ── SCOPE / KNOWN GAPS, stated rather than implied ──────────────────────────
//
//   • The surface is CLINICAL-DOCUMENT INGEST — the C-CDA and FHIR parsers and the AI
//     extractor's normalizers. DEVICE integrations are deliberately out (decision 6):
//     their destinations always wanted instants, so they already preserve them, and
//     nothing in phase 0 touches metric_samples ingest. #2096 tracks the one device
//     path with the same class of problem (zoneless Fitbit Takeout timestamps).
//   • The AI extraction path narrows in a place no source scan can see: the PROMPT
//     asks the model for `YYYY-MM-DD`, so a document's stated clock time never becomes
//     a value at all. That is a prompt decision with its own evidence question, not a
//     parser this ledger can count, and it is named here so it is not mistaken for
//     coverage.
//   • The detector below is textual and deliberately over-broad (see NARROWING_
//     PATTERNS). A false positive costs one ledger entry with a reason; a false
//     negative would cost a silent regression, so the trade is made in that direction.
//
// PURE — reads the repo's own source as TEXT. No DB, no network.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// The clinical-document ingest surface: everything that turns a FOREIGN clinical
// document into app values.
const SCAN_TARGETS = [
  "lib/cda",
  "lib/fhir",
  "lib/medical-extract",
  "lib/fhir.ts",
  "lib/health-record-parse.ts",
  "lib/health-import.ts",
  "lib/import-shape.ts",
];

// The definition site of the convention itself preserves every grain — its own
// grammar regexes are what makes the rest of this surface able to stop narrowing.
const EXCLUDED = new Set(["lib/source-time.ts"]);

// ---- The ledger ------------------------------------------------------------
//
// A file that still narrows a source timestamp below the grain the source stated,
// with the reason the narrowing is CORRECT (a destination that genuinely cannot hold
// more) and its frozen count. Adding an entry means asserting "the information this
// discards has nowhere to go, and here is where the decision to give it somewhere
// lives". A new narrowing fails; removing one must lower the count.
const NARROWING_LEDGER: Record<string, { count: number; why: string }> = {
  "lib/fhir/resources.ts": {
    count: 1,
    why: "`appointmentDateTime` keeps the wall clock the source printed and DROPS the offset. `Appointment.start` is typed `instant`, so fhirTime hands the mapper a real absolute moment — and `appointments.scheduled_at` is a zoneless local datetime (lib/time-columns.ts) with no companion column for a zone, so there is nowhere to put it. Storing the UTC instant instead would silently reschedule every offset-bearing import (14:30-05:00 would start rendering as 19:30). #2234 splits that column by grain and explicitly leaves the zone question open; when it is answered this count drops to 0. The drop happens at the MAPPER, which knows the destination, not at the parser, which does not.",
  },
};

// ---- The detector ----------------------------------------------------------
//
// Three textual shapes cover how a timestamp actually gets narrowed in this codebase:
//
//   prefix   `.slice(0, N)` / `.substring(0, N)` / `.substr(0, N)` for an N that is a
//            timestamp prefix length (year 4, year-month 7, day 10, hour 13, minute 16,
//            second 19). This is the FHIR `v.slice(0, 10)` shape.
//   splitT   `.split("T")[0]` — the same narrowing spelled differently.
//   regex    a start-anchored regex that matches only a PREFIX of a timestamp and is
//            therefore capable of discarding its tail. This is the C-CDA
//            `/^(\d{4})(\d{2})(\d{2})/` shape. An END-ANCHORED regex (containing `$`)
//            is a VALIDATOR — it accepts or rejects the whole string and discards
//            nothing — so it does not count.
const NARROWING_PATTERNS: { name: string; re: RegExp }[] = [
  {
    name: "prefix",
    re: /\.(?:slice|substring|substr)\(\s*0\s*,\s*(?:4|7|10|13|16|19)\s*\)/g,
  },
  { name: "splitT", re: /\.split\(\s*["'`]T["'`]\s*\)\s*\[\s*0\s*\]/g },
  {
    name: "regex",
    re: /\/\^(?:[^/\n\\]|\\.)*\\d\{4\}(?:[^/\n\\]|\\.)*\\d\{2\}(?:[^/\n\\]|\\.)*\//g,
  },
];

// Strip line and block comments so the PROSE this area is full of — including the
// explanations phase 0 added, which quote the very shapes being banned — can't trip
// the scanner.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function countNarrowings(text: string): number {
  const body = stripComments(text);
  let n = 0;
  for (const { name, re } of NARROWING_PATTERNS) {
    for (const m of body.matchAll(re)) {
      // An end-anchored regex is a validator, not a narrowing.
      if (name === "regex" && m[0].includes("$")) continue;
      n++;
    }
  }
  return n;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function scannedFiles(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  for (const target of SCAN_TARGETS) {
    const abs = path.join(REPO, target);
    if (!fs.existsSync(abs)) continue;
    const files = fs.statSync(abs).isDirectory() ? walk(abs) : [abs];
    for (const full of files) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (EXCLUDED.has(rel)) continue;
      if (rel.includes("__tests__") || rel.endsWith(".test.ts")) continue;
      out.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return out;
}

describe("the ingest narrowing ledger", () => {
  it("scans a surface that actually exists", () => {
    const files = scannedFiles();
    // A silently-empty scan would make every rule below pass vacuously.
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((f) => f.rel)).toContain("lib/cda/normalize.ts");
    expect(files.map((f) => f.rel)).toContain("lib/fhir/common.ts");
  });

  it("no clinical-document parser narrows beyond its frozen ledger entry", () => {
    const violations: string[] = [];
    const seen = new Set<string>();
    for (const { rel, text } of scannedFiles()) {
      const count = countNarrowings(text);
      const allowed = NARROWING_LEDGER[rel]?.count ?? 0;
      if (count > 0) seen.add(rel);
      if (count > allowed) {
        violations.push(
          `${rel}: ${count} timestamp narrowing(s), the ledger freezes ${allowed}. ` +
            `An ingest parser must return what the SOURCE said (lib/source-time.ts's ` +
            `SourceTime) and let the DESTINATION narrow — sourceDay() for a day-grained ` +
            `column, sourceInstant() for an instant-grained one. If this narrowing is ` +
            `correct because its destination genuinely cannot hold more, raise its ` +
            `entry in lib/__tests__/ingest-narrowing-scan.test.ts WITH the reason and ` +
            `the issue that would let it shrink.`
        );
      } else if (count < allowed) {
        violations.push(
          `${rel}: ${count} timestamp narrowing(s) but the ledger freezes ${allowed}. ` +
            `You removed one — LOWER (or delete) its entry in ` +
            `lib/__tests__/ingest-narrowing-scan.test.ts so the ledger keeps shrinking.`
        );
      }
    }
    for (const rel of Object.keys(NARROWING_LEDGER)) {
      if (!seen.has(rel)) {
        violations.push(
          `${rel}: on the ledger but no longer narrows (or no longer exists) — ` +
            `remove its entry in lib/__tests__/ingest-narrowing-scan.test.ts.`
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("the ledger is exactly one entry, and it states its reason", () => {
    // Phase 0's whole claim: after it, the ONE narrowing left in either clinical
    // parser is the appointment offset, which has nowhere to go until #2234 answers
    // the zone question. If this number grows, the claim is no longer true.
    const total = Object.values(NARROWING_LEDGER).reduce(
      (n, e) => n + e.count,
      0
    );
    expect(total).toBe(1);
    const thin = Object.entries(NARROWING_LEDGER)
      .filter(([, v]) => v.why.trim().length < 40)
      .map(([rel]) => rel);
    expect(
      thin,
      `These entries need a real reason (what is discarded, why the destination ` +
        `cannot hold it, and what would let the count shrink):\n${thin.join("\n")}`
    ).toEqual([]);
  });

  it("the two parsers still return a SourceTime, not a narrowed string", () => {
    // The structural half: the ledger counts what narrows, this pins that the parser
    // boundary itself did not quietly revert to `string | null`.
    const cda = fs.readFileSync(
      path.join(REPO, "lib/cda/normalize.ts"),
      "utf8"
    );
    expect(cda).toMatch(/export function hl7Time\([^)]*\): SourceTime \| null/);
    expect(cda).toMatch(/export function effTime\([^)]*\): SourceTime \| null/);
    const fhir = fs.readFileSync(path.join(REPO, "lib/fhir/common.ts"), "utf8");
    expect(fhir).toMatch(
      /export function fhirTime\([^)]*\): SourceTime \| null/
    );
    const src = fs.readFileSync(path.join(REPO, "lib/source-time.ts"), "utf8");
    for (const arm of [/grain: "day"/, /grain: "instant"/, /grain: "local"/]) {
      expect(src).toMatch(arm);
    }
    expect(src).toMatch(/export function sourceDay\b/);
    expect(src).toMatch(/export function sourceInstant\b/);
  });
});

describe("the narrowing detector the ledger relies on", () => {
  // The ledger is only as good as its counter, so pin the shapes it must and must not
  // see. These are the exact spellings phase 0 removed.
  it("counts the two shapes this issue deleted", () => {
    expect(countNarrowings("const d = v.slice(0, 10);")).toBe(1);
    expect(
      countNarrowings("const m = /^(\\d{4})(\\d{2})(\\d{2})/.exec(s);")
    ).toBe(1);
  });

  it("counts the other spellings of the same narrowing", () => {
    expect(countNarrowings('const d = v.split("T")[0];')).toBe(1);
    expect(countNarrowings("const d = v.substring(0, 16);")).toBe(1);
  });

  it("does not count a validator, an unrelated slice, or prose", () => {
    // End-anchored: accepts or rejects, discards nothing.
    expect(
      countNarrowings("const ok = /^\\d{4}-\\d{2}-\\d{2}$/.test(s);")
    ).toBe(0);
    // Not a timestamp prefix length.
    expect(countNarrowings("const head = s.slice(0, 3);")).toBe(0);
    // Comments quoting the banned shapes (this file and lib/source-time.ts are full
    // of them) must not trip the scanner.
    expect(
      countNarrowings("// v.slice(0, 10) was the old FHIR narrowing")
    ).toBe(0);
    expect(
      countNarrowings("/* /^(\\d{4})(\\d{2})(\\d{2})/ was hl7Date */")
    ).toBe(0);
  });

  it("sees the appointment mapper's narrowing, which is the ledger's one entry", () => {
    expect(
      countNarrowings(
        "const m = /^\\d{4}-\\d{2}-\\d{2}[Tt](\\d{2}:\\d{2})/.exec(String(v).trim());"
      )
    ).toBe(1);
  });
});
