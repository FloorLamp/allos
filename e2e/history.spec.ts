import Database from "better-sqlite3";
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { workerDbPath } from "./worker-env";
import { expectNoClippedContent, followLink, hydratedClick } from "./helpers";
import { zonedWallTimeToUtc } from "@/lib/date";

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
const DAY = "2026-08-17";
// A day in an EARLIER CALENDAR MONTH, so the fold spine this spec's rail scrubs has at
// least two stops whatever else the shared seed holds. The rail is not offered below
// two periods — a permanent strip down the edge of a one-period page is chrome
// charging rent — so without this the rail case would be conditional on a fixture
// nothing here controls.
const OLD_DAY = "2026-02-11";
const PRACTICE = "E2e History Rowing";
const FOOD_GROUP = "berries";
const FOOD_NAME = "Berries";

// The chrome budget, in CSS pixels, from the top of the page's content to the top of
// its first record at 390px. THE OWNER'S CRITERION IS ~140 and the prototype measured
// ~135; this is that number as a ceiling. What it bounds is the header stack — the
// title band (absent below `sm`), the one filter row, and the Add bar — so a proposed
// addition has to displace something rather than push the record down.
const CHROME_BUDGET_PX = 140;

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
      `INSERT INTO practice_logs (profile_id, practice, date, time, duration_min)
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

    // AND THE OLD ROUTES ARE GONE, with no shim standing in for them. A redirect
    // would be the compatibility layer the line-budget ruling forbids, so the check
    // is that the app answers 404 rather than that it answers at all.
    const gone = await page.request.get("/nutrition/food-history");
    expect(gone.status()).toBe(404);
  });

  test("a bad deep link degrades to the page, and the record ends at now", async ({
    page,
  }) => {
    seedDay();

    // An unknown kind, a phase-2 family that has not shipped, and a future day: each
    // falls back rather than 404ing. A record surface you cannot get back to from a
    // hand-edited URL is not a record.
    for (const url of [
      "/history?kind=sleep",
      "/history?family=clinical",
      "/history?kind=not-a-kind&item=nonsense",
    ]) {
      await page.goto(url);
      await expect(page.getByTestId("history-filters")).toBeVisible();
      await expect(page.getByTestId("history-chip-all")).toHaveAttribute(
        "aria-current",
        "true"
      );
    }

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
    // A profile with enough history to earn a rail at all: the shared seed spans
    // months, so the unfiltered record is where the fold spine exists.
    await page.goto("/history");
    // THE PREMISE BEFORE THE VERDICT: the rail is offered only from two periods up,
    // and `seedDay` plants a row in an earlier calendar month precisely so this is a
    // fact rather than a hope. Without it the case would pass over a page with no
    // rail on it at all — the empty state every overlap assertion is flattered by.
    const rail = page.getByTestId("timeline-scrubber");
    await expect(rail).toHaveCount(1);
    await expect(rail).toHaveAttribute("data-scrubber-ready", "true");

    const overlap = await page.evaluate(() => {
      const strip = document
        .querySelector('[data-testid="timeline-scrubber"]')!
        .getBoundingClientRect();
      // THE RELATIONSHIP, NOT AN ABSOLUTE: the claim is that the strip and a row's
      // ⋯ do not share pixels, which a distance-from-the-viewport-edge could not
      // see — the rail is fixed to the viewport and the row is inside a gutter.
      return [
        ...document.querySelectorAll('[data-testid="history-row"] button'),
      ]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.right > strip.left)
        .map((r) => ({
          right: Math.round(r.right),
          strip: Math.round(strip.left),
        }));
    });
    expect(overlap, JSON.stringify(overlap)).toEqual([]);
  });
});
