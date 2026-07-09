import { test, expect } from "@playwright/test";

// Exercises the long-lived calendar `.ics` token lifecycle (issue #24): enabling
// mints a subscribe URL that serves an iCalendar feed, and rotating it mints a
// FRESH URL while the previous one immediately 404s (the token hash was replaced).
// Drives the real authenticated setup UI, then fetches the public feed route with
// a fresh request context (no session cookie) to prove the token — not a session —
// is what authorizes the feed.
test.describe("Calendar feed token lifecycle", () => {
  test("rotate mints a new URL and revokes the old one", async ({
    page,
    request,
  }) => {
    await page.goto("/integrations/calendar-feed");

    // Enable the feed (default "never" expiry) and capture the one-time URL.
    await page.getByRole("button", { name: "Enable feed" }).click();
    const urlEl = page.getByTestId("calendar-feed-url");
    await expect(urlEl).toBeVisible();
    const firstUrl = (await urlEl.textContent())!.trim();
    expect(firstUrl).toMatch(/\/api\/calendar\/[0-9a-f]+\.ics$/);

    // The public feed route (no session) serves an iCalendar body for that token.
    const firstRes = await request.get(firstUrl);
    expect(firstRes.status()).toBe(200);
    expect(firstRes.headers()["content-type"]).toContain("text/calendar");
    expect(await firstRes.text()).toContain("BEGIN:VCALENDAR");

    // The last-used stamp surfaces in the UI after a fetch (reload to re-read it).
    await page.reload();
    await expect(page.getByTestId("token-last-used")).toBeVisible();

    // Rotate: a brand-new URL is shown.
    await page.getByTestId("calendar-feed-rotate").click();
    await expect(urlEl).toBeVisible();
    await expect
      .poll(async () => (await urlEl.textContent())?.trim())
      .not.toBe(firstUrl);
    const secondUrl = (await urlEl.textContent())!.trim();
    expect(secondUrl).toMatch(/\/api\/calendar\/[0-9a-f]+\.ics$/);
    expect(secondUrl).not.toBe(firstUrl);

    // The OLD URL is now dead (uniform 404), the NEW one serves.
    const oldRes = await request.get(firstUrl);
    expect(oldRes.status()).toBe(404);
    const newRes = await request.get(secondUrl);
    expect(newRes.status()).toBe(200);
    expect(await newRes.text()).toContain("BEGIN:VCALENDAR");
  });
});
