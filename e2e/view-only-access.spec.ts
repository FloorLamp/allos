import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_VIEWONLY_READ,
  E2E_LOGIN_VIEWONLY_WRITE,
} from "./fixture-logins";

// View-only access (issue #33). A profile grant now carries an access LEVEL:
// 'write' (read + edit — the historical behavior) or 'read' (view-only). These
// specs prove the boundary end-to-end:
//   1. a read-only member SEES the profile's data (reads are allowed) and gets a
//      "read-only" badge, but a mutating Server Action is REJECTED server-side
//      (requireWriteAccess() redirects to the app root before any write);
//   2. a write member is unaffected — the same mutation succeeds.
// The two members are DEDICATED, seeded logins (e2e/seed-events.ts + fixture-logins.ts),
// each granted ONLY profile 1 (the shared sample record) at its access level — so profile
// 1 is its sole/active profile on sign-in. This replaces the former runtime member
// creation through the Family UI (createLoginViaFamily/setGrantsViaFamily), whose
// onClick+router.refresh() create/grant went stale under CI load — the #830/#1111 census
// flake. We sign in as each in a fresh, cookie-less context (loginAs) so it never touches
// the shared admin storageState.

test.describe("View-only access (issue #33)", () => {
  test("a read-only member sees data but a mutation is rejected server-side", async ({
    browser,
  }) => {
    // Local `next dev` compiles the login/trends/medications routes on first hit.
    test.slow();

    const memberPage = await loginAs(browser, {
      username: E2E_LOGIN_VIEWONLY_READ,
      password: E2E_MEMBER_PASSWORD,
    });

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
    browser,
  }) => {
    test.slow();

    const memberPage = await loginAs(browser, {
      username: E2E_LOGIN_VIEWONLY_WRITE,
      password: E2E_MEMBER_PASSWORD,
    });

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
