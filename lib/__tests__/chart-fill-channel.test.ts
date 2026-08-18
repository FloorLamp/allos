import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// THE FILL CHANNEL (issue #2653, owner call 3).
//
// A dot's fill/hollow was carrying three meanings at once by 2026-08: hollow =
// an inexact bounded reading (BiomarkerChartInner), solid = "the readings are
// the content" (#2689's sparse demotion), and state 6 was about to make it four.
// The owner assigned the channel to INEXACTNESS — the meaning with clinical
// stakes — and sent the other two to channels they actually meant (mark size for
// sparse emphasis, paired offset marks for two-sources-one-day).
//
// This file is what makes that an app-wide fact rather than a note in a comment.
// It is a SOURCE SCAN because the thing being guarded is a vocabulary, and a
// vocabulary can only be checked across every speaker at once: any chart may
// reach for a surface-filled circle in a future pass, and the failure would be
// silent at runtime — a reader sees a hollow dot and has no way to know which
// claim it is making.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAFFOLD = "components/chart-scaffold.tsx";

function chartSources(): string[] {
  const dir = path.join(REPO, "components");
  return fs
    .readdirSync(dir)
    .filter((f) => /(Chart|chart)/.test(f) && /\.tsx?$/.test(f))
    .map((f) => `components/${f}`);
}

const scaffold = fs.readFileSync(path.join(REPO, SCAFFOLD), "utf8");

/** A `export const NAME = <number>;` in the scaffold, read as text — the pure
 *  tier does not import components/. */
function num(name: string): number | null {
  const m = scaffold.match(
    new RegExp(`export const ${name}\\s*=\\s*([0-9.]+)\\s*;`)
  );
  return m ? Number(m[1]) : null;
}

describe("fill means exactness, and only exactness", () => {
  it("the scaffold declares exactly one hollow mark, and names what it means", () => {
    expect(
      /export function chartInexactDot\b/.test(scaffold),
      "chart-scaffold must export chartInexactDot — the ONE hollow mark"
    ).toBe(true);
    // The helper's body is the only place a surface fill may appear.
    const body = scaffold.slice(
      scaffold.indexOf("export function chartInexactDot")
    );
    expect(body.slice(0, body.indexOf("}")).includes("fill: c.surface")).toBe(
      true
    );
  });

  it("no chart draws a surface-filled dot of its own", () => {
    const offenders: string[] = [];
    for (const rel of chartSources()) {
      if (rel === SCAFFOLD) continue;
      const text = fs.readFileSync(path.join(REPO, rel), "utf8");
      text.split("\n").forEach((line, i) => {
        // `stroke: c.surface` is the separator ring (chartStackSegmentProps, and
        // the solid dot's own halo) — a different channel entirely, so only FILL
        // is scanned.
        if (!/fill\s*[:=]\s*\{?\s*(c|colors)\.surface/.test(line)) return;
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(
      offenders,
      "a hollow dot means an INEXACT BOUNDED reading (#2653 owner call 3). " +
        "Use chartInexactDot from the scaffold, or a channel that isn't fill."
    ).toEqual([]);
  });

  it("the scaffold itself spends its one surface fill inside that helper", () => {
    const hits = scaffold
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((r) => /fill\s*[:=]\s*\{?\s*c\.surface/.test(r.line));
    expect(hits.map((h) => `${h.n}: ${h.line}`)).toHaveLength(1);
    const helper = scaffold.indexOf("export function chartInexactDot");
    const nextExport = scaffold.indexOf("\nexport ", helper + 1);
    const body = scaffold.slice(helper, nextExport);
    expect(
      body.includes(hits[0].line),
      "the scaffold's only surface-filled mark must be chartInexactDot"
    ).toBe(true);
  });

  it("the sparse demotion has left the fill channel", () => {
    const body = scaffold.slice(
      scaffold.indexOf("export function chartSparseDot")
    );
    const decl = body.slice(0, body.indexOf("\n}"));
    expect(
      /fill:\s*color/.test(decl),
      "chartSparseDot must fill with the series colour like any exact reading — " +
        "its emphasis rides mark SIZE, not fill"
    ).toBe(true);
    expect(/fill:\s*c\.surface/.test(decl)).toBe(false);
  });
});

describe("the emphasis that replaced it rides mark size", () => {
  it("finds the radii it is meant to compare", () => {
    // A guard on the guard: a regex that stopped matching would make every
    // inequality below vacuously true.
    expect(num("CHART_DOT_R")).not.toBeNull();
    expect(num("CHART_SPARSE_DOT_R")).not.toBeNull();
    expect(num("CHART_ACTIVE_DOT_R")).not.toBeNull();
  });

  it("a demoted line's marks out-weigh an ordinary line's", () => {
    expect(num("CHART_DOT_R") as number).toBeLessThan(
      num("CHART_SPARSE_DOT_R") as number
    );
  });

  it("hover is still a state change on a demoted line", () => {
    expect(num("CHART_SPARSE_DOT_R") as number).toBeLessThan(
      num("CHART_ACTIVE_DOT_R") as number
    );
  });

  it("the inexact mark sits AT the ordinary radius, by name and not by luck", () => {
    // #2831, and the same shape as #2829's surprise. `chartInexactDot` kept an
    // `r: 3` literal from the hollow default it replaced, so inexactness rode
    // SIZE as well as fill — on the channel the fill move had just assigned to
    // prominence. Nothing chose the 3, and nothing looked.
    //
    // Asserted on the SPELLING rather than on the value, because a literal that
    // happens to equal CHART_DOT_R today is the same bug back: it stops tracking
    // the constant the moment the constant moves.
    const body = scaffold.slice(
      scaffold.indexOf("export function chartInexactDot")
    );
    const decl = body.slice(0, body.indexOf("\n}"));
    const r = decl.match(/\br:\s*([^,\n]+)/);
    expect(r, "chartInexactDot must set a radius").not.toBeNull();
    expect(
      (r as RegExpMatchArray)[1].trim(),
      "an inexact reading is not a prominent one. Mark size means prominence " +
        "alone — ordinary, emphasised, hover — so the hollow mark is drawn at " +
        "CHART_DOT_R, never at a literal of its own."
    ).toBe("CHART_DOT_R");
  });
});
