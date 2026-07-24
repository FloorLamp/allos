import { test, expect, type Browser, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { settledClick, followLink } from "./helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_HHHIST,
  E2E_LOGIN_HHHIST_RO,
  E2E_LOGIN_CHILD,
  HH_HISTORY_PARENT_PROFILE,
  HH_HISTORY_CHILD_PROFILE,
} from "./fixture-logins";

// The consolidated care-trail surface (#1373 Part 2): /medical/episodes BECAME the
// view-set-driven household illness + visit trail (superseding the removed
// /household/history). Against the seeded household-history fixtures (a caregiver granted
// a well parent + a currently-sick child, the child's Cold carrying a LINKED urgent-care
// visit + a prescribed Amoxicillin course — see e2e/seed-events.ts):
//   1. single-view shows the acting profile's episodes; toggling the child INTO the view
//      (the #1096 session-global view-set) merges both members, the swimlane band + stats
//      strip appear, the child's Cold nests its linked visit + course (chain shown), and
//      the ?kind= toggle reveals the unlinked routine visit only in illness+visits;
//   2. the episode page still shows the household-context card for an overlapping episode
//      and omits it for a lonely one;
//   3. a single-profile login has no household affordances and reads its own episodes
//      (the old /household/history bounce is gone — the route no longer exists);
//   4. a read-only caregiver still reads the merged trail.
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

function profileId(name: string): number {
  const db = dbHandle();
  try {
    const row = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(name) as { id: number } | undefined;
    if (!row) throw new Error(`no profile ${name}`);
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

// Toggle a profile INTO the session view-set via the profile menu's eye toggle (the
// #1096 mechanism the banner drives). The view-set persists on the session, so a later
// navigation reloads multi-view.
async function addToView(page: Page, targetProfileId: number): Promise<void> {
  const trigger = page.getByTestId("user-menu-trigger");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.getByTestId("user-menu-popover")).toBeVisible();
  await settledClick(page, page.getByTestId(`view-toggle-${targetProfileId}`));
  await expect(page.getByTestId("profile-view-strip")).toBeVisible();
}

test.describe("Care-trail surface (#1373 Part 2)", () => {
  test("caregiver merges the view-set → band, stats, nested linked visit + course, kind toggle", async ({
    browser,
  }) => {
    test.slow();
    const { page, close } = await loginAs(browser, E2E_LOGIN_HHHIST);
    const childId = profileId(HH_HISTORY_CHILD_PROFILE);

    // Single-view default: the acting parent's episodes, the kind toggle, no view strip.
    await page.goto("/medical/episodes");
    await expect(page.getByTestId("care-trail-kind-toggle")).toBeVisible();
    await expect(page.getByTestId("care-trail-list")).toBeVisible();
    await expect(page.getByTestId("profile-view-strip")).toHaveCount(0);
    // The child's Cold is not in view yet.
    await expect(
      page.getByTestId("care-trail-row").filter({ hasText: "Cold" })
    ).toHaveCount(0);

    // Toggle the child into the view → merged trail.
    await addToView(page, childId);
    await page.goto("/medical/episodes");

    // Multi-view chrome: the swimlane band with two lanes + the per-member stats strip.
    await expect(page.getByTestId("care-trail-band")).toBeVisible();
    await expect(page.getByTestId("care-trail-lane")).toHaveCount(2);
    await expect(page.getByTestId("care-trail-stats")).toBeVisible();

    // The child's Cold nests its LINKED urgent-care visit + the prescribed course, with
    // the provable prescriber↔visit chain.
    const coldRow = page
      .getByTestId("care-trail-row")
      .filter({ hasText: "Cold" });
    await expect(coldRow).toBeVisible();
    await expect(coldRow.getByTestId("care-trail-link-count")).toContainText(
      "1 linked visit"
    );
    await expect(coldRow.getByTestId("care-trail-linked-visit")).toContainText(
      "Urgent care"
    );
    const course = coldRow.getByTestId("care-trail-course");
    await expect(course).toContainText("Amoxicillin");
    await expect(course.getByTestId("care-trail-course-chain")).toContainText(
      "prescribed at the"
    );

    // Illness mode hides the unlinked routine visits (no standalone visit rows).
    await expect(
      page.locator('[data-testid="care-trail-row"][data-kind="visit"]')
    ).toHaveCount(0);

    // illness+visits reveals the unlinked routine visits as standalone rows.
    await followLink(
      page,
      page.getByTestId("care-trail-kind-visits"),
      /kind=visits/
    );
    await expect(
      page.locator('[data-testid="care-trail-row"][data-kind="visit"]').first() // first-ok: asserts an unlinked standalone visit row now renders — order-agnostic presence
    ).toBeVisible();
    // The linked urgent-care visit STAYS nested (never a standalone row) in both modes.
    await expect(coldRow.getByTestId("care-trail-linked-visit")).toContainText(
      "Urgent care"
    );

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

  test("a single-profile login has no household affordances and reads its own episodes", async ({
    browser,
  }) => {
    test.slow();
    // E2E_LOGIN_CHILD's sole profile is Riley → no household.
    const { page, close } = await loginAs(browser, E2E_LOGIN_CHILD);

    await page.goto("/records/history/visits");
    await expect(page.getByTestId("household-view-link")).toHaveCount(0);

    // The episodes surface renders their own trail — no view strip, no bounce (the old
    // /household/history route is gone).
    await page.goto("/medical/episodes");
    await expect(page.getByTestId("care-trail-kind-toggle")).toBeVisible();
    await expect(page.getByTestId("profile-view-strip")).toHaveCount(0);

    await close();
  });

  test("a read-only caregiver still reads the merged care trail", async ({
    browser,
  }) => {
    test.slow();
    const { page, close } = await loginAs(browser, E2E_LOGIN_HHHIST_RO);
    const childId = profileId(HH_HISTORY_CHILD_PROFILE);

    await addToView(page, childId);
    await page.goto("/medical/episodes");
    await expect(page.getByTestId("care-trail-list")).toBeVisible();
    await expect(page.getByTestId("care-trail-lane")).toHaveCount(2);
    // Both members' episodes read (the child's Cold + the parent's Flu).
    await expect(
      page.getByTestId("care-trail-row").filter({ hasText: "Cold" })
    ).toBeVisible();

    await close();
  });
});
