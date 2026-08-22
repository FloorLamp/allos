import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { openDashboardAll } from "./helpers";
import {
  CENSUS_EXEMPT_SUBTREES,
  MACHINE_DATE_RE,
  machineDateHits,
} from "@/lib/machine-date-census";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";

// THE MACHINE-DATE CENSUS (#3492) — no storage-format date reaches user copy.
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
//   1. A CENSUS FLOOR. Every route declares the minimum number of rendered text
//      nodes it must yield. A 404 page and a bare shell come in an order of
//      magnitude under it.
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
   * 404'd or rendered a shell", not to pin a layout. Every route below measured at
   * least 3× its floor when this was written.
   */
  minTextNodes: number;
  /**
   * Where this route's date-bearing copy lives. The census only believes its own
   * silence once one of these elements has been seen carrying a date IN THE DISPLAY
   * SHAPE — which proves both that the surface rendered and that the boundary is
   * doing its job, in one assertion.
   */
  subject: string;
  /** Extra work needed before the subject is on screen. */
  reveal?: (page: Page) => Promise<void>;
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
    reveal: openDashboardAll,
  },
  {
    path: "/results/clinical-results",
    why: "The clinical results table's Date cell (lib/reading-date-line's day half).",
    minTextNodes: 120,
    subject: "td[data-card='meta']",
  },
  {
    path: "/results/clinical-results/view?name=HDL%20Cholesterol",
    why: "The bespoke per-biomarker history table and its 'as of' line.",
    minTextNodes: 80,
    subject: "table td",
  },
  {
    path: "/import/908",
    why: "Import review: the Document date provenance row and the analyte grid's DATE cells.",
    minTextNodes: 80,
    subject: "td[data-card='meta']",
  },
  {
    path: "/import/908?tab=visits",
    why: "Import review: the ProducedListing row date.",
    minTextNodes: 60,
    subject: '[data-testid="produced-item"]',
  },
  {
    path: "/import/912?tab=vitals",
    why: "Import review: the READ-ONLY row presentation's DATE cell (#1182).",
    minTextNodes: 60,
    subject: "td[data-card='meta']",
  },
];

// A date in the DISPLAY vocabulary: a written month beside a day-of-month, which is
// what all three of formatLongDate / formatMonthDay / formatDateWithYear emit under
// every non-"iso" pref. Loose ON PURPOSE — this is the "the surface rendered" half
// of the census, not a copy assertion, and pinning an exact string here would make
// it a second, weaker copy of the formatter's own unit tests.
const DISPLAY_DATE =
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/;

interface Census {
  examined: number;
  offenders: { text: string; where: string }[];
}

/**
 * Every RENDERED text node under `<main>`, minus the exempt subtrees, scanned for
 * machine dates.
 *
 * `matcherSource` is handed in rather than closed over: `page.evaluate` serializes
 * its argument into the browser, so the one rule from lib/machine-date-census
 * travels with it and there is no second copy of the pattern living in this file.
 */
async function census(page: Page, matcherSource: string): Promise<Census> {
  return page.evaluate(
    ({
      pattern,
      exemptSelectors,
    }: {
      pattern: string;
      exemptSelectors: string[];
    }) => {
      const re = new RegExp(pattern, "g");
      const main = document.querySelector("main");
      if (!main) return { examined: 0, offenders: [] };
      const exempt = exemptSelectors.flatMap((s) => [
        ...main.querySelectorAll(s),
      ]);
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
      const out: { text: string; where: string }[] = [];
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
        re.lastIndex = 0;
        const hits = [...text.matchAll(re)].map((m) => m[0]);
        for (const hit of hits) {
          const tag = parent.tagName.toLowerCase();
          const testid = parent.closest("[data-testid]");
          out.push({
            text: hit,
            where:
              `${tag}` +
              (testid
                ? ` inside [data-testid="${testid.getAttribute("data-testid")}"]`
                : "") +
              ` — ${text.trim().slice(0, 90)}`,
          });
        }
      }
      return { examined, offenders: out };
    },
    {
      pattern: matcherSource,
      exemptSelectors: CENSUS_EXEMPT_SUBTREES.map((e) => e.selector),
    }
  );
}

// NOT A COPY OF THE RULE — the rule itself, serialized into the page. A second
// spelling of the pattern living in this file could narrow silently, and an absence
// assertion over a narrowed matcher is green by construction.
const BROWSER_PATTERN = MACHINE_DATE_RE.source;

test("no rendered copy states a machine date, on any censused surface (#3492)", async ({
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

  for (const route of ROUTES) {
    await page.goto(route.path);
    await expect(page.getByRole("main")).toBeVisible();
    if (route.reveal) await route.reveal(page);

    // (2) THE NAMED SUBJECT, before anything is believed about silence. WAIT FOR
    // THE CONTENT, NOT THE CONTAINER: a route that renders its shell and then its
    // table would otherwise be censused between the two, and empty is the state
    // that flatters an absence assertion.
    const subject = page
      .locator(route.subject)
      .filter({ hasText: DISPLAY_DATE });
    await expect(
      subject.first(), // first-ok: read-only census — one instance is all that proves the surface rendered
      `${route.path}: no element matching \`${route.subject}\` rendered a date in ` +
        `the display shape, so this route's silence about machine dates means ` +
        `nothing — ${route.why}`
    ).toBeVisible();

    const { examined, offenders } = await census(page, BROWSER_PATTERN);

    // (1) THE CENSUS FLOOR.
    expect(
      examined,
      `${route.path}: only ${examined} rendered text nodes — under the floor of ` +
        `${route.minTextNodes}. This route did not render what it is in the census ` +
        `for, so its silence about machine dates means nothing.`
    ).toBeGreaterThanOrEqual(route.minTextNodes);

    totalExamined += examined;
    seen.push(route.path);
    for (const o of offenders) problems.push(`${route.path}: ${o.where}`);
  }

  // Every route in the list was actually walked — a `continue` or an early return
  // that silently shortened the sweep is the same failure as an empty page.
  expect(seen).toEqual(ROUTES.map((r) => r.path));
  expect(totalExamined).toBeGreaterThanOrEqual(
    ROUTES.reduce((n, r) => n + r.minTextNodes, 0)
  );

  // …and only NOW is the absence worth asserting.
  expect(
    problems,
    `Machine dates in rendered copy — render them through the display vocabulary in ` +
      `lib/format-date (client: useFormatPrefs(); server: getDisplayFormatPrefs(login.id) ` +
      `at the page boundary):\n${problems.join("\n")}`
  ).toEqual([]);
});

test("(3) the census catches a synthetic offender planted in the live DOM", async ({
  page,
}) => {
  test.slow();
  await page.goto("/results/clinical-results");
  await expect(page.getByRole("main")).toBeVisible();

  const clean = await census(page, BROWSER_PATTERN);
  expect(clean.examined).toBeGreaterThan(0);
  expect(clean.offenders).toEqual([]);

  // A forged date, in a text node, in the place real copy lives. If the collector
  // reads the wrong root, skips visible nodes, or the matcher has been narrowed to
  // the point of blindness, this is where it shows — and it is the ONLY assertion
  // in this file that can fail because the probe stopped working rather than
  // because the app did.
  await page.evaluate(() => {
    const main = document.querySelector("main");
    const p = document.createElement("p");
    p.setAttribute("data-testid", "forged-machine-date");
    // FORGED BY A SPEC on purpose — never a real render.
    p.textContent = "Forged by the census spec: 2014-03-09";
    main?.appendChild(p);
  });

  const dirty = await census(page, BROWSER_PATTERN);
  expect(dirty.offenders.map((o) => o.text)).toEqual(["2014-03-09"]);
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
