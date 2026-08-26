import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "./strip-comments";

// THE HOUSEHOLD GLANCE'S READS AND LINK TREATMENTS (#3487), as a source scan.
//
// Two of #3487's five fixes are pinned by pure tests over the shared computations they
// changed — the missed-line grouping in `intake-deltas.test.ts`, the lay gap nouns in
// `data-quality.test.ts`. The three that remain are a QUERY the page must no longer
// call, a class two links must no longer spell, and a glyph two doors must share, and
// all three live in `app/**` / `components/**` where the DOM tier (#3446) cannot reach
// a server component. So: a scan, comments blanked (both files argue about the retired
// shapes in prose, and a scan over raw source reads prose as code — #3509).
//
// The rendered half is `household-round.spec.ts`: the panel line, its tone badge and
// the two matching door glyphs, read off the real page.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function read(rel: string): string {
  return stripComments(fs.readFileSync(path.join(REPO, rel), "utf8"));
}

const PAGE = "app/(app)/household/page.tsx";
const CARD = "components/HouseholdCard.tsx";

describe("the member card speaks the broad panel, not the widest net (#3487 item 1)", () => {
  it("no out-of-reference-range read remains on this page", () => {
    const src = read(PAGE);
    // The retired read was `countClinicalObservations(pid, { current: true, range:
    // "oor" })`. Asserting the absence of the FUNCTION rather than of the option
    // object is the check that cannot be walked around by reformatting the call.
    expect(src).not.toContain("countClinicalObservations");
    expect(src).not.toMatch(/range:\s*"oor"/);
  });

  it("…and the OOR read is still available to the surfaces that own it", () => {
    // The ruling moved this line's AXIS; it retired nothing. A guard that had
    // actually deleted the query would be reporting a different, larger change.
    const queries = fs.readFileSync(
      path.join(REPO, "lib/queries/medical.ts"),
      "utf8"
    );
    expect(queries).toContain("countClinicalObservations");
  });

  it("the fraction comes from the dashboard's own hit-rate read, not a second derivation", () => {
    const src = read(PAGE);
    // `getOptimalHitRate` is the same gather + the same `optimalRangeHitRate` the
    // Longevity pillar consumes (#2023), which is what makes the two surfaces agree
    // by construction rather than by two authors matching a number.
    expect(src).toContain("getOptimalHitRate(pid)");
    expect(src).toContain("optimalTone(optimal)");
  });

  it("the card renders the fraction with the pillar's own tone map and its text twin", () => {
    const src = read(CARD);
    expect(src).toContain("Biomarkers optimal");
    expect(src).toContain("PILLAR_TONE_CLASS[biomarkers.tone]");
    // WCAG 1.4.1 (#1220): the verdict may not travel by colour alone, and the badge
    // is the ONE mapping both pillar surfaces already render.
    expect(src).toContain("<PillarToneBadge tone={biomarkers.tone} />");
    // Nothing left that colours a raw count rose.
    expect(src).not.toContain("oorBiomarkers");
  });
});

describe("the setup block's links join text-link (#3487 item 2 / #2719)", () => {
  // `text-link` is documented in app/globals.css as "the ONE inline action-link
  // treatment" and is the recorded survivor of exactly this kind of per-widget
  // near-copy. The setup block had re-spelled it as a literal sky pair at two sites,
  // on a card where three brand links render on the same screen.
  const CTA_ANCHOR = 'data-testid="household-setup-cta"';

  it("both CTA sites draw text-link", () => {
    const src = read(CARD);
    const sites = [...src.matchAll(new RegExp(CTA_ANCHOR, "g"))];
    // FLOOR FIRST: the two sites are a <Link> (a login-scoped route) and a form
    // <button> (a member-scoped route that needs the profile switch). An absence
    // assertion over "no sky classes" goes green the moment the scan stops finding
    // either, so count them before judging them.
    expect(sites.length).toBe(2);
    for (const site of sites) {
      // The className sits on the same tag; read the tag, not the file.
      const open = src.lastIndexOf("<", site.index);
      const close = src.indexOf(">", site.index);
      const tag = src.slice(open, close);
      expect(tag, tag).toContain("text-link");
      expect(tag, tag).not.toMatch(/text-sky-\d/);
    }
  });

  it("the scan can SEE a hand-rolled sky link", () => {
    expect(
      /text-sky-\d/.test(
        'className="mt-1 inline-block text-xs font-medium text-sky-700 hover:underline dark:text-sky-300"'
      )
    ).toBe(true);
  });

  it("the check's TONE map may still be sky — #3487 left that to the tone map", () => {
    // The block's non-link headline colours from `SETUP_TONE_TEXT`, whose `action`
    // entry is sky by the attention model's own banding vocabulary (#2173). Item 2
    // ruled the LINKS only, and a guard that swept the whole file for "text-sky"
    // would have quietly demanded a change nobody made.
    expect(read(CARD)).toContain('action: "text-sky-700 dark:text-sky-300"');
  });
});

describe("one arrow glyph for the doors in one row (#3487 item 5)", () => {
  it("both doors delegate their chevron to DestinationLink", () => {
    const page = read(PAGE);
    const door = read("components/intake/SharedSuppliesLink.tsx");
    const primitive = read("components/DestinationLink.tsx");
    const indicator = read("components/DestinationIndicator.tsx");
    expect(door).toContain("DestinationLink");
    expect(page).toContain("DestinationLink");
    expect(primitive).toContain("DestinationIndicator");
    expect(indicator).toContain("IconChevronRight");
    // The literal arrow this row used to end on is gone.
    expect(page).not.toContain("History →");
  });

  it("the scan can SEE a literal arrow glyph in that row", () => {
    expect("History →".includes("→")).toBe(true);
  });
});
