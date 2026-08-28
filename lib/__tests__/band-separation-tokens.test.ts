import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// THE BAND STILL SEPARATES FROM THE CANVAS (issue #3673).
//
// Below `sm` no card draws a frame, so what used to say "this is a surface" — a
// 1.5px `--border` and a radius — is gone and the FILL is carrying it alone. The
// invariant the issue names is the one that fails silently: a band that becomes
// invisible against the canvas is a failed de-card, not a shipped one, and it
// fails in exactly one theme at a time, which is how nobody notices.
//
// WHAT THIS ASSERTS AND IN WHAT UNIT. Not a WCAG ratio: 1.4.11's 3:1 floor is for
// a CONTROL BOUNDARY (`--field-bd`, design-system.md's token table) and no
// accessibility floor governs one background against another. What governs a band
// is that a reader can see where it starts, and the quantity is the WCAG
// contrast-ratio formula applied to the two fills — a number in [1, 21] that is 1
// exactly when the two are indistinguishable. So the floors below are the values
// the Botanical palette SHIPS today, recorded to the third decimal, and their job
// is to fail a token edit that flattens a band into its ground. They are a
// RECORDED FLOOR, not a design opinion: raising a token's separation is expected
// and the fix is to raise the number in the same change.
//
// The pairs are read out of `app/globals.css` rather than restated, because a test
// carrying its own copy of the palette proves the copy and not the app.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CSS = fs.readFileSync(path.join(REPO, "app/globals.css"), "utf8");

// The light block is `:root { … }`; the dark block is the one inside the `dark`
// custom variant. Anchored on each token's FIRST and SECOND definition in file
// order, which is the order globals.css declares them (light, then dark).
function tokens(name: string): [string, string] {
  const hits = [
    ...CSS.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, "g")),
  ].map((m) => m[1]);
  if (hits.length < 2)
    throw new Error(
      `--${name} must be defined for both themes in app/globals.css; found ${hits.length}`
    );
  return [hits[0], hits[1]];
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(
    (i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255
  );
  const [r, g, b] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// theme -> the band's fill, the ground it must stand off, the hairline it draws
// between its own rows, and the floor that pair holds today.
const SEPARATIONS = [
  // "fill OR divider" is the acceptance wording; both are asserted, because on a
  // phone a band relies on the first to say where it starts and the second to say
  // where one row ends. Losing either is a real regression.
  ["light", "surface", "canvas-base", 1.153],
  ["dark", "surface", "canvas-base", 1.097],
  ["light", "divider", "surface", 1.177],
  ["dark", "divider", "surface", 1.121],
] as const;

describe("a band stays separable from its ground (#3673)", () => {
  it.each(SEPARATIONS)(
    "%s: --%s against --%s holds at least %f:1",
    (theme, fill, ground, floor) => {
      const index = theme === "light" ? 0 : 1;
      const measured = ratio(tokens(fill)[index], tokens(ground)[index]);
      expect(
        measured,
        `--${fill} and --${ground} are the only thing left telling a ${theme}-mode reader where a band begins now that the frame is gone`
      ).toBeGreaterThanOrEqual(floor);
    }
  );

  // The floors are absence-shaped — "not less than" passes on any two colours far
  // apart — so the reading itself is exercised on values whose answer is known.
  it("the ratio reads what it claims: 21:1 at the extremes, 1:1 on identity", () => {
    expect(ratio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(ratio("#f4f8f0", "#f4f8f0")).toBe(1);
  });

  // And the pairs are real tokens, not a typo that would read as two missing
  // definitions and throw — which is the failure this test must not swallow.
  it("a token this file names but globals.css does not defines nothing to compare", () => {
    expect(() => tokens("surface-that-does-not-exist")).toThrow(/both themes/);
  });
});
