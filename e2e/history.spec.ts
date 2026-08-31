import Database from "better-sqlite3";
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { frozenNow, workerDbPath } from "./worker-env";
import { expectNoClippedContent, followLink, hydratedClick } from "./helpers";
import { shiftDateStr, zonedWallTimeToUtc } from "@/lib/date";

// `/history` — THE APP'S RECORD (#3958 phase 1).
//
// One page absorbed four standalone ledger routes. What this spec is FOR is the set
// of claims that can only be made against a rendered page: the chrome budget, the
// one-line row at a phone width, the rail's lane, the doors that used to point at the
// deleted routes, and the two degrade-to-the-page rules a hand-edited URL exercises.
// The grammar itself (the clock, the detail segment, the within-day order) is pinned
// in the pure tier, where a 720-permutation ordering guard is affordable.
//
// FIXTURE (#868 hygiene): this spec owns one serving and one practice session on one
// named day, both deleted before each test so a failed run leaves no residue. Instants
// are built with `zonedWallTimeToUtc` on the profile's own zone — the record groups by
// the profile-LOCAL day and the seed pins a rotating per-run zone (#1417/#3878), so a
// naive string would be right only for the zone a run's start hour happened to draw.

const PROFILE = 1;
// Comfortably inside the 14-day recent band at any run date. The shared profile's
// pinned timezone guarantees its local date equals the frozen instant's UTC date.
const DAY = shiftDateStr(frozenNow().toISOString().slice(0, 10), -7);
// A day in an EARLIER CALENDAR MONTH, so the fold spine this spec's rail scrubs has at
// least two stops whatever else the shared seed holds. The rail is not offered below
// two periods — a permanent strip down the edge of a one-period page is chrome
// charging rent — so without this the rail case would be conditional on a fixture
// nothing here controls.
const OLD_DAY = "2026-02-11";
const HISTORY_WITH_OLD_YEAR = `/history?open=${OLD_DAY.slice(0, 4)}`;
const PRACTICE = "E2e History Rowing";
const FOOD_GROUP = "berries";
const FOOD_NAME = "Berries";

// The chrome budget, in CSS pixels, from the top of the page's content to the top of
// its first record at 390px. THE OWNER'S CRITERION IS ~140 and the prototype measured
// ~135; this is that number as a ceiling. What it bounds is the header stack — the
// title band (absent below `sm`), the one filter row, and the Add bar — so a proposed
// addition has to displace something rather than push the record down.
const CHROME_BUDGET_PX = 140;

// A MONTH FOLD CARD, whichever one the record's own windowing drew. `windowTimelineDays`
// keys a month fold on `YYYY-MM` and a year fold on `YYYY` (lib/timeline-window.ts), so
// the dash is what tells the two apart — and the two cases below need a MONTH,
// because opening a year reveals more fold cards while opening a month reveals days.
// Named by key rather than pinned to `OLD_DAY`'s month: how far back the record's own
// `?show` bound reaches is the shared seed's business, not this spec's.
const MONTH_FOLD = '[data-testid^="history-fold-"][data-fold-key*="-"]';

// The two desktop widths the rail's lane is asked about. WIDE is past the point where
// the page margin beside the reading column is wider than the rail's 44px hit strip, so
// the rail sits in the margin and no card gives anything up; NARROW is inside it, where
// the carve-out exists and must be spent at ONE depth so the two cards still line up.
const WIDE_PX = 1440;
const NARROW_DESKTOP_PX = 1024;

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

function clearFixture(db: Database.Database): void {
  db.prepare(
    `DELETE FROM food_log_events
      WHERE profile_id = ? AND date IN (?, ?) AND group_key = ?`
  ).run(PROFILE, DAY, OLD_DAY, FOOD_GROUP);
  db.prepare(
    "DELETE FROM practice_logs WHERE profile_id = ? AND practice = ?"
  ).run(PROFILE, PRACTICE);
}

function zoneOf(db: Database.Database): string {
  const row = db
    .prepare(
      "SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'timezone'"
    )
    .get(PROFILE) as { value: string } | undefined;
  return row?.value ?? "UTC";
}

function seedDay(): void {
  const db = openDb();
  try {
    clearFixture(db);
    const at = zonedWallTimeToUtc(zoneOf(db), DAY, "08:46")!.toISOString();
    db.prepare(
      `INSERT INTO food_log_events
         (profile_id, group_key, date, meal_slot, recorded_at, occurred_at)
       VALUES (?, ?, ?, 'Morning', ?, ?)`
    ).run(PROFILE, FOOD_GROUP, DAY, at, at);
    db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, start_time, duration_min)
       VALUES (?, ?, ?, '07:15', 20)`
    ).run(PROFILE, PRACTICE, DAY);
    const old = zonedWallTimeToUtc(zoneOf(db), OLD_DAY, "09:12")!.toISOString();
    db.prepare(
      `INSERT INTO food_log_events
         (profile_id, group_key, date, meal_slot, recorded_at, occurred_at)
       VALUES (?, ?, ?, 'Morning', ?, ?)`
    ).run(PROFILE, FOOD_GROUP, OLD_DAY, old, old);
  } finally {
    db.close();
  }
}

async function phone(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
}

test.describe("the record (#3958)", () => {
  test("groups a day, states its count, and prints no date on a row", async ({
    page,
  }) => {
    seedDay();
    await page.goto(`/history?day=${DAY}`);

    const day = page.getByTestId("history-day");
    await expect(day).toHaveCount(1);
    const header = day.getByTestId("history-day-link");
    await expect(header).toBeVisible();
    // The day header is the whole "which day am I in" affordance, so the count line
    // beside it has to be the day's, not the page's.
    await expect(day.locator("h2")).toContainText(/\d+ records?/);

    const serving = page
      .getByTestId("history-row")
      .filter({ hasText: FOOD_NAME });
    await expect(serving).toHaveCount(1);
    // NO PER-ROW DATE CELL EXISTS. Asserted as the row's own text rather than as the
    // absence of a testid: a row that started printing "Mon, Aug 17" would satisfy
    // every structural check and be exactly the regression.
    await expect(serving).not.toContainText("Aug 17");
    await expect(serving).not.toContainText(DAY);
    // One clock grammar: bare and lower-case, or "logged" plus the same shape.
    const clock = (
      (await serving.getByTestId("history-row-clock").textContent()) ?? ""
    ).trim();
    expect(clock).toMatch(/^(logged )?\d{1,2}:\d{2}(am|pm)?$/);
  });

  test("is one line per row at 390px, and the page never scrolls sideways", async ({
    page,
  }) => {
    seedDay();
    await phone(page);
    await page.goto(`/history?day=${DAY}`);

    const rows = page.getByTestId("history-row");
    await expect(rows.first()).toBeVisible(); // first-ok: the anatomy claim is about any row
    const geometry = await page.evaluate(() => {
      const list = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-testid="history-row"]'
        ),
      ];
      const doc = document.documentElement;
      return {
        // ONE LINE MEANS ONE LINE OF TEXT, measured as the row's height against its
        // own line box rather than against a constant — a 44px row that wrapped
        // inside a taller container would satisfy any absolute ceiling.
        rows: list.map((el) => ({
          height: el.getBoundingClientRect().height,
          lineHeight: parseFloat(getComputedStyle(el).lineHeight),
          right: el.getBoundingClientRect().right,
        })),
        viewport: doc.clientWidth,
        scrollWidth: doc.scrollWidth,
      };
    });
    expect(geometry.rows.length).toBeGreaterThan(0);
    for (const row of geometry.rows) {
      expect(
        row.height,
        `a record row is ${Math.round(row.height)}px tall against a ${row.lineHeight}px line`
      ).toBeLessThan(row.lineHeight * 2 + 24);
      expect(Math.round(row.right)).toBeLessThanOrEqual(geometry.viewport);
    }
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport + 1);
    await expectNoClippedContent(page);
  });

  test("spends no more than the chrome budget above its first record at 390px", async ({
    page,
  }) => {
    seedDay();
    await phone(page);
    await page.goto("/history");

    const first = page.getByTestId("history-row").first(); // first-ok: the budget is about whatever record leads
    await expect(first).toBeVisible();
    const chrome = await page.evaluate(() => {
      const container = document.querySelector('[data-testid="history-page"]')!;
      const row = document.querySelector('[data-testid="history-row"]')!;
      // MEASURED AGAINST THIS PAGE'S OWN CONTENT BOX, not against the viewport and
      // not against `<main>`. The criterion is about what the PAGE spends — "a
      // proposed addition to the header stack has to name what it displaces" — and
      // the app shell's sticky top bar is on every page and displaceable by none of
      // them (the census in scripts/census-chrome-baseline.json is what records the
      // shell's own inset). Anchored on `<main>` this read 206px, of which 73 was
      // shell: a number that moves when the SHELL changes says nothing about this
      // page.
      const top = container.getBoundingClientRect().top;
      // THE BREAKDOWN IS PART OF THE FAILURE, not scaffolding to delete. A bare
      // "206px, expected 140" says nothing about WHICH band grew, and the answer has
      // been a different one every time this was measured — the fold cards rendering
      // above the recent band, then a wrapping filter row, then the anchor itself.
      // Keeping it is what makes the next red name its own cause (#2774).
      const band = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top - top), height: Math.round(r.height) };
      };
      return {
        chrome: row.getBoundingClientRect().top - top,
        h1: document.querySelectorAll("main h1:not(.sr-only)").length,
        bands: {
          header: band('[data-testid="history-page"] > div:first-child'),
          filters: band('[data-testid="history-filters"]'),
          add: band('[data-testid="history-add"]'),
          feed: band('[data-testid="history-feed"]'),
          day: band('[data-testid="history-day"] h2'),
        },
      };
    });
    expect(
      Math.round(chrome.chrome),
      `the record spends ${Math.round(chrome.chrome)}px above its first row — ` +
        JSON.stringify(chrome.bands)
    ).toBeLessThanOrEqual(CHROME_BUDGET_PX);
    // What buys it, asserted so a regression names its cause: no visible page title
    // below `sm` (the nav names the page), and exactly one filter row.
    expect(chrome.h1).toBe(0);
    await expect(page.getByTestId("history-filters")).toHaveCount(1);
  });

  test("the doors the deleted ledgers left behind all land here", async ({
    page,
  }) => {
    seedDay();

    await page.goto("/nutrition");
    await hydratedClick(page, page.getByTestId("food-ledger-link"));
    await expect(page).toHaveURL(/\/history\?kind=food/);
    await expect(page.getByTestId("history-filters")).toBeVisible();

    await page.goto("/wellness");
    await hydratedClick(page, page.getByTestId("practice-ledger-link"));
    await expect(page).toHaveURL(/\/history\?kind=practice/);
    await expect(
      page.getByTestId("history-row").filter({ hasText: PRACTICE })
    ).toHaveCount(1);

    // The substance record's FIRST door (#3958): every other logged-event surface
    // already owed the reader one.
    await page.goto("/records/specialty/substance-use");
    await followLink(
      page,
      page.getByTestId("substance-ledger-link"),
      /\/history\?kind=substance/
    );

    // THE OLD ROUTES ARE GONE, with no shim standing in for them, and the check for
    // that is NOT here: it is `git grep`, which the issue names as the acceptance
    // criterion precisely because a surviving reference is what a redirect would
    // hide. Spelling one of those paths in this file to assert its 404 would put the
    // string back in the tree and make that grep answer something — so what this
    // test proves is the half a browser can: every door lands on the record.
  });

  test("a bad deep link degrades to the page, and the record ends at now", async ({
    page,
  }) => {
    seedDay();

    // An unknown kind, an unknown family, and a nonsense item: each falls back to All
    // rather than 404ing. A record surface you cannot get back to from a hand-edited
    // URL is not a record.
    //
    // `?kind=sleep` AND `?family=clinical` USED TO BE ON THIS LIST and are not any
    // more, because phase 2 shipped them: sleep is a kind and clinical is a family, so
    // they resolve now instead of degrading. Leaving them here would have been the
    // worse half of the trade — a fallback list that admits everything cannot tell
    // "an invalid deep link degrades" from "nothing is valid", and it would have kept
    // passing on a tree where the whole registry had stopped resolving.
    for (const url of [
      "/history?kind=not-a-kind",
      "/history?family=not-a-family",
      "/history?kind=not-a-kind&item=nonsense",
    ]) {
      await page.goto(url);
      await expect(page.getByTestId("history-filters")).toBeVisible();
      await expect(page.getByTestId("history-chip-all")).toHaveAttribute(
        "aria-current",
        "true"
      );
    }

    // THE CONVERSE, in the same test and against the same chip: the two the phase-2
    // registry made real select themselves rather than falling back. Asserted as the
    // difference between two renders, so neither half is satisfiable by a page that
    // marks nothing current.
    await page.goto("/history?family=clinical");
    await expect(
      page.getByTestId("history-chip-family-clinical")
    ).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("history-chip-all")).not.toHaveAttribute(
      "aria-current",
      "true"
    );
    await page.goto("/history?kind=sleep");
    await expect(page.getByTestId("history-chip-sleep")).toHaveAttribute(
      "aria-current",
      "true"
    );

    // A future `?day` clamps to today — symmetric with the Add door's
    // never-the-future rule, and the reason the timeline's future fold is not
    // inherited.
    await page.goto("/history?day=2099-01-01");
    await expect(page.getByTestId("history-filters")).toBeVisible();
    const days = await page.getByTestId("history-day-link").allTextContents();
    expect(days.join(" ")).not.toContain("2099");
  });

  test("the jump rail owns a lane and never overlaps a row's action column", async ({
    page,
  }) => {
    seedDay();
    await phone(page);
    // ON `?kind=dose`, AND THE ROLLUP BOUNDARY IS WHY. This case ran on the unfiltered
    // record until phase 2, where the high-frequency log kinds collapse into a rollup
    // line that by rule draws neither ⋯ nor › — so Everything stopped drawing an
    // action column at all, and the verdict below went on passing over an EMPTY
    // candidate set. Measured: 0 candidates on `/history`, and the assertion could not
    // fail whatever the rail did. Filtered to a kind the page is the plain record, so
    // this is the view where "a row's action column" still names something; the rail's
    // lane on the unfiltered view is asserted on card edges by the case below.
    await page.goto("/history?kind=dose");
    // THE PREMISE BEFORE THE VERDICT: the rail is offered only from two periods up,
    // and `seedDay` plants a row in an earlier calendar month precisely so this is a
    // fact rather than a hope. Without it the case would pass over a page with no
    // rail on it at all — the empty state every overlap assertion is flattered by.
    const rail = page.getByTestId("timeline-scrubber");
    await expect(rail).toHaveCount(1);
    await expect(rail).toHaveAttribute("data-scrubber-ready", "true");

    const measured = await page.evaluate(() => {
      const strip = document
        .querySelector('[data-testid="timeline-scrubber"]')!
        .getBoundingClientRect();
      // THE RELATIONSHIP, NOT AN ABSOLUTE: the claim is that the strip and a row's
      // ⋯ do not share pixels, which a distance-from-the-viewport-edge could not
      // see — the rail is fixed to the viewport and the row is inside a gutter.
      const boxes = [
        ...document.querySelectorAll('[data-testid="history-row"] button'),
      ]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0);
      return {
        candidates: boxes.length,
        overlap: boxes
          .filter((r) => r.right > strip.left)
          .map((r) => ({
            right: Math.round(r.right),
            strip: Math.round(strip.left),
          })),
      };
    });
    // THE SECOND PREMISE, kept in the file rather than left to the route choice
    // above: "never overlaps a row's ACTION COLUMN" is a claim only while some row
    // still draws one. This is the assertion that CAUGHT the vacuum when the rollup
    // boundary emptied the candidate set, and it is what would catch the next thing
    // that empties it.
    expect(
      measured.candidates,
      "no row on the record draws an action control, so the overlap verdict is vacuous"
    ).toBeGreaterThan(0);
    expect(measured.overlap, JSON.stringify(measured.overlap)).toEqual([]);
  });

  // ── THE RAIL'S LANE, ON RENDERED GEOMETRY (#4045 §2) ──────────────────────
  //
  // NEVER ON CLASS STRINGS. The defect was that ONE token was applied at two
  // structural depths, so every class assertion the page could make was already true
  // while the edges disagreed by 28px. Only the boxes can see it.
  //
  // TWO WIDTHS, because the ruling has two halves and each is satisfiable by a tree
  // that breaks the other: a page that never reserves the lane passes the wide case and
  // puts the rail over its own cards at 1024, and the shipped page passed nothing.
  test("day cards and fold cards share one right edge, and the rail keeps out of the margin when there is one", async ({
    page,
  }) => {
    seedDay();
    for (const width of [WIDE_PX, NARROW_DESKTOP_PX]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(HISTORY_WITH_OLD_YEAR);
      // THE PREMISE BEFORE THE VERDICT, as the phone case does: no rail, no lane, and
      // an alignment assertion over a page with nothing to align is the empty result
      // that flatters every one of these.
      const rail = page.getByTestId("timeline-scrubber");
      await expect(rail).toHaveCount(1);
      await expect(rail).toHaveAttribute("data-scrubber-ready", "true");
      await expect(page.locator(MONTH_FOLD).first()).toBeVisible(); // first-ok: the edge claim is about any fold card
      await expect(page.getByTestId("history-rows").first()).toBeVisible(); // first-ok: the edge claim is about any day card

      const edges = await page.evaluate((foldSelector) => {
        const right = (el: Element | null) =>
          el ? Math.round(el.getBoundingClientRect().right) : null;
        return {
          day: right(document.querySelector('[data-testid="history-rows"]')),
          fold: right(document.querySelector(`${foldSelector} a`)),
          feed: right(document.querySelector('[data-testid="history-feed"]')),
          strip: Math.round(
            document
              .querySelector('[data-testid="timeline-scrubber"]')!
              .getBoundingClientRect().left
          ),
        };
      }, MONTH_FOLD);

      // THE RELATIONSHIP THE OWNER SAW: one card's border against the other's, not
      // either against the viewport. Both were "correct" distances from the page edge.
      expect(
        edges.day,
        `at ${width}px the day card ends at ${edges.day} and the fold card at ${edges.fold}`
      ).toBe(edges.fold);

      if (width === WIDE_PX) {
        // The lane does not exist here: every card runs the full width of the feed…
        expect(edges.day, `at ${width}px the feed ends at ${edges.feed}`).toBe(
          edges.feed
        );
        // …and the rail is beside the card rather than over it, which is the fact that
        // makes spending nothing safe. Asserted against the STRIP, so a future width
        // change cannot make "no gutter" quietly mean "the rail is on the cards".
        expect(
          edges.strip,
          `the rail starts at ${edges.strip}, the feed ends at ${edges.feed}`
        ).toBeGreaterThanOrEqual(edges.feed!);
      } else {
        // The carve-out exists here — asserted as a real reservation rather than as a
        // number, so it cannot silently become zero and pass as "aligned".
        expect(edges.feed! - edges.day!).toBeGreaterThan(0);
      }
    }
  });

  // ── A FOLD TAP HOLDS ITS PLACE (#4045 §4) ─────────────────────────────────
  //
  // ON SCROLL POSITION, never on markup: the shipped card was a plain `<Link>`, which
  // is indistinguishable from the fixed one in the DOM and different in the only way
  // that mattered — every tap landed the reader at the top of the page.
  test("opening a fold lands on the revealed days and closing returns to the card, never the page top", async ({
    page,
  }) => {
    seedDay();
    // A viewport short enough that the fold spine is genuinely below the fold of the
    // page: at full height the premise below ("we were not at the top") can be true by
    // accident on a sparse profile, and a scroll-reset assertion over a page that never
    // scrolled is the empty result that passes on the bug.
    await page.setViewportSize({ width: NARROW_DESKTOP_PX, height: 600 });
    await page.goto(HISTORY_WITH_OLD_YEAR);

    // PINNED TO ONE CARD BY KEY, not left as "the first shut month": that locator
    // re-resolves after the tap and quietly moves to the NEXT shut card, so every
    // assertion after the click would be about a fold nobody touched.
    const shut = page.locator(`${MONTH_FOLD}[data-fold-open="false"]`).first(); // first-ok: the claim is about whichever shut month the spine opens with
    await expect(shut).toBeVisible();
    const foldKey = await shut.getAttribute("data-fold-key");
    const fold = page.getByTestId(`history-fold-${foldKey}`);
    await fold.evaluate((el) => el.scrollIntoView(true));
    const before = await page.evaluate(() => Math.round(window.scrollY));
    expect(
      before,
      "the fold spine has to be below the first screen"
    ).toBeGreaterThan(0);

    await hydratedClick(page, fold.locator("a"));
    await expect(fold).toHaveAttribute("data-fold-open", "true");
    // THE REVEALED DAYS ARE AT THE TAP. They render as the fold card's next siblings
    // now, so this is the month's own first day and not some day elsewhere in the feed.
    const revealed = page
      .locator(
        `[data-testid="history-fold-${foldKey}"] ~ [data-testid="history-day"]`
      )
      .first(); // first-ok: the claim is about the day the tap revealed, which is the next one
    await expect(revealed).toBeInViewport();
    await expect(fold).toBeInViewport();
    expect(
      await page.evaluate(() => Math.round(window.scrollY)),
      "opening a fold scrolled the reader to the top of the page"
    ).toBeGreaterThan(0);

    await hydratedClick(page, fold.locator("a"));
    await expect(fold).toHaveAttribute("data-fold-open", "false");
    await expect(fold).toBeInViewport();
    expect(
      await page.evaluate(() => Math.round(window.scrollY)),
      "closing a fold scrolled the reader to the top of the page"
    ).toBeGreaterThan(0);
  });

  // ── ONE KIND, NO GLYPH COLUMN (#4045 §3) ──────────────────────────────────
  test("drops the glyph column in a single-kind view and keeps it in All", async ({
    page,
  }) => {
    seedDay();
    // The glyph is the row's LEADING child inside the shared logged-event anatomy —
    // named that way rather than as "an svg in the row", which the ⋯ also satisfies.
    const glyphs = page.locator(
      '[data-testid="history-row"] [data-logged-event-row] > svg'
    );

    await page.goto("/history");
    await expect(page.getByTestId("history-row").first()).toBeVisible(); // first-ok: readiness, no per-row claim
    const all = await glyphs.count();
    expect(all, "All draws one glyph per row").toBeGreaterThan(0);

    await page.goto("/history?kind=food");
    await expect(page.getByTestId("history-row").first()).toBeVisible(); // first-ok: readiness, no per-row claim
    await expect(glyphs).toHaveCount(0);
  });

  // ── THE DAY HEADER IS A DOOR AND SAYS SO (#4045 §7) ───────────────────────
  test("makes the whole day header the day link, chevron included", async ({
    page,
  }) => {
    seedDay();
    await page.goto(`/history?day=${DAY}`);
    const link = page.getByTestId("history-day-link");
    // THE COUNT IS INSIDE THE TAP TARGET. Asserted on the link's own text — shipped,
    // the count was a sibling of the link, which every "the h2 states a count" check
    // was satisfied by.
    await expect(link).toContainText(/\d+ records?/);
    // AND THE CLUSTER STILL READS AS A DATE WHEN IT IS READ LINEARLY. `gap-2`
    // separates the date from the count for an EYE and for nothing else: `textContent`
    // has no gaps, so two adjacent spans concatenate to "…August 295 records" and the
    // date's last digit runs into the count's first. That is not a style nit — it is
    // what stopped e2e/machine-date-census.spec.ts finding a display-shaped date on
    // this route at all, turning its positive control into an absence assertion over
    // nothing. #3958 writes the header WITH a separator ("FRI, AUG 28 — 15 records");
    // this asserts the separator survives, on the concatenation rather than on the
    // rendered line, because the rendered line looked right the whole time.
    const concatenated = await link.evaluate((el) => el.textContent ?? "");
    expect(
      concatenated,
      `the day header concatenates to "${concatenated}"`
    ).toMatch(/\d\s*—\s*\d+ records?/);
    // And the chevron that says the header is a door at all, in the text cluster: the
    // link's box ends where its content ends rather than spanning the header.
    await expect(link.locator("svg")).toHaveCount(1);
    const spans = await page.evaluate(() => {
      const h2 = document.querySelector('[data-testid="history-day"] h2')!;
      const a = h2.querySelector("a")!;
      return {
        header: Math.round(h2.getBoundingClientRect().width),
        link: Math.round(a.getBoundingClientRect().width),
        // NOTHING RIGHT-FLOATED, per the spec's own words: the header has one child
        // and it is the link, so no sibling can drift to the far edge.
        children: h2.childElementCount,
      };
    });
    expect(spans.children).toBe(1);
    expect(spans.link).toBeLessThan(spans.header);
  });

  // ── THE ADD DOOR RESOLVES IN PLACE (#4045 §1) ─────────────────────────────
  test("opens each kind's backfill form in place instead of navigating away", async ({
    page,
  }) => {
    seedDay();
    const exercised: string[] = [];
    for (const kind of ["food", "practice", "substance", "body"] as const) {
      await page.goto(`/history?kind=${kind}`);
      const opener = page.getByTestId(`history-add-open-${kind}`);
      // A kind whose vocabulary is empty renders no door — the dose door's own rule.
      // A BARE SKIP WOULD PASS OVER A PAGE WITH NO DOORS AT ALL, which is exactly the
      // tree this test exists to fail on, so the kinds actually exercised are counted
      // and named below.
      if ((await opener.count()) === 0) continue;
      exercised.push(kind);
      await hydratedClick(page, opener);
      await expect(page.getByTestId(`history-add-panel-${kind}`)).toBeVisible();
      // THE PAGE THE READER WAS ON. The defect was a redirect, so the URL is the
      // assertion: same route, same filter, same found context.
      await expect(page).toHaveURL(new RegExp(`/history\\?kind=${kind}$`));
    }
    expect(exercised, `doors opened in place: ${exercised.join(", ")}`).toEqual(
      ["food", "practice", "substance", "body"]
    );
    // The body door covers body metrics generally rather than weight alone — the
    // hardcoded `/trends/metric/weight` redirect was the loudest half of this defect.
    await page.goto("/history?kind=body");
    await hydratedClick(page, page.getByTestId("history-add-open-body"));
    const bodyPanel = page.getByTestId("history-add-panel-body");
    await expect(bodyPanel.locator('input[name="body_fat_pct"]')).toBeVisible();
    await expect(bodyPanel.locator('input[name="resting_hr"]')).toBeVisible();
  });

  // CORRECTING IN PLACE MEANS THE ROW SAYS THE NEW THING, and nothing asserted that.
  //
  // This page's whole claim is "correctable in place", so a correction that leaves the
  // old text on screen until the next navigation is the same defect as the Add door's
  // silent write that #4062 fixed with `router.refresh()`. The five ⋯ forms make no
  // such call, which reads exactly like the same bug waiting to be found.
  //
  // IT IS NOT ONE — measured rather than reasoned about, and the first explanation was
  // wrong, which is why the mechanism is not asserted here. The guess was that the
  // repaint rides each action's revalidation list, every one of which names `/history`.
  // Dropping `/history` from the practice list and re-running this test left it GREEN,
  // so whatever carries the repaint, it is not that. A `router.refresh()` added on the
  // strength of the original guess would have been a second mechanism for something
  // already working, which is the shape the line-budget ruling refuses.
  //
  // SO THIS ASSERTS THE BEHAVIOUR AND CLAIMS NOTHING ABOUT ITS CAUSE. That is the
  // honest scope: the property is real, it is the page's central promise, nothing else
  // pins it, and it is INHERITED from framework behaviour rather than stated anywhere
  // in this repo — which is precisely the kind of property that disappears without a
  // line of anyone's diff to blame. Shown to fail: removing the `done()` on the
  // correction's success path reddens it.
  //
  // Practice is the kind driven because its detail segment prints a value the form
  // edits directly, so the assertion reads the written value rather than a proxy.
  test("a correction repaints the row it corrected", async ({ page }) => {
    seedDay();
    await page.goto("/history?kind=practice");
    const row = () =>
      page.getByTestId("history-row").filter({ hasText: PRACTICE });
    await expect(row().getByTestId("history-row-detail")).toContainText(
      "20 min"
    );

    await hydratedClick(page, row().getByTestId("overflow-menu-trigger"));
    await page.getByTestId("history-row-edit").click();
    const form = page.getByTestId("history-row-editing");
    await form.locator('input[name="duration_min"]').fill("45");
    await form.getByRole("button", { name: "Save" }).click();

    // The SAME row, re-read after the write — not a fresh navigation, which would
    // pass over the defect this exists to catch.
    await expect(row().getByTestId("history-row-detail")).toContainText(
      "45 min"
    );
    await expect(row().getByTestId("history-row-detail")).not.toContainText(
      "20 min"
    );
  });
});
