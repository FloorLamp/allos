import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ONE PAGER IDIOM (issue #3378).
//
// `components/PaginationControls.tsx` was the app's pager, and three other
// surfaces had quietly grown their own copy of it beside it — the audit viewer,
// the notify-tick viewer (both recorded in docs/internals/nav-pending.md) and the
// Data → Manage dataset card (recorded nowhere, found while doing this). Each copy
// re-derived the same sentence and the same two `btn-ghost text-sm` steps, so each
// one ALSO missed the phone shape when the shared component grew one: four pagers,
// one of them thumb-sized.
//
// A count is only worth something if a fifth copy cannot appear silently, so this
// is a scan rather than a note. What it matches on is MEMBERSHIP — the sentence a
// pager writes — not a filename or an import, because the failure it exists to
// catch is precisely a file that does the job WITHOUT importing the component.
//
// THE RECOGNIZER COMES FROM HOW THIS REPO SPELLED IT, not from how the issue
// described it. All three retired copies wrote the page sentence as JSX —
// `Page {page} of {pageCount}` — and the Data → Manage one also wrote the extent
// as a range, `Showing {start + 1}–{…} of {total}`. Both are pinned below, and
// both are exercised against source authored to break them: a scan that has only
// ever seen a complying tree is a scan nobody has checked can see anything.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// WHY TWO DIRECTORIES ARE THE WHOLE ANSWER, and what would end that.
//
// `docs/internals/nav-pending.md` now says PaginationControls covers "every pager
// in the app", and this file is what makes that sentence checkable rather than
// remembered. A census whose SCOPE is an unstated assumption reports on a scope it
// never had, so the assumption is written down here and asserted below.
//
// The bound is the EXTENSION, not the directory. A pager's markup is JSX, and
// TypeScript parses JSX only in a `.tsx` file (tsconfig `"jsx": "react-jsx"`); a
// `.ts` file cannot hold it at all. So the question is only ever "where may a
// `.tsx` live", and AGENTS.md answers it: pages, route handlers and Server Actions
// in `app/`, shared UI in `components/`, business logic — which renders nothing —
// in `lib/`. `e2e/` and `scripts/` drive the app; they do not render it.
//
// That is the argument. The measurement is the third test below, which fails if a
// single `.tsx` appears anywhere else, so this comment cannot quietly go stale.
//
// TWO THINGS WOULD END IT, and they fail differently:
//   • A THIRD RENDERING ROOT — a `src/`, a `features/`, a co-located `ui/`, or a
//     component that moves into `lib/`. The scope test names the file and this
//     list is one entry short. That is the loud failure, and the one to expect.
//   • A pager hand-built with `React.createElement` in a `.ts` file. That escapes
//     the extension bound AND the JSX-shaped recognizer below, so widening
//     SCAN_DIRS would not catch it — it is a RECOGNIZER gap wearing a scope gap's
//     clothes, and the fix is a second pattern, not a third directory. Nothing in
//     this repo writes UI that way today, which is the only reason it is a note
//     here instead of a pattern in PAGER_SENTENCES.
const SCAN_DIRS = ["app", "components"];
const PAGER_HOME = "components/PaginationControls.tsx";

// The two sentences a pager writes. `Page {x} of {y}` is the page sentence; the
// second is the EXTENT as a range (note the en dash) — deliberately narrower than
// a bare "Showing … of …", which is how a non-pager count reads
// (`ClinicalResultsTable`'s "Showing {shown} of {group.total} clinical results")
// and which must stay silent here.
const PAGER_SENTENCES: { pattern: RegExp; what: string }[] = [
  {
    pattern: /Page\s*\{[^}]+\}\s*of\s*\{/,
    what: "a `Page {x} of {y}` sentence",
  },
  {
    pattern: /Showing\s*\{[^}]+\}–\{/,
    what: "a `Showing {a}–{b} of …` extent",
  },
];

function handRolledPager(text: string): string[] {
  return PAGER_SENTENCES.filter(({ pattern }) => pattern.test(text)).map(
    ({ what }) => what
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function repoTsxFiles(): string[] {
  return execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "*.tsx",
    ],
    { cwd: REPO, encoding: "utf8" }
  )
    .split("\0")
    .filter((rel) => rel && fs.existsSync(path.join(REPO, rel)));
}

const FILES = SCAN_DIRS.flatMap((dir) =>
  walk(path.join(REPO, dir)).map((full) => ({
    rel: path.relative(REPO, full).split(path.sep).join("/"),
    text: fs.readFileSync(full, "utf8"),
  }))
);

describe("one pager idiom (#3378)", () => {
  it("no surface writes its own pager beside PaginationControls", () => {
    const offenders = FILES.filter((f) => f.rel !== PAGER_HOME)
      .map((f) => ({ rel: f.rel, hits: handRolledPager(f.text) }))
      .filter((f) => f.hits.length > 0)
      .map((f) => `${f.rel} — ${f.hits.join(", ")}`);
    expect(
      offenders,
      "This surface is writing a pager by hand. Render " +
        "`components/PaginationControls.tsx` instead: it owns the two navigation " +
        "modes (in-memory `onPageChange` and URL-borne `prevHref`/`nextHref`), the " +
        "44px thumb steps below `md`, and the pending treatment on a link step. A " +
        "second copy is how three surfaces ended up without the phone shape."
    ).toEqual([]);
  });

  it("every mount of the pager reaches it by import", () => {
    // The complement of the scan above: the surfaces that DO page must be going
    // through the one component, so the count the scan protects is a real one.
    const mounts = FILES.filter((f) =>
      /from ["']@\/components\/PaginationControls["']/.test(f.text)
    ).map((f) => f.rel);
    expect(mounts.sort()).toEqual([
      "app/(app)/settings/audit/page.tsx",
      "app/(app)/settings/notify-log/page.tsx",
      "app/(app)/sleep/SleepMoodSection.tsx",
      "app/(app)/trends/BodySection.tsx",
      "app/(app)/whats-new/page.tsx",
      "components/DataTableManager.tsx",
    ]);
  });

  it("SEES the three pagers this issue retired", () => {
    // The markup as it actually stood, so the scan is measured against the thing
    // it was written to catch rather than against a tree that already complies.
    const retired: Record<string, string> = {
      "settings/audit": `
        <span data-testid="audit-total">{total} events</span>
        {page > 1 ? <PendingTextLink className="btn-ghost">Previous</PendingTextLink> : null}
        <span>Page {Math.min(page, pages)} of {pages}</span>`,
      "settings/notify-log": `
        <span data-testid="notify-log-total">{allRuns.length} runs</span>
        <span>Page {Math.min(page, pages)} of {pages}</span>`,
      DataTableManager: `
        <span>Showing {start + 1}–{start + pageRows.length} of {total}</span>
        <span>Page {currentPage} of {pageCount}</span>`,
    };
    for (const [name, source] of Object.entries(retired)) {
      expect(handRolledPager(source), name).not.toEqual([]);
    }
  });

  it("scans the whole app: no .tsx renders outside SCAN_DIRS", () => {
    // The scope claim above, as a measurement. Git names tracked plus non-ignored
    // untracked source, so runtime uploads, build output and installed packages are
    // excluded by the same boundary that decides what can ship.
    const outside = repoTsxFiles().filter(
      (rel) => !SCAN_DIRS.some((dir) => rel.startsWith(`${dir}/`))
    );
    expect(
      outside,
      "A .tsx outside `app/` and `components/` means the pager census above no " +
        "longer sweeps everywhere a pager can be written, and the 'every pager in " +
        "the app' sentence in docs/internals/nav-pending.md is wider than its " +
        "guard. Add the new root to SCAN_DIRS (and read the note there first: a " +
        "pager built with React.createElement in a .ts file needs a new PATTERN, " +
        "not a new directory)."
    ).toEqual([]);
  });

  it("stays SILENT on the count sentences that are not pagers", () => {
    // A guard that cried wolf on these would be switched off within a week, and
    // the real guard would go with it. None of them offers a page to turn.
    const benign = [
      // components/ClinicalResultsTable.tsx — a disclosure count, no page.
      `<span>Showing {shown} of {group.total} clinical results</span>`,
      // app/(app)/providers/[id]/page.tsx — a scope sentence.
      `<p>Showing {profile.name}’s records with this provider.</p>`,
      // components/TimelineDayNav.tsx — day arrows, a different axis entirely.
      `<Link href={next}>Next day</Link>`,
    ];
    for (const source of benign) {
      expect(handRolledPager(source), source).toEqual([]);
    }
  });
});
