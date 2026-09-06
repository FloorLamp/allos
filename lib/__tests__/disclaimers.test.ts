import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISCLAIMER_SECTIONS,
  DISCLAIMER_PHRASINGS,
  hasDisclaimerPhrasing,
  stripDisclaimerSentences,
} from "@/lib/disclaimers";

// Canonical disclaimer copy lives in lib/disclaimers.ts and renders on /disclaimer.
// The IMPORT boundary — no surface under app/ or components/ imports the copy — is an
// eslint.config.mjs override now (#5347). What stays here is the dataset, generator and
// runtime copy, which is prose: no type and no selector can tell a disclaimer sentence
// from any other sentence, so it is the tier a source scan is the right answer for.
// Rendered page behavior is covered in e2e/disclaimer.spec.ts.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Dataset and generator checks share the runtime module's phrasing list.
const BANNED: readonly RegExp[] = DISCLAIMER_PHRASINGS;

// ── The curated-dataset half (#2342) ──────────────────────────────────────────
//
// Curated JSON renders verbatim. `lib/canonical-result-definitions.json`'s `note`
// supplies the band-note clause on the reading detail page and
// `lib/datasets/data/biomarker-descriptions.json`'s `description` fills its
// explainer card.
//
// The rule is about RENDERED USER-FACING COPY, not about file type, so the scan covers
// the datasets' ENTRY payloads: every string inside a dataset's rows, whatever the field
// is called, because "and siblings" is not a list anybody will keep current.
//
// DELIBERATELY OUT OF SCOPE — file-level metadata: `$comment`, the top-level
// `description` (the dataset's own provenance blurb), `citation`, `source`, `license`.
// Those describe the dataset to a maintainer reading the JSON; no surface renders them,
// and several are sourcing/licensing statements where the framing is the point.
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
const SCANNED_GENERATORS = ["scripts/gen-canonical-result-definitions.ts"];

// TypeScript modules that are themselves curated copy — CURATED_LABS holds the `note`
// of every hand-curated canonical entry, and `curateResultDefinitions` writes it back over the
// JSON on every `--curated-only` regeneration. Stripping the JSON alone would have been
// undone by the next run (the idempotency test in canonical-result-loinc.test.ts is what
// caught it), so the source is scanned too, with COMMENTS removed: the surrounding
// commentary explains the app's posture to a maintainer and is not rendered anywhere.
const CURATED_COPY_MODULES = ["lib/curated/reference-data.ts"];

function datasetFiles(): string[] {
  const out = [path.join(REPO, "lib", "canonical-result-definitions.json")];
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

// Comments in curated-copy modules do not render.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("canonical disclaimer boundary (issue #1049)", () => {
  it("keeps the shared suggestions and reference-range caveat on the canonical surface", () => {
    const section = DISCLAIMER_SECTIONS.find(
      (candidate) => candidate.id === "suggestions-and-reference-ranges"
    );
    expect(section?.body).toMatch(/general guidelines/i);
    expect(section?.body).toMatch(/vary by age, sex, and clinical context/i);
    expect(section?.body).toMatch(/clinician's guidance takes priority/i);
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
        `the same #1049 policy: the disclaimer lives on /disclaimer ` +
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
        `curateResultDefinitions and rendered from there, so it is governed by the same rule ` +
        `as the JSON. Delete the sentence:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the generator of a scanned dataset is not itself written in disclaimer language", () => {
    // The root cause (#2342): scripts/gen-canonical-result-definitions.ts told the model "These
    // are INFORMATIONAL, not medical advice", and the model reasonably concluded the copy
    // it generated should carry the framing too. An output-only guard leaves the next
    // `npm run gen:canonical-results` free to re-add it, so the prompt states the constraint as
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
      path.join(REPO, "scripts/gen-canonical-result-definitions.ts"),
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
