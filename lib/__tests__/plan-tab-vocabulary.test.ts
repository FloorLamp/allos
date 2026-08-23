import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../add-affordance-grammar";

// THE PLAN TAB'S VOCABULARY AND ITS FOLDED ENTRY FORM (#3474), as a source scan.
//
// Four of #3474's five fixes have no runtime shape a pure test can call: they are
// strings a component writes and a class a JSX tag carries. `components/**` has a DOM
// tier now (#3446) but `app/**` does not, and these three files live there — so the
// tier that can host this today is a scan, which is what #3474's own "guards are
// mandatory" ruling asks for when the natural home is unavailable.
//
// The rendered halves are pinned in e2e (`training-routine-scope.spec.ts`): that the
// form is CLOSED on arrival at both widths, that a chip opens it, and that the only
// brand-coloured text on the tab belongs to real links.
//
// Comments are blanked before matching, because these files argue about the old
// wording in prose — `PlanSection` records what it was renamed FROM — and a scan over
// raw source reads prose as code (#3509).

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function read(rel: string): string {
  return withoutComments(fs.readFileSync(path.join(REPO, rel), "utf8"));
}

const PLAN_SECTION = "app/(app)/training/PlanSection.tsx";
const FREQUENCY_TARGETS = "app/(app)/training/FrequencyTargets.tsx";
const ROUTINES_MANAGER = "app/(app)/training/RoutinesManager.tsx";
const GOALS_MANAGER = "app/(app)/training/GoalsManager.tsx";

describe("the targets card reads 'Weekly targets' end to end (#3474 item 4)", () => {
  it("the card's heading and its subtitle name a TARGET, not a routine", () => {
    const src = read(PLAN_SECTION);
    expect(src).toContain("Weekly targets");
    expect(src).toContain("Click a target to edit it.");
  });

  it("every toast, confirm and inline error the card raises says target", () => {
    const src = read(FREQUENCY_TARGETS);
    for (const copy of [
      '"Target updated"',
      '"Target added"',
      '"Target deleted"',
      '"Delete target"',
      "Couldn't save this target",
      "Couldn't delete this target",
    ]) {
      expect(src, copy).toContain(copy);
    }
  });

  it("'Routines' keeps its own name — the rename separates two models, it does not merge them", () => {
    const src = read(ROUTINES_MANAGER);
    expect(src).toContain("Routines");
    expect(src).toContain("Routine deleted");
  });
});

// The whole-tree half of the acceptance criterion: "grep finds no user-facing
// 'routine' string that means a frequency target".
//
// SCOPE, stated because a content check that does not state one reports on a scope it
// never had: every tracked .ts/.tsx under app/, components/ and lib/, comments blanked,
// with the three test directories excluded — a test that NAMES the retired phrase in
// order to argue about it (this file does, twice) is not a call site.
//
// `lib/release-notes.json` is deliberately out of scope and must stay: it is a dated
// record of what shipped under the old name, and rewriting history to match today's
// copy is the opposite of what a release note is for.
describe("no user-facing 'weekly routine' string survives (#3474 item 4)", () => {
  const RETIRED = /weekly\s+routine/i;
  const NOT_A_CALL_SITE = /^lib\/__(tests|db_tests|action_tests)__\//;

  function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(REPO, dir), {
        withFileTypes: true,
      })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === ".next") continue;
          walk(rel);
        } else if (/\.tsx?$/.test(e.name) && !NOT_A_CALL_SITE.test(rel)) {
          out.push(rel);
        }
      }
    };
    for (const root of ["app", "components", "lib"]) walk(root);
    return out;
  }

  it("the scan clears a floor, so a sweep that stopped reading fails loudly", () => {
    // An absence assertion goes green the moment the scan finds no files at all.
    expect(sourceFiles().length).toBeGreaterThan(500);
  });

  it("the scan can SEE the retired phrase", () => {
    // Run the rule over sources authored to break it — a green sweep over a
    // complying tree says nothing about what the sweep can see.
    for (const forged of [
      "<h3>Weekly routine</h3>",
      'label="weekly routine counts"',
      "`Behind on the weekly  routine`",
    ]) {
      expect(RETIRED.test(forged), forged).toBe(true);
    }
  });

  it("…and stays QUIET on the words that legitimately remain", () => {
    // "Routines" (the structured-plan model) keeps its name, and so does every
    // sentence about a routine that is not a frequency target. A guard that fired on
    // those would be deleted within a week and would take this one with it.
    for (const benign of [
      "<h2>Routines</h2>",
      'toast("Routine deleted")',
      'title: "Activate this routine?"',
      "the weekly targets card",
    ]) {
      expect(RETIRED.test(benign), benign).toBe(false);
    }
  });

  it("no source file writes it", () => {
    const offenders = sourceFiles().filter((rel) =>
      RETIRED.test(
        withoutComments(fs.readFileSync(path.join(REPO, rel), "utf8"))
      )
    );
    expect(offenders).toEqual([]);
  });
});

describe("the goal target line is not dressed as a link (#3474 item 1)", () => {
  // Brand text is this app's interactive signal (the dashboard's doors, its action
  // labels). The three goal target sentences — "Barbell Bench Press 225 lb",
  // "Resting HR → 55 bpm" — were static <span>s wearing the identical tokens the real
  // "Open registry →" link one card below wears, so they read as dead links. They
  // take the category fallback's slate, with weight for the emphasis they earned.
  it("GoalsManager writes no brand text colour at all", () => {
    expect(read(GOALS_MANAGER)).not.toMatch(/text-brand-\d/);
  });

  it("the three target lines carry the fallback's slate plus weight", () => {
    const src = read(GOALS_MANAGER);
    const matches = src.match(
      /text-xs font-medium text-slate-500 dark:text-slate-400/g
    );
    // Exercise, body and biomarker — the three branches above the category fallback.
    expect(matches?.length).toBe(3);
  });

  it("the tab's one real link keeps the brand tone", () => {
    // The absence above must not be bought by bleaching the link too.
    expect(read(PLAN_SECTION)).toMatch(/text-brand-600/);
  });
});

describe("the entry form folds, and the empty state stops repeating itself", () => {
  it("the add-target form is behind a disclosure, closed by default (#3474 item 2)", () => {
    const src = read(FREQUENCY_TARGETS);
    // Closed on arrival — the #1497 rare-cadence rule. `useState(false)` is the
    // whole guarantee, and it is what an e2e can only observe one width at a time.
    expect(src).toMatch(/const \[formOpen, setFormOpen\] = useState\(false\)/);
    // The toggle announces itself, and the fold is the shared <Collapse> (which
    // takes the hidden controls out of the tab order), not a display:none.
    expect(src).toContain("aria-expanded={formOpen}");
    expect(src).toContain("<Collapse open={formOpen}>");
    // Selecting a chip opens it with that target loaded — the editing affordance the
    // fold had to preserve.
    expect(src).toMatch(
      /setPerWeek\(String\(item\.perWeek\)\);\s*\n\s*setFormOpen\(true\);/
    );
  });

  it("the Routines empty state carries the state and not the subtitle's instruction (#3474 item 3)", () => {
    const src = read(ROUTINES_MANAGER);
    expect(src).toContain('<EmptyState message="No routines yet." />');
    // The subtitle keeps the instruction; the box must not say it a second time one
    // screen-height below.
    expect(src).toContain("Adopt a template or build your own.");
    expect(src).not.toContain(
      "No routines yet. Adopt a template or build a custom routine"
    );
  });
});

describe("Goals and Routines carry their create in the section header row (#3474 item 5)", () => {
  // Already true on main when this landed (#2892/#3531 got there first) — pinned so
  // the family cannot drift apart again, which is the whole of what item 5 asks.
  it("both sections put the heading and the action in one justify-between row", () => {
    for (const rel of [GOALS_MANAGER, ROUTINES_MANAGER]) {
      const src = read(rel);
      const header = src.indexOf(
        'className="mb-3 flex flex-wrap items-center justify-between gap-2"'
      );
      expect(header, rel).toBeGreaterThan(-1);
      // The create button sits INSIDE that row: it appears after the row opens and
      // before the list/empty-state branch below it.
      const list = src.indexOf(".length === 0 ? (");
      const create = src.indexOf("<IconPlus", header);
      expect(create, rel).toBeGreaterThan(header);
      expect(create, rel).toBeLessThan(list);
    }
  });
});
