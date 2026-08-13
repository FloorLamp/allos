import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MEDICAL_DISCLAIMER,
  NOT_A_DIAGNOSIS,
  NEVER_PRESCRIPTIVE,
  DATASET_DISCLAIMER,
  DISCLAIMER_FULL,
  DISCLAIMER_SECTIONS,
  DISCLAIMER_PHRASINGS,
  hasDisclaimerPhrasing,
  stripDisclaimerSentences,
} from "@/lib/disclaimers";

// Source-scan guard for the disclaimer-consolidation invariant (issue #1049), in the
// profile-scoping / telegram-chokepoint / immediate-tx / notes-text tradition. Disclaimer
// copy used to live as ~40 inline literals that drifted into ~15 near-variants of one
// sentence. Per the owner's ratified call, all of that boilerplate is now DELETED from the
// surfaces: the disclaimer lives on ONE page (/disclaimer, footer-linked), and the domain
// pages carry no disclaimer prose at all. This test reads the repo's own source as TEXT
// (no DB, no network — it stays "pure") and fails the build if a disclaimer literal
// reappears under app/ or components/, so the consolidation can't silently regrow.
//
// STRICT: because no legitimate inline disclaimer remains, there are ZERO `disclaimer-ok:`
// escapes in the tree, and the second test below pins that count at 0. The escape hatch
// stays wired only for a future, reviewed carve-out; the PHQ-9 crisis contract (#716) is
// NOT one — it renders crisis RESOURCES (a safety surface) sourced from
// lib/crisis-resources.ts constants, which are not disclaimer phrasings and never trip
// this scan. lib/disclaimers.ts itself is out of scan scope (it lives under lib/, and the
// only remaining consumer is the /disclaimer page + tests).

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

// The banned disclaimer phrasings. They used to be defined HERE, which is exactly why
// #2342 could happen: a rule that lives in one test can only reach what that test reads.
// The list now lives in lib/disclaimers.ts beside the copy it protects, and the dataset
// scan below, the generator scan, and the runtime clamp in lib/coverage-gaps all read
// the same one.
const BANNED: readonly RegExp[] = DISCLAIMER_PHRASINGS;

// ── The curated-dataset half (#2342) ──────────────────────────────────────────
//
// The scan above reads SOURCE under app/ and components/. The banned sentence reached
// the domain pages anyway, through a route it cannot see: curated JSON under lib/,
// rendered verbatim. `lib/canonical-biomarkers.json`'s `note` supplies the band-note
// clause on the reading detail page and `lib/datasets/data/biomarker-descriptions.json`'s
// `description` fills its explainer card — 40 entries carried a phrasing, one of them
// byte-identical to NOT_A_DIAGNOSIS, a hand-copied duplicate of the constant this whole
// consolidation exists to be the only copy of.
//
// The rule is about RENDERED USER-FACING COPY, not about file type, so the scan covers
// the datasets' ENTRY payloads: every string inside a dataset's rows, whatever the field
// is called, because "and siblings" is not a list anybody will keep current.
//
// DELIBERATELY OUT OF SCOPE — file-level metadata: `$comment`, the top-level
// `description` (the dataset's own provenance blurb), `citation`, `source`, `license`.
// Those describe the dataset to a maintainer reading the JSON; no surface renders them,
// and several are sourcing/licensing statements where the framing is the point. A field
// moving from metadata into rendered copy is a change to the render site, which the
// source scan above still sees.
const DATASET_METADATA_KEYS = new Set([
  "$comment",
  "description",
  "citation",
  "source",
  "license",
]);

// Datasets whose rendered copy is generated. The GENERATOR is scanned too, because the
// output guard alone leaves the prompt free to re-teach the model the sentence on the
// next `npm run gen:` — the #2342 root cause. Only the generators of the datasets whose
// rendered fields this issue found polluted are listed; the remaining gen-*.ts scripts
// still carry disclaimer framing in their own prose, and their datasets' entry payloads
// are clean, so widening the list is a separate, deliberate pass rather than a silent
// one taken here.
const SCANNED_GENERATORS = ["scripts/gen-canonical-biomarkers.ts"];

// TypeScript modules that are themselves curated copy — CURATED_LABS holds the `note`
// of every hand-curated canonical entry, and `curateBiomarkers` writes it back over the
// JSON on every `--curated-only` regeneration. Stripping the JSON alone would have been
// undone by the next run (the idempotency test in biomarker-loinc.test.ts is what
// caught it), so the source is scanned too, with COMMENTS removed: the surrounding
// commentary explains the app's posture to a maintainer and is not rendered anywhere.
const CURATED_COPY_MODULES = ["lib/curated/reference-data.ts"];

function datasetFiles(): string[] {
  const out = [path.join(REPO, "lib", "canonical-biomarkers.json")];
  const dir = path.join(REPO, "lib", "datasets", "data");
  for (const name of fs.readdirSync(dir).sort())
    if (name.endsWith(".json")) out.push(path.join(dir, name));
  return out;
}

// Every string inside a dataset's entry payloads, with a JSON path for the failure
// message. Top-level metadata keys are skipped (see above).
function datasetCopy(file: string): { where: string; text: string }[] {
  const rel = path.relative(REPO, file).split(path.sep).join("/");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
    string,
    unknown
  >;
  const out: { where: string; text: string }[] = [];
  const walk = (node: unknown, at: string): void => {
    if (typeof node === "string")
      out.push({ where: `${rel}#${at}`, text: node });
    else if (Array.isArray(node))
      node.forEach((v, i) => walk(v, `${at}[${i}]`));
    else if (node && typeof node === "object")
      for (const [k, v] of Object.entries(node)) walk(v, `${at}.${k}`);
  };
  for (const [key, value] of Object.entries(parsed)) {
    if (DATASET_METADATA_KEYS.has(key)) continue;
    walk(value, key);
  }
  return out;
}

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs, [".ts", ".tsx"])) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (rel.includes("__tests__") || rel.endsWith(".test.tsx")) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

// Strip line/block comments so prose mentioning a disclaimer phrase (a doc comment
// explaining the framing) can't trip the scanner — only real code counts.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("disclaimer consolidation guard (issue #1049)", () => {
  it("no surface under app/ or components/ hand-writes a disclaimer literal", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      const code = stripComments(text);
      const lines = code.split("\n");
      lines.forEach((line, i) => {
        if (line.includes("disclaimer-ok")) return; // marker escape
        if (BANNED.some((re) => re.test(line)))
          offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `These hand-write a disclaimer phrase. Render a reference to a constant from ` +
        `lib/disclaimers.ts (MEDICAL_DISCLAIMER / NOT_A_DIAGNOSIS / NEVER_PRESCRIPTIVE / ` +
        `DATASET_DISCLAIMER) instead of a literal:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("carries ZERO disclaimer-ok escapes — the surfaces hold no inline disclaimers", () => {
    const escapes: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      text.split("\n").forEach((line, i) => {
        if (line.includes("disclaimer-ok")) escapes.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      escapes,
      `The disclaimer boilerplate was fully deleted from the surfaces, so no ` +
        `disclaimer-ok escape should exist. If a NEW reviewed carve-out genuinely ` +
        `needs one, update this test with the justification:\n${escapes.join("\n")}`
    ).toEqual([]);
  });

  it("no surface under app/ or components/ imports a disclaimer constant except the /disclaimer page", () => {
    const importers: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (rel === "app/(app)/disclaimer/page.tsx") continue;
      if (/from\s*["']@\/lib\/disclaimers["']/.test(text)) importers.push(rel);
    }
    expect(
      importers,
      `The disclaimer copy is consolidated onto /disclaimer; a domain surface should ` +
        `not import from @/lib/disclaimers (delete the inline disclaimer instead):\n` +
        importers.join("\n")
    ).toEqual([]);
  });

  it("the canonical constants carry the expected posture", () => {
    expect(MEDICAL_DISCLAIMER).toBe("Informational, not medical advice.");
    expect(NOT_A_DIAGNOSIS).toMatch(/not a diagnosis/i);
    expect(NEVER_PRESCRIPTIVE).toMatch(/never prescriptive/i);
    expect(DATASET_DISCLAIMER).toMatch(/curated subset/i);
  });

  it("DISCLAIMER_FULL covers every required framing (the single surface's content)", () => {
    expect(DISCLAIMER_SECTIONS.length).toBeGreaterThanOrEqual(5);
    expect(DISCLAIMER_FULL).toMatch(/not medical advice/i);
    expect(DISCLAIMER_FULL).toMatch(/not.*diagnos/i);
    expect(DISCLAIMER_FULL).toMatch(/curated/i);
    expect(DISCLAIMER_FULL).toMatch(/extract/i);
    expect(DISCLAIMER_FULL).toMatch(/emergency/i);
    expect(DISCLAIMER_FULL).toMatch(/self-hosted|your data/i);
  });

  it("the guard actually fires on a planted literal and passes a constant reference", () => {
    const planted = `<p>Informational, not medical advice.</p>`;
    const reference = `<p>{MEDICAL_DISCLAIMER}</p>`;
    expect(BANNED.some((re) => re.test(planted))).toBe(true);
    expect(BANNED.some((re) => re.test(reference))).toBe(false);
  });
});

describe("curated datasets carry no disclaimer copy either (issue #2342)", () => {
  it("no curated dataset entry field hand-writes a disclaimer phrasing", () => {
    const offenders: string[] = [];
    for (const file of datasetFiles())
      for (const { where, text } of datasetCopy(file))
        if (hasDisclaimerPhrasing(text))
          offenders.push(`${where}\n    ${text.slice(0, 140)}`);
    expect(
      offenders,
      `Curated dataset copy renders VERBATIM on a domain page, so it is governed by ` +
        `the same #1049 rule as a source literal: the disclaimer lives on /disclaimer ` +
        `and is footer-linked from every page. Delete the sentence — do not reference ` +
        `a constant here, a dataset row is not a place to render one:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("no curated-copy module hand-writes a disclaimer phrasing in a note literal", () => {
    const offenders: string[] = [];
    for (const rel of CURATED_COPY_MODULES) {
      const code = stripComments(fs.readFileSync(path.join(REPO, rel), "utf8"));
      code.split("\n").forEach((line, i) => {
        if (BANNED.some((re) => re.test(line)))
          offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `A curated \`note\` written here is copied onto the committed dataset by ` +
        `curateBiomarkers and rendered from there, so it is governed by the same rule ` +
        `as the JSON. Delete the sentence:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the generator of a scanned dataset is not itself written in disclaimer language", () => {
    // The root cause (#2342): scripts/gen-canonical-biomarkers.ts told the model "These
    // are INFORMATIONAL, not medical advice", and the model reasonably concluded the copy
    // it generated should carry the framing too. An output-only guard leaves the next
    // `npm run gen:biomarkers` free to re-add it, so the prompt states the constraint as
    // a PROHIBITION and this pins that it stays one.
    const offenders: string[] = [];
    for (const rel of SCANNED_GENERATORS) {
      const text = fs.readFileSync(path.join(REPO, rel), "utf8");
      text.split("\n").forEach((line, i) => {
        if (BANNED.some((re) => re.test(line)))
          offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `A generator that writes RENDERED curated copy must not be written in disclaimer ` +
        `language — including in its own comments, which are the same voice the prompt ` +
        `is drafted in. State the constraint as "no disclaimer sentences":\n` +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("the generator prompt forbids the sentence and forbids restating a band", () => {
    const gen = fs.readFileSync(
      path.join(REPO, "scripts/gen-canonical-biomarkers.ts"),
      "utf8"
    );
    expect(gen).toMatch(/NO DISCLAIMER SENTENCES/);
    // #2342's "related, same question": curated prose must not restate a threshold the
    // row already carries structurally in ref_*/optimal_* — two copies of one number
    // drift, and COVERAGE_ENRICH_SYSTEM already forbids exactly this for AI-written copy.
    expect(gen).toMatch(/Do NOT restate the/);
  });

  it("a generated note that carries the sentence is stripped before it is written", () => {
    // The write-side half: a prompt is a request, `sanitizeGeneratedNote` is the
    // enforcement. Low-entropy synthetic input — no real dataset row is used.
    expect(
      stripDisclaimerSentences(
        "Marker one rises with inflammation. Informational, not medical advice."
      )
    ).toBe("Marker one rises with inflammation.");
    // Whole-boilerplate copy clamps to nothing, which callers read as "no description".
    expect(stripDisclaimerSentences("Informational, not a diagnosis.")).toBe(
      ""
    );
    // A sentence that merely CONTAINS one of the words is untouched.
    expect(
      stripDisclaimerSentences("Advice on collection timing is on the report.")
    ).toBe("Advice on collection timing is on the report.");
  });
});
