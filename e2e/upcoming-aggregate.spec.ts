import { test, expect } from "./fixtures";
import { type Browser, type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { workerDbPath } from "./worker-env";
import { settledClick, expandUpcomingAggregates } from "./helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_UPCOMING_AGG,
  UPCOMING_AGG_PROFILE,
  UPCOMING_AGG_SUPPLEMENT,
  UPCOMING_AGG_TAKEN,
  UPCOMING_AGG_PRN,
  UPCOMING_AGG_GOAL_NEAREST,
  UPCOMING_AGG_APPOINTMENT,
  UPCOMING_AGG_APPOINTMENT_SOON,
} from "./fixture-logins";

// Upcoming display aggregation (#1504).
//
// The planning page's Today band was drowning in routine: every scheduled dose as its
// own full row, then a pile of pairwise interaction/PGx notes. The fold ports the
// always-present contract — the COUNT stays visible, the vertical cost becomes opt-in,
// the safety classes are exempt. These specs assert the four claims that make the fold
// acceptable rather than a hiding place:
//
//   1. the count (and the day's taken fraction) is stated while collapsed,
//   2. expanding gives back the REAL rows — a confirm still writes from in there,
//   3. the pinned safety row (a PRN over its confirmed max) is never folded and
//      renders ABOVE the aggregate, in both states,
//   4. the med-safety rollup folds interaction notes while each one keeps its own
//      dismiss.
//
// Fixture policy (#868): a DEDICATED login + profile (seedUpcomingAggregate), owned
// end to end by this file and its mobile twin. Nothing else reads this profile, so
// these may exact-count their own rows, confirm a dose and dismiss a finding. The
// two mutating cases write through the real UI and are undone by resetFixture below
// — a DB-level restore to the seeded baseline, so `--repeat-each` sees the same world
// no matter where a case failed.

// A Server-Action submit on this page re-renders the whole band (the aggregate's
// count moves with it), which is slower than a plain assertion budget on a cold
// worker. One NAMED ceiling, used only for the post-write re-render.
const RERENDER_MS = 20_000;

// The fixture schedules six `must` doses and logs one of them taken, so the collapsed
// summary must read "5 doses left · 1 of 6 taken".
const BASELINE_SUMMARY = "5 doses left · 1 of 6 taken";

// Restore the fixture profile to its seeded state: drop any dose confirm this file
// wrote today (the seeded taken dose and the two PRN administrations stay — they ARE
// the baseline), and clear any suppression. Short-lived connection with a busy
// timeout so it never contends with the running server (WAL).
function resetFixture(): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const profile = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(UPCOMING_AGG_PROFILE) as { id: number } | undefined;
    if (!profile) return;
    db.prepare(
      `DELETE FROM intake_item_logs
        WHERE item_id IN (
          SELECT id FROM intake_items
           WHERE profile_id = ? AND name NOT IN (?, ?)
        )`
    ).run(profile.id, UPCOMING_AGG_TAKEN, UPCOMING_AGG_PRN);
    db.prepare("DELETE FROM upcoming_dismissals WHERE profile_id = ?").run(
      profile.id
    );
  } finally {
    db.close();
  }
}

test.beforeEach(() => {
  resetFixture();
});

test.afterEach(() => {
  resetFixture();
});

async function openUpcoming(browser: Browser): Promise<{
  page: Page;
  main: Locator;
}> {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_UPCOMING_AGG,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/upcoming");
  const main = page.getByRole("main");
  await expect(main.getByTestId("upcoming-total")).toBeVisible();
  return { page, main };
}

const doseAggregate = (main: Locator) =>
  main.getByTestId("upcoming-aggregate-dose");
const doseSummary = (main: Locator) =>
  main.getByTestId("upcoming-aggregate-summary-dose");

// The dose row for a fixture item, addressed by its (spec-owned, unique) name.
const doseRow = (main: Locator, name: string) =>
  main
    .locator('[data-testid^="upcoming-item-dose:"]')
    .filter({ hasText: name });

test.describe("Upcoming display aggregation (#1504)", () => {
  test("Today states the dose count and the day's taken fraction while collapsed", async ({
    browser,
  }) => {
    const { main } = await openUpcoming(browser);

    // The fold is band-scoped: this is TODAY's aggregate, not a page-wide one.
    const aggregate = doseAggregate(main);
    await expect(aggregate).toBeVisible();
    await expect(aggregate).toHaveAttribute("data-band", "today");

    // Stateless: collapsed on arrival, every visit.
    await expect(aggregate).toHaveJSProperty("open", false);

    // ALWAYS PRESENT: the count is on screen without expanding anything, and so is
    // the fraction. It only reconciles because its denominator comes from the same
    // due evaluation as the rows behind it.
    await expect(doseSummary(main)).toContainText(BASELINE_SUMMARY);

    // …and the individual rows really are folded away, not merely restyled.
    await expect(doseRow(main, UPCOMING_AGG_SUPPLEMENT)).toBeHidden();
    // A dose already taken is in the fraction, never a row.
    await expect(doseRow(main, UPCOMING_AGG_TAKEN)).toHaveCount(0);

    // Expanding gives back the real rows, each with its own link and controls.
    await expandUpcomingAggregates(main, "dose");
    await expect(doseRow(main, UPCOMING_AGG_SUPPLEMENT)).toBeVisible();
    await expect(
      main.locator('[data-testid^="upcoming-item-dose:"]')
    ).toHaveCount(5);
  });

  test("a dose confirm still writes from inside the expanded fold", async ({
    browser,
  }) => {
    const { page, main } = await openUpcoming(browser);
    await expandUpcomingAggregates(main, "dose");

    const row = doseRow(main, UPCOMING_AGG_SUPPLEMENT);
    await expect(row).toBeVisible();
    const rowTestId = await row.getAttribute("data-testid");
    expect(rowTestId).toMatch(/^upcoming-item-dose:/);

    // The confirm is the ordinary row affordance — folding is a rendering decision,
    // so the write path behind it is untouched.
    await settledClick(page, row.getByRole("button", { name: "Mark taken" }));

    // The row is gone AND the always-visible summary moved with it: the count the
    // collapsed state advertises is the same fact the rows are.
    await expect(main.getByTestId(rowTestId!)).toHaveCount(0, {
      timeout: RERENDER_MS,
    });
    await expect(doseSummary(main)).toContainText(
      "4 doses left · 2 of 6 taken",
      { timeout: RERENDER_MS }
    );
  });

  test("the PRN over-max safety row is never folded and leads its band", async ({
    browser,
  }) => {
    const { main } = await openUpcoming(browser);

    // PINNED (#1504 / the #449 safety posture): a count that has already been
    // exceeded must never be summarised by another count. It is on screen with the
    // dose aggregate still COLLAPSED.
    const prn = main
      .locator('[data-testid^="upcoming-item-prn-max:"]')
      .filter({ hasText: UPCOMING_AGG_PRN });
    await expect(prn).toBeVisible();
    await expect(doseAggregate(main)).toHaveJSProperty("open", false);

    // ABOVE, not merely outside: compaction can never push a safety row below a
    // summary of routine work.
    const prnBox = await prn.boundingBox();
    const aggBox = await doseSummary(main).boundingBox();
    expect(prnBox).not.toBeNull();
    expect(aggBox).not.toBeNull();
    expect(prnBox!.y).toBeLessThan(aggBox!.y);

    // …and it is not one of the folded rows either.
    await expandUpcomingAggregates(main, "dose");
    await expect(
      doseAggregate(main).locator('[data-testid^="upcoming-item-prn-max:"]')
    ).toHaveCount(0);
  });

  test("the med-safety rollup folds the interaction notes, each keeping its own dismiss", async ({
    browser,
  }) => {
    const { page, main } = await openUpcoming(browser);

    // The rollup covers interaction + pgx only; the fixture's four interacting
    // medications yield at least the three pairs it takes to fold.
    const rollup = main.getByTestId("upcoming-aggregate-med-safety");
    await expect(rollup).toBeVisible();
    await expect(rollup).toHaveJSProperty("open", false);
    await expect(
      main.getByTestId("upcoming-aggregate-summary-med-safety")
    ).toContainText(/\d+ medication-safety notes/);

    await expandUpcomingAggregates(main, "med-safety");
    const notes = main.locator('[data-testid^="upcoming-item-interaction:"]');
    const before = await notes.count();
    expect(before).toBeGreaterThanOrEqual(3);

    // IDENTITY SURVIVES THE FOLD (#1496): each folded row still carries its own
    // dedupeKey and its own per-item dismiss.
    const note = notes.first(); // first-ok: any folded note proves per-item dismiss — order-agnostic
    const noteTestId = await note.getAttribute("data-testid");
    await note.getByRole("button", { name: "More actions" }).click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Dismiss" })
      .click();

    await expect(main.getByTestId(noteTestId!)).toHaveCount(0, {
      timeout: RERENDER_MS,
    });

    // The dismissed note lands in the page's own "Snoozed & dismissed" complement —
    // folding never removed it from the bus, it only changed where it renders.
    const suppressed = page.getByTestId("suppressed-section");
    await expect(suppressed).toBeVisible();
    await suppressed.locator("summary").click();
    await expect(suppressed.getByTestId("suppressed-row")).toHaveCount(1);
  });
});

// ── The goal fold and the Later band's calendar dates (#2579-A / #2579-B) ──
//
// The charter these two implement: /upcoming is the cross-domain forward LEDGER, and
// a row earns full height on it only if this page is its primary home. A goal
// deadline's home is the Training hub; the colonoscopy to book has no other home. On
// the live page the first buried the second.
//
// The date expectations below are formatted HERE, from the target_date the seed
// actually wrote, by a month table this file owns — never by calling the app's own
// formatter, which would pass with the feature gutted.
const MONTHS_SHORT_LOCAL = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// "Sep 26" for an ISO YYYY-MM-DD. The year clause is deliberately NOT reproduced:
// assertions below use `toContainText`, so a deadline that crosses the calendar year
// still matches on the month and day this pins.
function monthDayLabel(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${MONTHS_SHORT_LOCAL[Number(m) - 1]} ${Number(d)}`;
}

// The earliest target_date the seed wrote for this profile — the deadline the
// collapsed summary must name. Read from the store, not recomputed from the seed's
// offsets, so the spec and the fixture cannot drift apart silently.
function nearestGoalDate(): string {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const row = db
      .prepare(
        `SELECT MIN(g.target_date) AS d
           FROM goals g
           JOIN profiles p ON p.id = g.profile_id
          WHERE p.name = ? AND g.status = 'active' AND g.archived = 0`
      )
      .get(UPCOMING_AGG_PROFILE) as { d: string | null };
    if (!row?.d) throw new Error("fixture has no dated goal");
    return row.d;
  } finally {
    db.close();
  }
}

const goalAggregate = (main: Locator) =>
  main.getByTestId("upcoming-aggregate-goal");

test.describe("the goal fold (#2579-A) and planning dates (#2579-B)", () => {
  test("Later states the goal count and the nearest deadline while collapsed", async ({
    browser,
  }) => {
    const { main } = await openUpcoming(browser);

    const aggregate = goalAggregate(main);
    await expect(aggregate).toBeVisible();
    // Band-scoped, like its two siblings: these are the LATER goals.
    await expect(aggregate).toHaveAttribute("data-band", "later");
    // Stateless: collapsed on arrival, every visit.
    await expect(aggregate).toHaveJSProperty("open", false);

    // ALWAYS PRESENT and PRICED: the count is on screen unexpanded, and so is the
    // one fact a folded horizon has to answer — is anything about to land?
    await expect(
      main.getByTestId("upcoming-aggregate-summary-goal")
    ).toContainText(
      `4 goal deadlines · nearest ${monthDayLabel(nearestGoalDate())}`
    );

    // The individual goal rows really are folded away, not merely restyled. A
    // collapsed <details> keeps its children in the DOM, so this is a VISIBILITY
    // claim — a count assertion here would pass with the fold gutted.
    await expect(
      main
        .locator('[data-testid^="upcoming-item-goal:"]')
        .filter({ hasText: UPCOMING_AGG_GOAL_NEAREST })
    ).toBeHidden();
    // …while the arranging errand beside them keeps its full-height row. That is the
    // whole density rule: this page IS the colonoscopy's home, and is not the goals'.
    await expect(
      main
        .locator('[data-testid^="upcoming-item-appointment:"]')
        .filter({ hasText: UPCOMING_AGG_APPOINTMENT })
    ).toBeVisible();
  });

  test("expanding gives back the real goal rows, each with its own dismiss", async ({
    browser,
  }) => {
    const { page, main } = await openUpcoming(browser);
    await expandUpcomingAggregates(main, "goal");

    const rows = main.locator('[data-testid^="upcoming-item-goal:"]');
    await expect(rows).toHaveCount(4);
    // VISIBLE now, where the collapsed case proved them hidden.
    await expect(
      rows.filter({ hasText: UPCOMING_AGG_GOAL_NEAREST })
    ).toBeVisible();

    // IDENTITY SURVIVES THE FOLD (#1496): the folded row carries its own dedupeKey
    // and its own per-item dismiss, exactly as an unfolded row would.
    const row = rows.filter({ hasText: UPCOMING_AGG_GOAL_NEAREST });
    await expect(row).toBeVisible();
    const rowTestId = await row.getAttribute("data-testid");
    await row.getByRole("button", { name: "More actions" }).click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Dismiss" })
      .click();

    await expect(main.getByTestId(rowTestId!)).toHaveCount(0, {
      timeout: RERENDER_MS,
    });
    // The count moves with it — the fold summarises the rows, it does not cache them.
    await expect(
      main.getByTestId("upcoming-aggregate-summary-goal")
    ).toContainText("3 goal deadlines", { timeout: RERENDER_MS });

    // And the dismissed goal is in the bus's own complete window, not gone.
    const suppressed = page.getByTestId("suppressed-section");
    await expect(suppressed).toBeVisible();
    await suppressed.locator("summary").click();
    await expect(suppressed.getByTestId("suppressed-row")).toHaveCount(1);
  });

  test("a Later row states its calendar date, not a countdown (#2579-B)", async ({
    browser,
  }) => {
    const { main } = await openUpcoming(browser);

    // The appointment is 60 days out: before #2579-B this column read "60 days left",
    // which is arithmetic standing where the only calendar-ready fact belongs.
    const appointment = main
      .locator('[data-testid^="upcoming-item-appointment:"]')
      .filter({ hasText: UPCOMING_AGG_APPOINTMENT });
    const status = appointment.getByTestId("upcoming-status");
    await expect(status).toHaveText(/^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/);
    await expect(status).not.toHaveText(/days left/);

    // …and the same rule holds for a row inside the fold, on the exact date the
    // collapsed summary named.
    const nearest = monthDayLabel(nearestGoalDate());
    await expandUpcomingAggregates(main, "goal");
    const goalRow = main
      .locator('[data-testid^="upcoming-item-goal:"]')
      .filter({ hasText: UPCOMING_AGG_GOAL_NEAREST });
    await expect(goalRow.getByTestId("upcoming-status")).toContainText(nearest);
  });

  test("This week keeps countdown grammar, where a number still means something", async ({
    browser,
  }) => {
    const { main } = await openUpcoming(browser);

    // The near half of the SAME decision, on the same page and the same domain: two
    // scheduled appointments differing only in how far out they are. The band
    // boundary is what switches the grammar — nothing about the row does.
    const soon = main
      .locator('[data-testid^="upcoming-item-appointment:"]')
      .filter({ hasText: UPCOMING_AGG_APPOINTMENT_SOON });
    await expect(soon.getByTestId("upcoming-status")).toHaveText("3 days left");
  });
});
