// The dismissal-key CLASSIFICATION guard (issue #1931).
//
// `upcoming_dismissals.signal_key` is an arbitrary string, and only some of those
// strings are safe to leave lying around: an id never recycles, a catalog token has no
// other subject to point at, a dated key expires by construction — but a USER-TYPED
// NAME recycles, and an unswept name-keyed dismissal eventually silences a signal
// nobody dismissed. That class has been found and fixed namespace by namespace
// (#203/#283/#327 biomarkers, #376 immunizations, #1399/#1610 training observations,
// #1931 personal records), each time by re-deriving the same ~70-prefix audit by hand.
//
// These tests make the audit permanent. A new prefix cannot ship without a
// classification, a name-keyed one cannot ship without naming its sweep, and a prefix
// that is displayable but unclassified (or vice versa) fails CI.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DISMISSAL_KEY_REGISTRY,
  DISMISSAL_KEY_PREFIXES,
  NON_DISMISSAL_PREFIXES,
  SWEPT_DISMISSAL_PREFIXES,
  dismissalKeyEntryFor,
} from "@/lib/dismissal-classes";
import { SUPPRESSION_DISPLAY_PREFIXES } from "@/lib/suppression-display";

const LIB_ROOT = join(process.cwd(), "lib");

// Every non-test .ts file under lib/, so the scan sees the whole business layer.
function libSourceFiles(dir = LIB_ROOT): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith("__")) continue; // __tests__, __db_tests__, __action_tests__
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...libSourceFiles(full));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

// `export const SOMETHING_PREFIX = "literal"` — the shape every signal-key namespace
// in this codebase is declared with. Derived arrays (`… : readonly string[] = …`) are
// deliberately not matched: they are compositions of the literals, not new namespaces.
const PREFIX_DECL =
  /export const ([A-Z0-9_]*PREFIX[A-Z0-9_]*)\s*=\s*"([^"]*)"/g;

interface DeclaredPrefix {
  name: string;
  value: string;
  file: string;
}

function declaredPrefixes(): DeclaredPrefix[] {
  const out: DeclaredPrefix[] = [];
  for (const file of libSourceFiles()) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(PREFIX_DECL))
      out.push({
        name: m[1],
        value: m[2],
        file: file.slice(LIB_ROOT.length + 1),
      });
  }
  return out;
}

describe("dismissal-key classification registry (#1931)", () => {
  it("classifies every namespace the suppression bus can display", () => {
    const classified = new Set(DISMISSAL_KEY_PREFIXES);
    const missing = SUPPRESSION_DISPLAY_PREFIXES.filter(
      (p) => !classified.has(p)
    );
    expect(
      missing,
      "add an entry to DISMISSAL_KEY_REGISTRY (lib/dismissal-classes.ts) for each " +
        "new suppression namespace: state whether its key contains a user-recyclable " +
        "string, and if it does, name the sweep that de-orphans it"
    ).toEqual([]);
  });

  it("classifies nothing the display resolver cannot name", () => {
    const displayable = new Set(SUPPRESSION_DISPLAY_PREFIXES);
    const stray = DISMISSAL_KEY_PREFIXES.filter((p) => !displayable.has(p));
    expect(
      stray,
      "a classified namespace with no resolver entry renders as the generic orphan " +
        "row in Upcoming's Snoozed & dismissed — add it to lib/suppression-display.ts"
    ).toEqual([]);
  });

  it("declares each namespace exactly once", () => {
    const seen = new Map<string, number>();
    for (const e of DISMISSAL_KEY_REGISTRY)
      seen.set(e.prefix, (seen.get(e.prefix) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1).map(([p]) => p)).toEqual([]);
  });

  it("gives every entry a non-empty key shape", () => {
    const blank = DISMISSAL_KEY_REGISTRY.filter((e) => !e.shape.trim()).map(
      (e) => e.prefix
    );
    expect(blank).toEqual([]);
  });

  it("requires a named sweep for every name-keyed-swept namespace", () => {
    const unswept = DISMISSAL_KEY_REGISTRY.filter(
      (e) => e.keyClass === "name-keyed-swept" && !e.sweep?.trim()
    ).map((e) => e.prefix);
    expect(
      unswept,
      "`name-keyed-swept` is a claim that something de-orphans the key — name the function"
    ).toEqual([]);
  });

  it("requires a stated risk for every unswept / legacy name-keyed namespace", () => {
    const unstated = DISMISSAL_KEY_REGISTRY.filter(
      (e) =>
        (e.keyClass === "name-keyed-open" || e.keyClass === "legacy") &&
        !e.risk?.trim()
    ).map((e) => e.prefix);
    expect(
      unstated,
      "an unswept name-keyed (or retired) namespace must write down its residual exposure"
    ).toEqual([]);
  });

  it("never attaches a sweep to a class that doesn't have one", () => {
    const odd = DISMISSAL_KEY_REGISTRY.filter(
      (e) => e.sweep && e.keyClass !== "name-keyed-swept"
    ).map((e) => e.prefix);
    expect(odd).toEqual([]);
  });

  it("covers the personal-record namespaces this issue was filed for", () => {
    // The regression pin at the registry level: PR keys embed an exercise/activity
    // name, so they must be in the swept class with a named sweep — not quietly
    // classified as catalog or left out (which is the state #1931 found).
    expect(SWEPT_DISMISSAL_PREFIXES).toContain("pr:strength:");
    expect(SWEPT_DISMISSAL_PREFIXES).toContain("pr:cardio:");
    for (const p of ["pr:strength:", "pr:cardio:"]) {
      expect(dismissalKeyEntryFor(`${p}bench press@none:1rm`)?.sweep).toContain(
        "cleanupOrphanPrDismissals"
      );
    }
  });

  it("resolves a stored key to its own entry, not a neighbour's", () => {
    expect(dismissalKeyEntryFor("goal-pace:goal:4")?.prefix).toBe("goal-pace:");
    expect(dismissalKeyEntryFor("goal:4")?.prefix).toBe("goal:");
    expect(
      dismissalKeyEntryFor("training-obs:stale:curl:2026-01")?.prefix
    ).toBe("training-obs:");
    expect(dismissalKeyEntryFor("training:7")?.prefix).toBe("training:");
    expect(dismissalKeyEntryFor("biomarker-flag:ldl")?.prefix).toBe(
      "biomarker-flag:"
    );
    expect(dismissalKeyEntryFor("biomarker:ldl")?.prefix).toBe("biomarker:");
    expect(dismissalKeyEntryFor("pr:cardio:cycling:speed")?.prefix).toBe(
      "pr:cardio:"
    );
    expect(dismissalKeyEntryFor("nonsense:1")).toBeNull();
  });
});

describe("signal-key prefix source scan (#1931)", () => {
  it("finds the prefix declarations it is supposed to guard", () => {
    // A sanity floor: if the declaration shape ever changes, the scan must fail loudly
    // rather than silently pass over an empty set.
    const found = declaredPrefixes();
    expect(found.length).toBeGreaterThan(40);
    const values = found.map((d) => d.value);
    expect(values).toContain("pr:strength:");
    expect(values).toContain("trajectory:");
    expect(values).toContain("training-obs:");
  });

  it("every exported *_PREFIX literal is classified or explicitly not a dismissal", () => {
    const classified = new Set(DISMISSAL_KEY_PREFIXES);
    const excluded = new Set(NON_DISMISSAL_PREFIXES.map((e) => e.prefix));
    const unaccounted = declaredPrefixes()
      .filter((d) => !classified.has(d.value) && !excluded.has(d.value))
      .map((d) => `${d.name} = "${d.value}" (lib/${d.file})`);
    expect(
      unaccounted,
      "a new signal-key prefix must declare itself: add it to DISMISSAL_KEY_REGISTRY " +
        "(with its class, and a sweep if its key embeds a recyclable name) or to " +
        "NON_DISMISSAL_PREFIXES with what it actually keys — lib/dismissal-classes.ts"
    ).toEqual([]);
  });

  it("keeps the not-a-dismissal list honest", () => {
    // Every exclusion states what the prefix keys instead, and none of them may also
    // be classified as a dismissal namespace (that would be a contradiction).
    const classified = new Set(DISMISSAL_KEY_PREFIXES);
    for (const e of NON_DISMISSAL_PREFIXES) {
      expect(e.what.trim().length, e.prefix).toBeGreaterThan(0);
      expect(classified.has(e.prefix), e.prefix).toBe(false);
    }
  });

  it("does not carry exclusions for prefixes that no longer exist", () => {
    const live = new Set(declaredPrefixes().map((d) => d.value));
    const dead = NON_DISMISSAL_PREFIXES.filter((e) => !live.has(e.prefix)).map(
      (e) => e.prefix
    );
    expect(dead, "drop stale entries from NON_DISMISSAL_PREFIXES").toEqual([]);
  });
});
