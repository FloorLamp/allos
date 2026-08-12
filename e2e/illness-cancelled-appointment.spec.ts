import Database from "better-sqlite3";
import { test, expect } from "./fixtures";
import { workerDbPath } from "./worker-env";

// A CANCELLED appointment inside an illness episode's window renders AS cancelled
// (#2136). Before this, every appointment in the window mapped to
// "Appointment · «title» scheduled" whatever its status, so a visit the user
// cancelled appeared on the clinical record as care that happened.
//
// The ruling asserted here is deliberately not "hide it": the row is real history —
// the visit that fell through is often exactly why an illness ran on unseen — so it
// stays visible, and it is the CLAIM that is fixed. That is the same posture
// hasNoCurrentReading takes one domain over: keep the value, fix what the surface says
// about it.
//
// FIXTURE OWNERSHIP (#868): this spec inserts and removes its OWN two appointments,
// titled distinctively, and never counts the seed's rows. Profile 1's open illness
// episode covers today, so both land inside its window.
//
// SYNTHETIC ONLY: invented appointment titles. No PHI.

const CANCELLED_TITLE = "Fictional cancelled follow-up";
const SCHEDULED_TITLE = "Fictional nurse check";

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

// The day the fixture rows are dated. NOT a wall-clock "today": the episode window is
// a pair of profile-LOCAL days, so the open episode's own start day is the one day
// guaranteed to be inside it whatever the profile's timezone is. `appointments.date` is
// a plain clinic-local calendar day (#2234) and is never resolved against a zone, so
// there is no instant to convert here.
function episodeStartDay(): string {
  return withDb(
    (db) =>
      (
        db
          .prepare(
            `SELECT start_date FROM illness_episodes
              WHERE profile_id = 1 AND end_date IS NULL
              ORDER BY id DESC LIMIT 1`
          )
          .get() as { start_date: string }
      ).start_date
  );
}

function removeOwnRows(): void {
  withDb((db) => {
    db.prepare("DELETE FROM appointments WHERE title IN (?, ?)").run(
      CANCELLED_TITLE,
      SCHEDULED_TITLE
    );
  });
}

test.beforeEach(() => {
  removeOwnRows();
  const day = episodeStartDay();
  withDb((db) => {
    const insert = db.prepare(
      `INSERT INTO appointments (profile_id, date, time_of_day, title, status)
       VALUES (1, ?, ?, ?, ?)`
    );
    insert.run(day, "08:30", CANCELLED_TITLE, "cancelled");
    insert.run(day, "08:45", SCHEDULED_TITLE, "scheduled");
  });
});

test.afterAll(() => removeOwnRows());

test("a cancelled appointment shows on the episode timeline as cancelled", async ({
  page,
}) => {
  await page.goto("/medical/episodes");
  const ongoing = page
    .getByTestId("episode-index-row")
    .filter({ hasText: /ongoing/i })
    .first(); // first-ok: the fixture's own ongoing episode (filtered) — order-agnostic
  const href = await ongoing.getAttribute("href");
  expect(href).toMatch(/^\/medical\/episodes\/\d+$/);
  await page.goto(href!);

  const timeline = page.getByTestId("episode-illness-timeline");
  await expect(timeline).toBeVisible();

  // The row is PRESENT — hiding a real appointment would make a cancelled visit
  // indistinguishable from one that was never booked.
  const cancelled = timeline
    .getByTestId("illness-event-appointment")
    .filter({ hasText: CANCELLED_TITLE });
  await expect(cancelled).toBeVisible();
  // …and it says so, rather than reading as care that took place.
  await expect(cancelled).toContainText("Appointment cancelled");
  await expect(cancelled).not.toContainText("scheduled");

  // The still-scheduled sibling is untouched by the change.
  const scheduled = timeline
    .getByTestId("illness-event-appointment")
    .filter({ hasText: SCHEDULED_TITLE });
  await expect(scheduled).toBeVisible();
  await expect(scheduled).not.toContainText("cancelled");
});
