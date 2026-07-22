import { test, expect, type Browser, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { settledClick } from "./helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_HH_CAREGIVER,
  E2E_LOGIN_HH_SOLO,
  E2E_LOGIN_HH_VIEWER,
} from "./fixture-logins";

// Household view for members + actionable rollup (issue #31). The Household screen
// used to be admin-only; it's now open to ANY login that can reach 2+ profiles (a
// caregiver member with several grants, or an admin), and each card can confirm a
// due dose for its profile WITHOUT switching the session's active profile. These
// specs prove the boundary end-to-end against the seeded second profile (id 2,
// "Sam Rivers", carrying one due-today supplement dose — see e2e/seed-events.ts):
//   1. a member granted 2 profiles sees both cards and confirms the non-active
//      profile's dose from its card (active profile stays put);
//   2. a single-profile member has no Household nav and is redirected off the URL;
//   3. a read-only member sees the cards but gets NO confirm buttons.
// The default specs run authenticated as admin (storageState); here we sign in as the
// SEEDED caregiver fixtures (e2e/fixture-logins.ts) in fresh contexts — replacing the
// former runtime member-creation through Settings → Family, whose router.refresh() grant
// rows went stale under CI load (the #868 create-member census flake).

const SEEDED_PROFILE_2 = "2"; // "Sam Rivers"
const HOUSEHOLD_DUE_DOSE = "Household Vitamin D";
// Dedicated to the read-only spec: the write-member spec confirms (consumes) the
// Vitamin D dose, so the read-only assertions use their own never-consumed item.
const HOUSEHOLD_RO_DUE_DOSE = "Household Magnesium";

// Un-confirm profile 2's "Household Vitamin D" dose so it is DUE again at the start
// of the confirm test — the #868 fixture-ownership fix that retires the old
// skip-on-repeat guard. The write-member test taps "confirm dose", which writes an
// intake_item_logs row that persists (no per-run reset), so a second --repeat-each
// run (or a retry) previously saw the dose already-taken and the "due dose visible"
// assertion failed. Deleting the log rows for this dedicated household item (only this
// spec touches it) restores the seeded DUE state. Short-lived connection + busy timeout
// so it never contends with the running server on the WAL DB.
function resetHouseholdDose(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      `DELETE FROM intake_item_logs
        WHERE item_id IN (
          SELECT id FROM intake_items WHERE name = ? AND profile_id = ?
        )`
    ).run(HOUSEHOLD_DUE_DOSE, Number(SEEDED_PROFILE_2));
  } finally {
    db.close();
  }
}

// Sign in as the given credentials in a brand-new, explicitly cookie-less context
// (so it does NOT inherit the admin storageState). Returns the member's page.
async function loginAs(
  browser: Browser,
  creds: { username: string; password: string }
): Promise<Page> {
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill('input[name="username"]', creds.username);
  await page.fill('input[name="password"]', creds.password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 20_000,
  });
  return page;
}

test.describe("Household view for members (issue #31)", () => {
  test("a member with two grants sees both cards and confirms a dose for the non-active profile", async ({
    browser,
  }) => {
    // Un-confirm the shared-seed due dose so this test owns its fixture state and is
    // repeat-safe (#868): the confirm below writes a persistent log, so without this
    // reset a second --repeat-each run would find the dose already taken.
    resetHouseholdDose();
    // Local `next dev` compiles the family/household routes on first hit.
    test.slow();

    const memberPage = await loginAs(browser, {
      username: E2E_LOGIN_HH_CAREGIVER,
      password: E2E_MEMBER_PASSWORD,
    });

    // The Household nav entry is now visible for a multi-profile member. Exact:
    // the #1009 dashboard promotion link ("See the household's visit & illness
    // history") also carries "household" in its accessible name — a non-exact
    // role query is a strict-mode collision when the house is sick.
    await expect(
      memberPage.getByRole("link", { name: "Household", exact: true })
    ).toBeVisible();

    await memberPage.goto("/household");
    await expect(memberPage.getByTestId("household-card")).toHaveCount(2);

    // The active profile is the first accessible one (profile 1, named "admin"),
    // NOT the profile whose dose we're about to confirm.
    await expect(memberPage.getByTestId("user-menu-trigger")).toContainText(
      "admin"
    );

    // Profile 2's card (the NON-active profile) shows its due dose + a confirm.
    const p2Card = memberPage.locator(
      `[data-testid="household-card"][data-profile-id="${SEEDED_PROFILE_2}"]`
    );
    await expect(p2Card).toBeVisible();
    const doseRow = p2Card
      .getByTestId("household-due-dose")
      .filter({ hasText: HOUSEHOLD_DUE_DOSE });
    await expect(doseRow).toBeVisible();

    // Confirm posts the dose-confirm Server Action — settle on its POST so the
    // "dose drops off the card" assertion below can't race a half-applied
    // revalidate (#868/#891).
    await settledClick(
      memberPage,
      doseRow.getByTestId("household-confirm-dose")
    );

    // The confirmed dose drops off the card (revalidate) and we STAY on /household
    // — confirming a non-active profile's dose never switches the active profile
    // (openProfileAction would have redirected to "/").
    await expect(
      p2Card
        .getByTestId("household-due-dose")
        .filter({ hasText: HOUSEHOLD_DUE_DOSE })
    ).toHaveCount(0);
    await expect(memberPage).toHaveURL(/\/household/);
    await expect(memberPage.getByTestId("user-menu-trigger")).toContainText(
      "admin"
    );

    await memberPage.context().close();
  });

  test("a single-profile member has no Household nav and is redirected from the URL", async ({
    browser,
  }) => {
    test.slow();

    const memberPage = await loginAs(browser, {
      username: E2E_LOGIN_HH_SOLO,
      password: E2E_MEMBER_PASSWORD,
    });

    // Nav link hidden for a single-profile login…
    await expect(
      memberPage.getByRole("link", { name: "Household" })
    ).toHaveCount(0);

    // …and the page's own server gate bounces a direct visit to the dashboard.
    await memberPage.goto("/household");
    await memberPage.waitForURL((u) => u.pathname === "/", { timeout: 20_000 });

    await memberPage.context().close();
  });

  test("a read-only member sees the cards but gets no confirm buttons", async ({
    browser,
  }) => {
    test.slow();

    const memberPage = await loginAs(browser, {
      username: E2E_LOGIN_HH_VIEWER,
      password: E2E_MEMBER_PASSWORD,
    });

    await memberPage.goto("/household");
    await expect(memberPage.getByTestId("household-card")).toHaveCount(2);

    // The attention items still render (reads are allowed)…
    const p2Card = memberPage.locator(
      `[data-testid="household-card"][data-profile-id="${SEEDED_PROFILE_2}"]`
    );
    await expect(
      p2Card
        .getByTestId("household-due-dose")
        .filter({ hasText: HOUSEHOLD_RO_DUE_DOSE })
    ).toBeVisible();

    // …but a read-only caregiver gets NO quick-action buttons, on any card.
    await expect(p2Card.getByTestId("household-confirm-dose")).toHaveCount(0);
    await expect(memberPage.getByTestId("household-confirm-dose")).toHaveCount(
      0
    );

    await memberPage.context().close();
  });
});
