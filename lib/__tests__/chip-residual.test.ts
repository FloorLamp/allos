import fs from "node:fs";
import path from "node:path";
import ts from "typescript-api";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const IMPLEMENTATION = "components/Chip.tsx";
const TOKENS = new Set(["chip-base", "chip-nav", "chip-filter", "chip-offer"]);

function sourceFiles(dir: string): string[] {
  return fs
    .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory())
        return entry.name === "__tests__" ? [] : sourceFiles(rel);
      return /\.tsx?$/.test(entry.name) ? [rel] : [];
    });
}

function tokens(text: string): string[] {
  return text.split(/\s+/).filter((token) => TOKENS.has(token));
}

function rawChipTokens(file: string, text?: string): string[] {
  if (file === IMPLEMENTATION) return [];
  const source = ts.createSourceFile(
    file,
    text ?? fs.readFileSync(path.join(ROOT, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const findings = new Set<string>();
  function report(node: ts.Node, used: string[]) {
    if (used.length === 0) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    findings.add(`${file}:${line} ${used.join(" ")}`);
  }
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node)) {
      const used = tokens(node.text);
      report(node, used);
    }
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(source) === "className" &&
      node.initializer
    ) {
      const used: string[] = [];
      function collectLiteralTokens(part: ts.Node) {
        if (ts.isStringLiteralLike(part)) {
          used.push(...tokens(part.text));
          return;
        }
        ts.forEachChild(part, collectLiteralTokens);
      }
      collectLiteralTokens(node.initializer);
      report(node, used);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...findings];
}

describe("Chip residual", () => {
  it("keeps raw chip presentation inside the typed primitive", () => {
    const findings = ["app", "components"]
      .flatMap(sourceFiles)
      .flatMap((file) => {
        const text = fs.readFileSync(path.join(ROOT, file), "utf8");
        // Parsing cannot create a watched token. Keep the AST verdict for raw
        // candidates, but do not build thousands of guaranteed-empty source files.
        return [...TOKENS].some((token) => text.includes(token))
          ? rawChipTokens(file, text)
          : [];
      });
    expect(findings).toEqual([]);
  });

  it.each([
    ["direct", '<button className="chip-base chip-filter">A</button>'],
    [
      "hoisted",
      'const raw = "chip-base chip-nav"; export default () => <a className={raw}>A</a>',
    ],
    [
      "conditional",
      '<button className={`chip-base ${on ? "chip-filter" : "chip-nav"}`}>A</button>',
    ],
    ["base", 'const raw = "chip-base"; <button className={raw}>A</button>'],
    ["base with override", '<button className="chip-base w-full">A</button>'],
  ])("rejects a %s raw presentation", (_name, source) => {
    expect(rawChipTokens("components/Plant.tsx", source)).not.toEqual([]);
  });

  it("allows ordinary prose that says chip", () => {
    expect(
      rawChipTokens(
        "components/Plant.tsx",
        'const label = "chip"; export default () => <p>{label}</p>'
      )
    ).toEqual([]);
  });
});

// ── THE ADOPTION RULE, AND WHAT IT CANNOT SEE (issue #4753) ─────────────────
//
// The labeled-verb chip's LABEL shows the payload the tap carries, which is what
// retires the "…now"-suffixed dose verbs: "Taken now" said WHEN because nothing else
// on the control did, and on an adopted surface the label says it instead. So the
// rule is one sentence — A FILE THAT MOUNTS THE CHIP CARRIES NO "…now" VERB.
//
// MEMBERSHIP, NOT AN ALLOWLIST, for the same reason #4543's palette rule is keyed
// that way: "a control that logs something" has no syntactic shape a scan can match,
// and the try produces a list of surfaces that has to be maintained by hand and
// polices nothing between edits. Mounting the primitive is a fact about the file.
//
// WHICH MAKES THE FILE THE UNIT OF ADOPTION, and that is a constraint on adopters
// rather than an accident: a component that mounts the chip on one arm and keeps a
// "…now" verb on another reds here, so a partly-adopted file has to finish its copy
// migration before it can adopt at all. `QuickLogPrnControl` is the shape — its
// icon-only arm keeps the BUTTON it shipped with (an owner question), and it still
// had to drop "Taken now" to let the labeled arm mount the pill.
//
// AND IT IS SPELLED THE WAY THIS REPO SPELLS IT, not the way the issue describes it:
// the copy this was written against was "Taken now" (as-needed doses — retired by the
// PRN row's adoption), "Start now" (practices, still shipped) and "Log now" (the prose
// around them), which is a VERB FOLLOWED BY `now` rather than a single token — so the pattern is the pair, and it is matched in string literals and
// JSX text only, never in comments, because a comment that quotes the retired copy in
// order to explain the retirement is correct and must stay.
//
// WHAT IT CANNOT CATCH, said plainly because a rule read as exhaustive is worse than
// no rule at all:
//   • COPY THAT ARRIVES AS A PROP. `<DoseStatusControl label="Mark taken">` is
//     written in the PARENT; if the parent does not itself mount a chip it is not in
//     range, and if the child does, the literal is not in the child. This is the
//     likeliest way the copy survives an adoption.
//   • COPY COMPOSED AT RUNTIME — `${verb} now`, a lookup keyed elsewhere, or a
//     constant living in lib/. There is no literal to match.
//   • UNADOPTED FAMILIES, deliberately: a surface that has not mounted the chip may
//     keep its copy, which is what "one sweep as families adopt" means — but it also
//     means the rule cannot tell "not adopted yet" from "adopted, then reverted".
//   • ANYTHING OUTSIDE app/ AND components/, including the Telegram button spellings
//     that #4753 names as a later convergence.
//   • WHETHER THE LITERAL RENDERS. This reads source, so a string in a dead branch
//     reds and a rendered one composed from two halves does not.
//
// GREEN ON MAIN, AND THAT IS NOT A PASS. Before this change nothing mounted the chip,
// so the rule ranged over zero files and could not have failed. It ranges over the
// adopted files now and still faces FORWARD, at the next family — which is why the
// cases below forge both directions rather than trusting the sweep's silence.
//
// AND THE SECOND RULE IS THE OWNER'S, NOT AN INFERENCE (ruling 2, 2026-09-02). The
// build lane asked whether `Mark taken` was in scope at all, since it carries no
// "now"; the answer is that the verb names the ACT and never the BOOKKEEPING of it —
// `Take`/`Give`/`Log`, never `Mark taken`/`Mark done`. So the pattern below is two
// alternations reading one sentence: a verb that says WHEN, and a verb that says
// FILING. Both are matched the same way, in string literals and JSX text only, for
// the same reason — a comment explaining a retirement must be able to quote it.
//
// WHAT THE `Mark …` HALF CANNOT SEE is the list above plus two of its own. The
// PARTICIPLE IS ENUMERATED — `Mark taken` and `Mark done` are named, a surface that
// invents `Mark administered` is not caught — because an open `Mark \\w+` matches
// "Mark", "Marked up" and every proper noun. And it is the IMPERATIVE only: a control
// says "Mark taken", while "marked skipped" is a sentence DESCRIBING a record's state
// ("Not logged — this dose is marked skipped", the write core's own refusal), which is
// not a verb standing in for an act and must not be swept up with one.
const RETIRED_VERB = new RegExp(
  [
    // says WHEN: the verb carried the sentence because nothing else on the control did
    "\\b(?:take|taken|log|logged|give|given|start|started|mark|finish|finished|confirm|confirmed)\\s+now\\b",
    // says FILING: the bookkeeping of the act, standing in for the act
    "\\bmark\\s+(?:as\\s+|not\\s+)*(?:taken|done|logged|complete|completed|skipped|finished|read)\\b",
  ].join("|"),
  "i"
);
const CHIP_MOUNT = /\bLabeledVerbChip\b/;

function retiredVerbCopy(file: string, text: string): string[] {
  if (!CHIP_MOUNT.test(text)) return [];
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const findings: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) {
      const hit = node.text.match(RETIRED_VERB);
      if (hit)
        findings.push(
          `${file}:${
            source.getLineAndCharacterOfPosition(node.getStart()).line + 1
          } ${hit[0]}`
        );
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return findings;
}

describe("labeled-verb adoption retires the …now and Mark … verbs (issue #4753)", () => {
  it("no surface mounting the chip still says when, or says filing", () => {
    const findings = ["app", "components"]
      .flatMap(sourceFiles)
      .flatMap((file) =>
        retiredVerbCopy(file, fs.readFileSync(path.join(ROOT, file), "utf8"))
      );
    expect(
      findings,
      "A labeled-verb chip's LABEL states the payload, including when it happened, " +
        "so the verb is one word: it never carries `now`, and it names the act " +
        "rather than the filing of it (owner ruling 2). These adopted surfaces " +
        `still spell the retired copy:\n${findings.join("\n")}`
    ).toEqual([]);
  });

  it.each([
    // [what the forged file does, how many findings the rule must report]
    [
      "mounts the chip and keeps the retired label",
      'import { LabeledVerbChip } from "@/components/Chip";\nexport default () => <LabeledVerbChip label="Ibuprofen" verb="Taken now" onAct={a} tone="brand" />;',
      1,
    ],
    [
      "mounts the chip and keeps the copy as JSX text",
      'import { LabeledVerbChip } from "@/components/Chip";\nexport default () => <><LabeledVerbChip label="X" verb="Give" onAct={a} tone="brand" />Start now</>;',
      1,
    ],
    // The silences that keep the rule worth having. A neighbour that never adopted is
    // out of range on purpose, and a comment quoting the retired copy to explain the
    // retirement is the shape #3404 warns a text sweep will "correct".
    [
      "keeps the retired label without mounting the chip",
      '<button aria-label="Taken now">Taken now</button>',
      0,
    ],
    [
      "mounts the chip and only NAMES the retired copy in a comment",
      'import { LabeledVerbChip } from "@/components/Chip";\n// "Taken now" retired here (#4753).\nexport default () => <LabeledVerbChip label="Aug 30" verb="Log" onAct={a} tone="neutral" />;',
      0,
    ],
    [
      "mounts the chip and says now about something that is not a verb",
      'import { LabeledVerbChip } from "@/components/Chip";\nexport default () => <LabeledVerbChip label="Due now · 250 mg" verb="Log" onAct={a} tone="neutral" />;',
      0,
    ],
    // RULING 2's half, forged both directions for the same reason the first half is.
    [
      "mounts the chip and keeps the bookkeeping framing as an accessible name",
      'import { LabeledVerbChip } from "@/components/Chip";\nexport default () => <><LabeledVerbChip label="8:00am" verb="Take" onAct={a} tone="brand" /><button aria-label="Mark taken" /></>;',
      1,
    ],
    [
      "mounts the chip and negates the bookkeeping framing",
      'import { LabeledVerbChip } from "@/components/Chip";\nexport default () => <><LabeledVerbChip label="8:00am" verb="Take" onAct={a} tone="brand" /><button aria-label="Mark not taken" /></>;',
      1,
    ],
    [
      "mounts the chip and DESCRIBES a record's state rather than naming a control",
      'import { LabeledVerbChip } from "@/components/Chip";\nexport default () => <><LabeledVerbChip label="8:00am" verb="Take" onAct={a} tone="brand" />{"Not logged — this dose is marked skipped"}</>;',
      0,
    ],
    [
      "mounts the chip and says Mark about a person rather than a filing",
      'import { LabeledVerbChip } from "@/components/Chip";\nexport default () => <LabeledVerbChip label="Mark · 250 mg" verb="Give" onAct={a} tone="brand" />;',
      0,
    ],
  ])("%s: reports %i", (_name, source, count) => {
    expect(retiredVerbCopy("components/Plant.tsx", source)).toHaveLength(count);
  });
});

// ── THE ROW'S PAINT, AND WHY ONLY THE BRAND HALF IS SCANNED (issue #4548) ────
//
// `components/OfferRow.tsx` is the other half of this substrate — the chip above is
// the compact offer, the row is the full-width one, and they already share
// `OFFER_VERB_TONE`. The brand tint was copied byte-identically at four call sites
// while `DoseHistoryPanel` had extracted a DIFFERENT constant for the neutral one, so
// the rule here is the same one the chip tokens get: THE PAINT LIVES IN THE PRIMITIVE.
//
// THE SIGNATURE IS THE PAIR, not either token, because `bg-brand-50/60` alone is the
// app's ordinary brand tint and four shipped surfaces wear it as a STATIC panel
// (`ExerciseDetailPanel`, `StrengthSets` twice, `CreateVisitFromRecord`, and
// `RestTimer`'s resting arm). What makes a tint an OFFER is that it responds to a
// pointer: the resting token beside a `hover:bg-brand-*`. Onboarding's choice cards
// spell theirs `has-checked:bg-brand-50/60`, which is why the token is matched whole
// and not as a substring.
//
// WHAT IT CANNOT SEE, said plainly:
//   • THE NEUTRAL TONE. Its tokens (`bg-surface` + `hover:bg-(--ghost-hover)`) are
//     this app's generic ghost-surface vocabulary — twelve shipped non-offer surfaces
//     wear them — so a rule there would cry wolf on all of them and be deleted within
//     a week, taking the brand rule with it (#3325's lesson). The neutral copy that
//     #4548 names is gone; nothing guards a second one.
//   • A PAIR SPLIT ACROSS TWO LITERALS of one className. Every copy #4548 found was
//     written as ONE string, which is how this repo spells a row's paint, so that is
//     what is matched — per literal, so a ternary whose arms are exclusive (RestTimer)
//     cannot be paired with itself.
//   • ANYTHING OUTSIDE app/ AND components/, and whether the literal renders at all.
const OFFER_IMPLEMENTATION = "components/OfferRow.tsx";
const OFFER_TINT = "bg-brand-50/60";
const OFFER_HOVER = /^hover:bg-brand-/;

function offerRowPaint(file: string, text: string): string[] {
  if (file === OFFER_IMPLEMENTATION || !text.includes(OFFER_TINT)) return [];
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const findings: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      const words = node.text.split(/\s+/);
      if (words.includes(OFFER_TINT) && words.some((w) => OFFER_HOVER.test(w)))
        findings.push(
          `${file}:${
            source.getLineAndCharacterOfPosition(node.getStart()).line + 1
          }`
        );
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return findings;
}

describe("Offer row residual (issue #4548)", () => {
  it("keeps the brand offer tint inside the primitive", () => {
    const findings = ["app", "components"]
      .flatMap(sourceFiles)
      .flatMap((file) =>
        offerRowPaint(file, fs.readFileSync(path.join(ROOT, file), "utf8"))
      );
    expect(
      findings,
      "A brand-tinted row whose tap performs the write it describes is " +
        '`<OfferRow tone="brand">`; margins stay the caller\'s. These spell its ' +
        `paint by hand:\n${findings.join("\n")}`
    ).toHaveLength(0);
  });

  it.each([
    // [what the forged file spells, how many findings the rule must report]
    [
      "a direct copy of the row's className",
      '<button className="mb-2.5 flex w-full items-center gap-3 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2 text-left transition hover:bg-brand-50 disabled:opacity-50 dark:border-brand-900 dark:bg-brand-950/40 dark:hover:bg-brand-950/60">A</button>',
      1,
    ],
    [
      "a hoisted constant, the shape DoseHistoryPanel had",
      'const OFFER_ROW_CLASS = "border-brand-200 bg-brand-50/60 hover:bg-brand-50";\nexport default () => <button className={OFFER_ROW_CLASS}>A</button>;',
      1,
    ],
    [
      "the paint inside a template literal's own text",
      "<button className={`${base} bg-brand-50/60 hover:bg-brand-50`}>A</button>",
      1,
    ],
    // The silences that keep the rule worth having: a tint that does not respond to a
    // pointer is a PANEL, and onboarding's choice card carries the token only behind a
    // `has-checked:` prefix.
    [
      "a static brand-tinted panel (ExerciseDetailPanel's shape)",
      '<div className="mt-4 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2 dark:border-brand-900 dark:bg-brand-950/40">A</div>',
      0,
    ],
    [
      "a ternary whose arms are exclusive (RestTimer's shape)",
      '<div className={`rounded-xl border ${done ? "border-emerald-400 hover:bg-brand-50" : "border-brand-200 bg-brand-50/60"}`}>A</div>',
      0,
    ],
    [
      "onboarding's choice card, where the tint is checked-state only",
      '<label className="rounded-xl border transition hover:border-brand-300 has-checked:bg-brand-50/60">A</label>',
      0,
    ],
  ])("%s: reports %i", (_name, source, count) => {
    expect(offerRowPaint("components/Plant.tsx", source)).toHaveLength(count);
  });
});
