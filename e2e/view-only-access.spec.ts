import { test, expect, type Browser, type Page } from "@playwright/test";
import { settledClick } from "./helpers";

// View-only access (issue #33). A profile grant now carries an access LEVEL:
// 'write' (read + edit — the historical behavior) or 'read' (view-only). These
// specs prove the boundary end-to-end:
//   1. a read-only member SEES the profile's data (reads are allowed) and gets a
//      "read-only" badge, but a mutating Server Action is REJECTED server-side
//      (requireWriteAccess() redirects to the app root before any write);
//   2. a write member is unaffected — the same mutation succeeds.
// The default specs run authenticated as admin (storageState); here we create the
// member logins through the real Family UI, then sign in as them in fresh,
// cookie-less contexts.

// Create a member login granted profile 1 at the given access level, driving the
// Settings → Family screen exactly as an admin would. Returns the credentials.
async function createMember(
  adminPage: Page,
  access: "read" | "write"
): Promise<{ username: string; password: string }> {
  // Unique per run so a CI retry against the same persistent DB can't collide on
  // the NOCASE-unique username.
  const username = `${access}er${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const password = "member-pass-1234";

  await adminPage.goto("/settings/family");
  await adminPage.getByPlaceholder("Username").fill(username);
  await adminPage.getByPlaceholder("Password").fill(password);
  // settledClick, not a raw click: a click in the hydration window is silently
  // swallowed (#830 class — this create raced exactly so under full-suite load),
  // and the grant row only exists after the create action + revalidation land.
  await settledClick(
    adminPage,
    adminPage.getByRole("button", { name: "Create login" })
  );
  await expect(
    adminPage.getByText(`Created “${username}”. Grant it a profile below.`)
  ).toBeVisible();

  // The login is durable once the action returns, but the client-side
  // router.refresh() can leave the access matrix on its previous RSC payload
  // under CI load. Reload from the server before locating the new grant row.
  await adminPage.reload();

  const grantRow = adminPage.getByTestId(`grant-row-${username}`);
  await expect(grantRow).toBeVisible({ timeout: 15_000 });
  // Grant the seeded profile (id 1, which carries the full sample record).
  await grantRow.locator('input[type="checkbox"]').first().check();
  // Set the access LEVEL via the per-cell select (write is the default).
  await grantRow.getByTestId(`grant-access-${username}-1`).selectOption(access);
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

test.describe("View-only access (issue #33)", () => {
  test("a read-only member sees data but a mutation is rejected server-side", async ({
    page,
    browser,
  }) => {
    // Local `next dev` compiles the family/login/trends routes on first hit.
    test.slow();

    const viewer = await createMember(page, "read");
    const memberPage = await loginAs(browser, viewer);

    // READ works: the profile menu shows the "read-only" badge, and the profile's
    // data renders (the Trends → Body vitals quick-add form is present).
    await memberPage.goto("/trends?tab=body");
    await expect(memberPage.getByTestId("read-only-badge")).toBeVisible();
    const form = memberPage.getByTestId("vitals-quick-add");
    await expect(form).toBeVisible();

    // A read-only medication detail keeps today's scheduled status visible, just
    // as the PRN detail keeps its day summary visible, without exposing mutations.
    await memberPage.goto("/medications");
    const medicationLink = memberPage
      .getByTestId("medication-row")
      .filter({ hasText: "Adherence Refill Med (e2e)" })
      .getByTestId("medication-row-link");
    await expect(medicationLink).toBeVisible();
    await memberPage.goto((await medicationLink.getAttribute("href"))!);
    const scheduledToday = memberPage.getByTestId("scheduled-today");
    await expect(scheduledToday).toBeVisible();
    await expect(
      scheduledToday.getByTestId("scheduled-dose-readonly")
    ).toBeVisible();
    await expect(scheduledToday.getByTestId("dose-status")).toHaveCount(0);

    await memberPage.goto("/trends?tab=body");
    const readOnlyForm = memberPage.getByTestId("vitals-quick-add");

    // WRITE is blocked: submitting the (still-rendered) form hits addVitals, whose
    // requireWriteAccess() redirects a read-only member to the app ROOT before any
    // row is written. That redirect is the unmistakable signature of the server
    // guard — a SUCCESSFUL save would instead stay on /trends and refresh in place
    // (see the write-member test below). We assert the redirect on pathname, not
    // the toast: VitalsQuickAdd optimistically toasts once the action call
    // resolves, so the toast is not a reliable "it wrote" signal on a redirect.
    await readOnlyForm.getByLabel("Systolic (mmHg)").fill("118");
    await readOnlyForm.getByLabel("Diastolic (mmHg)").fill("76");
    await readOnlyForm.getByRole("button", { name: "Save vitals" }).click();

    await memberPage.waitForURL((u) => u.pathname === "/", { timeout: 20_000 });

    // Reads still work after the bounce: the member is on their (read-only)
    // dashboard, not an error/login page.
    await expect(memberPage.getByTestId("read-only-badge")).toBeVisible();

    await memberPage.context().close();
  });

  test("a write member is unaffected — the same mutation succeeds", async ({
    page,
    browser,
  }) => {
    test.slow();

    const editor = await createMember(page, "write");
    const memberPage = await loginAs(browser, editor);

    await memberPage.goto("/trends?tab=body");
    // A write grant shows NO read-only badge.
    await expect(memberPage.getByTestId("read-only-badge")).toHaveCount(0);

    const form = memberPage.getByTestId("vitals-quick-add");
    await expect(form).toBeVisible();
    await form.getByLabel("Systolic (mmHg)").fill("120");
    await form.getByLabel("Diastolic (mmHg)").fill("78");
    await form.getByRole("button", { name: "Save vitals" }).click();

    // The write path completes: the success toast appears and we STAY on the
    // Trends page — no requireWriteAccess redirect to root (contrast the read
    // member, who is bounced to "/").
    await expect(memberPage.getByText("Vitals saved")).toBeVisible();
    await expect(memberPage).toHaveURL(/\/trends/);

    await memberPage.context().close();
  });
});
