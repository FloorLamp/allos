import { test, expect, type Browser, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_HHHIST,
  E2E_LOGIN_HHHIST_RO,
  E2E_LOGIN_CHILD,
  HH_HISTORY_PARENT_PROFILE,
  HH_HISTORY_CHILD_PROFILE,
} from "./fixture-logins";

// The merged household visit + illness history (issue #1009). Against the seeded
// household-history fixtures (a caregiver granted a well parent + a currently-sick
// child, each carrying past visits + illness episodes — see e2e/seed-events.ts):
//   1. the merged timeline renders both people's rows, and the per-person toggle
//      narrows to one person;
//   2. the dashboard promotion link appears while a member is currently sick, and the
//      widen-to-household links render on Visits + Illness episodes;
//   3. the episode page shows the household-context card for an overlapping episode
//      and omits it for a lonely one;
//   4. a single-accessible-profile login sees NO household affordances and is bounced
//      off /household/history;
//   5. a read-only caregiver still reads the merged history.
// The default specs run as admin (storageState); these sign in as the seeded member
// logins in fresh, cookie-less contexts.

function dbHandle(): Database.Database {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  return db;
}

// The stable episode ROW id for a fixture profile's named situation — so the spec can
// navigate straight to its /medical/episodes/[id] page without guessing.
function episodeId(profileName: string, situation: string): number {
  const db = dbHandle();
  try {
    const row = db
      .prepare(
        `SELECT e.id AS id FROM illness_episodes e
           JOIN profiles p ON p.id = e.profile_id
          WHERE p.name = ? AND e.situation = ?
          ORDER BY e.id DESC LIMIT 1`
      )
      .get(profileName, situation) as { id: number } | undefined;
    if (!row) throw new Error(`no episode ${situation} for ${profileName}`);
    return row.id;
  } finally {
    db.close();
  }
}

async function loginAs(
  browser: Browser,
  username: string
): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', E2E_MEMBER_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 20_000,
  });
  return { page, close: () => ctx.close() };
}

test.describe("Household visit + illness history (issue #1009)", () => {
  test("a multi-profile caregiver sees the merged timeline, per-person toggle, promotion, and widen links", async ({
    browser,
  }) => {
    test.slow();
    const { page, close } = await loginAs(browser, E2E_LOGIN_HHHIST);

    // Merged view: reachable via the Household header, both profiles present as filter
    // chips, and rows for both people.
    await page.goto("/household/history");
    await expect(page.getByTestId("household-history-list")).toBeVisible();
    await expect(
      page.getByTestId("household-history-filter-all")
    ).toBeVisible();
    // Two accessible profiles → two per-person filter chips beside "Everyone".
    const chips = page
      .getByTestId("household-history-filter")
      .getByRole("button");
    await expect(chips).toHaveCount(3);

    // Rows are tagged by person — both the parent's and the child's appear.
    const rows = page.getByTestId("household-history-row");
    const parentRows = rows.filter({ hasText: HH_HISTORY_PARENT_PROFILE });
    const childRows = rows.filter({ hasText: HH_HISTORY_CHILD_PROFILE });
    await expect(parentRows.first()).toBeVisible();
    await expect(childRows.first()).toBeVisible();

    // Per-person toggle: filter to the child → only the child's rows remain.
    const childChip = page
      .getByTestId("household-history-filter")
      .getByRole("button", { name: HH_HISTORY_CHILD_PROFILE });
    await childChip.click();
    await expect(childRows.first()).toBeVisible();
    await expect(parentRows).toHaveCount(0);

    // Dashboard promotion: the household is currently sick (the child's open Cold), so
    // the calm promotion link surfaces.
    await page.goto("/");
    await expect(page.getByTestId("household-history-promo")).toBeVisible();

    // Widen-to-household links on the per-person history surfaces.
    await page.goto("/encounters");
    await expect(page.getByTestId("household-view-link")).toBeVisible();
    await page.goto("/medical/episodes");
    await expect(page.getByTestId("household-view-link")).toBeVisible();

    await close();
  });

  test("the episode page shows the household-context card for an overlapping episode and omits it for a lonely one", async ({
    browser,
  }) => {
    test.slow();
    const { page, close } = await loginAs(browser, E2E_LOGIN_HHHIST);

    // The child's Flu overlaps the parent's Flu → the card shows, naming the parent.
    const overlappingId = episodeId(HH_HISTORY_CHILD_PROFILE, "Flu");
    await page.goto(`/medical/episodes/${overlappingId}`);
    const card = page.getByTestId("episode-household-context");
    await expect(card).toBeVisible();
    await expect(card).toContainText(HH_HISTORY_PARENT_PROFILE);
    await expect(card).toContainText("overlapped");

    // The parent's far-past Chickenpox overlaps nobody → no card (not an empty shell).
    const lonelyId = episodeId(HH_HISTORY_PARENT_PROFILE, "Chickenpox");
    await page.goto(`/medical/episodes/${lonelyId}`);
    await expect(page.getByTestId("episode-household-context")).toHaveCount(0);

    await close();
  });

  test("a single-profile login sees no household affordances and is bounced off the history URL", async ({
    browser,
  }) => {
    test.slow();
    // E2E_LOGIN_CHILD's sole profile is Riley → no household.
    const { page, close } = await loginAs(browser, E2E_LOGIN_CHILD);

    await page.goto("/encounters");
    await expect(page.getByTestId("household-view-link")).toHaveCount(0);
    await page.goto("/medical/episodes");
    await expect(page.getByTestId("household-view-link")).toHaveCount(0);

    // The page's own server gate bounces a direct visit to the dashboard.
    await page.goto("/household/history");
    await page.waitForURL((u) => u.pathname === "/", { timeout: 20_000 });

    await close();
  });

  test("a read-only caregiver still reads the merged household history", async ({
    browser,
  }) => {
    test.slow();
    const { page, close } = await loginAs(browser, E2E_LOGIN_HHHIST_RO);

    await page.goto("/household/history");
    await expect(page.getByTestId("household-history-list")).toBeVisible();
    await expect(
      page.getByTestId("household-history-row").first()
    ).toBeVisible();

    await close();
  });
});
