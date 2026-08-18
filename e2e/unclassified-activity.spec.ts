import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";
import { loginAs } from "./nav";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// An UNCLASSIFIED activity is a real, rendered row (#2272).
//
// When a provider declines to classify a session — Health Connect's
// EXERCISE_TYPE_OTHER_WORKOUT means "a workout, unspecified" — the row now says so
// instead of asserting a `sport` nobody claimed. That value has to be a first-class
// citizen of the surfaces, not a hole in them, and the two ways it could silently
// become one are exactly what this spec covers:
//
//   • the ICON. `TYPE_FALLBACK` was `Record<string, …>` with a `?? "activity"`, so a
//     new type took the generic glyph with nothing failing. It still takes the generic
//     glyph here — but by DECLARATION, because a barbell or a medal would re-assert
//     the very claim the type withholds.
//   • the FILTER. The Training Log's type chips were hand-listed, so a type with no chip is
//     an unfilterable row: it renders in the feed and the filter bar cannot name it.
//
// `DURATION_ACTIVITY_TYPES` renders the SQL that Timeline, the sidebar calendar
// and Search share, so an omission would make a profile's own imported workout
// vanish from three surfaces at once. The child fixture proves those reads remain
// age-neutral.
//
// Fixture ownership (#868): every planted row carries a unique marker and is deleted
// in beforeAll/afterAll. Deep-past dates, synthetic values, no shared seed row touched.

const DB_PATH = workerDbPath();

// Deep past on purpose: the sample seed writes ~3 weeks of relative-date rows, so a
// 2017 date can never collide with one however the frozen clock moves.
const MARKER = "Unspecified Session Marker";
const OWN_DATE = "2017-05-09";
const OWN_TITLE = `${MARKER} adult`;
const CHILD_DATE = "2017-05-10";
const CHILD_TITLE = `${MARKER} child`;

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

function cleanup() {
  withDb((db) => {
    db.prepare("DELETE FROM activities WHERE title LIKE ?").run(`${MARKER}%`);
  });
}

test.beforeAll(() => {
  cleanup();
  withDb((db) => {
    const childProfile = db
      .prepare("SELECT id FROM profiles WHERE name LIKE 'Riley%'")
      .get() as { id: number } | undefined;
    const ins = db.prepare(
      `INSERT INTO activities
         (profile_id, date, type, title, duration_min, source, external_id)
       VALUES (?, ?, 'unclassified', ?, ?, 'health-connect', ?)`
    );
    // The reported shape: an hour with no distance, no HR, and no stated type.
    ins.run(1, OWN_DATE, OWN_TITLE, 60, `health-connect:${OWN_TITLE}`);
    if (childProfile)
      ins.run(
        childProfile.id,
        CHILD_DATE,
        CHILD_TITLE,
        45,
        `health-connect:${CHILD_TITLE}`
      );
  });
});

test.afterAll(() => {
  cleanup();
});

test("an unspecified import renders with the generic glyph and is filterable (#2272)", async ({
  page,
}) => {
  await page.goto("/training?tab=log");

  const search = page.getByPlaceholder("Search activities or exercises…");
  await expect(search).toBeVisible();
  await search.fill(OWN_TITLE);

  // The Server-Action round-trip ceiling used across the training log specs.
  // The feed renders slim rows (#2897); the row itself carries the type glyph.
  const row = page
    .getByTestId("training-log-row")
    .filter({ hasText: OWN_TITLE });
  await expect(row).toBeVisible({ timeout: 20_000 });

  // The DECLARED glyph for "the source did not say" — generic, never a barbell or a
  // medal. `data-icon` is the icon KEY, so this reads the resolution, not a class name.
  const glyph = row.getByTestId("activity-icon");
  await expect(glyph).toHaveAttribute("data-icon", "activity");

  // The type chips can NAME this row. Without a chip it would be visible and
  // unfilterable at the same time — present in the feed, absent from the filter bar.
  const chips = page.getByRole("group", { name: "Activity type" });
  await chips.getByRole("button", { name: "Unspecified" }).click();
  await expect(
    page.getByTestId("training-log-row").filter({ hasText: OWN_TITLE })
  ).toBeVisible({
    timeout: 20_000,
  });

  // …and it is a real filter, not a no-op: switching to Cardio drops the row.
  await chips.getByRole("button", { name: "Cardio" }).click();
  await expect(
    page.getByTestId("training-log-row").filter({ hasText: OWN_TITLE })
  ).toHaveCount(0, {
    timeout: 20_000,
  });
});

test("a minor still sees its own unspecified session (#3067/#2272)", async ({
  browser,
}) => {
  test.slow();
  // Every activity type is age-neutral and remains visible across activity surfaces.
  const member = await loginAs(browser, {
    username: E2E_LOGIN_CHILD,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await member.goto(`/timeline?from=${CHILD_DATE}&to=${CHILD_DATE}`);
    const row = member.getByText(CHILD_TITLE).first(); // first-ok: the ONLY row on this deep-past single-day view is the one this spec planted
    await expect(row).toBeVisible({ timeout: 20_000 });
  } finally {
    await member.context().close();
  }
});
