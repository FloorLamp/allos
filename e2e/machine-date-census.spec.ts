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
//      semantic landmarks; it must still yield a non-empty census sample. The
//      floor is counted ON THE SURFACE THE ROUTE'S SUBJECT LIVES IN (#5104) — a
//      route whose subject is a dialog cannot clear it out of the page underneath.
//   2. A NAMED SUBJECT per route — the element whose date was the defect — which
//      must be among the nodes actually collected. This is the tighter half: a
//      floor can be met by 200 nav labels while the table the route exists for
//      never rendered. A count says "something was here"; the subject says "the
//      thing I am making a claim about was here".
//   3. TWO SYNTHETIC OFFENDERS, planted in a live DOM and required to be caught:
//      one inside `<main>`, one inside a real DIALOG. A collector that reads the
//      wrong root, or a matcher that was quietly narrowed, fails these while
//      sailing through the other two — and the dialog one is the half that a
//      `<main>`-rooted collector passed for months while blind to every modal,
//      drawer and portalled surface in the app (#5104).
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
    // A LANDMARK RATHER THAN A FLOOR, AND THE OLD FLOOR IS WHY (#5104). This route
    // carried `minTextNodes: 40` and met it out of the DASHBOARD BEHIND THE PALETTE,
    // because the count was taken on `<main>` — 40 nodes of a surface this route is
    // not in the census for. Scoped to the palette, where its subject actually
    // lives, the numbers say a floor cannot work here at all. Measured 2026-09-10:
    // the palette reads 22 rendered text nodes with an EMPTY query, 9 with a query
    // that matches nothing, and 12 with the Selenium hit this route exists for. The
    // not-ready state is the LARGEST of the three, so no threshold separates ready
    // from not-ready on this surface — which is exactly the case `assertReady` is
    // for. The hit itself is the proof, and the loop still requires the palette to
    // contribute rendered copy to the sweep.
    assertReady: async (page) => {
      await expect(
        page.getByRole("option").filter({
          has: page.getByText("Selenium", { exact: true }),
        })
      ).toBeVisible();
    },
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
    },
  },
  {
    path: "/?quick=search",
    why: "Global search's logged-row subtitles — the day each record row is filed under (#5006).",
    // The same measured reason as the lab-unit palette route above: scoped to the
    // palette this route reads 11 rendered text nodes with its planted hit on
    // screen, against 22 for an empty query and 9 for a query that matches nothing.
    // The floor of 40 it used to carry was met by the dashboard behind the dialog.
    assertReady: async (page) => {
      // The palette mounts as a SIBLING of <main> (app/(app)/layout.tsx — <main>
      // closes, then <CommandPalette>), so it sits outside `app-content-container`
      // and outside every StreamedSection call site. appContent() scoping cannot
      // reach it, and there is no staged copy for a bare lookup to match.
      const group = page.getByTestId("palette-group-logged"); // testid-scope-ok: outside <main>
      await expect(
        group.getByRole("option", { name: LOGGED_SYMPTOM_PROBE })
      ).toBeVisible({ timeout: 15_000 });
    },
    kinds: ["date"],
    // THE SUBJECT IS NO LONGER THE WHOLE GUARD ON THIS ROUTE (#5104). It was, and
    // the comment this replaces said so from measurement: the collector walked
    // `document.querySelector("main")`, the palette is a dialog rendered OUTSIDE
    // main, and no palette copy had ever entered the offender sweep — on this route
    // or on the lab-unit one above it. #5006's lane proved it both ways, forcing the
    // subtitle to the machine shape with and without this `subject` line: with it the
    // route reds, without it the route PASSES with the ISO date on screen. The
    // collector now walks the body, so the sweep covers this dialog too and the
    // second mutation reds as well — see the (3b) control below, which plants that
    // exact offender in this exact palette on every run.
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
    },
  },
  {
    path: "/training?tab=goals",
    why: "The lab-goal target label and precomposed reference-range hint.",
    // ANOTHER FLOOR THAT WAS BEING MET BY THE PAGE UNDERNEATH (#5104). The goal form
    // is hosted in a ModalShell, so it renders OUTSIDE `<main>` too, and this route's
    // `minTextNodes: 35` was satisfied entirely by the training page behind the
    // modal — the census had never counted a node of the surface it is here for.
    // Measured 2026-09-10, the modal reads 10 rendered text nodes when it opens, 10
    // once Selenium is picked and 10 with the Target panel open: its density is flat
    // across every state, so a floor over it distinguishes nothing. The reference
    // hint below is the readiness proof, and it is a stronger one.
    assertReady: async (page) => {
      const hint = page.getByTestId("goal-clinical-result-reference"); // testid-scope-ok: the goal form is hosted in a ModalShell, so it renders outside <main> and no appContent() scoping can reach it
      await expect(hint).toBeVisible();
    },
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
    // Measured while widening the collector (2026-09-10), the date rule finds them
    // in `[data-testid="longevity-fitness-coverage"]` and in every
    // `[data-testid="longevity-biomarker-date"]` — all inside `<main>`, so they are
    // this exception's declared cost and not fallout from #5104.
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
    // `kinds` IS AN EXCEPTION AND IT IS COSTING SOMETHING, recorded here rather than
    // left implicit (#5104). This route is asked only about lab units, and the date
    // rule — run against it while widening the collector, 2026-09-10 — finds two
    // machine dates in `<main>` that nothing currently reports:
    //   * [data-testid="upcoming-item-biomarker:…"] — "Last tested 2025-06-17 (15mo
    //     ago) · retest every 6mo"
    //   * [data-testid="suppressed-row"] — "Snoozed until 2026-09-15"
    // Both are in `<main>`, so they predate this change and are NOT fallout from it:
    // the `kinds` filter, not the collector root, is what keeps them quiet. They are
    // routed to their owners rather than fixed here (this lane's fence is the census
    // itself), and the first one is worth a second look against
    // CENSUS_KNOWN_OFFENDERS' note that #3526 fixed the Upcoming biomarker-retest
    // line. Dropping `kinds` here is a product change plus a ledger entry, not a
    // test edit.
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
      await expect(page.getByTestId("history-day").first()).toBeVisible(); // eslint-disable-line no-restricted-properties -- first-ok: the readiness proof is that ANY day group rendered; no per-day claim is made
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
  /**
   * Text nodes the OFFENDER SWEEP read. The whole rendered page, `<main>` and the
   * portalled surfaces beside it alike.
   */
  swept: number;
  /**
   * The subset of `swept` that lies inside THE SURFACE ON SCREEN — a rendered
   * dialog, or `<main>` when none is open — which is the only copy a route's
   * `minTextNodes` floor is a claim about. Never a separate walk:
   * a node is counted here only after the sweep has already read it, so "enough
   * copy examined" cannot outrun "this copy was actually scanned".
   */
  examined: number;
  /** The counted surface, named for the floor's failure message. */
  surface: string;
  /**
   * Which selector the counted surface came from, so the caller can assert its own
   * subject is on it without a second, disagreeing definition of "the surface".
   */
  surfaceSelector: "main" | '[role="dialog"]';
  offenders: {
    kind: "date" | "lab-unit";
    text: string;
    testId: string;
    where: string;
  }[];
}

/**
 * Every RENDERED text node in the document body, minus the exempt subtrees, scanned
 * for machine dates and machine-spelled lab units.
 *
 * ── THE ROOT IS THE BODY, NOT `<main>` (#5104) ─────────────────────────────────
 *
 * It read `document.querySelector("main")` for months, and every modal, drawer,
 * bottom sheet and portalled surface in this app renders OUTSIDE main — the palette
 * is a sibling of it (app/(app)/layout.tsx), and components/BottomSheet.tsx portals
 * to `document.body`. So the sweep could not fail on an entire class of surface:
 * #5006's lane put a raw ISO date in the palette subtitle with no `subject` naming
 * it and the route passed with the date on screen. The collector, not the matcher,
 * was the hole; `e2e/machine-date-census.spec.ts`'s own dialog-planted offender
 * test below is the control that keeps it shut.
 *
 * NOTHING IS SUBTRACTED FOR BEING "CHROME". The sidebar, the dock and the toasters
 * are copy a person reads, so a machine date in one of them is a real offender and
 * the sweep says so. What chrome must NOT do is pad a route's readiness count,
 * which is what `surface` below is for — the floor is scoped, the sweep is not.
 * (Narrowing the collector to keep a floor honest would re-open exactly this bug.)
 *
 * `matcherSource` is handed in rather than closed over: the evaluate call serializes
 * its argument into the browser, so the rules from lib/machine-date-census and
 * lib/machine-lab-unit-census travel with it and there is no second copy of either
 * pattern living in this file.
 *
 * ── THE COUNTED SURFACE IS RESOLVED IN THE BROWSER, NOT CARRIED INTO IT ────────
 *
 * A rendered dialog is the surface; `<main>` is the surface when none is open. Both
 * are found HERE, inside the walk, from a selector — never handed in as an element
 * resolved by an earlier round trip. That was the first shape of this and it was
 * wrong in a way worth recording: the route's own subject was resolved in Node and
 * passed as a handle, and on /import/908 (and again on /import/908?tab=visits) the
 * page re-rendered in the gap between the two calls, so the census received a
 * DETACHED node. A stale node's `closest()` is null, which silently scopes the count
 * back to `<main>` — the exact mis-scoping this is built to prevent, arriving as an
 * intermittent one. `locator.evaluate` does not close that gap either: it resolves
 * the selector and evaluates in two calls, so a re-render between them detaches the
 * element without erroring. Nothing here now survives across a round trip.
 *
 * What the caller still owes: proving its route's subject is ON that surface. It
 * does that with an ordinary auto-retrying assertion against `surfaceSelector`,
 * which re-resolves on every poll and so cannot go stale (see the loop).
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
      const root = document.body;
      if (!main || !root)
        return {
          swept: 0,
          examined: 0,
          surface: "nothing rendered",
          surfaceSelector: "main" as const,
          offenders: [],
        };
      // THE SURFACE THE FLOOR IS A CLAIM ABOUT. A rendered dialog IS the surface
      // while one is open — it is what a person is looking at, and the page behind it
      // is what the old `<main>` count was mistaking for evidence. `<main>` is the
      // surface the rest of the time, which is what every existing floor was measured
      // against. A dialog that is mounted but not rendered is neither.
      const dialogs = [...root.querySelectorAll('[role="dialog"]')].filter(
        (el) => el.getClientRects().length > 0
      );
      const surfaces: Element[] = dialogs.length ? dialogs : [main];
      const surfaceName = dialogs.length
        ? `[role="dialog"]` +
          (dialogs.length > 1 ? ` (${dialogs.length} open)` : "") +
          (dialogs[0].closest("[data-testid]")
            ? ` inside [data-testid="${dialogs[0].closest("[data-testid]")?.getAttribute("data-testid")}"]`
            : "")
        : "<main>";
      const exempt = exemptSelectors.flatMap((s) => [
        ...root.querySelectorAll(s),
      ]);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const out: {
        kind: "date" | "lab-unit";
        text: string;
        testId: string;
        where: string;
      }[] = [];
      let swept = 0;
      let examined = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent ?? "";
        if (!text.trim()) continue;
        const parent = n.parentElement;
        if (!parent) continue;
        // NOT COPY AT ALL. Widening the root to the body brings `<script>` into
        // reach for the first time — Next's flight payload is a text node full of
        // storage-shaped dates, and it is a transport, not something anyone reads.
        // The visibility check below already drops it (a script box has no rects),
        // but that is a coincidence of layout and this is the reason.
        if (
          parent.tagName === "SCRIPT" ||
          parent.tagName === "STYLE" ||
          parent.tagName === "NOSCRIPT" ||
          parent.tagName === "TEMPLATE"
        )
          continue;
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
        swept += 1;
        if (surfaces.some((el) => el.contains(n))) examined += 1;
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
                // Which side of `<main>` a hit is on, stated: everything on the far
                // side of it was invisible to this sweep until #5104.
                (main.contains(n) ? "" : "OUTSIDE <main> — ") +
                `${tag}` +
                (testid
                  ? ` inside [data-testid="${testid.getAttribute("data-testid")}"]`
                  : "") +
                ` — ${text.trim().slice(0, 90)}`,
            });
          }
        }
      }
      return {
        swept,
        examined,
        surface: surfaceName,
        surfaceSelector: dialogs.length
          ? ('[role="dialog"]' as const)
          : ("main" as const),
        offenders: out,
      };
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
    // …AND ONE SUBJECT, WHICH IS WHAT TIES THE FLOOR TO A SURFACE (#5104). The
    // readiness count is taken over the surface the PAGE is showing — a rendered
    // dialog, or `<main>` when none is open — and the loop then requires this
    // route's subject to be ON it. A route that names no subject can make that
    // check of nothing, which is how "enough copy examined" came to be a claim
    // about a surface the route had never entered.
    expect(
      Number(route.subject !== undefined) +
        Number(route.unitSubject !== undefined),
      `${route.path} must declare a subject or a unitSubject: the census counts its ` +
        `readiness floor on the surface that subject lives in`
    ).toBeGreaterThan(0);
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
      //
      // Every subject proved out here is ALSO required, below, to be ON THE SURFACE
      // the readiness count is taken over (#5104) — so the two halves of the route's
      // claim cannot describe different parts of the screen.
      const subjects: { what: string; locator: Locator }[] = [];
      if (route.subject) {
        const dated = page
          .locator(route.subject)
          .filter({ hasText: DISPLAY_DATE });
        const subject = dated.first(); // eslint-disable-line no-restricted-properties -- first-ok: read-only census — one instance is all that proves the surface rendered
        await expect(
          subject,
          `${route.path}: no element matching \`${route.subject}\` rendered a date in ` +
            `the display shape, so this route's silence about machine dates means ` +
            `nothing — ${route.why}`
        ).toBeVisible();
        // The unfiltered locator for the containment check below: Playwright refuses
        // a `has:` locator that has already been narrowed to an index.
        subjects.push({ what: `subject \`${route.subject}\``, locator: dated });
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
        subjects.push({ what: "unitSubject", locator: unitSubject });
      }

      const { swept, examined, surface, surfaceSelector, offenders } =
        await census(page, BROWSER_PATTERNS);

      // (1) THE ROUTE-READINESS PROOF, COUNTED ON THE SURFACE THE ROUTE IS IN THE
      // CENSUS FOR (#5104). It used to be counted on `<main>` for every route, so a
      // route whose subject is a DIALOG cleared its floor on the page UNDERNEATH the
      // dialog: `/?quick=search` met a floor of 40 out of the dashboard behind the
      // palette and reported "enough copy examined" about a surface it had not
      // entered, and `/training?tab=goals` did the same behind its goal modal. A
      // threshold satisfied by the wrong nodes is the same defect as a sweep that
      // cannot reach them, one level up.
      //
      // Three things hold it honest, and each fails LOUDLY rather than open:
      //   * the surface follows THE PAGE — an open dialog is the surface — so it is
      //     nothing a route can forget to declare when the next dialog route lands;
      //   * every subject this route made a claim about has to be ON that surface,
      //     asserted here, so a floor and a subject can never be about different
      //     things;
      //   * a counted node is a SWEPT node, asserted, so "examined" can never
      //     describe copy the offender sweep did not read.
      for (const { what, locator } of subjects) {
        await expect(
          page.locator(surfaceSelector).filter({ has: locator }),
          `${route.path}: its ${what} is not inside ${surface}, the surface the ` +
            `readiness count is taken over — the count and the subject are claims ` +
            `about different parts of the screen. ${route.why}`
        ).not.toHaveCount(0);
      }
      expect(
        examined,
        `${route.path}: the readiness count (${examined}) exceeds what the offender ` +
          `sweep read (${swept}) — the floor is counting nodes the sweep never saw.`
      ).toBeLessThanOrEqual(swept);
      if (route.minTextNodes !== undefined) {
        expect(
          examined,
          `${route.path}: only ${examined} rendered text nodes in ${surface} — under ` +
            `the floor of ${route.minTextNodes} (the whole page swept ${swept}). This ` +
            `route did not render what it is in the census for, so its silence about ` +
            `machine dates means nothing.`
        ).toBeGreaterThanOrEqual(route.minTextNodes);
      } else {
        expect(
          examined,
          `${route.path}: its semantic readiness landmarks rendered but the census ` +
            `collected no text in ${surface}, so its silence about machine text means ` +
            `nothing.`
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
  expect(dirty.swept).toBe(clean.swept + 1);
});

// ── (3b) THE SAME PROOF, IN A DIALOG — THE HALF THAT COULD NOT FAIL (#5104) ────
//
// The control above plants inside `<main>`, and a collector rooted at `<main>` sails
// through it: it passed on every day the sweep was blind to every modal, drawer,
// bottom sheet and portalled surface in the app. So the offender sweep gets a second
// synthetic offender that a `<main>`-rooted collector CANNOT see, planted in a real
// dialog on a real censused route, with NO `subject` selector naming it — which is
// exactly the mutation #5006's lane ran and watched pass with the date on screen.
//
// It asserts the planted node is outside `<main>` before it asserts the catch. That
// ordering is the whole test: without it, a future edit that re-narrowed the root
// would keep this green by planting somewhere the narrow root still reaches.
test("(3b) the census catches a synthetic offender planted in a DIALOG (#5104)", async ({
  page,
}) => {
  test.slow();
  await page.goto("/?quick=search");
  await expect(page.getByRole("main")).toBeVisible();
  const input = page.getByRole("combobox", { name: "Search or run a command" });
  await expect(input).toBeVisible();
  const palette = page.getByRole("dialog", { name: "Search" });
  await expect(palette).toBeVisible();

  const clean = await census(page, BROWSER_PATTERNS);
  expect(clean.offenders).toEqual([]);

  // The palette's own copy has to be IN the sweep for its silence to mean anything —
  // the count the dashboard behind it contributes is not evidence about this surface.
  const paletteNodes = await palette.evaluate((el) => {
    let n = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode())
      if ((t.textContent ?? "").trim()) n += 1;
    return n;
  });
  expect(
    paletteNodes,
    "the palette rendered no copy, so planting in it proves nothing"
  ).toBeGreaterThan(0);

  const outsideMain = await palette.evaluate(
    (el) => !document.querySelector("main")?.contains(el)
  );
  expect(
    outsideMain,
    "the palette is no longer outside <main>, so this control no longer covers the " +
      "class of surface #5104 was about — find a surface that still is"
  ).toBe(true);

  await palette.evaluate((el) => {
    const p = document.createElement("p");
    p.setAttribute("data-testid", "forged-dialog-machine-text");
    // FORGED BY A SPEC on purpose — never a real render.
    p.textContent = "Forged in a dialog by the census spec: 2014-03-09";
    el.appendChild(p);
  });

  const dirty = await census(page, BROWSER_PATTERNS);
  expect(
    dirty.offenders.map((o) => [o.kind, o.text]),
    "a machine date rendered in a dialog did not red the offender sweep — the " +
      "collector has been narrowed back inside <main> (#5104)"
  ).toEqual([["date", "2014-03-09"]]);
  expect(dirty.offenders[0]?.where).toContain("OUTSIDE <main>");
  expect(dirty.swept).toBe(clean.swept + 1);
});

// ── THE FLOOR COUNTS THE RIGHT NODES, PROVED BY MUTATION (#5104) ──────────────
//
// `minTextNodes` is the census's "enough copy examined" claim, and on a route whose
// subject is a dialog it used to be met entirely by the page UNDERNEATH: the sweep
// counted `<main>`, so `/?quick=search` cleared a floor of 40 from the dashboard
// behind the palette without the palette contributing a single node. A count
// satisfied by the wrong inputs says nothing, however green it is.
//
// The mutation that shows it: add copy to `<main>` while the palette is open. The
// swept total must move (the sweep reads the whole page) and the palette-scoped
// count must NOT (the floor is a claim about the palette). A floor scoped back to
// `<main>` fails the second half.
test("a dialog route's readiness floor counts the dialog, not the page under it (#5104)", async ({
  page,
}) => {
  test.slow();
  await page.goto("/?quick=search");
  await expect(page.getByRole("main")).toBeVisible();
  const input = page.getByRole("combobox", { name: "Search or run a command" });
  await expect(input).toBeVisible();
  const palette = page.getByRole("dialog", { name: "Search" });
  await expect(palette).toBeVisible();

  const scoped = await census(page, BROWSER_PATTERNS);
  expect(scoped.surface).toContain('[role="dialog"]');
  expect(scoped.surfaceSelector).toBe('[role="dialog"]');
  expect(scoped.examined).toBeGreaterThan(0);
  expect(
    scoped.examined,
    "the palette-scoped count is the whole swept page — the floor was not scoped"
  ).toBeLessThan(scoped.swept);

  // Ten nodes of dashboard copy: enough to clear a floor on its own, and none of it
  // on the surface this route is in the census for.
  await page.evaluate(() => {
    const main = document.querySelector("main");
    for (let i = 0; i < 10; i += 1) {
      const p = document.createElement("p");
      p.setAttribute("data-testid", "forged-under-dialog-copy");
      p.textContent = `Forged by the census spec: filler line ${i}`;
      main?.appendChild(p);
    }
  });

  const after = await census(page, BROWSER_PATTERNS);
  expect(
    after.swept,
    "the offender sweep did not read the copy added to <main> — it is not reading " +
      "the whole page"
  ).toBe(scoped.swept + 10);
  expect(
    after.examined,
    "copy added UNDER the dialog moved this route's readiness count — the floor is " +
      "being met by nodes from a surface the route is not in the census for (#5104)"
  ).toBe(scoped.examined);
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
