import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bandExemption,
  bandExemptionFor,
  countRollValue,
  MICRO_MOTIONS,
  MICRO_MOTION_BAND_EXEMPTIONS,
  MICRO_MOTION_EASE,
  MICRO_MOTION_MAX_MS,
  MICRO_MOTION_MIN_MS,
  microMotion,
  microMotionPlan,
  withinMicroMotionBand,
  type MicroMotion,
} from "@/lib/micro-motion";

// The micro-motion vocabulary (#2654). Its numbers live in TWO places by necessity —
// lib/micro-motion.ts times the counter's requestAnimationFrame tween and the settle's
// class window, app/globals.css times the paint — so they are pinned to each other
// here, exactly as the overlay family's are in motion-tokens.test.ts.
//
// The other four assertions are the issue's guardrails made mechanical: the 150–300 ms
// band, nothing looping, every motion declaring an independent carrier and a designed
// reduced-motion end state, and every declared motion actually having a class.
//
// THE BAND HAS EXACTLY ONE EXEMPTION and it is not a hole. The owner ruling of
// 2026-08-13 exempts the fold pulse at 500 ms, and the whole point of the ruling was
// that "a bare numeric exception with no stated why is how a band stops being a rule".
// So the exemption is a VALUE that cannot be constructed without its reasoning, and
// the assertions below make three further things impossible: an exemption that
// authorizes a duration other than the one actually declared, a STALE exemption for a
// motion that has come back inside the band, and a second exemption slipping in
// without an edit to the pinned key list right here.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CSS = fs.readFileSync(path.join(REPO, "app/globals.css"), "utf8");

// The stylesheet's own Micro-motion section, sliced out by its SECTION headers so a
// rule in a neighbouring section can neither satisfy nor fail these assertions.
const SECTION = (() => {
  const start = CSS.indexOf("/* ── SECTION: Micro-motion ── */");
  expect(
    start,
    "the Micro-motion SECTION is missing from app/globals.css"
  ).toBeGreaterThan(-1);
  const end = CSS.indexOf("/* ── SECTION:", start + 1);
  return CSS.slice(start, end === -1 ? CSS.length : end);
})();

function sectionVar(name: string): string {
  const match = SECTION.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!match)
    throw new Error(`${name} is not declared in the Micro-motion section`);
  return match[1].trim();
}

const KINDS = Object.keys(MICRO_MOTIONS) as MicroMotion[];
const SORTED_KINDS = [...KINDS].sort();

// THE CSS HALF IS A CENSUS, AND A CENSUS MAY NOT SKIP WHAT IT CANNOT PARSE (#2770).
// Both stylesheet checks below used to key on `[a-z]+` followed by a required
// ` {`, so `.motion-slide2` and `.motion-count-roll` matched NOTHING — and an
// unmatched rule is not a counted rule, so the `length` equality still held. Every
// other assertion here iterates the registry keys, so a motion with no registry row
// was never visited at all: the audit's 900 ms `.motion-slide2`, animating `width`,
// passed all 21 tests while breaking all four load-bearing rules.
//
// Widening the class to `[a-z0-9-]` fixes the two counts, but only until the next
// name the pattern cannot spell. So the NAMES are collected with a pattern wide
// enough to catch a name the convention FORBIDS, and required to equal the registry
// exactly — in all three places a motion is written down. An unspellable name now
// FAILS instead of disappearing, which is the difference between a census and a
// filter.
const CSS_NAME = /^[a-z][a-z0-9-]*$/;

const MOTION_VAR = /--motion-([^\s:;{}()]+)\s*:/g;
const MOTION_CLASS = /\.motion-([^\s{,:;.)]+)/g;
const MOTION_FRAME = /@keyframes\s+micro-([^\s{]+)/g;

function namesIn(pattern: RegExp, source: string): string[] {
  return [...new Set([...source.matchAll(pattern)].map((m) => m[1]))].sort();
}

function sectionNames(pattern: RegExp): string[] {
  return namesIn(pattern, SECTION);
}

describe("micro-motion tokens", () => {
  it("declares every duration once in CSS and matches the module", () => {
    for (const kind of KINDS) {
      expect(sectionVar(`--motion-${kind}`)).toBe(
        `${MICRO_MOTIONS[kind].ms}ms`
      );
    }
  });

  it("names the same motions in the stylesheet as in the registry, three ways", () => {
    // A motion is written down in three places, and each one is matched LOOSELY —
    // any run of characters a CSS identifier could hold — so a name outside the
    // convention lands in the census as an extra rather than slipping past the
    // pattern. Set equality in both directions is what makes the registry the only
    // way to add a motion: CSS with no row fails HERE, a row with no CSS fails in
    // "gives every declared motion a class".
    expect(
      sectionNames(MOTION_VAR).filter((n) => n !== "ease"),
      "a `--motion-…` custom property with no MICRO_MOTIONS row, or vice versa"
    ).toEqual(SORTED_KINDS);
    expect(
      sectionNames(MOTION_CLASS),
      "a `.motion-…` class with no MICRO_MOTIONS row, or vice versa"
    ).toEqual(SORTED_KINDS);
    expect(
      sectionNames(MOTION_FRAME),
      "a `@keyframes micro-…` block with no MICRO_MOTIONS row, or vice versa"
    ).toEqual(SORTED_KINDS);
  });

  it("counts a motion the OLD pattern could not spell", () => {
    // #2770's mutation, made permanent, and the assertion that fails the moment
    // anyone narrows these patterns back. Spelling the reach is not exercising it
    // (#2677), so the rogue motion is run through the same census the real one
    // uses — as a synthetic section, because a permanent case must not require a
    // permanent violation in globals.css.
    const rogue = [
      ":root {",
      "  --motion-slide2: 900ms;",
      "}",
      ".motion-slide2 {",
      "  animation: micro-slide2 var(--motion-slide2) var(--motion-ease);",
      "}",
      "@keyframes micro-slide2 {",
      "  from {",
      "    width: 0;",
      "  }",
      "}",
    ].join("\n");
    expect(namesIn(MOTION_VAR, rogue).filter((n) => n !== "ease")).toEqual([
      "slide2",
    ]);
    expect(namesIn(MOTION_CLASS, rogue)).toEqual(["slide2"]);
    expect(namesIn(MOTION_FRAME, rogue)).toEqual(["slide2"]);
    // And the names the widened `[a-z0-9-]` class STILL cannot spell are reported
    // by the loose census rather than skipped — which is the whole reason the
    // census is loose and the convention is pinned separately. A pattern that has
    // to keep chasing the next legal identifier is the defect, not the width.
    expect(namesIn(MOTION_CLASS, ".motion-Slide_2 {\n}")).toEqual(["Slide_2"]);
    expect(namesIn(MOTION_FRAME, "@keyframes micro-fade.in {\n}")).toEqual([
      "fade.in",
    ]);
  });

  it("keeps every name inside the shape the stylesheet checks can read", () => {
    // The other half of #2770's fix, and the half that stops the widening being a
    // chase. The rule-body and keyframe-body checks below still parse by name, so a
    // motion named outside `[a-z][a-z0-9-]*` — an underscore, a capital, a leading
    // digit — would be a rule nobody reads. That is a FAILURE here, at the registry,
    // rather than a silent gap in the two censuses.
    for (const kind of KINDS) expect(kind, kind).toMatch(CSS_NAME);
  });

  it("declares ONE ease curve, in both halves", () => {
    expect(sectionVar("--motion-ease")).toBe(MICRO_MOTION_EASE);
    // No rule may carry its own curve — that is the fourth-vocabulary drift the
    // token exists to stop.
    const rules = (
      SECTION.match(/\.motion-[a-z0-9-]+ \{[^}]*\}/g) ?? []
    ).filter(
      // The reduced-motion block neutralizes the same selectors; it is asserted
      // separately below and has no duration or curve to carry.
      (rule) => !/animation:\s*none/.test(rule)
    );
    expect(rules.length).toBe(KINDS.length);
    const anyToken = new RegExp(`var\\(--motion-(${KINDS.join("|")})\\)`);
    for (const rule of rules) {
      expect(rule, rule).toContain("var(--motion-ease)");
      expect(rule, rule).toMatch(anyToken);
    }
  });

  it("keeps every duration inside the 150–300 ms band, or argues its way out", () => {
    for (const kind of KINDS) {
      const { ms } = MICRO_MOTIONS[kind];
      // An exempt motion is judged by its exemption instead (asserted below). A
      // motion with none has no answer but the band.
      if (bandExemptionFor(kind)) continue;
      expect(ms, kind).toBeGreaterThanOrEqual(MICRO_MOTION_MIN_MS);
      expect(ms, kind).toBeLessThanOrEqual(MICRO_MOTION_MAX_MS);
    }
  });

  it("gives every declared motion a class in the stylesheet", () => {
    for (const kind of KINDS) {
      expect(SECTION, kind).toContain(`.motion-${kind} {`);
      expect(SECTION, kind).toContain(`@keyframes micro-${kind} {`);
      expect(microMotionPlan(kind, false).className).toBe(`motion-${kind}`);
    }
  });

  it("loops nothing", () => {
    // A looping animation is an attention claim that never stops making itself.
    // Neither an explicit iteration count nor the shorthand's `infinite`/`alternate`
    // keywords may appear anywhere in the section.
    expect(SECTION).not.toMatch(/animation-iteration-count/);
    expect(SECTION).not.toMatch(/\binfinite\b/);
    expect(SECTION).not.toMatch(/\balternate\b/);
  });

  it("animates nothing that triggers layout", () => {
    // Motion never delays or displaces the next tap: transform, box-shadow and
    // opacity only — the three that paint or composite without reflowing anything
    // around them. Read out of the @keyframes blocks, which are the only place a
    // property is actually interpolated.
    const frames =
      SECTION.match(/@keyframes micro-[a-z0-9-]+ \{[\s\S]*?\n\}/g) ?? [];
    expect(frames.length).toBe(KINDS.length);
    const animated = new Set(
      frames.flatMap((block) =>
        [...block.matchAll(/^\s{4}([a-z-]+):/gm)].map((m) => m[1])
      )
    );
    expect([...animated].sort()).toEqual([
      "box-shadow",
      "opacity",
      "transform",
    ]);
  });
});

describe("the band's one argued exemption", () => {
  const EXEMPT = Object.keys(MICRO_MOTION_BAND_EXEMPTIONS) as MicroMotion[];

  it("is exactly the fold pulse, and nothing else", () => {
    // Pinned so a second exemption cannot arrive as a quiet table entry. Adding one
    // means editing THIS line, which is where the next reader asks what ruling
    // authorized it — the ruling's own words: a band that accumulates unargued
    // exceptions has stopped being a band.
    expect(EXEMPT).toEqual(["fold"]);
  });

  it("names its ruling and states its reasoning, structurally", () => {
    for (const kind of EXEMPT) {
      const exemption = bandExemptionFor(kind);
      expect(exemption, kind).not.toBeNull();
      if (!exemption) continue;
      expect(exemption.ruling, kind).toMatch(/\d{4}-\d{2}-\d{2}/);
      // Not a length check dressed as a rule: the reasoning has to be an ARGUMENT,
      // so it must say why THIS motion is different rather than restate its number.
      expect(exemption.because.length, kind).toBeGreaterThan(120);
      expect(exemption.because, kind).toMatch(/deliberate|hurried|travel/i);
    }
    // And the constructor is the reason a bare entry is impossible in the first
    // place — there is no way to write one down without both halves.
    expect(() => bandExemption(500, "", "because")).toThrow();
    expect(() => bandExemption(500, "a ruling", "  ")).toThrow();
    expect(() => bandExemption(0, "a ruling", "a reason")).toThrow();
  });

  it("authorizes exactly the duration the motion declares", () => {
    // An exemption is a permission for ONE number, never a ceiling. Re-timing an
    // exempt motion has to come back through the ruling.
    for (const kind of EXEMPT) {
      expect(bandExemptionFor(kind)?.exemptMs, kind).toBe(
        MICRO_MOTIONS[kind].ms
      );
    }
  });

  it("fails as STALE once its motion is back inside the band", () => {
    // The failure mode an allowlist has that a rule does not: an entry nobody needs,
    // sitting there reading like a licence. An exempt motion must actually be out of
    // the band, or its exemption is dead and must go.
    for (const kind of EXEMPT) {
      expect(withinMicroMotionBand(MICRO_MOTIONS[kind].ms), kind).toBe(false);
    }
  });

  it("leaves the two halves of motion 2 separately timed", () => {
    // The dismissed row TRAVELLING and the fold ANSWERING are different motions with
    // different durations, and the ruling exempts only the second. Folding them into
    // one token would smuggle the row's travel out of the band too.
    expect(withinMicroMotionBand(MICRO_MOTIONS.slide.ms)).toBe(true);
    expect(bandExemptionFor("slide")).toBeNull();
    expect(MICRO_MOTIONS.fold.ms).not.toBe(MICRO_MOTIONS.slide.ms);
  });
});

describe("micro-motion declarations", () => {
  it("makes every motion state its independent carrier and its reduced design", () => {
    // Rules 3 and 4: a motion whose meaning is lost when it is switched off was
    // decoration, and a motion that is the only carrier of its state is inaccessible.
    // Both are prose, so the check is that the prose EXISTS and is a real sentence.
    for (const kind of KINDS) {
      const decl = microMotion(kind);
      expect(decl.conveys.length, kind).toBeGreaterThan(20);
      expect(decl.carriedBy.length, kind).toBeGreaterThan(20);
      expect(decl.reducedEndState.length, kind).toBeGreaterThan(20);
    }
  });

  it("suppresses every class under prefers-reduced-motion, in both halves", () => {
    // Two independent guarantees, because either alone is one refactor from failing:
    // the planner hands back no class at all, AND the stylesheet neutralizes the
    // classes for anything that applies them another way.
    for (const kind of KINDS) {
      const plan = microMotionPlan(kind, true);
      expect(plan.animate, kind).toBe(false);
      expect(plan.ms, kind).toBe(0);
      expect(plan.className, kind).toBe("");
    }
    const reduced = SECTION.slice(
      SECTION.indexOf("@media (prefers-reduced-motion: reduce)")
    );
    expect(reduced).not.toBe("");
    for (const kind of KINDS) expect(reduced).toContain(`.motion-${kind}`);
    expect(reduced).toContain("animation: none");
  });

  it("plans the full duration when motion is allowed", () => {
    expect(microMotionPlan("settle", false)).toEqual({
      ms: 300,
      animate: true,
      className: "motion-settle",
    });
    expect(microMotionPlan("count", false).ms).toBe(250);
    // Motion 2's two halves, separately: the row's travel and the fold's answer.
    expect(microMotionPlan("slide", false).ms).toBe(300);
    expect(microMotionPlan("fold", false)).toEqual({
      ms: 500,
      animate: true,
      className: "motion-fold",
    });
  });

  it("keeps the overlay family out of this vocabulary", () => {
    // #1469's overlay tokens answer a different question at 240 ms. A micro-motion
    // name colliding with one would let a surface reach for the wrong feel.
    for (const kind of KINDS) expect(kind).not.toMatch(/overlay|drawer|sheet/);
  });
});

describe("countRollValue", () => {
  it("answers the destination at and past the end of the roll", () => {
    expect(countRollValue(0, 30, 250, 250)).toBe(30);
    expect(countRollValue(0, 30, 900, 250)).toBe(30);
  });

  it("answers the destination instantly at zero duration (reduced motion)", () => {
    // The SAME function serves the reduced-motion path — no second code path for a
    // caller to get wrong.
    expect(countRollValue(0, 30, 0, 0)).toBe(30);
    expect(countRollValue(120, 5, 16, 0)).toBe(5);
  });

  it("starts from the value it left", () => {
    expect(countRollValue(10, 40, 0, 250)).toBe(10);
  });

  it("eases out: more than half the travel is done by the halfway point", () => {
    const half = countRollValue(0, 100, 125, 250);
    expect(half).toBeGreaterThan(50);
    expect(half).toBeLessThan(100);
  });

  it("moves monotonically toward the destination, both directions", () => {
    let up = countRollValue(0, 60, 0, 250);
    for (let t = 10; t <= 250; t += 10) {
      const next = countRollValue(0, 60, t, 250);
      expect(next).toBeGreaterThanOrEqual(up);
      up = next;
    }
    expect(up).toBe(60);

    let down = countRollValue(60, 0, 0, 250);
    for (let t = 10; t <= 250; t += 10) {
      const next = countRollValue(60, 0, t, 250);
      expect(next).toBeLessThanOrEqual(down);
      down = next;
    }
    expect(down).toBe(0);
  });

  it("rounds toward the destination so the first frame is never a stutter", () => {
    // Rounding to nearest would repeat the starting number on the first frame or
    // two of a slow roll, which reads as a stall rather than a travel.
    expect(countRollValue(0, 1, 1, 250)).toBe(0);
    expect(countRollValue(0, 100, 5, 250)).toBeGreaterThan(0);
    expect(countRollValue(100, 0, 5, 250)).toBeLessThan(100);
  });
});
