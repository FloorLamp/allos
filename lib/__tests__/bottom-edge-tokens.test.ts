import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BOTTOM_EDGE_ABOVE_NAV,
  BOTTOM_EDGE_NAV_ROW_HEIGHT,
} from "@/components/overlay/tokens";
import { stripComments } from "./strip-comments";

// The bottom-edge convention (issue #1520 part B, #2651) — a source scan in the
// shape of the overlay-motion chokepoint one level down, over the five FIXED
// surfaces that converge on the phone's bottom edge.
//
// The regression this freezes: each surface hand-wrote `bottom-[max(1rem,
// env(safe-area-inset-bottom))]` and picked a z-index in isolation, so a toast
// raised during a live workout landed ON TOP of the workout dock. The fix is not a
// slot manager — it is a documented stacking order plus shared class strings in
// components/overlay/tokens.ts, and claimants publishing their TOP EDGE into
// `--bottom-edge-offset`. That convergence only survives if a NEW bottom-anchored
// surface can't quietly re-hand-write the inset.
//
// #2651 is why the surface list is worth having: it added the phone nav dock under
// everything else, and the collision came straight back in a new place. Both base
// layers claim now, and the lift that clears the nav dock is a token rather than a
// number a second surface could get subtly different.
//
// Five rules:
//   1. Every bottom-edge surface consumes the shared tokens.
//   2. Both base layers claim the edge.
//   3. NOBODY outside components/overlay hand-writes the bottom-edge inset literal,
//      or the lift that clears the nav dock.
//   4. That lift agrees with the nav dock's own row height.
//   5. A FIXED SURFACE THAT SPANS THE VIEWPORT AND ANCHORS TO ITS BOTTOM either
//      claims the edge or consumes the tokens — no list, no exemptions.
//
// RULE 5 IS THERE BECAUSE RULES 1-2 COULD NOT SEE #4334. They iterate the map
// below, so a bottom-anchored surface ABSENT from it was invisible to both — and
// `BottomSheet` was absent for as long as the sheet has existed. Rules 3 and 4 do
// read every file, but only for two exact literals, and the sheet anchors itself
// with neither (`fixed inset-0` plus a flex anchor). So the one failure mode this
// file was written to prevent was the one it structurally could not detect, and it
// was green throughout. Rule 5 is DERIVED — it needs nobody to remember a
// filename — and it carries no allowlist: a surface it flags answers by claiming
// or by composing a token, never by being written down as an exception.
//
// IT EXTENDS THE SCAN RULES 3 AND 4 ALREADY RUN; it does not add one. Those two
// already walk every file under app/, components/ and lib/ — rule 5 widens what
// that same walk is looking FOR, from two exact literals to the anchoring the
// repository actually writes. The alternative considered and rejected was keeping
// the map below as the only membership test, which is a filename somebody has to
// remember, and a list of who is exempt is the shape this rule exists to retire.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components", "lib"];
const TOKENS_HOME = "components/overlay/";

// The bottom-edge surfaces, and what each one is for. A new one is added here with
// its layer — that is the review moment this test exists to force.
const BOTTOM_EDGE_SURFACES = new Map<string, string>([
  [
    "components/MobileDock.tsx",
    "LAYER 0 (navigation) — the phone's nav dock, the floor of the edge; it claims the edge (#2651)",
  ],
  [
    "components/WorkoutDock.tsx",
    "LAYER 1 (session) — the full-width live-workout bar; it sits above the nav dock and claims the edge",
  ],
  [
    "components/Toast.tsx",
    "LAYER 2 — the toast stack, bottom-right; stacks above the dock instead of over it",
  ],
  [
    "components/OfflineQueueProvider.tsx",
    "LAYER 2 (pill, bottom-left) + LAYER 3 (rejected-writes panel, bottom-right)",
  ],
  [
    "components/UpdateReadyBar.tsx",
    "LAYER 2 — the deploy update offer (#1700), bottom-left, one row above the offline pill's slot so the two never overlap",
  ],
  [
    "components/BottomSheet.tsx",
    "LAYER 1 (session) — an OPEN bottom sheet is base-layer while it is up, so it claims the edge and the notice layers clear it instead of landing on the row that raised them (#4334)",
  ],
]);

// A `fixed` element that SPANS the viewport horizontally and anchors to its
// BOTTOM, in the spellings this repository actually writes. Measured over the
// tracked tree rather than taken from #4334's prose, which describes the sheet
// only: the nav dock writes `fixed inset-x-0 bottom-0`, the sheet writes
// `fixed inset-0` with `items-end` doing the anchoring from a composed variable
// three functions away, and the workout dock anchors through an imported token.
//
// SPANNING IS HALF THE PREDICATE, and it is what keeps this quiet on the
// neighbours. A bare `fixed inset-0` is a SCRIM — every overlay in the app has one
// — and it owns no more of the bottom edge than of any other part of the screen.
// A `fixed` strip that anchors low but is NOT full width is not a bottom-edge
// surface either: `components/JumpRailScrubber.tsx` is a 44px rail down the right
// gutter, ending 5rem above the bottom, and a notice has never been at risk of
// landing on it.
const FIXED = /[\s"'`{]fixed[\s"'`}]/;
const SPANS = /[\s"'`{](?:inset-0|inset-x-0)[\s"'`}]/;
const ANCHORS_BOTTOM = /[\s"'`{](?:bottom-0|items-end)[\s"'`}]|bottom-\[/;

function mightBeBottomEdgeSurface(source: string): boolean {
  return (
    FIXED.test(source) && SPANS.test(source) && ANCHORS_BOTTOM.test(source)
  );
}

export function isBottomEdgeSurface(source: string): boolean {
  // Comment stripping is deliberately exact but expensive over the whole tree.
  // The raw source must contain all three tokens before its code possibly can.
  if (!mightBeBottomEdgeSurface(source)) return false;
  const code = stripComments(source).replace(/\s+/g, " ");
  return mightBeBottomEdgeSurface(code);
}

/**
 * Registered by DOING it: calling the claim hook, or composing a bottom-edge
 * token — with the IMPORTS taken out first, and that is not a detail.
 *
 * Measured while proving this rule can fail (#4334): with the import line left in,
 * deleting the sheet's `useBottomEdgeClaim(...)` call outright left the whole file
 * GREEN, because `import { useBottomEdgeClaim }` still carried the name. A guard
 * keyed on a mention answers "does this file know the symbol exists", which is not
 * the question, and it fails toward silence. So the import block goes, and the
 * hook is matched at its CALL — `useBottomEdgeClaim(` or `useBottomEdgeClaim<`.
 */
function registersWithTheEdge(source: string): boolean {
  const code = stripComments(source).replace(
    /^\s*import\s[\s\S]*?from\s*["'][^"']*["'];?/gm,
    ""
  );
  return (
    /useBottomEdgeClaim\s*[<(]/.test(code) || /BOTTOM_EDGE_[A-Z_]+/.test(code)
  );
}

interface SourceFile {
  file: string;
  source: string;
}

let sourceCorpusCache: SourceFile[] | undefined;

function sourceCorpus(): SourceFile[] {
  if (sourceCorpusCache) return sourceCorpusCache;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) {
          continue;
        }
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push(path.relative(REPO, full));
      }
    }
  };
  for (const dir of SCAN_DIRS) walk(path.join(REPO, dir));
  sourceCorpusCache = files.map((file) => ({
    file,
    source: fs.readFileSync(path.join(REPO, file), "utf8"),
  }));
  return sourceCorpusCache;
}

function scanOffenders(matches: (source: string) => boolean): string[] {
  return sourceCorpus()
    .filter(
      ({ file, source }) =>
        !file.startsWith(TOKENS_HOME) &&
        !file.startsWith("lib/__tests__/") &&
        matches(source)
    )
    .map(({ file }) => file);
}

describe("bottom-edge tokens (#1520)", () => {
  it("every bottom-edge surface consumes the shared tokens", () => {
    for (const [file, why] of BOTTOM_EDGE_SURFACES) {
      const src = fs.readFileSync(path.join(REPO, file), "utf8");
      // Composing a token OR claiming the edge. A NOTICE has to be told where the
      // edge is, so it composes; a BASE LAYER is the thing being cleared, so it
      // claims and may never write an inset at all — which is `BottomSheet`, whose
      // panel is positioned by its container's flex anchor (#4334).
      expect(
        registersWithTheEdge(src),
        `${file} (${why}) must consume the bottom-edge tokens or claim the edge`
      ).toBe(true);
    }
  });

  it("both base layers claim the edge so the notice layers can clear them", () => {
    // Two claimants, not one. A base layer that renders without claiming is
    // invisible to every notice — which is exactly how #2651's nav dock started
    // out, with toasts landing on the bar they were tapped from.
    for (const file of [
      "components/MobileDock.tsx",
      "components/WorkoutDock.tsx",
      // #4334: an open sheet is the third. It publishes its top edge through the
      // same hook, gated on its drag handle so it stops claiming at the width
      // where it stops being a sheet.
      "components/BottomSheet.tsx",
    ]) {
      const src = fs.readFileSync(path.join(REPO, file), "utf8");
      // The CALL, not the import — see registersWithTheEdge for the measurement.
      expect(
        /useBottomEdgeClaim\s*[<(]/.test(stripComments(src)),
        `${file} must claim the bottom edge`
      ).toBe(true);
    }
  });

  it("nothing outside components/overlay hand-writes the bottom-edge inset", () => {
    // The literal the four surfaces used to each carry a copy of. A new surface
    // that needs to sit at the bottom edge composes BOTTOM_EDGE_NOTICE_BOTTOM
    // (which resolves to exactly this when no base layer is claimed) instead.
    const HAND_WRITTEN =
      /bottom-\[max\(1rem,\s*env\(safe-area-inset-bottom\)\)\]/;
    const offenders = scanOffenders((source) => HAND_WRITTEN.test(source));
    expect(
      offenders,
      "hand-written bottom-edge inset — use BOTTOM_EDGE_NOTICE_BOTTOM from components/overlay"
    ).toEqual([]);
  });

  it("nothing outside components/overlay hand-writes the lift over the nav dock", () => {
    // The #2651 twin of the rule above. The workout dock shipped this literal
    // inline; a second session-layer surface copying it is how the two start
    // disagreeing by a quarter rem.
    const HAND_WRITTEN =
      /bottom-\[calc\(3\.5rem\s*\+\s*env\(safe-area-inset-bottom\)\)\]/;
    const offenders = scanOffenders((source) => HAND_WRITTEN.test(source));
    expect(
      offenders,
      "hand-written nav-dock lift — use BOTTOM_EDGE_ABOVE_NAV from components/overlay"
    ).toEqual([]);
  });

  it("the lift agrees with the nav dock's own row height", () => {
    // Tailwind's spacing scale is 0.25rem per step, so `h-14` is 3.5rem. The lift
    // has to be a LITERAL (a runtime custom property would leave the workout dock
    // flush for the first paint and then jump it), so this is what stops the pair
    // drifting when the bar's height is next tuned.
    const step = Number(
      /^h-(\d+(?:\.\d+)?)$/.exec(BOTTOM_EDGE_NAV_ROW_HEIGHT)?.[1]
    );
    expect(
      step,
      "nav row height must be a Tailwind h-<n> class"
    ).toBeGreaterThan(0);
    const lift = /bottom-\[calc\((\d+(?:\.\d+)?)rem/.exec(
      BOTTOM_EDGE_ABOVE_NAV
    )?.[1];
    expect(Number(lift)).toBe(step * 0.25);
    // …and above `md` the nav dock does not render, so the lift drops back flush.
    expect(BOTTOM_EDGE_ABOVE_NAV).toContain("md:bottom-0");
  });

  it("every bottom-anchored fixed surface registers with the edge", () => {
    const offenders = scanOffenders(
      (source) => isBottomEdgeSurface(source) && !registersWithTheEdge(source)
    );
    expect(
      offenders,
      "a fixed, viewport-spanning, bottom-anchored surface must claim the edge " +
        "(useBottomEdgeClaim) or compose a BOTTOM_EDGE_* token — a notice cannot " +
        "move out of the way of something it has never been told about (#4334)"
    ).toEqual([]);
  });

  // The scan's own see-and-stay-silent pair, in the tradition of the overlay
  // chokepoint's. A green sweep over a COMPLYING tree says nothing about what the
  // sweep can see, and this rule's whole reason for existing is that its four
  // neighbours above were green while blind.
  it.each([
    [
      "a dock spelled the way the nav dock spells it",
      '<nav className="fixed inset-x-0 bottom-0 z-30" />',
    ],
    [
      "a sheet spelled the way BottomSheet spells it",
      'const anchor = "items-end";\n<div className={`fixed inset-0 z-60 flex ${anchor}`} />',
    ],
    [
      "a bar lifted clear of another bar",
      '<div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))]" />',
    ],
  ])("the scan sees %s", (_why, source) => {
    expect(isBottomEdgeSurface(source)).toBe(true);
    expect(registersWithTheEdge(source)).toBe(false);
  });

  it.each([
    [
      "a full-viewport scrim, which owns no edge in particular",
      '<div className="fixed inset-0 bg-black/40" />',
    ],
    ["a top-anchored bar", '<div className="fixed inset-x-0 top-0 h-1" />'],
    [
      "a narrow rail that ends above the edge",
      '<div className="fixed right-0 top-20 bottom-[calc(5rem+env(safe-area-inset-bottom))] w-11" />',
    ],
    ["a sticky header", '<div className="sticky top-0 z-10 bg-surface" />'],
    [
      "prose that only NAMES the shape",
      "// a fixed inset-0 surface with items-end would anchor to the bottom",
    ],
  ])("the scan stays silent on %s", (_why, source) => {
    expect(isBottomEdgeSurface(source)).toBe(false);
  });

  it.each([
    ["a claim call", "const r = useBottomEdgeClaim<HTMLDivElement>();", true],
    ["a composed token", "className={BOTTOM_EDGE_NOTICE_BOTTOM}", true],
    [
      "a comment wishing for one",
      "// should really useBottomEdgeClaim one day",
      false,
    ],
    [
      "an import with the call deleted — the shape that shipped this rule green",
      'import { useBottomEdgeClaim } from "@/components/overlay";\nexport default function S() { return null; }',
      false,
    ],
  ])(
    "the registration half reads DOING it, not saying it: %s",
    (_why, source, expected) => {
      expect(registersWithTheEdge(source)).toBe(expected);
    }
  );
});
