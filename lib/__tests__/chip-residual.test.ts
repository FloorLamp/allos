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
// AND IT IS SPELLED THE WAY THIS REPO SPELLS IT, not the way the issue describes it:
// the shipped copy is "Taken now" (as-needed doses), "Start now" (practices) and
// "Log now" (the prose around them), which is a VERB FOLLOWED BY `now` rather than a
// single token — so the pattern is the pair, and it is matched in string literals and
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
// so the rule ranged over zero files and could not have failed. It faces FORWARD, at
// the next family to adopt — which is why the cases below forge both directions
// rather than trusting the sweep's silence.
const RETIRED_VERB =
  /\b(?:take|taken|log|logged|give|given|start|started|mark|finish|finished|confirm|confirmed)\s+now\b/i;
const CHIP_MOUNT = /\bLabeledVerbChip\b/;

function retiredNowCopy(file: string, text: string): string[] {
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

describe("labeled-verb adoption retires the …now verbs (issue #4753)", () => {
  it("no surface mounting the chip still says a verb and then now", () => {
    const findings = ["app", "components"]
      .flatMap(sourceFiles)
      .flatMap((file) =>
        retiredNowCopy(file, fs.readFileSync(path.join(ROOT, file), "utf8"))
      );
    expect(
      findings,
      "A labeled-verb chip's LABEL states the payload, including when it happened, " +
        "so the verb is one word and never carries `now`. These adopted surfaces " +
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
  ])("%s: reports %i", (_name, source, count) => {
    expect(retiredNowCopy("components/Plant.tsx", source)).toHaveLength(count);
  });
});
