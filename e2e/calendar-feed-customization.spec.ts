import { test, expect } from "@playwright/test";

// Exercises the calendar feed customization controls (issue #12): the setup UI
// gains category toggles, a reminder switch, and past/future window selects, all
// persisted per profile and reflected in the served `.ics`. This drives the real
// authenticated UI, then fetches the token-authed public feed (no session) to
// prove the saved options actually change what leaves the app.
test.describe("Calendar feed customization", () => {
  test("reminder toggle + category toggle persist and change the feed", async ({
    page,
    request,
  }) => {
    await page.goto("/integrations/calendar-feed");

    // Enable the feed and capture the one-time subscribe URL.
    await page.getByRole("button", { name: "Enable feed" }).click();
    const urlEl = page.getByTestId("calendar-feed-url");
    await expect(urlEl).toBeVisible();
    const feedUrl = (await urlEl.textContent())!.trim();
    expect(feedUrl).toMatch(/\/api\/calendar\/[0-9a-f]+\.ics$/);

    // Default: reminders on → the served feed carries VALARM blocks.
    const before = await request.get(feedUrl);
    expect(before.status()).toBe(200);
    expect(await before.text()).toContain("BEGIN:VALARM");

    // The customization controls are present.
    const reminders = page.getByTestId("calendar-feed-reminders");
    await expect(reminders).toBeChecked();
    await expect(
      page.getByTestId("calendar-category-appointment")
    ).toBeChecked();
    await expect(page.getByTestId("calendar-category-goal")).not.toBeChecked();

    // Turn reminders OFF and also opt into the "goal deadlines" category, then save.
    await reminders.uncheck();
    await page.getByTestId("calendar-category-goal").check();
    await page.getByTestId("calendar-feed-options-save").click();
    await expect(page.getByText("Saved")).toBeVisible();

    // The served feed now has no reminders.
    const after = await request.get(feedUrl);
    expect(after.status()).toBe(200);
    expect(await after.text()).not.toContain("BEGIN:VALARM");

    // The selections persist across a reload (read back from profile_settings).
    await page.reload();
    await expect(page.getByTestId("calendar-feed-reminders")).not.toBeChecked();
    await expect(page.getByTestId("calendar-category-goal")).toBeChecked();

    // Clean up: restore the default options and DISABLE the feed. The e2e DB is
    // shared across specs, and calendar-feed-token.spec.ts (which sorts after
    // this file) starts by clicking "Enable feed" — leaving the feed enabled
    // here strands that spec waiting on a button that never renders.
    await page.getByTestId("calendar-feed-reminders").check();
    await page.getByTestId("calendar-category-goal").uncheck();
    await page.getByTestId("calendar-feed-options-save").click();
    await expect(page.getByText("Saved")).toBeVisible();
    await page.getByRole("button", { name: "Disable feed" }).click();
    await expect(
      page.getByRole("button", { name: "Enable feed" })
    ).toBeVisible();
  });
});
