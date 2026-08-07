import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { hydratedClick } from "./helpers";
import { frozenNow, workerDbPath } from "./worker-env";
// The Upcoming section of the merged Visits page (issue #288 — appointments and
// encounters share one /encounters surface now). Originally the standalone
// /appointments list (#391, gap 7); retargeted here to the merged page. Asserts a
// seeded scheduled visit renders with its provider inside the Upcoming section, and
// that cancelling the dedicated future appointment both settles its status and
// drops it from the Upcoming feed (list↔digest parity). Also proves the old
// /appointments route redirects into the merged page.

const APPT_UPCOMING = '[data-testid^="upcoming-item-appointment:"]';

test.describe("Visits — Upcoming (appointments) (#288)", () => {
  test("the old /appointments route redirects to the merged Visits page", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/appointments");
    await expect(page).toHaveURL(/\/records\/history\/visits$/);
    await expect(page.getByTestId("records-visits")).toBeVisible();
  });

  test("a seeded scheduled appointment renders with its provider", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/records/history/visits");
    await expect(page.getByTestId("records-visits")).toBeVisible();

    // The Upcoming section carries the appointments surface.
    const upcoming = page.getByTestId("visits-upcoming");
    await expect(upcoming).toBeVisible();

    // A scheduled visit whose date passed is separated from genuinely upcoming
    // appointments so it can be resolved without inflating the Upcoming count.
    await upcoming
      .locator("summary", { hasText: "Past date—update status" })
      .click();
    const row = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: "Cardiology follow-up" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Dr. Marcus Lee");
  });

  test("cancelling an appointment settles its status and clears it from Upcoming", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/records/history/visits");
    const upcoming = page.getByTestId("visits-upcoming");

    // The dedicated future appointment while it's still scheduled (only scheduled
    // rows carry the Cancel control). Guarded so a CI retry — where it's already
    // cancelled — skips straight to the assertions.
    const scheduledRow = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: "E2E dermatology visit" })
      .filter({
        has: page.getByRole("button", { name: "Cancel appointment" }),
      });
    if (await scheduledRow.count()) {
      await scheduledRow
        .getByRole("button", { name: "Cancel appointment" })
        .click();
      // It leaves the Scheduled list (its status is no longer "scheduled").
      await expect(scheduledRow).toHaveCount(0, { timeout: 15_000 });
    }

    // Its status settled to Cancelled — visible once the settled-history section
    // is expanded.
    await page.getByText(/Completed & cancelled/).click();
    const settledRow = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: "E2E dermatology visit" });
    await expect(settledRow).toContainText("Cancelled");

    // And it's gone from the Upcoming feed.
    await page.goto("/upcoming");
    await expect(
      page.locator(APPT_UPCOMING).filter({ hasText: "E2E dermatology visit" })
    ).toHaveCount(0);
  });
});

// #2234: the appointment day/time split. An appointment saved WITH a time and one
// saved WITHOUT are both real product states ("Time (optional)"), stored as the
// two columns `date` + `time_of_day` — never a folded string. Each test drives the
// real form end-to-end (save → stored halves → rendered row → re-opened edit
// form), which is the round-trip a user actually performs.
const TIMED_MARKER = "E2E day-time timed visit";
const DAY_ONLY_MARKER = "E2E day-time day-only visit";

// A future day relative to the run's frozen clock (never a fixed near-present
// date), as bare ISO.
function futureDay(daysAhead: number): string {
  return new Date(frozenNow().getTime() + daysAhead * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
}

// The stored halves for a marker title this spec created, straight from the
// worker's own database.
function storedHalves(title: string): {
  date: string;
  time_of_day: string | null;
} {
  const handle = new Database(workerDbPath());
  try {
    return handle
      .prepare(`SELECT date, time_of_day FROM appointments WHERE title = ?`)
      .get(title) as { date: string; time_of_day: string | null };
  } finally {
    handle.close();
  }
}

function cleanupDayTimeFixtures() {
  const handle = new Database(workerDbPath());
  try {
    handle
      .prepare(`DELETE FROM appointments WHERE title IN (?, ?)`)
      .run(TIMED_MARKER, DAY_ONLY_MARKER);
  } finally {
    handle.close();
  }
}

test.describe("Appointments — day + optional time round-trip (#2234)", () => {
  // Per-test cleanup (not just beforeAll) so a CI retry never sees its own
  // half-created marker row and trip the strict-mode row filter.
  test.beforeEach(cleanupDayTimeFixtures);
  test.afterAll(cleanupDayTimeFixtures);

  test("an appointment saved WITH a time stores, renders, and re-opens its clock", async ({
    page,
  }) => {
    test.slow();
    const day = futureDay(9);

    await page.goto("/records/history/visits");
    const upcoming = page.getByTestId("visits-upcoming");
    await expect(upcoming).toBeVisible();

    await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
    const dialog = page.getByRole("dialog", { name: "Add visit" });
    await dialog.getByLabel("Reason / title").fill(TIMED_MARKER);
    await dialog.getByLabel("Date", { exact: true }).fill(day);
    await dialog.getByLabel("Time (optional)").fill("14:30");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Appointment saved")).toBeVisible();

    // Stored as the two halves — the form submits date and time separately.
    const row = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: TIMED_MARKER });
    await expect(row).toBeVisible({ timeout: 15_000 });
    expect(storedHalves(TIMED_MARKER)).toEqual({
      date: day,
      time_of_day: "14:30",
    });

    // The row renders the wall clock exactly as entered.
    await expect(row).toContainText("14:30");

    // Re-open in the edit form: the time field carries the stored clock.
    await row.getByRole("button", { name: "Appointment actions" }).click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Edit" })
      .click();
    await expect(upcoming.getByLabel("Time (optional)")).toHaveValue("14:30");
    // The date field re-opens on the stored day (display shows the day + year).
    await expect(upcoming.getByLabel("Date", { exact: true })).toHaveValue(
      new RegExp(`\\b${Number(day.slice(8, 10))}, ${day.slice(0, 4)}$`)
    );
  });

  test("an appointment saved WITHOUT a time stays day-only end-to-end", async ({
    page,
  }) => {
    test.slow();
    const day = futureDay(10);

    await page.goto("/records/history/visits");
    const upcoming = page.getByTestId("visits-upcoming");
    await expect(upcoming).toBeVisible();

    await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
    const dialog = page.getByRole("dialog", { name: "Add visit" });
    await dialog.getByLabel("Reason / title").fill(DAY_ONLY_MARKER);
    await dialog.getByLabel("Date", { exact: true }).fill(day);
    // Time left blank on purpose — a day-only booking is a real state.
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Appointment saved")).toBeVisible();

    const row = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: DAY_ONLY_MARKER });
    await expect(row).toBeVisible({ timeout: 15_000 });
    expect(storedHalves(DAY_ONLY_MARKER)).toEqual({
      date: day,
      time_of_day: null,
    });

    // No invented clock anywhere on the rendered row.
    await expect(row).not.toContainText(/\d{1,2}:\d{2}/);

    // Re-open in the edit form: the time field is genuinely empty.
    await row.getByRole("button", { name: "Appointment actions" }).click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Edit" })
      .click();
    await expect(upcoming.getByLabel("Time (optional)")).toHaveValue("");
    await expect(upcoming.getByLabel("Date", { exact: true })).toHaveValue(
      new RegExp(`\\b${Number(day.slice(8, 10))}, ${day.slice(0, 4)}$`)
    );
  });
});

// The single "Add visit" entry (issue #566): one affordance that branches on
// tense instead of two separate add forms. These cases prove the branch selection
// only — the tense toggle swaps the appointment↔encounter shape, and the date the
// user enters routes to the matching shape — without saving anything (no DB
// mutation, so no fixture cleanup). The end-to-end save of each branch is covered
// by visits-lifecycle.spec (appointment) and encounters.spec (encounter).
test.describe("Visits — single Add visit entry (#566)", () => {
  test("the tense toggle swaps between the appointment and encounter branches", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/records/history/visits?new=1");
    const add = page.getByTestId("visits-add");
    await expect(add).toBeVisible();

    // Default branch is the appointment (future / scheduling) shape.
    await expect(add.getByLabel("Reason / title")).toBeVisible();
    await expect(add.getByLabel("Kind (optional)")).toBeVisible();
    await expect(add.getByLabel("Diagnoses")).toHaveCount(0);

    // "Already happened" reveals the encounter (past / clinical) shape.
    await add.getByTestId("visit-tense-past").click();
    await expect(add.getByLabel("Diagnoses")).toBeVisible();
    await expect(add.getByLabel("Reason (chief complaint)")).toBeVisible();
    await expect(add.getByLabel("Kind (optional)")).toHaveCount(0);

    // …and back to the appointment shape.
    await add.getByTestId("visit-tense-upcoming").click();
    await expect(add.getByLabel("Kind (optional)")).toBeVisible();
    await expect(add.getByLabel("Diagnoses")).toHaveCount(0);
  });

  test("a past date routes the entry to the encounter branch, a future date to the appointment branch", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/records/history/visits?new=1");
    const add = page.getByTestId("visits-add");
    await expect(add).toBeVisible();

    // Starts on the appointment branch; entering a clearly-past date flips the
    // entry to the encounter (clinical) shape — the "pick a date first" routing.
    await expect(add.getByLabel("Kind (optional)")).toBeVisible();
    await add.getByLabel("Date", { exact: true }).fill("2020-01-15");
    await expect(add.getByLabel("Diagnoses")).toBeVisible();

    // A clearly-future date flips it back to the appointment (scheduling) shape.
    await add.getByLabel("Date", { exact: true }).fill("2099-01-15");
    await expect(add.getByLabel("Kind (optional)")).toBeVisible();
  });
});
