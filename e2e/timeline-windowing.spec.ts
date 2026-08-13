import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { followLink } from "./helpers";
import { workerDbPath, frozenNow } from "./worker-env";

// Timeline windowing (issue #2657).
//
// `/timeline` at its default "All · All dates" unrolled 47,251px of individual event
// cards at 390px, and OPENED on far-future goal target dates — the reader's entry
// point was speculative scheduling rather than their own recent history. The feed now
// folds: the future to one line, the last 14 days event-grained, everything older to
// one collapsible card per calendar month.
//
// The claim this spec has to keep honest is the one a windowing change can quietly
// break — that nothing was REMOVED, only compressed. So each fold is proved twice: the
// planted entry is absent from the default page, and present after the fold that hides
// it is opened. The "Oldest" jump is proved to carry the fold open with it, because a
// jump into a collapsed card is a link to nothing.
//
// Fixture-OWNED (#868): two goals on the shared default profile, one unambiguously
// future and one unambiguously older than the recent band in ANY timezone the profile
// might be in, planted in beforeAll and removed in afterAll — so the spec establishes
// its own preconditions (both an ABSENCE and a PRESENCE) instead of trusting the seed,
// and leaves the shared profile exactly as it found it.

const DB_PATH = workerDbPath();
const AHEAD_GOAL = "E2E windowing ahead goal";
const OLD_GOAL = "E2E windowing old goal";

function shiftedDay(days: number): string {
  const d = new Date(frozenNow());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// +45 / −100 days: far enough from both boundaries that no profile timezone can move
// either across the "after today" or the 14-day edge.
const AHEAD_DATE = shiftedDay(45);
const OLD_DATE = shiftedDay(-100);
const OLD_MONTH = OLD_DATE.slice(0, 7);

function withDb<T>(fn: (handle: Database.Database) => T): T {
  const handle = new Database(DB_PATH);
  try {
    handle.pragma("busy_timeout = 5000");
    return fn(handle);
  } finally {
    handle.close();
  }
}

function cleanup(): void {
  withDb((db) => {
    db.prepare("DELETE FROM goals WHERE title IN (?, ?)").run(
      AHEAD_GOAL,
      OLD_GOAL
    );
  });
}

function seed(): void {
  cleanup();
  withDb((db) => {
    const insert = db.prepare(
      `INSERT INTO goals (profile_id, title, target_date, status)
       VALUES (1, ?, ?, 'active')`
    );
    insert.run(AHEAD_GOAL, AHEAD_DATE);
    insert.run(OLD_GOAL, OLD_DATE);
  });
}

test.describe("timeline windowing (#2657)", () => {
  test.beforeAll(seed);
  test.afterAll(cleanup);

  test("the feed opens on recent history — the future and older months are folded away", async ({
    page,
  }) => {
    await page.goto("/timeline");

    // The very first thing in the feed is the future fold, not a December day group.
    const first = page.locator("#timeline-feed section").first(); // first-ok: asserts WHICH element leads the feed — the assertion is about position
    await expect(first).toHaveAttribute("data-fold-key", "ahead");

    const ahead = page.getByTestId("timeline-fold-ahead");
    await expect(ahead).toHaveAttribute("data-fold-open", "false");
    await expect(
      page.getByTestId("timeline-fold-ahead-toggle")
    ).toHaveAttribute("aria-expanded", "false");
    // The always-present count (#1504 grammar): the amount never hides, only the
    // vertical cost of it does.
    await expect(page.getByTestId("timeline-fold-ahead-counts")).toHaveText(
      /^\d+ events? · \d+ days?$/
    );

    // …and the scheduled-ahead entry itself is genuinely not rendered.
    await expect(page.getByText(AHEAD_GOAL)).toHaveCount(0);
    await expect(page.locator(`#timeline-day-${AHEAD_DATE}`)).toHaveCount(0);

    // The same for the old month: a card, closed, with its rows unrendered.
    const month = page.getByTestId(`timeline-fold-${OLD_MONTH}`);
    await expect(month).toHaveAttribute("data-fold-open", "false");
    await expect(page.getByText(OLD_GOAL)).toHaveCount(0);
    await expect(page.locator(`#timeline-day-${OLD_DATE}`)).toHaveCount(0);
  });

  test("a month card expands in place, and the open fold is in the URL", async ({
    page,
  }) => {
    await page.goto("/timeline");

    await followLink(
      page,
      page.getByTestId(`timeline-fold-${OLD_MONTH}-toggle`),
      new RegExp(`open=${OLD_MONTH}`)
    );

    await expect(
      page.getByTestId(`timeline-fold-${OLD_MONTH}-toggle`)
    ).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`#timeline-day-${OLD_DATE}`)).toBeVisible();
    await expect(page.getByText(OLD_GOAL)).toBeVisible();

    // The other folds stay shut — expanding one month is not expanding the page.
    await expect(page.getByTestId("timeline-fold-ahead")).toHaveAttribute(
      "data-fold-open",
      "false"
    );

    // And it closes again, back to the fold-free URL.
    await followLink(
      page,
      page.getByTestId(`timeline-fold-${OLD_MONTH}-toggle`),
      /\/timeline$/
    );
    await expect(page.getByText(OLD_GOAL)).toHaveCount(0);
  });

  test("the future fold opens to the scheduled-ahead entry", async ({
    page,
  }) => {
    await page.goto("/timeline");

    await followLink(
      page,
      page.getByTestId("timeline-fold-ahead-toggle"),
      /open=ahead/
    );

    await expect(
      page.getByTestId("timeline-fold-ahead-toggle")
    ).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`#timeline-day-${AHEAD_DATE}`)).toBeVisible();
    await expect(page.getByText(AHEAD_GOAL)).toBeVisible();
  });

  test("the Oldest jump carries the fold that hides its destination open", async ({
    page,
  }) => {
    await page.goto("/timeline");

    const oldest = page.getByRole("link", { name: "Oldest" });
    const href = await oldest.getAttribute("href");
    // A bare "#timeline-day-…" fragment here would be a link into a collapsed card:
    // the jump must name the fold it needs opened as well as the day it lands on.
    expect(href).toMatch(
      /^\/timeline\?open=\d{4}-(0[1-9]|1[0-2])#timeline-day-\d{4}-\d{2}-\d{2}$/
    );
    const destination = href?.split("#timeline-day-")[1] ?? "";

    await followLink(page, oldest, /open=\d{4}-\d{2}/);
    await expect(page.locator(`#timeline-day-${destination}`)).toBeVisible();
  });
});
