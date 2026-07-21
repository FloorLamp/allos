import { test, expect } from "@playwright/test";
import { settledClick } from "./helpers";

// Exercises the CONSOLIDATED "family" calendar feed (per-login .ics spanning every
// profile the login can access). The e2e login is the bootstrap admin, who can act
// as every profile; the seed adds a second profile ("Test Child") with an upcoming
// appointment, so both it and profile 1's seeded appointments must merge into one
// feed. Drives the real authenticated setup UI, then fetches the PUBLIC feed route
// with a fresh (session-free) request context to prove the per-login token — not a
// cookie — authorizes it, and that rotating mints a fresh URL while the old 404s.

// The displayed subscribe URL is composed against the GLOBAL public-URL setting
// (`absoluteUrl(baseUrl, path)` in ConsolidatedFeedConfig). That setting is shared
// across the one seeded DB, so a sibling spec that configures it (email-auth sets it
// to "app.example.com") can make the displayed URL absolute to a host that doesn't
// resolve — the getaddrinfo ENOTFOUND flake seen under the parallel full suite. This
// spec doesn't own that global, so it fetches the token PATH against the test server
// (Playwright's configured baseURL) instead of the displayed host: the token — not
// the public-URL setting — is what authorizes the feed, so pathOf() keeps the assertion
// on what this test actually owns and immune to whatever public URL a neighbor set.
function pathOf(displayedUrl: string): string {
  const m = displayedUrl.match(/\/api\/calendar\/family\/[0-9a-f]+\.ics$/);
  if (!m) throw new Error(`no feed path in displayed URL: ${displayedUrl}`);
  return m[0];
}

test.describe("Family (consolidated) calendar feed", () => {
  // The family feed is a per-LOGIN singleton token on the shared bootstrap-admin
  // login. Under the CI changed-spec lane's --repeat-each=3 the repeats share that
  // one login's single token slot, so they MUST run sequentially — which they do:
  // CI pins workers=1 (playwright.config.ts), the codebase-wide model that makes
  // one seeded DB safe. The start-of-test normalization below then resets the feed
  // to its disabled baseline so each sequential repeat owns its own enable→rotate
  // flow. (A local multi-worker run — workers=undefined — would parallelize the
  // repeats and stomp the shared token; run this spec at --workers=1 to match CI.)
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

    // The family feed is a per-LOGIN setting and the e2e login is the shared
    // bootstrap admin, so a prior run (or a --repeat-each repeat, which the CI
    // changed-spec lane uses) can leave it already enabled — which hides the enable
    // button and only shows rotate/disable. Normalize to the disabled baseline first
    // so every run starts from the same known state and owns its own fixture.
    const disableBtn = page.getByTestId("family-feed-disable");
    if (await disableBtn.isVisible().catch(() => false)) {
      await settledClick(page, disableBtn);
    }
    await expect(page.getByTestId("family-feed-enable")).toBeVisible();

    // Enable the family feed and capture the one-time URL (a per-login token).
    await page.getByTestId("family-feed-enable").click();
    const urlEl = page.getByTestId("family-feed-url");
    await expect(urlEl).toBeVisible();
    const firstUrl = (await urlEl.textContent())!.trim();
    expect(firstUrl).toMatch(/\/api\/calendar\/family\/[0-9a-f]+\.ics$/);

    // The public feed (no session) serves an iCalendar body containing BOTH
    // profiles' appointments — the second profile's event is prefixed with its name.
    const firstRes = await request.get(pathOf(firstUrl));
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

    const oldRes = await request.get(pathOf(firstUrl));
    expect(oldRes.status()).toBe(404);
    const newRes = await request.get(pathOf(secondUrl));
    expect(newRes.status()).toBe(200);
    expect(await newRes.text()).toContain("Test Child: ");
  });
});
