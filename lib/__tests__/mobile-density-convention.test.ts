import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The phone density conventions (issue #3466) — a source scan in the tradition of
// bottom-edge-tokens.test.ts, over the two spacing layers that #3466 stepped down.
//
// The regression this freezes is NOT "the numbers changed". It is the one #3466
// was filed to prevent: eight per-file numbers instead of one convention. A sweep
// that lands `max-sm:p-3` at eight call sites has spent the effort and bought
// nothing, because the ninth sub-panel added next month inherits nothing — so the
// value of this work is entirely in there being exactly ONE place each step is
// written, and this test is what makes that checkable.
//
// Four rules:
//   1. app/globals.css declares every tier of both conventions, once each.
//   2. Every tier is a `max-sm:` override carrying `!`. This is the DESKTOP-SAFETY
//      proof and it is structural rather than measured: a `max-sm:` variant emits
//      only inside `@media (width < 40rem)`, so at >=`sm` these classes contribute
//      nothing at all and there is no per-site desktop value to get wrong. (Checked
//      against the compiled sheet while #3466 was written: all seven rules land
//      inside that one media query, `!important` included, and nowhere else.) The
//      `!` is load-bearing for the OTHER direction — Tailwind 4 sorts custom
//      utilities independently of source order, so without it a call site's own
//      `p-4` could win the tie and the convention would apply or not depending on
//      generated order.
//   3. Every site #3466 enumerated still carries its tier class, next to the inset
//      it steps down FROM. The pair is the review moment: a call site that changes
//      its desktop padding has to come here and re-pick its tier.
//   4. NOBODY outside app/globals.css hand-writes a phone step for these two
//      properties. This is the rule that keeps a second convention from quietly
//      appearing beside the first, which is the actual failure mode #3466 names.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GLOBALS = "app/globals.css";

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

// tier -> the phone value it sets. Desktop is whatever the call site already had.
const TIERS = new Map<string, string>([
  // Class A — a padded box INSIDE a padded card. Keyed by the inset the box
  // carries today, because that is what a call site looks at to pick one.
  ["subpanel-inset", "p-3"], // from p-4 (16) / p-4 sm:p-5
  ["subpanel-inset-sm", "p-2.5"], // from p-3 (12)
  ["subpanel-inset-xs", "p-2"], // from p-2.5 (10)
  // Class C — the vertical seam BETWEEN page sections.
  ["section-seam", "mb-4"], // from mb-6 (24)
  ["section-seam-lg", "mb-6"], // from mb-8 (32)
  ["section-stack", "space-y-6"], // from space-y-10 (40)
  ["section-stack-sm", "space-y-4"], // from space-y-6 (24)
]);

// Every site #3466's table names, plus the same-shape siblings on the same card
// that the convention has to reach for the surface to read as one thing: file ->
// (tier, the inset it steps down from). A new sub-panel is added here, which is
// the point — the list is a census, not a changelog.
const SITES: ReadonlyArray<readonly [string, string, string]> = [
  // A. Boxed sub-panels inside cards, worst first (the issue's own order).
  ["app/(app)/settings/ai/AiTierSettings.tsx", "subpanel-inset", "p-4"],
  ["components/practices/PracticeTrends.tsx", "subpanel-inset", "p-4 sm:p-5"],
  ["app/(app)/trends/VitalsTodayStrip.tsx", "subpanel-inset", "px-4 py-3.5"],
  ["app/(app)/settings/server/BackupSettings.tsx", "subpanel-inset-sm", "p-3"],
  ["app/(app)/settings/server/SmtpSettings.tsx", "subpanel-inset-sm", "p-3"],
  ["app/(app)/settings/family/FamilyManager.tsx", "subpanel-inset-sm", "p-3"],
  ["app/(app)/training/TrainingWatchCard.tsx", "subpanel-inset-sm", "p-3"],
  ["components/FindingRow.tsx", "subpanel-inset-sm", "p-3"],
  ["app/(app)/training/EndurancePlanBar.tsx", "subpanel-inset-sm", "py-3"],
  ["app/(app)/training/MuscleCoverageCard.tsx", "subpanel-inset-xs", "p-2.5"],
  ["app/(app)/encounters/AppointmentList.tsx", "subpanel-inset-sm", "p-3"],
  ["app/(app)/longevity/PillarStat.tsx", "subpanel-inset-xs", "p-2.5"],
  // B. The unwrapped card-in-card, which lands as a sub-panel of its host card.
  ["components/IntegrationSyncHistoryLink.tsx", "subpanel-inset", "p-4"],
  // C. The seams the sweep flagged by name.
  ["app/(app)/records/VisitsSection.tsx", "section-stack", "space-y-10"],
  ["app/(app)/records/VisitsSection.tsx", "section-stack-sm", "space-y-6"],
  ["app/(app)/whats-new/page.tsx", "section-stack-sm", "space-y-6"],
  ["app/(app)/results/BioAgeInputsCard.tsx", "section-seam", "mb-6"],
  ["components/dashboard/DashboardAhead.tsx", "section-seam-lg", "mb-8"],
  [
    "components/dashboard/DashboardStandingCluster.tsx",
    "section-seam-lg",
    "mb-8",
  ],
  ["app/(app)/wellness/page.tsx", "section-seam-lg", "mb-8"],
];

// Rule 4's scan. These are the SPELLINGS this convention owns; a `max-sm:` step
// for any other property (the table utilities' row flattening, for instance) is
// somebody else's business and must stay quiet here.
const OWNED_STEP = /max-sm:(p-[\d.]+|mb-\d+|space-y-\d+)\b/;

// The three test directories are excluded and nothing else is: a spec that NAMES
// the forbidden spelling in order to argue about it — this file does, twice — is
// not a call site, and a guard that fires on its own source gets deleted.
const NOT_A_CALL_SITE = /^lib\/__(tests|db_tests|action_tests)__\//;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(REPO, dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".tsx") || e.name.endsWith(".ts")) out.push(rel);
    }
  };
  for (const d of ["app", "components", "lib"]) walk(d);
  return out.filter((f) => !NOT_A_CALL_SITE.test(f));
}

describe("phone density conventions (#3466)", () => {
  const css = read(GLOBALS);

  it("rule 1+2: every tier is declared once in app/globals.css, as a max-sm override carrying !", () => {
    for (const [tier, phoneValue] of TIERS) {
      const declarations = [
        ...css.matchAll(new RegExp(`@utility ${tier} \\{`, "g")),
      ];
      expect(
        declarations.length,
        `${tier} must be declared exactly once in ${GLOBALS} — it is the single place its phone step is written`
      ).toBe(1);

      // The body, verbatim. Anything else — a bare `p-3`, a `sm:` twin, a second
      // declaration — would put a desktop value inside the convention, which is
      // the one thing its construction guarantees it cannot have.
      const body = css.slice(css.indexOf(`@utility ${tier} {`));
      const rule = body.slice(0, body.indexOf("}"));
      expect(
        rule,
        `${tier} must be spelled '@apply max-sm:${phoneValue}!;' — the max-sm variant is what makes desktop identical by construction, and the ! is what makes the convention beat a call site's own padding regardless of Tailwind's generated order`
      ).toContain(`@apply max-sm:${phoneValue}!;`);
    }
  });

  it("rule 3: every site #3466 enumerated carries its tier next to the inset it steps down from", () => {
    for (const [file, tier, from] of SITES) {
      const src = read(file);
      expect(src, `${file} must carry ${tier} (#3466)`).toContain(tier);
      expect(
        src,
        `${file} must still carry its own '${from}' — the convention is an ADDITION beside the desktop vocabulary, never a replacement for it; a site that drops it has moved its desktop value too`
      ).toContain(from);
    }
  });

  it("rule 4: nobody outside app/globals.css hand-writes a phone step for these properties", () => {
    const offenders = sourceFiles().filter((f) => OWNED_STEP.test(read(f)));
    expect(
      offenders,
      "a per-file `max-sm:p-*` / `max-sm:mb-*` / `max-sm:space-y-*` is the second convention #3466 exists to prevent — add a tier to app/globals.css and use it"
    ).toEqual([]);
  });

  it("the two card-in-card nests draw one border each (#3466 class B)", () => {
    // /data mounts IntegrationsGrid — itself a grid of `.card`s — so its wrapper
    // may not be one. Matched on the wrapper's own id, not on the file: the page
    // has many legitimate cards.
    const dataPage = read("app/(app)/data/page.tsx");
    const wrapper = /<div id="integrations" className="([^"]*)"/.exec(dataPage);
    expect(
      wrapper,
      "the /data integrations wrapper must still be findable by id"
    ).not.toBeNull();
    expect(
      wrapper![1].split(/\s+/),
      "the integrations wrapper may not be a `.card` — the grid inside it already draws one border per source"
    ).not.toContain("card");

    // The takeout page's Status card is this link's only host, and it mounts it
    // INSIDE that card.
    const link = read("components/IntegrationSyncHistoryLink.tsx");
    const cls = /className="([^"]*)"/.exec(link);
    expect(
      cls,
      "IntegrationSyncHistoryLink must still carry a className"
    ).not.toBeNull();
    expect(
      cls![1].split(/\s+/),
      "IntegrationSyncHistoryLink may not hardcode `card` on itself — every host it has mounts it inside one"
    ).not.toContain("card");
  });
});
