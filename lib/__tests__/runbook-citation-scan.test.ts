import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// THE RUNBOOK'S OWN CITATIONS, RECONCILED THE WAY THE TRACKER'S ARE.
//
// `reconcile-tracker` re-verifies every issue body's citations against main,
// because "the tracker is prose that quotes the code". The runbook and the
// skills are the same kind of prose — full of `docs/...` paths, script names,
// and `file.md §Section` anchors — and until 2026-08-30 they had no
// reconciler at all: that day's hand staleness pass found a skill citing a
// runbook section (`§Labels`) that a split had moved to `labels.md`. This
// scan is that pass, standing: every rooted path a guarded file cites must
// exist, and every qualified `§` anchor must resolve to a real heading.
//
// Deliberately OUT of reach, so the gap is named rather than discovered:
// - Issue/PR numbers (`#NNNN`) — verifying them needs the network, and this
//   scan runs offline in CI.
// - Bare basenames (`reconcile-tracker-core.ts`) and dir mentions (`lib/`) —
//   only ROOTED file paths are checkable without guessing.
//
// ONE OF THOSE GAPS COST A FLIGHT RECORDER (#5242). The citation scan skips
// anything templated, and a shell script's helper calls are ALL templated —
// `node "$(dirname "$0")/work/ledger.mjs"` is a `$` expression, so this file
// walked past five invocations of a directory that has never existed for as
// long as they were there. They are not prose citations: they are commands,
// and the shell resolves them against a known base, so they ARE checkable.
// The second describe below resolves them, and it is where the check for a
// path a shell script INVOKES belongs — the question is the same one this
// file already answers for prose, asked of the executable half.

const REPO = process.cwd();

/** The scanned surface: runbook, skills, PR template, work scripts. */
function scannedFiles(): string[] {
  const work = readdirSync(path.join(REPO, "docs/orchestration"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.posix.join("docs/orchestration", name));
  const skills = readdirSync(path.join(REPO, ".claude/skills"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.posix.join(".claude/skills", entry.name, "SKILL.md"));
  const scripts = readdirSync(path.join(REPO, "scripts/orchestration")).map(
    (name) => path.posix.join("scripts/orchestration", name)
  );
  return [
    "docs/orchestration.md",
    ...work,
    ...skills,
    ".github/pull_request_template.md",
    ...scripts,
    "scripts/orchestrator-checkin.sh",
  ].sort();
}

/**
 * Rooted repo paths the text cites. Skips anything templated (`*`, `<`, `$`,
 * `{`) and strips a trailing `:NNN` line reference — the line number is the
 * tracker reconciler's problem, existence is this scan's.
 */
function pathRefs(text: string): string[] {
  const pattern =
    /(?<![\w/.@-])((?:docs|scripts|lib|app|components|\.claude|\.github)\/[A-Za-z0-9_./*<>${}-]*[A-Za-z0-9_>}])/g;
  const refs = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const raw = match[1].replace(/:\d+$/, "");
    if (/[*<>${}]/.test(raw)) continue;
    refs.add(raw);
  }
  return [...refs].sort();
}

/** Every `.sh` under scripts/, which is the set that invokes helpers. */
function shellScripts(dir = "scripts"): string[] {
  return readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) return shellScripts(rel);
      return entry.name.endsWith(".sh") ? [rel] : [];
    }
  );
}

/**
 * Repo-relative paths a shell script INVOKES, resolved the way the shell
 * resolves them.
 *
 * Scoped to lines that run something (`node`, `bash`, `sh`, `npx`, `tsx`),
 * because the same three spellings appear in prose and in pathspec regexes —
 * pm-digest.sh's `PROC_PATHS` holds `scripts/orchestration/` as a REGEX
 * FRAGMENT, and a scan that read it as an invocation would cry wolf on a
 * correct file. The three forms are the ones the repo actually writes:
 * `$(dirname "$0")/x` (against the script's own directory), `$REPO_DIR/x`
 * (against the root), and a bare rooted `scripts/x.mjs`.
 *
 * A path expression assigned to a variable is expanded first. #5242's fix
 * names the helper directory once as `HELPERS`, and a guard that could not
 * follow one hop would be blind to exactly the five call sites it exists to
 * watch — it would check the directory and never the file.
 */
export function invokedPaths(source: string, relative: string): string[] {
  const vars = [
    ...source.matchAll(
      /^([A-Za-z_][A-Za-z0-9_]*)="?(\$\(dirname "\$0"\)[^"\s]*|\$\{?REPO(?:_DIR)?\}?[^"\s]*)"?$/gm
    ),
  ];
  const here = path.posix.dirname(relative);
  const forms = [
    [/\$\(dirname "\$0"\)((?:\/[A-Za-z0-9_.-]+)+)/g, (p: string) => path.posix.join(here, p)],
    [/\$\{?REPO(?:_DIR)?\}?((?:\/[A-Za-z0-9_.-]+)+)/g, (p: string) => p.slice(1)],
    [
      /(?<![\w/.$-])((?:scripts|lib|e2e|app|components)\/[A-Za-z0-9_./-]*\.(?:mjs|ts|sh))/g,
      (p: string) => p,
    ],
  ] as const;
  const found = new Set<string>();
  for (const raw of source.split("\n")) {
    if (!/(?:^|[\s;&|(`])(?:node|bash|sh|npx|tsx)\s/.test(raw)) continue;
    let line = raw;
    for (const [, name, value] of vars) {
      line = line.replaceAll(`\${${name}}`, value).replaceAll(`$${name}`, value);
    }
    for (const [pattern, resolve] of forms) {
      for (const match of line.matchAll(pattern)) found.add(resolve(match[1]));
    }
  }
  return [...found].sort();
}

type AnchorRef = { file: string; anchor: string };

/**
 * Qualified section anchors: a `.md` filename followed by `§Name`. The anchor
 * text runs to the first punctuation, so "§Merge requires" cites §Merge.
 */
function anchorRefs(text: string): AnchorRef[] {
  const flat = text.replace(/\s+/g, " ");
  const pattern = /([A-Za-z0-9_./-]+\.md)`?\s*§\s*([A-Za-z][A-Za-z0-9 -]*)/g;
  return [...flat.matchAll(pattern)].map((m) => ({
    file: m[1],
    anchor: m[2].trim(),
  }));
}

/** A cited .md file, resolved as written or against the runbook directory. */
function resolveDoc(file: string): string | null {
  for (const candidate of [file, path.posix.join("docs/orchestration", file)]) {
    if (existsSync(path.join(REPO, candidate))) return candidate;
  }
  return null;
}

function headings(relative: string): string[] {
  return readFileSync(path.join(REPO, relative), "utf8")
    .split("\n")
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/\*\*/g, "")
        .trim()
    );
}

/** "§Merge requires" resolves against heading "Merge": prefix + boundary. */
function anchorResolves(anchor: string, heading: string): boolean {
  if (!anchor.startsWith(heading)) return false;
  const next = anchor[heading.length];
  return next === undefined || next === " ";
}

/**
 * Refs that LOOK dead and are meant to: regex fragments the extractor cannot
 * tell from paths, and the reconciler's own doc-comment examples of moved
 * paths (a dead path is what those examples are ABOUT). Pinned per file and
 * per string — a new dead ref still fails, and the census test below fails
 * when an entry here no longer appears in its file.
 */
const DELIBERATE_REFS: Record<string, readonly string[]> = {
  // PROC_PATHS regex fragments: `\.sh` splits one, the other is a prefix.
  "scripts/orchestration/pm-digest.sh": [
    "scripts/orchestrator-checkin",
    "docs/internals/e2e",
  ],
  // Doc-comment examples of the path detector's inputs — dead by design.
  "scripts/orchestration/reconcile-tracker-core.ts": [
    "app/api/integrations/apple-health/ingest/route.ts",
    "lib/screenings.json",
  ],
};

describe("runbook citation scan", () => {
  const files = scannedFiles();

  it.each(files)("%s cites only paths that exist on main", (relative) => {
    const text = readFileSync(path.join(REPO, relative), "utf8");
    const allowed = new Set(DELIBERATE_REFS[relative] ?? []);
    const dead = pathRefs(text).filter(
      (ref) => !allowed.has(ref) && !existsSync(path.join(REPO, ref))
    );
    expect(
      dead,
      `${relative} cites paths that do not exist:\n${dead.join("\n")}\n` +
        `Refresh the citation (or root a real example) — a dead path here ` +
        `misdirects an agent exactly the way a stale tracker citation does.`
    ).toEqual([]);
  });

  it.each(files)("%s § references resolve to real headings", (relative) => {
    const text = readFileSync(path.join(REPO, relative), "utf8");
    const broken: string[] = [];
    for (const { file, anchor } of anchorRefs(text)) {
      const doc = resolveDoc(file);
      if (!doc) {
        broken.push(`${file} §${anchor} — no such file`);
        continue;
      }
      if (!headings(doc).some((h) => anchorResolves(anchor, h))) {
        broken.push(`${doc} §${anchor} — no matching heading`);
      }
    }
    expect(
      broken,
      `${relative} carries § references that no longer resolve:\n` +
        `${broken.join("\n")}\nPoint them at the heading that now carries ` +
        `the rule — this is the drift the 2026-08-30 pass found by hand.`
    ).toEqual([]);
  });

  it("scans the whole runbook surface", () => {
    expect(files).toContain("docs/orchestration/review-merge.md");
    expect(files).toContain(".claude/skills/orchestrate/SKILL.md");
    expect(files).toContain("scripts/orchestration/merge-gate.mjs");
  });

  it("keeps the deliberate-refs allowlist honest in both directions", () => {
    // An entry that no longer appears in its file is a stale exemption a
    // future dead path could hide behind.
    for (const [relative, refs] of Object.entries(DELIBERATE_REFS)) {
      const found = pathRefs(readFileSync(path.join(REPO, relative), "utf8"));
      for (const ref of refs) {
        expect(found, `${relative} no longer cites ${ref}`).toContain(ref);
      }
    }
  });
});

// A green scan over citations that happen to resolve proves nothing about
// what it can SEE (the brevity scan's own rule). These run the extractors
// over text written to break them.
describe("the citation scan's reach", () => {
  it("catches a dead rooted path and strips a line suffix first", () => {
    expect(pathRefs("see `docs/orchestration/vanished.md:12` for why")).toEqual(
      ["docs/orchestration/vanished.md"]
    );
  });

  it("skips templated and unrooted paths rather than guessing", () => {
    const text =
      "check `docs/**` and `lib/<domain>.ts` and `scripts/${name}` " +
      "and bare `dri.ts` and /tmp/plan.json";
    expect(pathRefs(text)).toEqual([]);
  });

  it("resolves a qualified anchor across a line wrap, prefix + boundary", () => {
    const wrapped =
      "per `docs/orchestration/environment.md`\n§GitHub access governs";
    expect(anchorRefs(wrapped)).toEqual([
      {
        file: "docs/orchestration/environment.md",
        anchor: "GitHub access governs",
      },
    ]);
    expect(anchorResolves("GitHub access governs", "GitHub access")).toBe(true);
    // "GitHub accessible" must NOT satisfy §"GitHub access" — boundary, not
    // substring.
    expect(anchorResolves("GitHub accessible", "GitHub access")).toBe(false);
  });

  it("resolves short filenames against the runbook directory", () => {
    expect(resolveDoc("review-merge.md")).toBe(
      "docs/orchestration/review-merge.md"
    );
    expect(resolveDoc("no-such-doc.md")).toBeNull();
  });
});

// A shell script's helper calls are the half of this repo's citations that
// EXECUTE, and #5242 is what it costs when nothing resolves them: five calls
// into a directory that never existed, each one swallowing its own failure
// into a plausible answer, for as long as nobody ran the script and read the
// stderr it was hiding. The two loudest call sites were the two that hid it.
describe("shell helper invocations", () => {
  it.each(shellScripts())("%s invokes only helpers that exist", (relative) => {
    const dead = invokedPaths(
      readFileSync(path.join(REPO, relative), "utf8"),
      relative
    ).filter((target) => !existsSync(path.join(REPO, target)));
    expect(
      dead,
      `${relative} invokes paths that are not on disk:\n${dead.join("\n")}\n` +
        `The shell resolves these at run time and most of these call sites ` +
        `have a fallback, so a wrong one does not fail — it answers wrongly.`
    ).toEqual([]);
  });

  // The whole set, so a script added under scripts/ is scanned without anyone
  // remembering to list it, and #5242's own subject cannot drop out.
  it("scans every shell script under scripts/", () => {
    expect(shellScripts()).toEqual([
      "scripts/dev.sh",
      "scripts/orchestration/agent-gates.sh",
      "scripts/orchestration/pm-digest.sh",
      "scripts/orchestrator-checkin.sh",
    ]);
  });

  it("resolves the check-in's five helper calls, through the variable", () => {
    expect(
      invokedPaths(
        readFileSync(path.join(REPO, "scripts/orchestrator-checkin.sh"), "utf8"),
        "scripts/orchestrator-checkin.sh"
      )
    ).toEqual([
      "scripts/orchestration/host.mjs",
      "scripts/orchestration/ledger.mjs",
      "scripts/orchestration/queue-snapshot.mjs",
      "scripts/orchestrator-checkin.sh",
    ]);
  });
});

// Green over a tree whose paths resolve says nothing about what the extractor
// can SEE, so it is run over the defect verbatim and over the neighbours it
// must stay quiet on.
describe("the invocation scan's reach", () => {
  it("catches #5242's own line, base-relative and through a variable", () => {
    expect(
      invokedPaths(
        'STATE_DIR=$(node "$(dirname "$0")/work/host.mjs" state-dir)',
        "scripts/orchestrator-checkin.sh"
      )
    ).toEqual(["scripts/work/host.mjs"]);
    expect(
      invokedPaths(
        'HELPERS="$(dirname "$0")/work"\nnode "$HELPERS/ledger.mjs" branches',
        "scripts/orchestrator-checkin.sh"
      )
    ).toEqual(["scripts/work/ledger.mjs"]);
  });

  it.each([
    ["a pathspec regex, which runs nothing", "PROC='^(scripts/orchestration/)'"],
    ["prose in an echo with no path", 'echo "run dispatch-brief.mjs done"'],
    ["a bare basename, unrooted and unresolvable", "node ledger.mjs branches"],
  ])("stays quiet on %s", (_why, line) => {
    expect(invokedPaths(line, "scripts/orchestrator-checkin.sh")).toEqual([]);
  });
});
