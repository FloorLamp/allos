import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath, frozenNow } from "./worker-env";
import { settledClick } from "./helpers";

// Issue #1670, the rendered half: a weekly floor the profile has been under for four
// completed weeks is SUGGESTED for the cadence actually kept — or for the domain's own
// no-expectation state — on the surface that already owns that commitment. Accepting is
// the user's tap and nothing else, so each test asserts BOTH that the stored target
// really changed and that the suggestion cleared.
//
// Every test owns its fixture rows (unique names, deleted in `finally`) and asserts only
// on those, so nothing here depends on the shared seed's own targets — profile 1 seeds a
// practice and a food habit of its own, and either may legitimately be a candidate.
// Dates come from frozenNow(), never wall-clock.

const PRACTICE_NAME = "Rightsize Practice (e2e)";
const FOOD_GROUP = "berries";
const TRAINING_TYPE = "sport";

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

// The frozen run clock as a YYYY-MM-DD calendar day, `back` days earlier.
function dayBack(back: number): string {
  const d = frozenNow();
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

// Days that land EXACTLY ONE per completed week whatever the profile's week mode and
// week-start day happen to be. Any window of seven consecutive days contains exactly one
// member of a 7-periodic set, so a fixture built on this spacing is deterministic without
// touching the profile's week settings (which other specs share this worker DB with).
const ONE_PER_WEEK = [1, 8, 15, 22, 29, 36].map(dayBack);

// A target created long before the detector's window opens — `created_at` is set
// explicitly because the column's default is SQLite's own clock, which the frozen run
// clock does not move, and a defaulted row would read as younger than the window.
function seedTarget(
  db: Database.Database,
  kind: string,
  value: string,
  floor: number
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO frequency_targets
           (profile_id, scope_kind, scope_value, scope_identity, per_week, created_at)
         VALUES (1, ?, ?, ?, ?, ?)`
      )
      .run(
        kind,
        value,
        kind === "practice" ? value.toLowerCase() : null,
        floor,
        `${dayBack(120)} 08:00:00`
      ).lastInsertRowid
  );
}

function dropTarget(db: Database.Database, id: number | null): void {
  if (id == null) return;
  db.prepare("DELETE FROM frequency_targets WHERE id = ?").run(id);
  db.prepare("DELETE FROM upcoming_dismissals WHERE signal_key LIKE ?").run(
    `right-size:${id}%`
  );
  db.prepare("DELETE FROM upcoming_dismissals WHERE signal_key = ?").run(
    `practice:${id}`
  );
}

function floorOf(db: Database.Database, id: number): number | null {
  const row = db
    .prepare("SELECT per_week FROM frequency_targets WHERE id = ?")
    .get(id) as { per_week: number } | undefined;
  return row?.per_week ?? null;
}

test("a chronically under-floor practice is offered its own cadence, and accepting lowers it (#1670)", async ({
  page,
}) => {
  const db = openDb();
  let targetId: number | null = null;
  try {
    targetId = seedTarget(db, "practice", PRACTICE_NAME, 4);
    const logs = db.prepare(
      "INSERT INTO practice_logs (profile_id, practice, date) VALUES (1, ?, ?)"
    );
    for (const date of ONE_PER_WEEK) logs.run(PRACTICE_NAME, date);

    await page.goto("/wellness");
    const card = page
      .getByTestId("right-size-item")
      .filter({ hasText: PRACTICE_NAME });
    await expect(card).toBeVisible();
    // The suggestion states the declared target and the cadence actually kept, and
    // offers exactly the number that makes the observed window true.
    await expect(card).toContainText("4×");
    const lower = card.getByTestId("right-size-lower");
    await expect(lower).toHaveText("Lower to 1× a week");

    await settledClick(page, lower);

    // The suggestion cleared itself: every week in its window now clears the new
    // floor, so there is nothing left to suggest. No dismissal was needed.
    await expect(
      page.getByTestId("right-size-item").filter({ hasText: PRACTICE_NAME })
    ).toHaveCount(0);
    // The stored commitment really moved — the user's tap is the write.
    expect(floorOf(db, targetId)).toBe(1);
    // The practice keeps its card and its sessions.
    await expect(
      page
        .getByTestId("wellness-practice-card")
        .filter({ hasText: PRACTICE_NAME })
    ).toBeVisible();
  } finally {
    db.prepare("DELETE FROM practice_logs WHERE practice = ?").run(
      PRACTICE_NAME
    );
    dropTarget(db, targetId);
    db.close();
  }
});

test("accepting a practice suggestion's stop lands in the logs-only state (#1670)", async ({
  page,
}) => {
  const db = openDb();
  const name = `${PRACTICE_NAME} stop`;
  let targetId: number | null = null;
  try {
    targetId = seedTarget(db, "practice", name, 4);
    const logs = db.prepare(
      "INSERT INTO practice_logs (profile_id, practice, date) VALUES (1, ?, ?)"
    );
    for (const date of ONE_PER_WEEK) logs.run(name, date);

    await page.goto("/wellness");
    const card = page.getByTestId("right-size-item").filter({ hasText: name });
    await expect(card).toBeVisible();
    await settledClick(page, card.getByTestId("right-size-stop"));

    // The weekly goal is gone; the practice and every logged session are not.
    await expect(
      page.getByTestId("right-size-item").filter({ hasText: name })
    ).toHaveCount(0);
    expect(floorOf(db, targetId)).toBeNull();
    const practiceCard = page
      .getByTestId("wellness-practice-card")
      .filter({ hasText: name });
    await expect(practiceCard).toBeVisible();
    await expect(practiceCard).toContainText("Session history only");
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM practice_logs WHERE profile_id = 1 AND practice = ?"
        )
        .get(name)
    ).toEqual({ n: ONE_PER_WEEK.length });
  } finally {
    db.prepare("DELETE FROM practice_logs WHERE practice = ?").run(name);
    dropTarget(db, targetId);
    db.close();
  }
});

test("a chronically under-floor food habit can be untracked without touching the food log (#1670)", async ({
  page,
}) => {
  const db = openDb();
  let targetId: number | null = null;
  try {
    targetId = seedTarget(db, "food_group", FOOD_GROUP, 10);
    const logs = db.prepare(
      "INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (1, ?, ?, 1)"
    );
    for (const date of ONE_PER_WEEK) logs.run(date, FOOD_GROUP);

    await page.goto("/nutrition?tab=food");
    const card = page
      .getByTestId("right-size-item")
      .filter({ hasText: "Berries" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("food log");
    await settledClick(page, card.getByTestId("right-size-stop"));

    // The habit has left the weekly-habits list…
    await expect(
      page.getByTestId("weekly-habits").getByTestId(`habit-${FOOD_GROUP}`)
    ).toHaveCount(0);
    expect(floorOf(db, targetId)).toBeNull();
    // …and the record of what was actually eaten is exactly as it was.
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM food_log WHERE profile_id = 1 AND group_key = ?"
        )
        .get(FOOD_GROUP)
    ).toEqual({ n: ONE_PER_WEEK.length });
  } finally {
    db.prepare(
      "DELETE FROM food_log WHERE profile_id = 1 AND group_key = ?"
    ).run(FOOD_GROUP);
    dropTarget(db, targetId);
    db.close();
  }
});

test("a chronically under-floor training routine is offered its own cadence, and Keep as is only hides it (#1670)", async ({
  page,
}) => {
  const db = openDb();
  let targetId: number | null = null;
  try {
    targetId = seedTarget(db, "type", TRAINING_TYPE, 4);
    const acts = db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, source)
       VALUES (1, ?, ?, 'Rightsize session (e2e)', 'manual')`
    );
    for (const date of ONE_PER_WEEK) acts.run(date, TRAINING_TYPE);

    await page.goto("/training?tab=goals");
    const card = page
      .getByTestId("right-size-item")
      .filter({ hasText: "Sport" });
    await expect(card).toBeVisible();
    await expect(card.getByTestId("right-size-lower")).toHaveText(
      "Lower to 1× a week"
    );

    // "Keep as is" is the calm half of the coaching contract: it hides the card and
    // leaves the commitment exactly where the user put it.
    await settledClick(page, card.getByTestId("right-size-dismiss"));
    await expect(
      page.getByTestId("right-size-item").filter({ hasText: "Sport" })
    ).toHaveCount(0);
    expect(floorOf(db, targetId)).toBe(4);
  } finally {
    db.prepare(
      "DELETE FROM activities WHERE profile_id = 1 AND title = 'Rightsize session (e2e)'"
    ).run();
    dropTarget(db, targetId);
    db.close();
  }
});
