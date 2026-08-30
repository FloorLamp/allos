// Tracker reconciliation (#865) — the pure tier.
//
// Three things are proven here, in ascending order of how much damage getting
// them wrong would do:
//
//   1. THE PARSERS. Citation, dependency and PR-claim grammars, over a fixture
//      repo state. Cheap to test and cheap to get wrong.
//   2. THE FALSE-POSITIVE FLOOR. A detector that cries wolf is a detector
//      nobody reads. The regression fixtures here are the ones measured on the
//      live tracker on 2026-08-12: a bare basename is NOT a dead path (a naive
//      existence check called 46 citations dead where 13 were), and a feature
//      issue naming the symbol it PROPOSES is not drift.
//   3. THE GUARDRAILS. That the patcher refuses a drifted anchor rather than
//      mangling prose, that its three kinds are shape-checked, and that the
//      toolchain the run is granted contains nothing that can close an issue.
//      The last one is a SOURCE SCAN, not a promise: "the prompt says not to"
//      is the same theatre as gating a Server Action in the UI only.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANCHOR_TOLERANCE_LINES,
  anchorsNear,
  checkDocsContracts,
  checkLabelHygiene,
  checkLineCitation,
  decideDomainAdd,
  decideLabelRemoval,
  decidePriorityLabel,
  KNOWN_LABELS,
  parseStatedPriority,
  planLabelRemovals,
  scoreDomains,
  fencedRanges,
  gatherEvidence,
  parseDependencies,
  parsePathCitations,
  parsePrClaims,
  parseSymbolCitations,
  renderReport,
  resolvePath,
  isRootedCitation,
  movedHint,
  resolveRunConfig,
  symbolConfidence,
  symbolExists,
  topLevelDirs,
  type RepoIndex,
  type TrackerIssue,
  type TrackerPr,
} from "../../scripts/orchestration/reconcile-tracker-core";
import {
  applyAnchoredPatch,
  applyPatchPlan,
  PATCH_KINDS,
  type AnchoredPatch,
} from "../../scripts/orchestration/reconcile-patch";

const ROOT = process.cwd();

/** A fixture repository: file path → contents. */
function repo(files: Record<string, string>): RepoIndex {
  return {
    files: Object.keys(files),
    read: (f) => files[f] ?? null,
  };
}

function issue(over: Partial<TrackerIssue> & { number: number }): TrackerIssue {
  return {
    title: "an issue",
    body: "",
    state: "open",
    labels: [],
    ...over,
  };
}

describe("path citations", () => {
  it("reads a path, a line and a range out of inline code", () => {
    const body =
      "See `lib/queries/metrics.ts:600` and `lib/day-grid.ts:12-40` and `docs/ai.md`.";
    expect(parsePathCitations(body)).toEqual([
      {
        raw: "lib/queries/metrics.ts:600",
        path: "lib/queries/metrics.ts",
        startLine: 600,
        endLine: 600,
        at: expect.any(Number),
      },
      {
        raw: "lib/day-grid.ts:12-40",
        path: "lib/day-grid.ts",
        startLine: 12,
        endLine: 40,
        at: expect.any(Number),
      },
      {
        raw: "docs/ai.md",
        path: "docs/ai.md",
        startLine: null,
        endLine: null,
        at: expect.any(Number),
      },
    ]);
  });

  it("ignores a path in running prose — only a backticked one is a citation", () => {
    expect(parsePathCitations("we should look at lib/foo.ts sometime")).toEqual(
      []
    );
  });

  it("ignores citations inside a fenced block", () => {
    // A fence quotes code rather than citing it: its line numbers are
    // illustrative, and patching inside one rewrites a snippet the author
    // pasted deliberately.
    const body = [
      "before `lib/a.ts`",
      "```ts",
      "// `lib/b.ts:99` inside the fence",
      "```",
      "after `lib/c.ts`",
    ].join("\n");
    expect(parsePathCitations(body).map((c) => c.path)).toEqual([
      "lib/a.ts",
      "lib/c.ts",
    ]);
  });

  it("treats an unterminated fence the way a renderer does — it swallows the rest", () => {
    const body = "`lib/a.ts`\n```ts\n`lib/b.ts`\n";
    expect(fencedRanges(body)).toHaveLength(1);
    expect(parsePathCitations(body).map((c) => c.path)).toEqual(["lib/a.ts"]);
  });
});

describe("resolvePath", () => {
  const index = repo({
    "lib/queries/metrics.ts": "",
    "app/(app)/settings/family/actions.ts": "",
    "app/(app)/login/actions.ts": "",
    "components/RecordTable.tsx": "",
  });

  it("matches an exact repo-relative path", () => {
    expect(resolvePath(index, "lib/queries/metrics.ts")).toEqual({
      kind: "exact",
      file: "lib/queries/metrics.ts",
    });
  });

  // THE FALSE-POSITIVE REGRESSION. Bodies cite `RecordTable.tsx`, not the full
  // path; a naive fs.existsSync over the live tracker called 46 citations dead
  // where only 13 were, which is the difference between a report anyone reads
  // and one nobody does.
  it("resolves a bare basename rather than calling it dead", () => {
    expect(resolvePath(index, "RecordTable.tsx")).toEqual({
      kind: "suffix",
      file: "components/RecordTable.tsx",
    });
  });

  it("resolves a partial path by suffix", () => {
    expect(resolvePath(index, "family/actions.ts")).toEqual({
      kind: "suffix",
      file: "app/(app)/settings/family/actions.ts",
    });
  });

  it("reports ambiguity as its own answer, never as a correction", () => {
    const resolved = resolvePath(index, "actions.ts");
    expect(resolved.kind).toBe("ambiguous");
    if (resolved.kind !== "ambiguous") throw new Error("unreachable");
    expect(resolved.candidates).toHaveLength(2);
  });

  it("calls a path dead only when nothing anywhere matches", () => {
    expect(resolvePath(index, "lib/trends-body-metrics.ts")).toEqual({
      kind: "missing",
    });
  });

  // The opposite failure to the one above, and it fired on the same live run:
  // a fully-qualified path that matches nothing is a SPECIFIC claim that
  // failed. Collapsing it to its basename answered "ambiguous across 33
  // route.ts files", which is less true and less useful than "does not exist".
  it("does not collapse a directoried path to its basename", () => {
    expect(
      resolvePath(index, "app/api/integrations/apple-health/ingest/actions.ts")
    ).toEqual({ kind: "missing" });
  });

  it("does not read a bare extension suffix as a path at all", () => {
    expect(parsePathCitations("a `.d.ts` file and a `.tsx` one")).toEqual([]);
  });

  it("separates a claim about this repo from a mention of some other file", () => {
    const dirs = topLevelDirs(index);
    expect([...dirs].sort()).toEqual(["app", "components", "lib"]);
    expect(isRootedCitation("lib/gone.ts", dirs)).toBe(true);
    expect(isRootedCitation("configuration.yaml", dirs)).toBe(false);
    expect(isRootedCitation("server/app-render/action-handler.js", dirs)).toBe(
      false
    );
  });
});

describe("line citations", () => {
  const source = [
    "// header", // 1
    "import x from 'y';", // 2
    "", // 3
    "export function movedThing() {", // 4
    "  return 1;", // 5
    "}", // 6
  ].join("\n");
  const index = repo({ "lib/a.ts": source });

  it("accepts a citation whose anchor is still within tolerance", () => {
    const body = "`movedThing` lives at `lib/a.ts:6`";
    const [citation] = parsePathCitations(body);
    expect(checkLineCitation(index, "lib/a.ts", citation, body)).toEqual({
      kind: "current",
      anchor: "movedThing",
      at: [4],
    });
  });

  it("reports a moved citation with the corrected line", () => {
    const body = "`movedThing` lives at `lib/a.ts:400`";
    const [citation] = parsePathCitations(body);
    expect(checkLineCitation(index, "lib/a.ts", citation, body)).toEqual({
      kind: "moved",
      anchor: "movedThing",
      at: [4],
      nearest: 4,
    });
  });

  it("corrects to the NEAREST occurrence, not the first", () => {
    // The live shape: a component named once in the import block at the top of
    // a 2,000-line file and again where it is used. Answering with the import
    // line sends the reader to the wrong end of the file.
    const long = [
      "import { Widget } from './w';",
      ...Array.from({ length: 40 }, () => "// filler"),
      "  <Widget />",
    ].join("\n");
    const wide = repo({ "lib/long.ts": long });
    const body = "`Widget` renders at `lib/long.ts:60`";
    const [citation] = parsePathCitations(body);
    const verdict = checkLineCitation(wide, "lib/long.ts", citation, body);
    expect(verdict).toEqual({
      kind: "moved",
      anchor: "Widget",
      at: [1, 42],
      nearest: 42,
    });
  });

  it("refuses to correct from a token that is all over the file", () => {
    // `profile_settings` appears on sixteen lines of one real module: "it is
    // at line 80" would be a coin flip wearing a correction's clothes.
    const diffuse = repo({
      "lib/d.ts": Array.from({ length: 20 }, () => "profile_settings").join(
        "\n"
      ),
    });
    const body = "`profile_settings` at `lib/d.ts:300`";
    const [citation] = parsePathCitations(body);
    expect(checkLineCitation(diffuse, "lib/d.ts", citation, body)).toEqual({
      kind: "anchor-diffuse",
      tried: ["profile_settings"],
    });
  });

  it("admits it cannot judge a bare line number with no anchor beside it", () => {
    // The file has 6 lines either way — a line count proves nothing. On the
    // live tracker zero of 72 resolvable citations pointed past EOF, so a
    // length check would have found nothing at all.
    const body = "something around `lib/a.ts:400`";
    const [citation] = parsePathCitations(body);
    expect(checkLineCitation(index, "lib/a.ts", citation, body)).toEqual({
      kind: "no-anchor",
    });
  });

  it("admits it cannot judge when the anchor is not in the file", () => {
    const body = "`renamedAway` at `lib/a.ts:400`";
    const [citation] = parsePathCitations(body);
    expect(checkLineCitation(index, "lib/a.ts", citation, body)).toEqual({
      kind: "anchor-absent",
      tried: ["renamedAway"],
    });
  });

  it("prefers the nearest anchor", () => {
    const body = "`movedThing` … " + "x".repeat(200) + " `import` `lib/a.ts:4`";
    expect(anchorsNear(body, body.indexOf("`lib/a.ts:4`"))[0]).toBe("import");
  });

  it("tolerates the author's own imprecision but not a screenful", () => {
    const body = `\`movedThing\` at \`lib/a.ts:${4 + ANCHOR_TOLERANCE_LINES}\``;
    const [citation] = parsePathCitations(body);
    expect(checkLineCitation(index, "lib/a.ts", citation, body).kind).toBe(
      "current"
    );
    const far = `\`movedThing\` at \`lib/a.ts:${5 + ANCHOR_TOLERANCE_LINES}\``;
    const [farCitation] = parsePathCitations(far);
    expect(checkLineCitation(index, "lib/a.ts", farCitation, far).kind).toBe(
      "moved"
    );
  });
});

describe("dependencies", () => {
  it("reads the structured convention and the free-text forms", () => {
    const body = [
      "Depends-on: #123, #456",
      "",
      "Do this once #789 lands, after #790 ships.",
      "Blocked by #791. Requires #792.",
    ].join("\n");
    expect(parseDependencies(body).map((d) => [d.target, d.form])).toEqual([
      [123, "structured"],
      [456, "structured"],
      [789, "once-lands"],
      [790, "after"],
      [791, "blocked-by"],
      [792, "requires"],
    ]);
  });

  it("does not let a sentence containing the words pose as the declaration", () => {
    // The structured form is line-anchored on purpose: prose that happens to
    // say "Depends-on" mid-sentence is not a machine-readable declaration.
    expect(parseDependencies("This Depends-on: #5 in some way.")).toEqual([]);
  });

  it("ignores dependencies quoted inside a fence", () => {
    expect(parseDependencies("```\nDepends-on: #5\n```")).toEqual([]);
  });
});

describe("PR claims", () => {
  const pr = (title: string, body = ""): TrackerPr => ({
    number: 2600,
    title,
    body,
    mergedAt: "2026-08-12T00:00:00Z",
  });

  it("separates a closing keyword from a partial claim", () => {
    const claims = parsePrClaims(
      pr("Something (#2600)", "Closes #100. Part of #794, clusters 4+8b.")
    );
    expect(claims.map((c) => [c.target, c.form])).toEqual([
      [100, "closes"],
      [794, "part-of"],
    ]);
  });

  it("reads the claim out of the title too", () => {
    expect(parsePrClaims(pr("Towards #794")).map((c) => c.target)).toEqual([
      794,
    ]);
  });
});

describe("symbol tiering", () => {
  it("treats a bug's backticked symbol as a premise and a feature's as a proposal", () => {
    expect(symbolConfidence(["bug", "P2"])).toBe("premise");
    expect(symbolConfidence(["feat"])).toBe("proposal");
    expect(symbolConfidence([])).toBe("proposal");
  });

  it("finds a symbol anywhere on main, as a whole word", () => {
    const index = repo({ "lib/a.ts": "export const placeReading = 1;" });
    expect(symbolExists(index, "placeReading")).toBe(true);
    expect(symbolExists(index, "placeRead")).toBe(false);
  });

  it("collects each distinct identifier once", () => {
    expect(
      parseSymbolCitations("`alpha` then `alpha` then `betaThing` and `x`").map(
        (s) => s.symbol
      )
    ).toEqual(["alpha", "betaThing"]);
  });
});

describe("gatherEvidence", () => {
  const index = repo({
    "lib/queries/metrics.ts": [
      "",
      "",
      "export function readSleepSessions() {}",
    ].join("\n"),
    "components/RecordTable.tsx": "export function RecordTable() {}",
    "docs/thing-spec.md":
      "Status: **shipped**\n\nSee `lib/queries/metrics.ts`.",
  });
  const watermark = { previous: null, current: "2026-08-12T00:00:00Z" };

  it("finds each mechanical drift class and computes its correction", () => {
    const evidence = gatherEvidence(
      {
        issues: [
          issue({
            number: 1,
            labels: ["bug"],
            // A dead path, an unqualified one, a moved line, a closed dep and
            // an absent premise symbol — one of each.
            body: [
              "The gone file is `lib/trends-body-metrics.ts`.",
              "`RecordTable.tsx` renders the rows.",
              "`readSleepSessions` sits at `lib/queries/metrics.ts:600`.",
              "Depends-on: #900",
              "`vanishedHelper` is what does it.",
            ].join("\n\n"),
          }),
        ],
        mergedPrs: [],
        issueStates: new Map([[900, "closed"]]),
      },
      index,
      watermark
    );
    const kinds = evidence.findings.map((f) => f.kind).sort();
    expect(kinds).toEqual([
      "absent-premise-symbol",
      "closed-dependency",
      "dead-path",
      "moved-line",
      "unqualified-path",
    ]);
    expect(
      evidence.findings.find((f) => f.kind === "unqualified-path")?.correction
    ).toBe("components/RecordTable.tsx");
    expect(
      evidence.findings.find((f) => f.kind === "moved-line")?.correction
    ).toBe("lib/queries/metrics.ts:3");
  });

  it("keeps the line span when it qualifies an unrooted path", () => {
    // Qualifying the path used to return the FILE, dropping the span: a
    // citation reading `metrics.ts:600` became a whole-module reference, and
    // the reader lost the one thing that pointed at the code being discussed.
    const evidence = gatherEvidence(
      {
        issues: [
          issue({
            number: 1,
            // Line 3 is where readSleepSessions lives, so the span still holds
            // and only the path needs repairing.
            body: "`RecordTable.tsx:12` renders it.",
          }),
        ],
        mergedPrs: [],
        issueStates: new Map(),
      },
      index,
      watermark
    );
    expect(
      evidence.findings.find((f) => f.kind === "unqualified-path")?.correction
    ).toBe("components/RecordTable.tsx:12");
  });

  it("emits ONE correction for a citation that is both unqualified and stale", () => {
    // Two patches sharing an anchor is not two edits. The first consumes the
    // anchor and the second refuses, so whichever ran first decided which half
    // of the citation got repaired — silently.
    const evidence = gatherEvidence(
      {
        issues: [
          issue({
            number: 1,
            body: "`readSleepSessions` sits at `metrics.ts:600`.",
          }),
        ],
        mergedPrs: [],
        issueStates: new Map(),
      },
      index,
      watermark
    );
    const corrections = evidence.findings
      .filter((f) => f.correction !== undefined)
      .map((f) => f.correction);
    // Both fixes, once: the qualified path AND the corrected line.
    expect(corrections).toEqual(["lib/queries/metrics.ts:3"]);
  });

  it("reports a repeated anchor without guessing which occurrence was meant", () => {
    // Measured on the real tracker, nearest-of-two was wrong three times in
    // seven: a citation about the code AROUND a symbol gets dragged onto the
    // symbol's own line. The occurrences are still reported — only the guess
    // is withheld.
    const twice = repo({
      "lib/twice.ts": [
        "import { Widget } from './w';", // 1
        ...Array.from({ length: 30 }, () => "// filler"),
        "  <Widget />", // 32
      ].join("\n"),
    });
    const evidence = gatherEvidence(
      {
        issues: [
          issue({
            number: 1,
            body: "`Widget` is wired at `lib/twice.ts:900`.",
          }),
        ],
        mergedPrs: [],
        issueStates: new Map(),
      },
      twice,
      watermark
    );
    const moved = evidence.findings.find((f) => f.kind === "moved-line");
    expect(moved?.correction).toBeUndefined();
    expect(moved?.bucket).toBe("unverifiable");
    // The evidence a human needs is still on the record.
    expect(moved?.detail).toContain("line 1, 32");
  });

  it("puts an unrooted dead citation in the unverifiable bucket", () => {
    // `hr_minutes.ts` is a SQL table written like a module; `metrics.json` is
    // an operator's file. Neither is a claim that this checkout contains it.
    const evidence = gatherEvidence(
      {
        issues: [
          issue({
            number: 9,
            labels: ["bug"],
            body: "`hr_minutes.ts` fills from `lib/gone.ts`.",
          }),
        ],
        mergedPrs: [],
        issueStates: new Map(),
      },
      index,
      watermark
    );
    expect(evidence.findings.map((f) => [f.anchor, f.bucket]).sort()).toEqual([
      ["hr_minutes.ts", "unverifiable"],
      ["lib/gone.ts", "changed"],
    ]);
  });

  it("does not report a feature issue's proposed symbol as drift", () => {
    const evidence = gatherEvidence(
      {
        issues: [
          issue({
            number: 2,
            labels: ["feat"],
            body: "Store it as `lmp_date` on a new column.",
          }),
        ],
        mergedPrs: [],
        issueStates: new Map(),
      },
      index,
      watermark
    );
    expect(evidence.findings).toEqual([]);
    // Counted, not hidden: a reader can still ask for the proposals.
    expect(evidence.totals.proposalSymbols).toBe(1);
    expect(evidence.verifiedClean).toEqual([2]);
  });

  it("leaves a dependency on an unknown issue alone rather than guessing", () => {
    const evidence = gatherEvidence(
      {
        issues: [issue({ number: 3, body: "Depends-on: #4242" })],
        mergedPrs: [],
        issueStates: new Map(),
      },
      index,
      watermark
    );
    expect(evidence.findings).toEqual([]);
    expect(evidence.totals.dependenciesFollowed).toBe(0);
  });

  it("flags a merged PR that claimed part of a still-open umbrella", () => {
    const evidence = gatherEvidence(
      {
        issues: [issue({ number: 794, body: "- [ ] cluster 4" })],
        mergedPrs: [
          {
            number: 2600,
            title: "Part of #794, clusters 4+8b",
            body: "",
            mergedAt: "2026-08-12T00:00:00Z",
          },
        ],
        issueStates: new Map([[794, "open"]]),
      },
      index,
      watermark
    );
    expect(evidence.findings.map((f) => f.kind)).toEqual([
      "open-umbrella-claim",
    ]);
    expect(evidence.findings[0].bucket).toBe("unverifiable");
  });

  it("publishes denominators so an empty report can be told from a blind one", () => {
    const clean = gatherEvidence(
      {
        issues: [
          issue({ number: 5, body: "`RecordTable.tsx` is fine as it is." }),
        ],
        mergedPrs: [],
        issueStates: new Map(),
      },
      index,
      watermark
    );
    const blind = gatherEvidence(
      { issues: [], mergedPrs: [], issueStates: new Map() },
      index,
      watermark
    );
    expect(clean.findings.map((f) => f.kind)).toEqual(["unqualified-path"]);
    expect(blind.findings).toEqual([]);
    // The findings sections of a healthy run and a run that examined nothing
    // are indistinguishable; the counts are not, which is why the report leads
    // with them.
    expect(renderReport(blind)).toContain("issues examined: 0");
    expect(renderReport(blind)).toContain("path citations parsed: 0");
    expect(renderReport(clean)).toContain("issues examined: 1");
    expect(renderReport(blind).indexOf("## What was examined")).toBeLessThan(
      renderReport(blind).indexOf("## Patch candidates")
    );
  });
});

describe("label hygiene (dispatch.md §Queue labels)", () => {
  it("flags a doubled priority slot, a missing slot, a missing domain, and a retired label", () => {
    const findings = checkLabelHygiene([
      // The live defect this check exists for: #2701 carried P2 AND parked.
      issue({ number: 1, labels: ["feat", "P2", "ui", "parked"] }),
      issue({ number: 2, labels: ["training"] }),
      issue({ number: 3, labels: ["P2", "ui"] }),
      issue({ number: 4, labels: ["P3", "intake", "cleanup"] }),
    ]);
    expect(findings).toEqual([
      { issue: 1, kind: "priority-slot", detail: expect.stringContaining("2") },
      {
        issue: 1,
        kind: "no-domain",
        detail: expect.stringContaining("domain"),
      },
      {
        issue: 2,
        kind: "priority-slot",
        detail: expect.stringContaining("exactly one"),
      },
      {
        issue: 3,
        kind: "no-domain",
        detail: expect.stringContaining("design"),
      },
      {
        issue: 4,
        kind: "retired-label",
        detail: expect.stringContaining("cleanup"),
      },
    ]);
  });

  it("passes the two-axis contract and ignores closed issues entirely", () => {
    expect(
      checkLabelHygiene([
        issue({ number: 5, labels: ["bug", "P1", "biomarkers"] }),
        issue({ number: 6, labels: ["P2", "design", "ui"] }),
        // Closed issues are out of scope for the check, whatever they carry.
        issue({ number: 7, labels: ["lib", "cleanup"], state: "closed" }),
      ])
    ).toEqual([]);
  });

  it("flags a label outside the closed taxonomy, once per stray", () => {
    // The live drift this catches: GitHub's add-labels endpoint silently
    // CREATES an unknown label, so `deps` (for `dependencies`), `tooling`
    // (for `infra`) and friends accumulated repo-side — 16 strays counted
    // 2026-08-30 — and issues carrying them cluster on nothing. Three of the
    // sixteen (`testing`, `a11y`, `dashboard`) were later promoted by owner
    // ruling, which is why the fixtures here use ones that stayed stray.
    const findings = checkLabelHygiene([
      issue({ number: 11, labels: ["P3", "intake", "db", "tooling"] }),
      issue({ number: 12, labels: ["P2", "design", "sleep", "deps"] }),
    ]);
    expect(findings).toEqual([
      {
        issue: 11,
        kind: "unknown-label",
        detail: expect.stringContaining("tooling"),
      },
      {
        issue: 12,
        kind: "unknown-label",
        detail: expect.stringContaining("sleep"),
      },
      {
        issue: 12,
        kind: "unknown-label",
        detail: expect.stringContaining("deps"),
      },
    ]);
  });

  it("does not double-flag a retired label as also unknown", () => {
    const findings = checkLabelHygiene([
      issue({ number: 13, labels: ["P3", "intake", "cleanup"] }),
    ]);
    expect(findings).toEqual([
      {
        issue: 13,
        kind: "retired-label",
        detail: expect.stringContaining("cleanup"),
      },
    ]);
  });

  it("the taxonomy is the union of the four axes and contains no stray", () => {
    // KNOWN_LABELS is what a filer verifies a label against — never the live
    // repo list, which validates every past mistake. Pin its composition,
    // including the three 2026-08-30 promotions (testing/a11y as type color,
    // dashboard as a domain).
    for (const l of [
      "P0",
      "parked",
      "training",
      "dashboard",
      "bug",
      "testing",
      "a11y",
      "needs-human",
    ]) {
      expect(KNOWN_LABELS.has(l)).toBe(true);
    }
    for (const l of ["deps", "infrastructure", "sleep", "tooling", "lib"]) {
      expect(KNOWN_LABELS.has(l)).toBe(false);
    }
  });

  it("rides gatherEvidence into the report's own section", () => {
    const evidence = gatherEvidence(
      {
        issues: [issue({ number: 8, labels: ["P2", "parked", "training"] })],
        mergedPrs: [],
        issueStates: new Map(),
      },
      repo({ "lib/real.ts": "" }),
      { previous: null, current: "2026-08-15T00:00:00Z" }
    );
    expect(evidence.labelFindings).toHaveLength(1);
    const report = renderReport(evidence);
    expect(report).toContain("## Label hygiene (1)");
    expect(report).toContain("#8");
  });
});

describe("label removal — the only label op", () => {
  it("removes a retired label from an open issue that keeps a domain", () => {
    expect(
      decideLabelRemoval(
        issue({ number: 1, labels: ["lib", "P2", "notifications"] }),
        "lib"
      )
    ).toEqual({ ok: true });
  });

  it("refuses to strand an issue with no domain label left", () => {
    // The case that motivates the guard: `lib` is retired AND satisfies no
    // domain, so a naive removal turns "wrongly labelled" into "invisible".
    const outcome = decideLabelRemoval(
      issue({ number: 2, labels: ["lib", "P2"] }),
      "lib"
    );
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ refusal: "would-strand" });
  });

  it("refuses any label that is not retired, however scruffy", () => {
    for (const label of ["P2", "bug", "notifications", "needs-human"]) {
      expect(
        decideLabelRemoval(
          issue({ number: 3, labels: [label, "training", "P1"] }),
          label
        )
      ).toMatchObject({ ok: false, refusal: "not-retired" });
    }
  });

  it("refuses a closed issue — its labels are history, not queue state", () => {
    expect(
      decideLabelRemoval(
        issue({ number: 4, labels: ["lib", "training"], state: "closed" }),
        "lib"
      )
    ).toMatchObject({ ok: false, refusal: "issue-closed" });
  });

  it("refuses a label the issue no longer carries", () => {
    expect(
      decideLabelRemoval(issue({ number: 5, labels: ["training"] }), "lib")
    ).toMatchObject({ ok: false, refusal: "not-carried" });
  });

  it("plans every removable retired label and silently drops the rest", () => {
    expect(
      planLabelRemovals([
        issue({ number: 6, labels: ["lib", "cleanup", "P2", "training"] }),
        // Would strand — planned around, not planned in.
        issue({ number: 7, labels: ["lib", "P3"] }),
        issue({ number: 8, labels: ["P1", "design"] }),
        issue({ number: 9, labels: ["lib", "db"], state: "closed" }),
      ])
    ).toEqual([
      expect.objectContaining({ issue: 6, label: "lib" }),
      expect.objectContaining({ issue: 6, label: "cleanup" }),
    ]);
  });

  it("has no add op — a missing domain stays a FLAG, not a write", () => {
    // The fact/judgment line, asserted rather than described: an issue with no
    // domain label produces a hygiene FINDING and zero planned writes.
    const stranded = issue({ number: 10, labels: ["P2"] });
    expect(checkLabelHygiene([stranded])).toContainEqual(
      expect.objectContaining({ kind: "no-domain" })
    );
    expect(planLabelRemovals([stranded])).toEqual([]);
  });
});

describe("a domain add may only fill a gap", () => {
  it("fills a gap", () => {
    expect(
      decideDomainAdd(issue({ number: 1, labels: ["bug", "P2"] }), "wellness")
    ).toEqual({ ok: true });
  });

  it("refuses to re-classify an issue that already carries a domain", () => {
    expect(
      decideDomainAdd(issue({ number: 1, labels: ["bug", "db"] }), "wellness")
    ).toEqual({
      ok: false,
      refusal: "already-classified",
      detail: "carries db; re-classifying is not this routine's call",
    });
  });

  it("counts a label THIS RUN already added as carried (#3122)", () => {
    // The defect: two adds for one issue judged against one pre-loop snapshot.
    // The snapshot is identical in both calls below — what differs is only what
    // the run has already decided, which is the state a re-read cannot supply in
    // a dry run because a dry run performs no write for it to read back.
    const gap = issue({ number: 1, labels: ["bug", "P2"] });
    expect(decideDomainAdd(gap, "wellness", []).ok).toBe(true);
    expect(decideDomainAdd(gap, "training", ["wellness"])).toEqual({
      ok: false,
      refusal: "already-classified",
      detail: "carries wellness; re-classifying is not this routine's call",
    });
  });

  it("ignores non-domain labels already added this run", () => {
    // Only the domain axis closes the gap; a priority label added elsewhere in
    // the same run must not make a domain add look like a re-classification.
    expect(
      decideDomainAdd(issue({ number: 1, labels: ["bug"] }), "wellness", ["P2"])
    ).toEqual({ ok: true });
  });

  it("refuses a label off the domain axis, and a closed issue", () => {
    expect(decideDomainAdd(issue({ number: 1, labels: [] }), "P1").ok).toBe(
      false
    );
    expect(
      decideDomainAdd(issue({ number: 1, labels: [], state: "closed" }), "db")
    ).toEqual({
      ok: false,
      refusal: "issue-closed",
      detail: "the issue is closed",
    });
  });
});

describe("priority reconciled against the body's own ruling", () => {
  it("reads the resulting priority out of the shapes owner rulings use", () => {
    expect(parseStatedPriority("**Priority dropped P2 → P3.** Because.")).toBe(
      "P3"
    );
    expect(parseStatedPriority("Priority unchanged at P2: the wiring")).toBe(
      "P2"
    );
    expect(parseStatedPriority("Priority raised to P1 after the outage")).toBe(
      "P1"
    );
    expect(parseStatedPriority("no ruling about urgency here")).toBeNull();
    // A bare mention of a priority is not a ruling ABOUT this issue.
    expect(parseStatedPriority("blocked by a P0 elsewhere")).toBeNull();
  });

  it("moves the label to the priority the body already ruled", () => {
    expect(
      decidePriorityLabel(
        issue({
          number: 1,
          labels: ["P2", "training"],
          body: "**Priority dropped P2 → P3.**",
        })
      )
    ).toEqual({ ok: true, from: "P2", to: "P3" });
  });

  it("fills an absent slot from a stated priority", () => {
    expect(
      decidePriorityLabel(
        issue({ number: 2, labels: ["db"], body: "Priority unchanged at P1" })
      )
    ).toEqual({ ok: true, from: null, to: "P1" });
  });

  it("invents nothing when the body states no priority", () => {
    expect(
      decidePriorityLabel(issue({ number: 3, labels: ["db"], body: "prose" }))
    ).toMatchObject({ ok: false, refusal: "no-stated-priority" });
  });

  it("refuses to let prose overrule a deliberate park or a contested slot", () => {
    expect(
      decidePriorityLabel(
        issue({
          number: 4,
          labels: ["parked", "db"],
          body: "Priority unchanged at P2",
        })
      )
    ).toMatchObject({ ok: false, refusal: "slot-contested" });
    expect(
      decidePriorityLabel(
        issue({
          number: 5,
          labels: ["P1", "P3", "db"],
          body: "Priority unchanged at P2",
        })
      )
    ).toMatchObject({ ok: false, refusal: "slot-contested" });
  });

  it("is a no-op when the label already agrees", () => {
    expect(
      decidePriorityLabel(
        issue({
          number: 6,
          labels: ["P3", "db"],
          body: "Priority dropped to P3",
        })
      )
    ).toMatchObject({ ok: false, refusal: "already-correct" });
  });
});

describe("domain evidence", () => {
  const index = repo({
    "lib/notifications/digest-data.ts": "",
    "lib/notifications/send-markers.ts": "",
    "lib/db.ts": "",
    "e2e/sleep-page.spec.ts": "",
  });

  it("tallies resolved citations by domain, strongest first", () => {
    const scored = scoreDomains(
      issue({
        number: 1,
        body: "See `lib/notifications/digest-data.ts` and `lib/notifications/send-markers.ts` and `lib/db.ts`.",
      }),
      index
    );
    expect(scored[0]).toMatchObject({ domain: "notifications", hits: 2 });
    expect(scored[1]).toMatchObject({ domain: "db", hits: 1 });
  });

  it("scores the most specific match, not the first plausible one", () => {
    // `lib/notifications/**` beats the db tier despite both patterns matching.
    expect(
      scoreDomains(
        issue({ number: 2, body: "`lib/notifications/digest-data.ts`" }),
        index
      ).map((s) => s.domain)
    ).toEqual(["notifications"]);
  });

  it("ignores a citation that resolves to nothing — a proposal does not vote", () => {
    expect(
      scoreDomains(
        issue({ number: 3, body: "we will add `lib/not-built-yet.ts`" }),
        index
      )
    ).toEqual([]);
  });

  it("returns a tally, never a verdict, when the evidence is split", () => {
    const scored = scoreDomains(
      issue({
        number: 4,
        body: "`lib/db.ts` and `e2e/sleep-page.spec.ts`",
      }),
      index
    );
    // One hit each: the caller has to see that this is a coin-flip, so the
    // shape must not collapse to a single winner.
    expect(scored).toHaveLength(2);
    expect(new Set(scored.map((s) => s.hits))).toEqual(new Set([1]));
  });
});

describe("docs contract", () => {
  it("fails a spec document with no Status line and finds its dead citations", () => {
    const index = repo({
      "docs/good-spec.md": "Status: **shipped**\n\nSee `lib/real.ts`.",
      "docs/bad-spec.md": "# Title\n\nSee `lib/gone.ts`.",
      "lib/real.ts": "",
    });
    expect(checkDocsContracts(index)).toEqual([
      {
        file: "docs/bad-spec.md",
        kind: "missing-status",
        anchor: "Status:",
        detail: expect.stringContaining("Status:"),
      },
      {
        file: "docs/bad-spec.md",
        kind: "dead-path",
        anchor: "lib/gone.ts",
        detail: expect.stringContaining("lib/gone.ts"),
      },
    ]);
  });

  it("hints where a moved file went without proposing the patch", () => {
    // `lib/screenings.json` → `lib/datasets/data/screenings.json` is a real
    // move this found in docs/features.md. "Almost certainly the same file" is
    // not the standard a patch is applied on, so the hint rides in the prose
    // and the finding carries no correction.
    const index = repo({
      "docs/x.md": "See `lib/screenings.json`.",
      "lib/datasets/data/screenings.json": "{}",
    });
    const [finding] = checkDocsContracts(index);
    expect(finding.detail).toContain("lib/datasets/data/screenings.json");
    expect(movedHint(index, "lib/screenings.json")).toBe(
      "lib/datasets/data/screenings.json"
    );
    expect(movedHint(index, "lib/nothing-like-this.ts")).toBeNull();
  });

  it("holds against the real docs tree", () => {
    // Not a fixture — the repo's own rule, checked on the repo. A `docs/*-spec.md`
    // without a Status line is a documented defect, so this must stay green.
    const files = fs
      .readdirSync(path.join(ROOT, "docs"))
      .filter((f) => f.endsWith("-spec.md"))
      .map((f) => `docs/${f}`);
    expect(files.length).toBeGreaterThan(0);
    const index: RepoIndex = {
      files,
      read: (f) => fs.readFileSync(path.join(ROOT, f), "utf8"),
    };
    const missing = checkDocsContracts(index).filter(
      (d) => d.kind === "missing-status"
    );
    expect(missing).toEqual([]);
  });
});

describe("run configuration", () => {
  it("takes the environment as an argument rather than reading the global", () => {
    expect(
      resolveRunConfig({ GH_TOKEN: "token-placeholder-1" }, [
        "--issue",
        "12,13",
        "--since",
        "2026-08-01T00:00:00Z",
        "--stamp",
      ])
    ).toEqual({
      repo: "FloorLamp/allos",
      token: "token-placeholder-1",
      only: [12, 13],
      since: "2026-08-01T00:00:00Z",
      stamp: true,
      out: null,
      json: null,
    });
  });

  it("defaults the watermark stamp OFF so a dry run never advances it", () => {
    expect(resolveRunConfig({}, []).stamp).toBe(false);
    expect(resolveRunConfig({}, []).token).toBeNull();
  });
});

// ── GUARDRAILS ───────────────────────────────────────────────────────────────

describe("the patcher refuses rather than mangles", () => {
  const body = "Fix the thing in `lib/old/place.ts` before shipping.";
  const patch = (over: Partial<AnchoredPatch>): AnchoredPatch => ({
    kind: "path-refresh",
    anchor: "lib/old/place.ts",
    replacement: "lib/new/place.ts",
    reason: "moved",
    ...over,
  });

  it("applies a well-formed patch and touches nothing else", () => {
    const out = applyAnchoredPatch(body, patch({}));
    expect(out).toEqual({
      ok: true,
      body: "Fix the thing in `lib/new/place.ts` before shipping.",
    });
    if (!out.ok) throw new Error("unreachable");
    // Everything outside the anchor span is byte-identical, by construction.
    expect(out.body.replace("lib/new/place.ts", "lib/old/place.ts")).toBe(body);
  });

  // THE ONE THAT MATTERS. Evidence is gathered minutes-to-hours before it is
  // applied, on a tracker that moves hourly. A drifted anchor must stop.
  it("skips and flags a drifted anchor", () => {
    const drifted = "Fix the thing in `lib/somewhere/else.ts` before shipping.";
    const out = applyAnchoredPatch(drifted, patch({}));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.refusal).toBe("anchor-missing");
    expect(out.detail).toContain("drifted");
  });

  it("skips and flags an ambiguous anchor rather than picking one", () => {
    const twice = `${body}\n${body}`;
    const out = applyAnchoredPatch(twice, patch({}));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.refusal).toBe("anchor-ambiguous");
  });

  it("refuses an empty anchor, which anchors nothing", () => {
    const out = applyAnchoredPatch(body, patch({ anchor: "" }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.refusal).toBe("empty-anchor");
  });

  it("refuses a no-op", () => {
    const out = applyAnchoredPatch(
      body,
      patch({ replacement: "lib/old/place.ts" })
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.refusal).toBe("no-change");
  });

  it("refuses a kind outside the three-wide vocabulary", () => {
    const out = applyAnchoredPatch(
      body,
      patch({ kind: "rewrite-prose" as never })
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.refusal).toBe("unknown-kind");
  });

  it("keeps the vocabulary four wide", () => {
    expect([...PATCH_KINDS]).toEqual([
      "status-marker",
      "cross-ref",
      "path-refresh",
      "symbol-refresh",
    ]);
  });
});

describe("each patch kind is shape-checked, so the kind alone smuggles nothing", () => {
  const refusalFor = (p: AnchoredPatch, body: string): string => {
    const out = applyAnchoredPatch(body, p);
    if (out.ok) throw new Error("expected a refusal");
    return out.refusal;
  };

  it("a path-refresh replacement must parse as a path", () => {
    expect(
      refusalFor(
        {
          kind: "path-refresh",
          anchor: "lib/a.ts",
          replacement: "this is a sentence about the design",
          reason: "",
        },
        "see `lib/a.ts` there"
      )
    ).toBe("shape-rejected");
  });

  it("a cross-ref may only APPEND a bounded parenthetical", () => {
    const anchor = "the coverage note";
    const body = `Note: ${anchor} is unclear.`;
    expect(
      applyAnchoredPatch(body, {
        kind: "cross-ref",
        anchor,
        replacement: `${anchor} (shipped in #775)`,
        reason: "",
      })
    ).toEqual({
      ok: true,
      body: "Note: the coverage note (shipped in #775) is unclear.",
    });
    // It cannot rewrite the anchor…
    expect(
      refusalFor(
        {
          kind: "cross-ref",
          anchor,
          replacement: "the coverage note is actually fine",
          reason: "",
        },
        body
      )
    ).toBe("shape-rejected");
    // …and it cannot append free prose.
    expect(
      refusalFor(
        {
          kind: "cross-ref",
          anchor,
          replacement: `${anchor} — and I think the whole approach is wrong`,
          reason: "",
        },
        body
      )
    ).toBe("shape-rejected");
  });

  it("a status-marker moves between markers and nowhere else", () => {
    expect(
      applyAnchoredPatch("- [ ] cluster 4", {
        kind: "status-marker",
        anchor: "- [ ]",
        replacement: "- [x]",
        reason: "verified on main",
      })
    ).toEqual({ ok: true, body: "- [x] cluster 4" });
    expect(
      refusalFor(
        {
          kind: "status-marker",
          anchor: "- [ ]",
          replacement: "- [x] and this is out of scope now",
          reason: "",
        },
        "- [ ] cluster 4"
      )
    ).toBe("shape-rejected");
  });
});

// ── THE FOURTH KIND: A RENAME (#3619) ────────────────────────────────────────
//
// The scan half reports `absent-premise-symbol` — an issue body citing an
// identifier that no longer exists on main — and until #3619 the patcher had no
// way to express the repair. The kind that fills the gap has a WIDER blast
// radius than a path, so it earns two guardrails the other three do not need:
// the anchor and the replacement are BACKTICKED (so a patch can only ever land
// inside a citation, never in a sentence discussing the rename), and the rename
// itself is checked against the tree (so a rename to a name that also does not
// exist refuses instead of landing).
//
// EVERY IDENTIFIER BELOW IS INVENTED, AND THAT IS NOT SQUEAMISHNESS. `symbolExists`
// asks "does this name appear anywhere in the tracked tree", raw text, comments
// included — so writing a real absent symbol HERE would make it exist, and the scan
// would stop reporting the very finding this kind was built to repair. Measured
// while writing this file: a first cut used the two live examples verbatim, and the
// live apply of #3594's repair then refused with "still exists on main" — pointing
// at this test. A guard blinded by its own fixture, in the file about guards blinded
// by prose. The two real cases are described in the comments by what they are, never
// by name, and their verbatim before/after is on the PR instead.
//
// BOTH DIRECTIONS ARE TESTED, because a patch that lands and a patch that must
// refuse are two different claims and only one of them is reassuring.
describe("a symbol-refresh repairs a rename, or refuses (#3619)", () => {
  // The live repair #3619 was filed with, transposed: an issue's Refs bullet cites
  // an import-mapper that was renamed — narrowed to one FHIR resource kind — before
  // the branch naming it ever merged, so the cited name never existed on main.
  const body =
    "`lib/fhir/resources.ts:1764` (`mapZephyrReport`, imaging branch) and " +
    "`:1837` (`mapZephyrDocument`) both write `capNarrative(...)`.";
  const ON_MAIN = new Set(["mapZephyrDocumentImaging", "mapZephyrReport"]);
  const resolveSymbol = (symbol: string): boolean => ON_MAIN.has(symbol);
  const patch = (over: Partial<AnchoredPatch> = {}): AnchoredPatch => ({
    kind: "symbol-refresh",
    anchor: "`mapZephyrDocument`",
    replacement: "`mapZephyrDocumentImaging`",
    reason: "renamed before merge",
    ...over,
  });

  it("applies the repair and touches nothing else", () => {
    const out = applyAnchoredPatch(body, patch(), { resolveSymbol });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.body).toContain("(`mapZephyrDocumentImaging`)");
    // Every character outside the anchor span is byte-identical, by construction
    // — the neighbouring citation on the same line included.
    expect(
      out.body.replace("`mapZephyrDocumentImaging`", "`mapZephyrDocument`")
    ).toBe(body);
  });

  it("refuses a replacement that does not resolve on main either", () => {
    const out = applyAnchoredPatch(
      body,
      patch({ replacement: "`mapZephyrDocumentImagingg`" }),
      { resolveSymbol }
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.refusal).toBe("symbol-unresolvable");
    expect(out.detail).toContain("one absent name to another");
  });

  it("refuses when the OLD name is still there, because nothing expired", () => {
    // The scan proposes these only for symbols it could not find. If the tree
    // disagrees at apply time, the evidence is stale and the "repair" would be
    // an unasked-for rename of a live citation.
    const out = applyAnchoredPatch(
      body,
      patch({
        anchor: "`mapZephyrReport`",
        replacement: "`mapZephyrDocumentImaging`",
      }),
      { resolveSymbol }
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.refusal).toBe("symbol-unresolvable");
    expect(out.detail).toContain("still exists on main");
  });

  it("refuses with no resolver at all — fail-closed, never fail-open", () => {
    // A symbol-refresh applied with nothing to check against is exactly the
    // patch that reads as verified and is not.
    const out = applyAnchoredPatch(body, patch());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.refusal).toBe("symbol-unresolvable");
    expect(out.detail).toContain("no resolver was supplied");
  });

  it("refuses a bare identifier on either side — the backticks are the guard", () => {
    const bare = applyAnchoredPatch(
      body,
      patch({ anchor: "mapZephyrDocument" }),
      { resolveSymbol }
    );
    expect(bare.ok).toBe(false);
    if (bare.ok) throw new Error("unreachable");
    expect(bare.refusal).toBe("shape-rejected");
    const loose = applyAnchoredPatch(
      body,
      patch({ replacement: "`the imaging mapper`" }),
      { resolveSymbol }
    );
    expect(loose.ok).toBe(false);
    if (loose.ok) throw new Error("unreachable");
    expect(loose.refusal).toBe("shape-rejected");
  });

  it("cannot reach a bare mention in the prose ABOUT the rename", () => {
    // #3619's named wrong-direction. The sentence explaining the rename says the
    // old name out loud; only the CITATION is a fact with a shape.
    const discussed =
      "We renamed mapZephyrDocument during review, so `mapZephyrDocument` " +
      "in the Refs bullet is stale.";
    const out = applyAnchoredPatch(discussed, patch(), { resolveSymbol });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.body).toBe(
      "We renamed mapZephyrDocument during review, so " +
        "`mapZephyrDocumentImaging` in the Refs bullet is stale."
    );
  });

  it("refuses the held shape, where a ruling cites the same symbol", () => {
    // THE SECOND REAL REPAIR IS HELD, and it is held STRUCTURALLY rather than by
    // policy. That issue names its absent constant twice — once in Refs, once
    // inside the owner ruling that decided what to do about it — so repairing the
    // bullet alone would leave the body internally inconsistent AND make a stale
    // decision read as validated. The existing exactly-once anchor contract
    // already refuses it; this pins that it is not an accident of wording.
    const twice = [
      "## Refs",
      "",
      "- `lib/zephyr.ts` — `ZEPHYR_SEP_CHARS` and the paragraph above it.",
      "",
      "## Owner ruling",
      "",
      "The zero-width members in `ZEPHYR_SEP_CHARS` stay as defence in depth.",
    ].join("\n");
    const out = applyAnchoredPatch(
      twice,
      patch({
        anchor: "`ZEPHYR_SEP_CHARS`",
        replacement: "`ZEPHYR_SEP_RUN`",
      }),
      { resolveSymbol: (sym) => sym === "ZEPHYR_SEP_RUN" }
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.refusal).toBe("anchor-ambiguous");
  });

  it("carries the resolver through a batch", () => {
    const { entries } = applyPatchPlan(body, [patch()], { resolveSymbol });
    expect(entries[0].outcome.ok).toBe(true);
    const { entries: without } = applyPatchPlan(body, [patch()]);
    expect(without[0].outcome.ok).toBe(false);
  });
});

describe("a patch batch", () => {
  it("lands the safe patches and flags the rest, never all-or-nothing", () => {
    const body = "`lib/a.ts` and `lib/b.ts`";
    const { body: after, entries } = applyPatchPlan(body, [
      {
        kind: "path-refresh",
        anchor: "lib/a.ts",
        replacement: "lib/x.ts",
        reason: "",
      },
      {
        kind: "path-refresh",
        anchor: "lib/gone.ts",
        replacement: "lib/y.ts",
        reason: "",
      },
    ]);
    expect(after).toBe("`lib/x.ts` and `lib/b.ts`");
    expect(entries.map((e) => e.outcome.ok)).toEqual([true, false]);
  });

  it("refuses the second of two overlapping patches, because its anchor is gone", () => {
    const { body, entries } = applyPatchPlan("`lib/a.ts`", [
      {
        kind: "path-refresh",
        anchor: "lib/a.ts",
        replacement: "lib/x.ts",
        reason: "",
      },
      {
        kind: "path-refresh",
        anchor: "lib/a.ts",
        replacement: "lib/z.ts",
        reason: "",
      },
    ]);
    expect(body).toBe("`lib/x.ts`");
    expect(entries[1].outcome.ok).toBe(false);
  });
});

describe("the toolchain granted to a reconciliation run cannot close an issue", () => {
  // STRUCTURAL, not instructed. The routine's first guardrail is "never closes
  // issues"; a run holding a close-capable tool and a prompt asking it not to
  // is the same theatre as a UI-only gate over a Server Action (#1279/#2107).
  const MODULES = [
    "scripts/orchestration/reconcile-tracker.ts",
    "scripts/orchestration/reconcile-tracker-core.ts",
    "scripts/orchestration/reconcile-repo-index.ts",
    "scripts/orchestration/reconcile-patch.ts",
    "scripts/orchestration/reconcile-apply.ts",
    "scripts/orchestration/reconcile-labels.ts",
    "scripts/orchestration/delete-unknown-labels.ts",
    "scripts/orchestration/usage.mjs",
    "scripts/orchestration/host.mjs",
  ];
  const SKILL = ".claude/skills/reconcile-tracker/SKILL.md";

  const source = (rel: string): string =>
    fs.readFileSync(path.join(ROOT, rel), "utf8");

  // Written as one regex per capability so a failure names which one appeared.
  const CLOSE_CAPABILITIES: ReadonlyArray<[string, RegExp]> = [
    ["the GitHub close keyword in a payload", /"state"\s*:/],
    ["a close reason", /state_reason/],
    ["the gh CLI's close verb", /\bgh\s+issue\s+close\b/],
    ["the gh CLI's edit verb", /\bgh\s+issue\s+edit\b/],
    // `?state=open` on a LIST endpoint is a read filter, not a close, so the
    // word "state" is not the pattern to hunt. The verb is, and that is
    // checked precisely below ("only the applier writes").
    ["the gh CLI's REST escape hatch", /\bgh\s+api\b/],
    ["the close-capable MCP issue writer", /mcp__github__issue_write/],
    ["the close-capable MCP sub-issue writer", /mcp__github__sub_issue_write/],
  ];

  it.each(MODULES)("%s holds no close capability", (rel) => {
    const text = source(rel);
    for (const [name, re] of CLOSE_CAPABILITIES) {
      expect({ rel, name, found: re.test(text) }).toEqual({
        rel,
        name,
        found: false,
      });
    }
  });

  it("the skill grants no close-capable tool", () => {
    const text = source(SKILL);
    const allowed = /^allowed-tools:\s*(.+)$/m.exec(text);
    expect(allowed).not.toBeNull();
    for (const [name, re] of CLOSE_CAPABILITIES) {
      expect({ name, found: re.test(allowed![1]) }).toEqual({
        name,
        found: false,
      });
    }
    // A general Bash grant would re-open every hole the list above closes.
    expect(allowed![1]).not.toMatch(/(^|,)\s*Bash\s*(,|$)/);
    for (const grant of allowed![1].split(",").map((s) => s.trim())) {
      if (!grant.startsWith("Bash(")) continue;
      expect(grant).toMatch(
        /^Bash\((?:npx tsx scripts\/orchestration\/reconcile-[a-z-]+\.ts|git (?:grep|log|show|diff)):\*\)$/
      );
    }
  });

  // THREE writers now, each confined to a different endpoint, and the point of
  // this block is that no confinement rests on intent. The body applier can
  // name only `body`; the label writer sends no body at all; the label deleter
  // holds one verb against the repo's own label collection and no issue URL
  // whatsoever. Everything else in the toolchain still holds no write verb.
  const WRITERS = [
    "scripts/orchestration/reconcile-apply.ts",
    "scripts/orchestration/reconcile-labels.ts",
    "scripts/orchestration/delete-unknown-labels.ts",
  ];

  it("the body applier writes one verb and builds its payload from one field", () => {
    const applier = source("scripts/orchestration/reconcile-apply.ts");
    expect(applier.match(/"PATCH"/g)).toHaveLength(1);
    expect(applier).toContain("JSON.stringify({ body })");
    expect(applier).not.toMatch(/"(?:POST|PUT|DELETE)"/);
  });

  it("the label writer touches only the per-issue LABELS endpoints", () => {
    const labels = source("scripts/orchestration/reconcile-labels.ts");
    // Two verbs, one each. DELETE names its target in the PATH and sends no
    // body at all; POST sends a payload built from exactly one field. Neither
    // endpoint HAS a field an issue's state could ride in — which is why this
    // stays a structural guarantee rather than a promise.
    expect(labels.match(/"DELETE"/g)).toHaveLength(1);
    expect(labels.match(/"POST"/g)).toHaveLength(1);
    expect(labels).not.toMatch(/"(?:PATCH|PUT)"/);
    expect(labels).toContain("/labels/${encodeURIComponent(label)}");
    expect(labels).toContain("JSON.stringify({ labels })");
    // Every write URL ends at a labels collection or one label within it.
    for (const [, url] of labels.matchAll(
      /`\$\{issueUrl\([^)]*\)\}([^`]*)`/g
    )) {
      expect(url).toMatch(/^\/labels(\/\$\{encodeURIComponent\(label\)\})?$/);
    }
  });

  it("the label deleter holds one verb, aimed only at the repo label collection", () => {
    const del = source("scripts/orchestration/delete-unknown-labels.ts");
    // One DELETE, no other verb — and no issue URL anywhere in the file, so
    // the only thing it can ever remove is a label from the repo's own list.
    expect(del.match(/"DELETE"/g)).toHaveLength(1);
    expect(del).not.toMatch(/"(?:PATCH|POST|PUT)"/);
    expect(del).toContain("/labels/${encodeURIComponent(name)}");
    expect(del).not.toContain("/issues");
  });

  it("nothing outside the three writers holds a write verb at all", () => {
    for (const rel of MODULES.filter((m) => !WRITERS.includes(m))) {
      expect({
        rel,
        writes: /"(?:PATCH|POST|PUT|DELETE)"/.test(source(rel)),
      }).toEqual({ rel, writes: false });
    }
  });

  it("the skill states the guardrails it is bound by", () => {
    const text = source(SKILL);
    expect(text).toContain("never closes issues");
    expect(text).toContain("judgment calls get FLAGGED, not made");
  });
});
