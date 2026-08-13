import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { openLogSheet } from "./log-sheet-helpers";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_SHELL,
  E2E_MEMBER_PASSWORD,
  SHELL_PROFILE,
} from "./fixture-logins";
import { frozenNow, workerDbPath } from "./worker-env";
import { LOG_HABIT_MIN_DAYS } from "@/lib/log-sheet";

// THE DASHBOARD'S LOG SHEET OPENS WHERE THIS PROFILE ACTUALLY LOGS (issue #2709).
//
// Every other route either promotes its own domain (`/nutrition` → Food) or falls
// through to the historical "Log activity" answer. The dashboard promoted nothing,
// so the sheet opened on Train there and logging food from home cost two taps —
// on the surface people are on most. The owner's ruling (2026-08-13) is that it
// opens instead on the profile's MOST-LOGGED domain, measured as days-logged over
// the trailing quarter.
//
// ── WHY THIS SPEC OWNS ITS HISTORY, AND CAN ──────────────────────────────────
//
// The opening segment is a function of a whole profile's ledgers, which is the
// one thing a shared-seed assertion can never own (#868). So it runs on the
// Mobile Shell fixture — a dedicated write-granted login on an otherwise-empty
// profile — and writes the history it asserts on, then removes it.
//
// The no-history half is robust for a structural reason rather than a hopeful
// one: the measure has an evidence FLOOR of `LOG_HABIT_MIN_DAYS` logged days, and
// a neighbour spec logging on this fixture logs TODAY, so it can move any segment
// by at most one day. Nothing short of a week of days can reach the floor, which
// is exactly the churn property the ruling asked for, asserted rather than
// asserted-about.
//
// A raw context from loginAs does NOT inherit the `mobile` project's `use` block,
// so the phone viewport has to be restated or this silently runs at desktop width
// where neither the dock nor its sheet renders at all.
const PHONE_CONTEXT = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
} as const;

// Comfortably past the floor, so a neighbour's same-day write cannot change the
// answer either way.
const FOOD_DAYS = LOG_HABIT_MIN_DAYS + 5;

// A group nothing else on this fixture logs, so the rows this spec removes are
// exactly the rows it wrote.
const FIXTURE_GROUP = "leafy_greens";

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

// The days this spec writes on: a run of recent days, each far enough inside the
// 90-day window that a timezone fold cannot push one out of it.
function fixtureDates(): string[] {
  return Array.from({ length: FOOD_DAYS }, (_, i) => {
    const d = new Date(frozenNow());
    d.setUTCDate(d.getUTCDate() - (i + 2));
    return d.toISOString().slice(0, 10);
  });
}

function profileId(db: Database.Database): number {
  return (
    db.prepare("SELECT id FROM profiles WHERE name = ?").get(SHELL_PROFILE) as {
      id: number;
    }
  ).id;
}

// Write a run of food servings on PAST days and remove exactly those rows again.
// Never a blanket delete, and never today: the neighbouring spec logs this group's
// siblings on the frozen today and reads that day's totals back.
function setFoodHistory(present: boolean): void {
  const db = openDb();
  try {
    const id = profileId(db);
    const insert = db.prepare(
      `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
         ON CONFLICT (profile_id, date, group_key) DO NOTHING`
    );
    const remove = db.prepare(
      "DELETE FROM food_log WHERE profile_id = ? AND date = ? AND group_key = ?"
    );
    for (const date of fixtureDates()) {
      if (present) insert.run(id, date, FIXTURE_GROUP);
      else remove.run(id, date, FIXTURE_GROUP);
    }
  } finally {
    db.close();
  }
}

// The segment the track reports as selected, without touching it.
async function openingSegment(page: Page): Promise<string | null> {
  const sheet = await openLogSheet(page);
  const track = sheet.getByTestId("log-sheet-segments");
  await expect(track).toBeVisible();
  const selected = track.locator('[aria-pressed="true"]');
  await expect(selected).toHaveCount(1);
  return selected.getAttribute("data-testid");
}

test.describe("the dashboard sheet's opening segment (#2709)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(
      browser,
      { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
      PHONE_CONTEXT
    );
  });

  test.beforeEach(() => {
    setFoodHistory(false);
  });

  test.afterAll(async () => {
    setFoodHistory(false);
    await page.close();
  });

  test("falls back to the historical answer while there is no habit to read", async () => {
    // The ruling's required no-history fallback: exactly what the sheet did
    // before #2709, so a brand-new profile sees no adaptive behaviour at all.
    await page.goto("/");
    expect(await openingSegment(page)).toBe("log-sheet-segment-train");
  });

  test("opens on the domain this profile logs on the most days", async () => {
    setFoodHistory(true);
    await page.goto("/");
    expect(await openingSegment(page)).toBe("log-sheet-segment-food");

    // …and the segment is genuinely selected, not merely marked: its row is the
    // one under the thumb, with no segment tap spent. This is #2709's own
    // complaint answered — logging food from home is one tap again.
    const sheet = page.getByTestId("quick-log-sheet");
    await expect(sheet.getByTestId("quick-log-log-food")).toBeVisible();
    await expect(sheet.getByTestId("quick-log-log-activity")).toHaveCount(0);
  });

  test("changes nothing on a route that promotes its own domain", async () => {
    // The ruling's stated scope. Medications promotes doses however heavily this
    // profile has been logging food, because the page you are standing on is
    // better evidence about the next tap than a quarter of history.
    setFoodHistory(true);
    await page.goto("/medications");
    expect(await openingSegment(page)).toBe("log-sheet-segment-care");
  });
});
