import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "./strip-comments";

// THE PLAN TAB'S TARGET-VS-ROUTINE VOCABULARY (#3474), as a source scan.
//
// The rendered layout rules live in e2e (`training-routine-scope.spec.ts`): the form
// is closed on arrival at both widths, a chip opens it, and brand-coloured text belongs
// to real links. Repeating those rules against JSX source added coupling without
// covering another behavior, so this file keeps only the copy distinction a DOM test
// cannot express as one durable rule.
//
// Comments are blanked before matching, because these files argue about the old
// wording in prose — `PlanSection` records what it was renamed FROM — and a scan over
// raw source reads prose as code (#3509).

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function read(rel: string): string {
  return (readCache[rel] ??= stripComments(
    fs.readFileSync(path.join(REPO, rel), "utf8")
  ));
}

const readCache: Record<string, string> = {};
const PLAN_SECTION = "app/(app)/training/PlanSection.tsx";
const FREQUENCY_TARGETS = "app/(app)/training/FrequencyTargets.tsx";
const ROUTINES_MANAGER = "app/(app)/training/RoutinesManager.tsx";

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

  let sourceFilesCache: string[] | undefined;

  function sourceFiles(): string[] {
    if (sourceFilesCache) return sourceFilesCache;
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
    return (sourceFilesCache = out);
  }

  it("no source file writes it", () => {
    const files = sourceFiles();
    // An absence assertion goes green if the walk stops reading. The relevant file
    // count proves its scope more directly than separate regex self-tests did.
    expect(files.length).toBeGreaterThan(500);
    const offenders = files.filter((rel) => {
      const raw = fs.readFileSync(path.join(REPO, rel), "utf8");
      if (!/weekly/i.test(raw) || !/routine/i.test(raw)) return false;
      return RETIRED.test(stripComments(raw));
    });
    expect(offenders).toEqual([]);
  });
});
