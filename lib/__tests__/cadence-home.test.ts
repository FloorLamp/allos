// THE SCOPE-HOME COMPLETENESS GUARD (issue #2888).
//
// `frequency_targets` is one table with seven scope kinds spanning four domains, and
// `getFrequencyTargetProgress` returns every floor target a profile has. Nothing said
// which PAGE each scope belongs to, so /training read the generic list as "the training
// routine" and captioned a fatty-fish habit and a red-light-therapy practice with it.
// The one filter it did carry — `scope_kind !== "practice"` — is the shape that let
// `food_group` stay: a subtraction only excludes what its author remembered.
//
// So `CADENCE_SCOPES.home` declares the owning page per scope, total by the
// `Record<FrequencyScopeKind, …>` type, and this test does for it what
// cadence-registry.test.ts does for the nudge engine: it makes membership total, and it
// grows a REFLECTION tooth so a surface cannot answer the same question privately.
//
// The teeth, in the house style (read the source as text, no DB, no network):
//
//   1. Every scope kind names a home, and every declared home is a real page.
//   2. The training surfaces reach the REGISTRY. No file under app/(app)/training may
//      carry its own `scope_kind` literal comparison — that is the subtraction this
//      issue removed, and it must not grow back.
//   3. Every chip the Plan tab can render has a matching option in the editor's Scope
//      select. This is the silent-no-op guard: a chip whose scope the select cannot
//      represent renders a blank field, submits no scope_kind, and `createFrequencyTarget`
//      returns without writing while the form toasts "Routine updated". A future scope
//      kind declaring `home: "training"` without an option fails here instead.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CADENCE_SCOPES,
  cadenceHome,
  cadenceScopesAtHome,
  isCadenceHome,
  type CadenceHome,
} from "@/lib/cadence";
import { FREQUENCY_SCOPE_KINDS } from "@/lib/frequency-targets";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TRAINING_DIR = path.join(REPO, "app", "(app)", "training");

const read = (rel: string) =>
  fs.readFileSync(path.join(REPO, rel), "utf8") as string;

// Strip comments so the prose in this domain's module headers — which quotes scope
// kinds constantly — is never read as code.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      out.push(full);
  }
  return out;
}

// The homes a scope may claim. A page, not a mood — each one is a route a reader can
// open and find the target's progress, its explanation and its edit control.
const HOMES: readonly CadenceHome[] = [
  "training",
  "nutrition",
  "wellness",
  "substance-use",
];

describe("every cadence scope declares the page it lives on (#2888)", () => {
  it("all seven scope kinds name a home, and it is a real one", () => {
    const missing = FREQUENCY_SCOPE_KINDS.filter(
      (k) => !HOMES.includes(CADENCE_SCOPES[k].home)
    );
    expect(
      missing,
      `scope kinds with no valid home: ${missing.join(", ")} — add a \`home\` to ` +
        `its CADENCE_SCOPES entry naming the domain page that renders, explains and ` +
        `edits it, or the target defaults onto whichever page reads the generic list`
    ).toEqual([]);
  });

  it("the training set is the routine proper plus mobility", () => {
    // Mobility is the member a strict "training domain" reading would have dropped:
    // it is counted from mobility sessions, not training days (#840/#482), but the
    // Training hub's own Mobility card MINTS the target, so excluding it would leave
    // the page creating a target it refuses to show.
    expect([...cadenceScopesAtHome("training")]).toEqual([
      "region",
      "group",
      "type",
      "mobility_region",
    ]);
    expect([...cadenceScopesAtHome("nutrition")]).toEqual(["food_group"]);
    expect([...cadenceScopesAtHome("wellness")]).toEqual(["practice"]);
    expect([...cadenceScopesAtHome("substance-use")]).toEqual(["substance"]);
  });

  it("every home owns at least one scope — no page declared for nobody", () => {
    for (const home of HOMES)
      expect(cadenceScopesAtHome(home).length, home).toBeGreaterThan(0);
  });

  it("the lookup fails safe for an unregistered kind", () => {
    // An unknown kind belongs to NO page rather than defaulting onto one — the same
    // posture `cadenceDirection` takes.
    expect(cadenceHome("not_a_scope")).toBeNull();
    expect(isCadenceHome("training", "not_a_scope")).toBe(false);
    expect(isCadenceHome("training", "food_group")).toBe(false);
    expect(isCadenceHome("nutrition", "food_group")).toBe(true);
  });

  it("substance stays out of the floor readers by DIRECTION, not by home", () => {
    // Its home records where it lives and changes nothing: a cap target never reaches
    // getFrequencyTargetProgress at all (#998), which is why no floor surface has to
    // remember it.
    expect(CADENCE_SCOPES.substance.home).toBe("substance-use");
    expect(CADENCE_SCOPES.substance.direction).toBe("cap");
  });
});

describe("the reflection tooth: the surfaces reach the registry", () => {
  it("no training file carries its own scope_kind list", () => {
    // The `scope_kind !== "practice"` subtraction on the Plan card was a private
    // membership rule that disagreed with the two surfaces beside it. Any scope_kind
    // comparison under app/(app)/training is that shape coming back.
    const offenders = tsxFiles(TRAINING_DIR)
      .filter((full) =>
        /scope_kind\s*[=!]==?\s*["']/.test(
          stripComments(fs.readFileSync(full, "utf8"))
        )
      )
      .map((full) => path.relative(REPO, full).split(path.sep).join("/"));
    expect(
      offenders,
      `these training files compare scope_kind to a literal: ${offenders.join(", ")} ` +
        `— filter with getFrequencyTargetProgressForHome(profileId, "training") so ` +
        `membership stays declared once in CADENCE_SCOPES.home`
    ).toEqual([]);
  });

  it("both training routine surfaces read the SCOPED rollup", () => {
    // One question, one computation (#221): the card that RENDERS the chips and the
    // card that EDITS them must ask for the same set, or the page disagrees with
    // itself again.
    for (const rel of [
      "app/(app)/training/OverviewSection.tsx",
      "app/(app)/training/PlanSection.tsx",
    ]) {
      const src = stripComments(read(rel));
      expect(src, rel).toMatch(
        /getFrequencyTargetProgressForHome\(\s*profile\.id,\s*"training"\s*\)/
      );
      // The generic rollup is what leaked; neither surface may still call it.
      expect(src, rel).not.toMatch(/getFrequencyTargetProgress\(/);
    }
  });

  it("the domain pages that already filtered still do", () => {
    // Nutrition's and wellness's own filters are untouched by this fix (converting
    // them to read `home` is a tidy-up, not a requirement) — but they must not have
    // been dropped on the way past.
    expect(stripComments(read("app/(app)/nutrition/WeeklyHabits.tsx"))).toMatch(
      /scope_kind === "food_group"/
    );
    const wellness = stripComments(read("lib/queries/wellness.ts"));
    expect(
      wellness.match(/scope_kind === "practice"/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("every chip the Plan editor renders can be edited (#2888)", () => {
  // The Scope select's option values, read out of the editor itself.
  function scopeSelectOptions(): string[] {
    const src = read("app/(app)/training/FrequencyTargets.tsx");
    const select = /name="scope_kind"[\s\S]*?<\/select>/.exec(src);
    expect(select, "the Scope select is still named scope_kind").not.toBeNull();
    return [...select![0].matchAll(/<option value="([^"]+)"/g)].map(
      (m) => m[1]
    );
  }

  it("the select offers exactly the scopes whose home is training", () => {
    // The load-bearing correspondence. A chip the editor cannot represent drives the
    // controlled <select> to selectedIndex −1: the field renders blank, submits no
    // scope_kind, isValidScope("") is false, and createFrequencyTarget returns without
    // writing — while save() (which only catches a throw) toasts "Routine updated".
    // Equality in BOTH directions: an unrepresentable chip is the silent no-op, and an
    // option for a scope the page does not show would offer to create a target that
    // then vanishes.
    expect(scopeSelectOptions().sort()).toEqual(
      [...cadenceScopesAtHome("training")].sort()
    );
  });

  it("every offered option is a registered scope kind", () => {
    const known = new Set<string>(FREQUENCY_SCOPE_KINDS as readonly string[]);
    for (const opt of scopeSelectOptions())
      expect(known.has(opt), opt).toBe(true);
  });

  it("the mobility target the hub itself mints is one of them", () => {
    // MobilitySection accepts a deficit suggestion straight into a mobility_region
    // target, so the editor has to be able to load it back.
    expect(read("app/(app)/training/MobilitySection.tsx")).toMatch(
      /name="scope_kind"\s*\n?\s*value="mobility_region"/
    );
    expect(scopeSelectOptions()).toContain("mobility_region");
    expect(cadenceHome("mobility_region")).toBe("training");
  });
});
