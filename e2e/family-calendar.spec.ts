import { test, expect } from "@playwright/test";

// Exercises the CONSOLIDATED "family" calendar feed (per-login .ics spanning every
// profile the login can access). The e2e login is the bootstrap admin, who can act
// as every profile; the seed adds a second profile ("Test Child") with an upcoming
// appointment, so both it and profile 1's seeded appointments must merge into one
// feed. Drives the real authenticated setup UI, then fetches the PUBLIC feed route
// with a fresh (session-free) request context to prove the per-login token — not a
// cookie — authorizes it, and that rotating mints a fresh URL while the old 404s.
test.describe("Family (consolidated) calendar feed", () => {
  test("preview merges profiles; feed serves both; rotate revokes the old URL", async ({
    page,
    request,
  }) => {
    await page.goto("/integrations/calendar-feed");

    // The consolidated preview lists appointments across profiles, each labeled
    // with its profile name — the second profile's row proves the merge.
    const preview = page.getByTestId("family-feed-preview");
    await expect(preview).toBeVisible();
    await expect(
      preview.getByTestId("family-feed-profile-label").filter({
        hasText: "Test Child",
      })
    ).toHaveCount(1);
    // Test Child's profile defaults to MINIMAL detail, so the title ("Pediatric
    // checkup") is hidden — the neutral label + location are what show, proving the
    // per-profile detail level is honored inside the shared feed.
    await expect(preview.getByText("Springfield Pediatrics")).toBeVisible();

    // Enable the family feed and capture the one-time URL (a per-login token).
    await page.getByTestId("family-feed-enable").click();
    const urlEl = page.getByTestId("family-feed-url");
    await expect(urlEl).toBeVisible();
    const firstUrl = (await urlEl.textContent())!.trim();
    expect(firstUrl).toMatch(/\/api\/calendar\/family\/[0-9a-f]+\.ics$/);

    // The public feed (no session) serves an iCalendar body containing BOTH
    // profiles' appointments — the second profile's event is prefixed with its name.
    const firstRes = await request.get(firstUrl);
    expect(firstRes.status()).toBe(200);
    expect(firstRes.headers()["content-type"]).toContain("text/calendar");
    const body = await firstRes.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("Test Child: ");
    // Profile 1's seeded appointments (admin profile) also ride in the same feed.
    expect(body).toContain("fam-1-appt-");
    expect(body).toContain("fam-");

    // Rotate: a brand-new URL is shown and the old one dies (uniform 404).
    await page.getByTestId("family-feed-rotate").click();
    await expect
      .poll(async () => (await urlEl.textContent())?.trim())
      .not.toBe(firstUrl);
    const secondUrl = (await urlEl.textContent())!.trim();
    expect(secondUrl).toMatch(/\/api\/calendar\/family\/[0-9a-f]+\.ics$/);
    expect(secondUrl).not.toBe(firstUrl);

    const oldRes = await request.get(firstUrl);
    expect(oldRes.status()).toBe(404);
    const newRes = await request.get(secondUrl);
    expect(newRes.status()).toBe(200);
    expect(await newRes.text()).toContain("Test Child: ");
  });
});
