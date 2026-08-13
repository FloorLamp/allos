import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { followLink } from "./helpers";
import { frozenNow, workerDbPath } from "./worker-env";

// Issue #2179: the annual retrospective — a rendered, user-initiated "year in health"
// page at `scale: "year"` over the existing recap engine, whose one declared difference
// is the COMMEMORATIVE EXEMPTION: a raw count is allowed as a RECORD, and in exchange
// carries no comparison at all.
//
// THE SPEC OWNS ITS DATA, and it has to. The seed's training history spans about
// sixteen weeks, so the calendar years this page is really about — a whole closed one,
// and the one before it as its comparison — hold nothing at all. Two years back is far
// outside every seeded window (and outside every quick range on Trends and Training),
// so the fixture writes there and deletes exactly what it wrote.
//
// The comparison year is populated ON PURPOSE. With four sessions sitting in the prior
// year, the workouts line's SILENCE is a decision the page made rather than an absence
// of data — and the training-mix line right beside it, which is a trajectory and keeps
// its comparison, proves the prior year really was loaded.
//
// `activities.date` is a profile-local DAY column, not an instant, so a plain day
// string is what it means and there is no zone conversion at this door.

const SEED_PROFILE = 1;

// Two years back: past the seed's ~16-week training history by an order of magnitude.
const SUBJECT_YEAR = frozenNow().getUTCFullYear() - 2;
const PRIOR_YEAR = SUBJECT_YEAR - 1;

// Distinct enough that the cleanup below cannot touch a neighbour's row.
const TITLE = "retro spec session";

const SUBJECT_DATES = [
  `${SUBJECT_YEAR}-02-04`,
  `${SUBJECT_YEAR}-04-08`,
  `${SUBJECT_YEAR}-06-10`,
  `${SUBJECT_YEAR}-08-12`,
  `${SUBJECT_YEAR}-10-14`,
  `${SUBJECT_YEAR}-11-18`,
];
// March, deliberately NOT January: it makes PRIOR_YEAR the profile's first year AND a
// partial one, which is the "since March, when your data begins" case.
const PRIOR_DATES = [
  `${PRIOR_YEAR}-03-05`,
  `${PRIOR_YEAR}-05-07`,
  `${PRIOR_YEAR}-07-09`,
  `${PRIOR_YEAR}-09-11`,
];

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

function seedYears(): void {
  withDb((db) => {
    const insert = db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, ?, 'strength', ?, 45)`
    );
    for (const date of [...SUBJECT_DATES, ...PRIOR_DATES])
      insert.run(SEED_PROFILE, date, TITLE);
  });
}

// Leave the shared profile as it was found — the rows are addressed by the spec's own
// title, so a neighbour's activity on the same day is untouched.
function clearYears(): void {
  withDb((db) => {
    db.prepare("DELETE FROM activities WHERE profile_id = ? AND title = ?").run(
      SEED_PROFILE,
      TITLE
    );
  });
}

test.beforeAll(() => {
  clearYears();
  seedYears();
});
test.afterAll(() => clearYears());

test("the retrospective states the year's count as a record, with no comparison (#2179)", async ({
  page,
}) => {
  await page.goto(`/retrospective?year=${SUBJECT_YEAR}`);

  await expect(
    page.getByRole("heading", { name: `${SUBJECT_YEAR} in review` })
  ).toBeVisible();
  await expect(page.getByTestId("retrospective-range")).toContainText(
    String(SUBJECT_YEAR)
  );

  const workouts = page.locator(
    '[data-testid="retrospective-line"][data-line="workouts"]'
  );
  await expect(workouts).toBeVisible();
  await expect(workouts.getByTestId("retrospective-line-value")).toHaveText(
    String(SUBJECT_DATES.length)
  );
  // THE EXEMPTION'S PRICE. Four sessions sit in the prior year; a build without the
  // exemption would render "4 last year" right here.
  await expect(workouts).not.toContainText("last year");

  // …and the prior year IS loaded, which is what makes that absence meaningful: the
  // trajectory line beside it compares against exactly those four sessions.
  const mix = page.locator(
    '[data-testid="retrospective-line"][data-line="training-mix"]'
  );
  await expect(mix).toBeVisible();
  await expect(mix).toContainText("last year");

  // The commemorative headline the genre exists for.
  await expect(page.getByTestId("retrospective-headline")).toContainText(
    `${SUBJECT_DATES.length} workouts`
  );
});

test("the year picker moves between years and the first year says where the data begins (#2179)", async ({
  page,
}) => {
  await page.goto(`/retrospective?year=${SUBJECT_YEAR}`);

  const priorSegment = page.getByTestId(`retrospective-year-${PRIOR_YEAR}`);
  await followLink(page, priorSegment, new RegExp(`year=${PRIOR_YEAR}`));

  await expect(
    page.getByRole("heading", { name: `${PRIOR_YEAR} in review` })
  ).toBeVisible();
  await expect(priorSegment).toHaveAttribute("aria-current", "page");

  // The first year with data is a PARTIAL year, and the page says so rather than
  // letting four sessions imply twelve months.
  await expect(page.getByTestId("retrospective-coverage")).toContainText(
    "when your data begins"
  );
  await expect(
    page
      .locator('[data-testid="retrospective-line"][data-line="workouts"]')
      .getByTestId("retrospective-line-value")
  ).toHaveText(String(PRIOR_DATES.length));
});
