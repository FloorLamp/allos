import { test, expect, type Browser, type Page } from "@playwright/test";

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
// The default specs run authenticated as admin (storageState); here we create the
// member logins through the real Family UI, then sign in as them in fresh contexts.

const SEEDED_PROFILE_2 = "2"; // "Sam Rivers"
const HOUSEHOLD_DUE_DOSE = "Household Vitamin D";
// Dedicated to the read-only spec: the write-member spec confirms (consumes) the
// Vitamin D dose, so the read-only assertions use their own never-consumed item.
const HOUSEHOLD_RO_DUE_DOSE = "Household Magnesium";

// Create a member login and grant it the given profiles at the given access
// levels, driving Settings → Family exactly as an admin would. Returns creds.
async function createMemberWithGrants(
  adminPage: Page,
  grants: { profileId: number; access: "read" | "write" }[]
): Promise<{ username: string; password: string }> {
  // Unique per run so a CI retry against the same persistent DB can't collide on
  // the NOCASE-unique username.
  const username = `hh${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const password = "member-pass-1234";

  await adminPage.goto("/settings/family");
  await adminPage.getByPlaceholder("Username").fill(username);
  await adminPage.getByPlaceholder("Password").fill(password);
  await adminPage.getByRole("button", { name: "Create login" }).click();

  const grantRow = adminPage.getByTestId(`grant-row-${username}`);
  await expect(grantRow).toBeVisible();
  for (const g of grants) {
    const cell = adminPage.getByTestId(`grant-cell-${username}-${g.profileId}`);
    await cell.locator('input[type="checkbox"]').check();
    await adminPage
      .getByTestId(`grant-access-${username}-${g.profileId}`)
      .selectOption(g.access);
  }
  await grantRow.getByRole("button", { name: "Save access" }).click();
  await expect(grantRow.getByText("Access updated.")).toBeVisible();

  return { username, password };
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
    page,
    browser,
  }) => {
    // Local `next dev` compiles the family/household routes on first hit.
    test.slow();

    const caregiver = await createMemberWithGrants(page, [
      { profileId: 1, access: "write" },
      { profileId: 2, access: "write" },
    ]);
    const memberPage = await loginAs(browser, caregiver);

    // The Household nav entry is now visible for a multi-profile member.
    await expect(
      memberPage.getByRole("link", { name: "Household" })
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

    await doseRow.getByTestId("household-confirm-dose").click();

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
    page,
    browser,
  }) => {
    test.slow();

    const solo = await createMemberWithGrants(page, [
      { profileId: 1, access: "write" },
    ]);
    const memberPage = await loginAs(browser, solo);

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
    page,
    browser,
  }) => {
    test.slow();

    const viewer = await createMemberWithGrants(page, [
      { profileId: 1, access: "read" },
      { profileId: 2, access: "read" },
    ]);
    const memberPage = await loginAs(browser, viewer);

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
