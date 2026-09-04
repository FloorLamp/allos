import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import Database from "better-sqlite3";
import {
  hydratedClick,
  openCombobox,
  openDashboardAll,
  settledFill,
} from "./helpers";
import { workerDbPath } from "./worker-env";
import {
  CENSUS_EXEMPT_SUBTREES,
  CENSUS_KNOWN_OFFENDERS,
  MACHINE_DATE_RE,
  knownMachineDateOffender,
  machineDateHits,
} from "@/lib/machine-date-census";
import { MACHINE_LAB_UNIT_RE } from "@/lib/machine-lab-unit-census";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";

import { plantTrashCaptures, sweepTrashProbes } from "./trash-probe";
import { openGoalFact } from "./goal-form-helpers";

// THE MACHINE-TEXT CENSUS (#3492/#3545) — no storage-format date or bare ASCII
// microgram lab unit reaches user copy.
//
// Four surfaces printed a raw `YYYY-MM-DD` at a person in ONE day's review, which
// is why this is a class guard rather than a fifth per-page fix: the surface added
// next month inherits nothing from four format calls. The rule itself
// (lib/machine-date-census.ts) is shared with the pure test that proves it can SEE
// and stay QUIET; this file is what asks it of RENDERED PAGES.
//
// ── IT IS AN ABSENCE ASSERTION, SO IT FAILS OPEN ────────────────────────────────
//
// "No user-facing copy contains an ISO date" goes green the moment the probe stops
// finding any copy at all: a changed selector, a route that 404s under this
// fixture, an empty seed, a shell that renders before its content. Nothing about
// that failure looks like a failure. So NOTHING here believes a clean sweep until
// the sweep has proved it took place, and it proves it three ways, in this order:
//
//   1. A ROUTE-READINESS PROOF. Most routes use a deliberately loose census
//      floor: a 404 page and a bare shell come in an order of magnitude under it.
//      A compact surface whose density legitimately changes instead names stable
//      semantic landmarks; it must still yield a non-empty census sample.
//   2. A NAMED SUBJECT per route — the element whose date was the defect — which
//      must be among the nodes actually collected. This is the tighter half: a
//      floor can be met by 200 nav labels while the table the route exists for
//      never rendered. A count says "something was here"; the subject says "the
//      thing I am making a claim about was here".
//   3. A SYNTHETIC OFFENDER, planted in the live DOM of the last route and required
//      to be caught. A collector that reads the wrong root, or a matcher that was
//      quietly narrowed, fails this while sailing through the other two.
//
// ── WHAT IT READS, AND WHY NOT SOURCE ───────────────────────────────────────────
//
// Rendered TEXT NODES, never source and never `innerText` of a whole page. Every
// offending site is computed (`{r.date}`), so a source scan finds none of them
// while flagging comments, fixtures and `<time datetime="…">` attributes that are
// the boundary working correctly. A text node cannot be an attribute, a `value=`,
// or a comment, so the legitimate machine dates are excluded by the MECHANISM
// rather than by an allowlist somebody has to maintain. See the rule module.
//
// Fixture (#868 hygiene): READ-ONLY over the shared seed. Nothing is written, no
// seeded row is exact-counted, and the synthetic offender is planted in the DOM of
// a page that is about to be discarded — never in the database.

interface CensusRoute {
  path: string;
  /** What this route is in the census FOR. */
  why: string;
  /**
   * The floor on rendered text nodes. Set from a measured run and rounded DOWN
   * hard: the number exists to separate "this page rendered" from "this page
   * 404'd or rendered a shell", not to pin a layout. Omit only when `assertReady`
   * names a stronger semantic readiness proof.
   */
  minTextNodes?: number;
  /**
   * Semantic route readiness for a compact surface whose text-node density is not
   * a stable contract. This must prove the route-specific content (not only shared
   * shell chrome) rendered. Exactly one of this and `minTextNodes` is declared.
   */
  assertReady?: (page: Page) => Promise<void>;
  /** Rules this route was added to exercise. Omit to run both. */
  kinds?: ("date" | "lab-unit")[];
  /**
   * Where this route's date-bearing copy lives. The census only believes its own
   * silence once one of these elements has been seen carrying a date IN THE DISPLAY
   * SHAPE — which proves both that the surface rendered and that the boundary is
   * doing its job, in one assertion.
   */
  subject?: string;
  /** The exact fixture-owned result this census proves rendered a micro unit. */
  unitSubject?: (page: Page) => Locator;
  /** Extra work needed before the subject is on screen. */
  reveal?: (page: Page) => Promise<void>;
  /**
   * A route whose subject the shared seed does not supply, so this census plants
   * it and sweeps it (#3491). Kept as a declared property rather than a special
   * case in the loop, because a route the census cannot render is a route whose
   * silence means nothing — which is the failure this whole file is built around.
   */
  plant?: () => void;
  sweep?: () => void;
}

// THE PALETTE'S LOGGED-ROW PROBE (#5006). Global search now indexes the record's
// row-only kinds, and each hit's subtitle states the day it is filed under — the
// first date this surface has ever printed. The shared seed cannot be relied on to
// put one in front of a fixed query, and a route whose subject never renders is a
// route whose silence means nothing, so the census plants its own symptom row and
// sweeps it. A symptom on purpose: it is the one logged kind with no catalog entity
// beside it, so the query returns this row and nothing else.
const LOGGED_SYMPTOM_PROBE = "Census itch";
const LOGGED_SYMPTOM_DAY = "2026-01-09";

function sweepLoggedSymptomProbe(): void {
  const handle = new Database(workerDbPath());
  try {
    handle
      .prepare("DELETE FROM symptom_logs WHERE profile_id = 1 AND symptom = ?")
      .run(LOGGED_SYMPTOM_PROBE);
  } finally {
    handle.close();
  }
}

function plantLoggedSymptomProbe(): void {
  sweepLoggedSymptomProbe();
  const handle = new Database(workerDbPath());
  try {
    handle
      .prepare(
        `INSERT INTO symptom_logs (profile_id, date, symptom, severity)
         VALUES (1, ?, ?, 2)`
      )
      .run(LOGGED_SYMPTOM_DAY, LOGGED_SYMPTOM_PROBE);
  } finally {
    handle.close();
  }
}

const FOLLOWUP_COPY_PROBE = "e2e:lab-unit-census-followup";
const RESOLVING_COPY_PROBE = "e2e:lab-unit-census-resolving";
const REFERENCE_COPY_PROBE = "e2e:lab-unit-census-reference";

function sweepFollowupCopyProbe(): void {
  const handle = new Database(workerDbPath());
  try {
    handle
      .prepare(
        "DELETE FROM care_plan_items WHERE profile_id = 1 AND external_id = ?"
      )
      .run(FOLLOWUP_COPY_PROBE);
    handle
      .prepare(
        "DELETE FROM medical_records WHERE profile_id = 1 AND external_id = ?"
      )
      .run(RESOLVING_COPY_PROBE);
  } finally {
    handle.close();
  }
}

function plantFollowupCopyProbe(): void {
  sweepFollowupCopyProbe();
  const handle = new Database(workerDbPath());
  try {
    const source = handle
      .prepare(
        `SELECT id FROM medical_records
         WHERE profile_id = 1 AND canonical_name = 'Selenium'
         ORDER BY date, id LIMIT 1`
      )
      .get() as { id: number };
    const { today } = handle.prepare("SELECT date('now') AS today").get() as {
      today: string;
    };
    handle.transaction(() => {
      handle
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, value_num, unit,
              canonical_name, flag, source, external_id)
           VALUES (1, ?, 'lab', 'Selenium', '46', 46, 'ug / L',
                   'Selenium', 'low', 'manual', ?)`
        )
        .run(today, RESOLVING_COPY_PROBE);
      handle
        .prepare(
          `INSERT INTO care_plan_items
             (profile_id, description, category, planned_date, status,
              source_kind, source_medical_record_id,
              recommended_interval_days, external_id)
           VALUES (1, 'Recheck Selenium', 'follow-up', ?, NULL,
                   'labs', ?, 30, ?)`
        )
        .run(today, source.id, FOLLOWUP_COPY_PROBE);
    })();
  } finally {
    handle.close();
  }
}

function sweepReferenceCopyProbe(): void {
  const handle = new Database(workerDbPath());
  try {
    handle
      .prepare(
        "DELETE FROM medical_records WHERE profile_id = 1 AND external_id = ?"
      )
      .run(REFERENCE_COPY_PROBE);
  } finally {
    handle.close();
  }
}

function plantReferenceCopyProbe(): void {
  sweepReferenceCopyProbe();
  const handle = new Database(workerDbPath());
  try {
    handle
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, value_num, unit,
            canonical_name, fasting, source, external_id)
         VALUES (1, date('now'), 'lab', 'E2E Micro Reference', '9', 9,
                 'mg/dL', 'Insulin, Fasting', 1, 'manual', ?)`
      )
      .run(REFERENCE_COPY_PROBE);
  } finally {
    handle.close();
  }
}

// Document 908 is the e2e seed's multi-tab import (e2e/seed-events.ts): labs,
// a projected medication, a visit, a condition, an immunization, a provider.
// Document 912 carries the vitals rows, which take the READ-ONLY row presentation
// (#1182) rather than the editable analyte grid — two different date cells.
const ROUTES: CensusRoute[] = [
  {
    path: "/",
    why: "Dashboard Standing rows — '112/72 mmHg 2026-07-22' in the filed report.",
    minTextNodes: 120,
    subject: '[data-testid="vitals-latest-bp-age"]',
    unitSubject: (page) =>
      page.locator(
        '[data-testid="dashboard-candidate"][data-candidate-id="labs.latest:Selenium"]'
      ),
    // ONE fold since #4232, and it is the reason this route reveals at all. A quiet
    // clinical result sits behind Show everything — present in the DOM, hidden — so a
    // census that reads RENDERED copy stops seeing it. Copy one tap behind a disclosure
    // is still copy a person reaches, so the census opens the fold and looks; it does
    // not lower its expectation to "visible or hidden", which would make it unable to
    // tell reachable copy from copy that is gone.
    reveal: async (page) => {
      await openDashboardAll(page);
    },
  },
  {
    path: "/?quick=search",
    why: "Global search's precomposed Selenium result subtitle.",
    minTextNodes: 40,
    kinds: ["lab-unit"],
    unitSubject: (page) =>
      page.getByRole("option").filter({
        has: page.getByText("Selenium", { exact: true }),
      }),
    reveal: async (page) => {
      const input = page.getByRole("combobox", {
        name: "Search or run a command",
      });
      await expect(input).toBeVisible();
      await settledFill(page, input, "Selenium");
      await expect(
        page.getByRole("option").filter({
          has: page.getByText("Selenium", { exact: true }),
        })
      ).toBeVisible();
    },
  },
  {
    path: "/?quick=search",
    why: "Global search's logged-row subtitles — the day each record row is filed under (#5006).",
    minTextNodes: 40,
    kinds: ["date"],
    // THE SUBJECT IS THE WHOLE GUARD ON THIS ROUTE, and that is measured rather than
    // assumed: the collector below walks `document.querySelector("main")`, and the
    // palette is a dialog rendered OUTSIDE main, so no palette copy has ever entered
    // the offender sweep — on this route or on the lab-unit one above it. Forcing the
    // subtitle to the machine shape leaves the sweep silent and reds THIS line, which
    // is the assertion doing the work. Widening the collector past `main` would put
    // every dialog on every route into the sweep at once; that is its own change.
    //
    // The hit itself, not the group box: the group renders before its rows, and an
    // assertion taken between the two is a claim about an empty list.
    subject: '[data-testid="palette-group-logged"] [role="option"]',
    plant: plantLoggedSymptomProbe,
    sweep: sweepLoggedSymptomProbe,
    reveal: async (page) => {
      const input = page.getByRole("combobox", {
        name: "Search or run a command",
      });
      await expect(input).toBeVisible();
      await settledFill(page, input, LOGGED_SYMPTOM_PROBE);
      await expect(
        page
          .getByTestId("palette-group-logged")
          .getByRole("option", { name: LOGGED_SYMPTOM_PROBE })
      ).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    path: "/training?tab=goals",
    why: "The lab-goal target label and precomposed reference-range hint.",
    minTextNodes: 35,
    kinds: ["lab-unit"],
    unitSubject: (page) => page.getByTestId("goal-clinical-result-reference"),
    reveal: async (page) => {
      await hydratedClick(page, page.getByRole("button", { name: "Add goal" }));
      const form = page.getByTestId("goal-form");
      await expect(form).toBeVisible();
      const field = form.getByRole("combobox", { name: "Lab or vital" });
      const listbox = await openCombobox(page, field);
      await settledFill(page, field, "Selenium");
      await listbox
        .getByRole("option", { name: "Selenium", exact: true })
        .click();
      await expect(field).toHaveValue("Selenium");
      // Picking the subject leaves the summary-first form's subject editor open.
      // The reference hint belongs to Target, so open that real panel rather than
      // treating hidden mounted copy as visible proof.
      await openGoalFact(form, "target");
    },
  },
  {
    // `?q=` bounds the table to a row that is certain to be in the shared seed AND
    // opens its panel group: every group on the unfiltered page arrives COLLAPSED
    // (boundPanelGroups only sends rows for expanded groups), so the bare route
    // renders a table with no result rows at all — a census over it would have been
    // examining a page whose date cells were never created.
    path: "/results/clinical-results?q=E2E%20Novel%20Lab",
    why: "The clinical results table's Date cell (lib/reading-date-line's day half).",
    minTextNodes: 60,
    subject: "td[data-card='meta']",
    unitSubject: (page) =>
      page
        .getByRole("row")
        .filter({
          has: page.getByText("E2E Novel Lab", { exact: true }),
        })
        .locator("td[data-card='value']"),
  },
  {
    path: "/results/clinical-results?q=E2E%20Micro%20Reference",
    why: "The Clinical results mismatch branch's precomposed canonical reference unit.",
    minTextNodes: 55,
    kinds: ["lab-unit"],
    unitSubject: (page) =>
      page.getByTestId("clinical-result-reference").filter({ hasText: "µIU" }),
    plant: plantReferenceCopyProbe,
    sweep: sweepReferenceCopyProbe,
  },
  {
    path: "/results/clinical-results/view?name=Selenium",
    why: "The Selenium detail's latest value, curated ranges, chart labels, and history table.",
    // Measured 67 on the production fixture; 60 stays well above the shell while
    // leaving normal copy/layout variation room.
    minTextNodes: 60,
    subject: "table td",
    unitSubject: (page) => page.getByTestId("biomarker-latest-value"),
  },
  {
    path: "/longevity",
    why: "The biological-age input list's stored lab values and units.",
    minTextNodes: 40,
    // This route joins the census for its micro-unit fixture. Its existing raw
    // dates are #3492 follow-up scope, not a reason to omit the unit surface.
    kinds: ["lab-unit"],
    unitSubject: (page) =>
      page.getByTestId("bio-age-input").filter({
        has: page.getByRole("link", {
          name: "White Blood Cell Count",
          exact: true,
        }),
      }),
  },
  {
    path: "/upcoming",
    why: "Flagged-lab follow-up source and resolving labels on Upcoming.",
    minTextNodes: 30,
    kinds: ["lab-unit"],
    unitSubject: (page) =>
      page
        .locator('[data-testid^="upcoming-item-followup:"]')
        .filter({ hasText: "Recheck Selenium" }),
    plant: plantFollowupCopyProbe,
    sweep: sweepFollowupCopyProbe,
  },
  {
    path: "/trends?tab=insights&cmpA=result%3ASelenium&cmpB=metric%3Aweight&range=all",
    why: "The clinical Trends series' Compare legend and chart unit.",
    // #3656 correctly consolidated repeated chip text, reducing this compact route's
    // rendered text nodes without reducing what the census can observe. The stable
    // contract is the URL-selected pair plus its lazy chart — not how many separate
    // text nodes their controls happen to use. The unique `(µg/L)` subject below then
    // proves the clinical display boundary is present in that ready comparison.
    assertReady: async (page) => {
      await expect(
        page.getByRole("combobox", { name: "Series A" })
      ).toHaveValue("Selenium");
      await expect(
        page.getByRole("combobox", { name: "Series B" })
      ).toHaveValue("Weight");
      await expect(page.getByTestId("compare-chart")).toBeVisible();
    },
    kinds: ["lab-unit"],
    unitSubject: (page) => page.getByText("(µg/L)", { exact: true }),
  },
  {
    path: "/import/908",
    why: "Import review: the Document date provenance row and the analyte grid's DATE cells.",
    minTextNodes: 22,
    subject: "td[data-card='meta']",
    unitSubject: (page) =>
      page
        .getByRole("row")
        .filter({
          has: page.getByText("E2E Novel Lab", { exact: true }),
        })
        .locator("td[data-card='value']"),
  },
  {
    path: "/import/908?tab=visits",
    why: "Import review: the ProducedListing row date.",
    minTextNodes: 18,
    subject: '[data-testid="produced-item"]',
  },
  {
    path: "/import/912?tab=vitals",
    why: "Import review: the READ-ONLY row presentation's DATE cell (#1182).",
    minTextNodes: 18,
    subject: "td[data-card='meta']",
  },
  {
    // THE RECORD'S DAY HEADERS (#3958). This entry used to census the dose ledger's
    // window note — "Showing confirmed doses from … to …", #3478 item 2 — and that
    // note went with the range chrome when the four ledger routes folded into
    // `/history`. What the route still owes the census is the same guarantee at a
    // higher volume: the record prints ONE date per day group and nothing per row,
    // so a boundary regression shows up on every header at once.
    //
    // `assertReady` RATHER THAN A TEXT-NODE FLOOR, deliberately: this page's density
    // is whatever the shared seed logged that fortnight, so a floor here would be a
    // number nobody could re-derive. The readiness proof is the route's own content
    // — a rendered day group carrying a day link — which is a stronger claim than a
    // node count anyway.
    path: "/history?kind=dose",
    why: "The record's sticky day headers — the one date shape a day group prints (#3958).",
    assertReady: async (page) => {
      await expect(page.getByTestId("history-day").first()).toBeVisible(); // first-ok: the readiness proof is that ANY day group rendered; no per-day claim is made
    },
    subject: '[data-testid="history-day-link"]',
  },
  {
    // #3491 item 3: the Trash row printed `entry.date` in its headline and
    // `deletedAt.slice(0, 10)` in its subtitle — TWO machine dates per row, on a
    // surface where the date is the only thing distinguishing one untitled
    // capture from another. Both now cross the display boundary at the surface.
    //
    // IT PLANTS ITS OWN SUBJECT, and that is not a shortcut. The shared seed puts
    // nothing in `deleted_rows`, so this route renders an empty state — and an
    // empty page is precisely the state an absence assertion is flattered by. The
    // alternative, seeding the trash, cannot work while e2e/trash.spec.ts empties
    // the whole trash: the route would then be censused or not by shard
    // composition (#3388). See e2e/trash-probe.ts.
    path: "/data?section=trash",
    why: "Data → Trash: the row headline's capture date and its 'Deleted …' subtitle (#3491).",
    // MEASURED 2026-08-22, and the number the floor has to clear is not zero.
    // This route's failure-to-render state is not a blank page — it is the trash
    // EMPTY STATE, which renders the same intro card and reads 13 rendered text
    // nodes. The two planted rows read 24, and one row alone reads 20. So 18
    // sits above every state in which the list did not render and below the one
    // it is in the census for. (The other routes' "3× the floor" rounding would
    // have put it at 8 — under the empty state, which is exactly the silence an
    // absence assertion is flattered by.)
    minTextNodes: 18,
    subject: '[data-testid="trash-row-headline"]',
    plant: () =>
      plantTrashCaptures([
        { labelSuffix: "census untitled", title: null, date: "2019-03-11" },
        {
          labelSuffix: "census titled",
          title: "Morning ride along the river",
          date: "2019-04-02",
        },
      ]),
    sweep: sweepTrashProbes,
  },
];

// A date in the DISPLAY vocabulary: a written month beside a day-of-month, which is
// what all three of formatLongDate / formatMonthDay / formatDateWithYear emit under
// every non-"iso" pref. Loose ON PURPOSE — this is the "the surface rendered" half
// of the census, not a copy assertion, and pinning an exact string here would make
// it a second, weaker copy of the formatter's own unit tests.
//
// NO LEADING `\b`, and that is measured rather than sloppy. A ResponsiveTable meta
// cell carries a `card-cell-label` span, so the cell's text reads "DateJun 20, 2026"
// with no boundary between the label and the month — `\bJun` does not match it, and
// this check would have failed on a page that was rendering correctly. A matcher too
// tight fails toward "the surface never rendered", which on an absence assertion is
// the direction that manufactures work.
const DISPLAY_DATE =
  /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/;

const DISPLAY_MICRO_UNIT = /µ(?:g(?=\s*\/)|L\b|IU(?=\s*\/)|mol(?=\s*\/))/;

interface Census {
  examined: number;
  offenders: {
    kind: "date" | "lab-unit";
    text: string;
    testId: string;
    where: string;
  }[];
}

/**
 * Every RENDERED text node under `<main>`, minus the exempt subtrees, scanned for
 * machine dates and machine-spelled lab units.
 *
 * `matcherSource` is handed in rather than closed over: `page.evaluate` serializes
 * its argument into the browser, so the rules from lib/machine-date-census and
 * lib/machine-lab-unit-census travel with it and there is no second copy of either
 * pattern living in this file.
 */
async function census(
  page: Page,
  matcherSources: { date: string; labUnit: string }
): Promise<Census> {
  return page.evaluate(
    ({
      patterns,
      exemptSelectors,
    }: {
      patterns: { date: string; labUnit: string };
      exemptSelectors: string[];
    }) => {
      const matchers = [
        { kind: "date" as const, re: new RegExp(patterns.date, "g") },
        { kind: "lab-unit" as const, re: new RegExp(patterns.labUnit, "g") },
      ];
      const main = document.querySelector("main");
      if (!main) return { examined: 0, offenders: [] };
      const exempt = exemptSelectors.flatMap((s) => [
        ...main.querySelectorAll(s),
      ]);
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
      const out: {
        kind: "date" | "lab-unit";
        text: string;
        testId: string;
        where: string;
      }[] = [];
      let examined = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent ?? "";
        if (!text.trim()) continue;
        const parent = n.parentElement;
        if (!parent) continue;
        // NOT RENDERED IS NOT COPY. A closed <details>, a `hidden` attribute and a
        // `display:none` branch are all in the DOM and none of them is something a
        // person is reading. `offsetParent` is null for every one of them (and for
        // `position:fixed`, which is why the visibility check falls back to a rect).
        const shown =
          parent.offsetParent !== null ||
          parent.getClientRects().length > 0 ||
          parent.tagName === "BODY";
        if (!shown) continue;
        if (exempt.some((el) => el.contains(n))) continue;
        examined += 1;
        for (const matcher of matchers) {
          matcher.re.lastIndex = 0;
          const hits = [...text.matchAll(matcher.re)].map((m) => m[0]);
          for (const hit of hits) {
            const tag = parent.tagName.toLowerCase();
            const testid = parent.closest("[data-testid]");
            out.push({
              kind: matcher.kind,
              text: hit,
              testId: testid?.getAttribute("data-testid") ?? "",
              where:
                `${tag}` +
                (testid
                  ? ` inside [data-testid="${testid.getAttribute("data-testid")}"]`
                  : "") +
                ` — ${text.trim().slice(0, 90)}`,
            });
          }
        }
      }
      return { examined, offenders: out };
    },
    {
      patterns: matcherSources,
      exemptSelectors: CENSUS_EXEMPT_SUBTREES.map((e) => e.selector),
    }
  );
}

// NOT A COPY OF THE RULE — the rule itself, serialized into the page. A second
// spelling of the pattern living in this file could narrow silently, and an absence
// assertion over a narrowed matcher is green by construction.
const BROWSER_PATTERNS = {
  date: MACHINE_DATE_RE.source,
  labUnit: MACHINE_LAB_UNIT_RE.source,
};

test("every census route declares one honest route-readiness proof", () => {
  for (const route of ROUTES) {
    const strategies =
      Number(route.minTextNodes !== undefined) +
      Number(route.assertReady !== undefined);
    expect(
      strategies,
      `${route.path} must declare exactly one of minTextNodes or assertReady`
    ).toBe(1);
  }
});

test("no rendered copy states machine dates or ASCII microgram lab units (#3492/#3545)", async ({
  page,
}) => {
  test.slow(); // next start compiles each route on its first hit

  // ── PREMISE ────────────────────────────────────────────────────────────────────
  // "iso" is a date format a LOGIN MAY CHOOSE (lib/format-date's DateFormat), and a
  // login that chose it is asking for YYYY-MM-DD everywhere — under those prefs this
  // whole census is meaningless rather than merely noisy. It runs as the seeded
  // admin, who has set no override, so the resolved shape is the default. Pinning
  // the default here means a change to it re-opens this question instead of turning
  // the census into a tautology.
  expect(
    DEFAULT_FORMAT_PREFS.dateFormat,
    "the census is only a claim about copy while the reader has NOT asked for the machine shape"
  ).not.toBe("iso");

  let totalExamined = 0;
  const seen: string[] = [];
  const problems: string[] = [];
  const stillOffending = new Set<string>();

  for (const route of ROUTES) {
    // A planted subject is swept in a `finally` below, so a failed assertion
    // cannot leave a capture behind for the next spec in this worker to count.
    route.plant?.();
    try {
      await page.goto(route.path);
      await expect(page.getByRole("main")).toBeVisible();
      if (route.reveal) await route.reveal(page);
      if (route.assertReady) await route.assertReady(page);

      // (2) THE NAMED SUBJECT, before anything is believed about silence. WAIT FOR
      // THE CONTENT, NOT THE CONTAINER: a route that renders its shell and then its
      // table would otherwise be censused between the two, and empty is the state
      // that flatters an absence assertion.
      if (route.subject) {
        const subject = page
          .locator(route.subject)
          .filter({ hasText: DISPLAY_DATE });
        await expect(
          subject.first(), // first-ok: read-only census — one instance is all that proves the surface rendered
          `${route.path}: no element matching \`${route.subject}\` rendered a date in ` +
            `the display shape, so this route's silence about machine dates means ` +
            `nothing — ${route.why}`
        ).toBeVisible();
      }

      if (route.unitSubject) {
        const unitSubject = route.unitSubject(page);
        await expect(
          unitSubject,
          `${route.path}: the fixture-owned micro-unit result was not unique — ` +
            `${route.why}`
        ).toHaveCount(1);
        await expect(
          unitSubject,
          `${route.path}: the fixture-owned result did not render a microgram unit ` +
            `in the display shape, so this route's silence about machine-spelled ` +
            `lab units means nothing — ${route.why}`
        ).toContainText(DISPLAY_MICRO_UNIT);
        await expect(
          unitSubject,
          `${route.path}: the fixture-owned micro-unit result was not visible — ` +
            `${route.why}`
        ).toBeVisible();
      }

      const { examined, offenders } = await census(page, BROWSER_PATTERNS);

      // (1) THE ROUTE-READINESS PROOF. A semantic route still has to contribute
      // actual rendered text to the collector; its landmarks replace only the
      // arbitrary density threshold, never the evidence that a sweep occurred.
      if (route.minTextNodes !== undefined) {
        expect(
          examined,
          `${route.path}: only ${examined} rendered text nodes — under the floor of ` +
            `${route.minTextNodes}. This route did not render what it is in the census ` +
            `for, so its silence about machine dates means nothing.`
        ).toBeGreaterThanOrEqual(route.minTextNodes);
      } else {
        expect(
          examined,
          `${route.path}: its semantic readiness landmarks rendered but the census ` +
            `collected no text, so its silence about machine text means nothing.`
        ).toBeGreaterThan(0);
      }

      totalExamined += examined;
      seen.push(route.path);
      const relevantOffenders = route.kinds
        ? offenders.filter((offender) => route.kinds?.includes(offender.kind))
        : offenders;
      for (const o of relevantOffenders) {
        // A KNOWN offender is recorded, not hidden: it stays out of `problems` so the
        // census can be green today, and it is required to still be here below.
        const known = knownMachineDateOffender(route.path, o);
        if (known) {
          stillOffending.add(`${known.route} ${known.testId}`);
          continue;
        }
        problems.push(`${route.path} [${o.kind}]: ${o.where}`);
      }
    } finally {
      route.sweep?.();
    }
  }

  // Every route in the list was actually walked — a `continue` or an early return
  // that silently shortened the sweep is the same failure as an empty page.
  expect(seen).toEqual(ROUTES.map((r) => r.path));
  expect(totalExamined).toBeGreaterThanOrEqual(
    ROUTES.reduce((n, r) => n + (r.minTextNodes ?? 1), 0)
  );

  // …and only NOW is the absence worth asserting.
  expect(
    problems,
    `Machine text in rendered copy — dates go through lib/format-date and lab units ` +
      `through lib/display-unit at MedicalValue:\n${problems.join("\n")}`
  ).toEqual([]);

  // DISPLAY ONLY. The same synthetic row proved `µg/mL` on the clinical-results
  // table and import subpage above; its stored spelling remains the import evidence.
  const stored = new Database(workerDbPath(), { readonly: true });
  try {
    expect(
      stored
        .prepare(
          `SELECT unit FROM medical_records
           WHERE profile_id = 1 AND document_id = 908 AND name = 'E2E Novel Lab'`
        )
        .get()
    ).toEqual({ unit: "ug/mL" });
  } finally {
    stored.close();
  }

  // SHRINK-ONLY. Every known offender on a route the sweep actually visited must
  // still be offending. The day one is fixed this fails and asks for its entry to be
  // deleted — which is what stops the ledger from outliving the defects it names, and
  // what stops it from being mistaken for an exemption.
  const expected = CENSUS_KNOWN_OFFENDERS.filter((k) =>
    seen.includes(k.route)
  ).map((k) => `${k.route} ${k.testId}`);
  expect(
    [...stillOffending].sort(),
    `A CENSUS_KNOWN_OFFENDERS entry no longer prints a machine date — delete it from ` +
      `lib/machine-date-census.ts in the same PR (the ledger only shrinks).`
  ).toEqual([...new Set(expected)].sort());
});

test("(3) the census catches synthetic offenders planted in the live DOM", async ({
  page,
}) => {
  test.slow();
  await page.goto("/results/clinical-results");
  await expect(page.getByRole("main")).toBeVisible();

  const clean = await census(page, BROWSER_PATTERNS);
  expect(clean.examined).toBeGreaterThan(0);
  expect(clean.offenders).toEqual([]);

  // Forged machine text, in a text node, in the place real copy lives. If the
  // collector reads the wrong root, skips visible nodes, or either matcher has been
  // narrowed to blindness, this is where it shows.
  await page.evaluate(() => {
    const main = document.querySelector("main");
    const p = document.createElement("p");
    p.setAttribute("data-testid", "forged-machine-text");
    // FORGED BY A SPEC on purpose — never a real render.
    p.textContent = "Forged by the census spec: 2014-03-09 · 1.20 uU / mL";
    main?.appendChild(p);
  });

  const dirty = await census(page, BROWSER_PATTERNS);
  expect(dirty.offenders.map((o) => [o.kind, o.text])).toEqual([
    ["date", "2014-03-09"],
    ["lab-unit", "uU"],
  ]);
  expect(dirty.examined).toBe(clean.examined + 1);
});

test("the exemptions hold only while their premises do (#3492 item 3)", async ({
  page,
}) => {
  test.slow();
  await page.goto("/import/908");
  await expect(page.getByRole("main")).toBeVisible();

  // ── EXEMPTION: the Debug disclosure ────────────────────────────────────────────
  // Its subject IS the machine representation — the stored extraction payload — so
  // reformatting the dates inside it would make it stop being the payload. The
  // premise that licenses that: it is a <details> a reader OPTS INTO, not prose they
  // are handed. Promote it to always-visible and this goes red, which is the point:
  // an exemption must not outlive its reason (#3260's opt-out did exactly that).
  const debug = page.getByTestId("debug-disclosure");
  await expect(debug).toHaveCount(1);
  await expect(debug).toHaveJSProperty("tagName", "DETAILS");
  await expect(debug).not.toHaveAttribute("open", "");
  expect(CENSUS_EXEMPT_SUBTREES.map((e) => e.selector)).toContain(
    '[data-testid="debug-disclosure"]'
  );

  // ── NOT AN EXEMPTION, A MECHANISM: `<time datetime>` ───────────────────────────
  // The app ships `<time dateTime={iso}>{formatted}</time>` (TrendMiniCard,
  // DayHistory, the single-reading chart captions). That is the boundary working
  // correctly — the machine value in the ATTRIBUTE, the display value in the text —
  // and it needs no allowlist entry because a text-node census cannot see an
  // attribute at all. Asserted rather than assumed, because the day the text and
  // the attribute stop differing is the day this reasoning is wrong.
  await page.goto("/trends#body");
  await expect(page.getByRole("main")).toBeVisible();
  const times = page.locator("main time[datetime]");
  const count = await times.count();
  expect(
    count,
    "no <time datetime> on /trends — the premise cannot be checked here"
  ).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const el = times.nth(i);
    const machine = (await el.getAttribute("datetime")) ?? "";
    const shown = (await el.innerText()).trim();
    expect(
      machineDateHits(machine).length,
      "a <time datetime> whose attribute is NOT a machine date has nothing to exempt"
    ).toBe(1);
    expect(
      machineDateHits(shown),
      `<time> text "${shown}" states the machine date instead of the display one — ` +
        `the attribute is the machine channel, the text is copy`
    ).toEqual([]);
  }
});
