import { test, expect } from "@playwright/test";

// Public share links (issue #391, gap 1 — the ONLY anonymous PHI surface). The
// create→view→revoke flow (PassportControls → profile/actions →
// app/share/[token]/page) had zero browser coverage beyond a 404-header check.
// This drives the whole loop as the owner (admin storageState) and verifies the
// anonymous render in a FRESH, cookie-less context:
//   (a) a link scoped to a SUBSET of fields renders the granted section and NOT a
//       de-selected one — proving the field allow-list truly gates the render;
//   (b) the shared page carries no app nav/header chrome and shows the read-only
//       watermark, never a login;
//   (c) revoking it makes the same URL 404 with the friendly not-found copy.
test.describe("Public passport share links (#391)", () => {
  test("create a scoped link, view it anonymously, then revoke it", async ({
    page,
    browser,
  }) => {
    // Local `next dev` compiles /profile + /share on first hit.
    test.slow();

    await page.goto("/profile");
    await page.getByRole("button", { name: "Share" }).click();

    // De-select Medications so the created link's allow-list excludes it while
    // keeping Allergies (checked by default). The field checkboxes live ONLY in
    // the share modal, so these locators are unambiguous on this page.
    await page.locator('input[name="field"][value="medications"]').uncheck();
    await expect(
      page.locator('input[name="field"][value="allergies"]')
    ).toBeChecked();

    await page.getByRole("button", { name: "Create link" }).click();

    // The created URL is echoed once into a read-only field (it won't be shown
    // again). Read it, then open it with no session.
    const urlField = page.locator("input[readonly]");
    await expect(urlField).toBeVisible();
    const shareUrl = await urlField.inputValue();
    expect(shareUrl).toContain("/share/");

    const anonCtx = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const anon = await anonCtx.newPage();
    const resp = await anon.goto(shareUrl);
    expect(resp?.status()).toBe(200);

    // Granted section renders; the de-selected one is absent entirely.
    await expect(
      anon.getByRole("heading", { name: "Allergies" })
    ).toBeVisible();
    await expect(
      anon.getByRole("heading", { name: "Medications" })
    ).toHaveCount(0);
    // The share-only watermark marks it a read-only copy.
    await expect(anon.getByText(/Shared read-only copy/i)).toBeVisible();
    // No app chrome on this logged-out surface: no primary nav, no profile menu.
    await expect(anon.getByRole("link", { name: "Data" })).toHaveCount(0);
    await expect(anon.getByTestId("user-menu-trigger")).toHaveCount(0);
    await anonCtx.close();

    // Revoke it from the still-open modal's "Existing links" list (revalidatePath
    // surfaced the new link there after create).
    await page.getByRole("button", { name: "Revoke" }).click();

    // Reloading the same token now 404s with the friendly, anti-probing copy —
    // indistinguishable from an invalid link.
    const anonCtx2 = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const anon2 = await anonCtx2.newPage();
    const resp2 = await anon2.goto(shareUrl);
    expect(resp2?.status()).toBe(404);
    await expect(
      anon2.getByText("This link is no longer active")
    ).toBeVisible();
    await anonCtx2.close();
  });
});
