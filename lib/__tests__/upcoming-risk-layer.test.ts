import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Invariant guard for the risk/priority layer (issue #553). #517 built a
// risk-stratified `priority` layer and wired only TWO of the three due-signal
// engines into it (retest ✓, screening ✓, immunization ✗), so an
// immunocompromised/healthcare-worker/pregnant profile's key vaccines never ranked
// up. Close it MECHANICALLY so a fourth engine can't be silently left out: every
// builder in lib/queries/upcoming/generators.ts that EMITS UpcomingItems must
// either consult the risk/priority layer (a `*PriorityFor` / `retestModulationFor`
// call in its body) OR be on a justified allowlist (dose/refill/appointment/goal/
// training/… where risk-priority is N/A) — each with a one-line reason. A new
// engine that emits items without doing either fails CI. This reads the module's
// own source as TEXT (no DB, no network — "pure" in the vitest sense).

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GENERATORS = path.join(REPO, "lib/queries/upcoming/generators.ts");

// Builders that MUST route through the risk/priority layer — each is expected to
// reference a `*PriorityFor` or `retestModulationFor` call in its body.
const RISK_AWARE = new Set<string>([
  "immunizationItems", // immunizationPriorityFor (issue #553)
  "preventiveItems", // screeningPriorityFor (issue #517)
  "biomarkerItems", // retestModulationFor (issue #517/#546)
]);

// Builders where risk-stratified priority is N/A — each with the reason it opts
// out. A dose/refill is a fixed schedule/supply fact; an appointment/goal carries
// its own real calendar date; a training target is a weekly count; the
// dietary-limit/interaction findings are standing safety notes, not risk-ranked
// due signals.
const ALLOWLIST: Record<string, string> = {
  doseItems:
    "scheduled dose for today — user-set mandatory/high/low priority, NOT " +
    "risk-ranked (#559: supplements are user-prioritized, so the risk engine " +
    "must not recompute their priority); the only dynamic axis is time-urgency " +
    "via the existing dose/escalation lattice, not this layer",
  refillItems: "supply run-out math — not a risk-ranked due signal",
  dietaryLimitItems: "standing UL warning — informational, not risk-ranked",
  prnMaxItems:
    "PRN over-daily-max care finding (#798) — a per-day count vs the user's OWN " +
    "confirmed max_daily_count; informational safety note, not a risk-ranked due signal",
  interactionItems:
    "standing interaction warning — informational, not risk-ranked",
  pgxItems:
    "standing pharmacogenomics cross-check (#710) — a stored PGx result " +
    "affecting an active med; informational safety note, not a risk-ranked due signal",
  contrastItems:
    "standing contrast-safety cross-check (#701) — a planned contrast study meeting " +
    "an allergy/CKD gate; informational pre-procedure safety note, not a risk-ranked due signal",
  dentalSafetyItems:
    "standing dental-procedure safety cross-check (#704) — a planned invasive dental " +
    "procedure meeting an antiresorptive/cardiac/anticoagulant gate; informational " +
    "pre-procedure safety note, not a risk-ranked due signal",
  appointmentItems: "carries its own real appointment date",
  goalItems: "carries its own target date",
  trainingItems: "weekly frequency count — not risk-ranked",
  carePlanItems: "provider-ordered item with its own planned date",
  enduranceEventItems:
    "endurance event day (#839) — carries its own real event_date; a user-set race " +
    "goal, not a risk-ranked clinical due signal",
  mentalHealthCrisisItems:
    "mental-health crisis finding (#716) — a severe PHQ-9/GAD-7 or positive item 9 is a " +
    "non-dismissible safety signal that is ALREADY maximally urgent; risk-stratified " +
    "priority (family history / life stage) is N/A and must never rank a crisis line " +
    "down, so it opts out of this layer like the other safety findings",
};

// Aggregators/collectors that COMPOSE the builders rather than emit their own
// items — not subject to the rule (they inherit each builder's decision).
const AGGREGATORS = new Set<string>([
  "rawUpcoming",
  "collectUpcoming",
  "collectSuppressedUpcoming",
  "collectHouseholdRollup",
]);

// Extract a function body by brace-matching from the first `{` after the name.
function functionBody(src: string, name: string): string {
  // Match `function name(` — tolerates a `cache(function name(` wrapper.
  const sig = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!sig) throw new Error(`function ${name} not found`);
  let i = src.indexOf("{", sig.index);
  if (i < 0) throw new Error(`no body for ${name}`);
  let depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

describe("every Upcoming due-signal builder consumes the risk/priority layer (#553)", () => {
  const src = fs.readFileSync(GENERATORS, "utf8");

  // Every function declared with an explicit `: UpcomingItem[]` return type is a
  // builder (or an aggregator returning the flat list). A new one that isn't in
  // any bucket below trips the completeness assertion.
  const builders = Array.from(
    src.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*:\s*UpcomingItem\[\]/g),
    (m) => m[1]
  );

  it("finds the known builder set (sanity: the regex matches real functions)", () => {
    expect(builders).toEqual(expect.arrayContaining([...RISK_AWARE]));
    expect(builders).toEqual(expect.arrayContaining(Object.keys(ALLOWLIST)));
  });

  it("classifies every UpcomingItem[] builder as risk-aware, allowlisted, or an aggregator", () => {
    const unclassified = builders.filter(
      (n) => !RISK_AWARE.has(n) && !(n in ALLOWLIST) && !AGGREGATORS.has(n)
    );
    expect(
      unclassified,
      `New Upcoming builder(s) [${unclassified.join(
        ", "
      )}] emit items without a risk-layer decision. Either call a *PriorityFor / ` +
        `retestModulationFor helper (and add to RISK_AWARE) or add to ALLOWLIST with a reason.`
    ).toEqual([]);
  });

  it("each risk-aware builder actually references a priority/modulation call in its body", () => {
    const priorityCall = /(\w+PriorityFor|retestModulationFor)\s*\(/;
    for (const name of RISK_AWARE) {
      const body = functionBody(src, name);
      expect(
        priorityCall.test(body),
        `${name} is marked risk-aware but does not call a *PriorityFor / retestModulationFor helper`
      ).toBe(true);
    }
  });
});
