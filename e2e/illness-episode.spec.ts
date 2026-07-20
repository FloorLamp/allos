import { test, expect, type Page } from "@playwright/test";
import { loginAs, followLink } from "./nav";
import { settledClick } from "./helpers";

// Illness-episode view (issue #801). The seed makes profile 1 currently sick — an
// ongoing "Illness" situation with day-by-day symptoms, a fever curve (#800), and PRN
// ibuprofen administrations (#797). These specs drive the surfaces that tell that story:
//   1. the Timeline episode card + its detail page (over the shared assembly);
//   2. the tokenized /share link rendering the summary anonymously;
//   3. the illness hero's cross-profile accordion (#858) for a granted member.
// All format over the SAME assembleIllnessEpisode — no second engine (#221).

test.describe("Illness-episode view (#801)", () => {
  test("the Timeline shows an episode story card that opens the detail page", async ({
    page,
  }) => {
    test.slow(); // local next dev compiles /timeline + /medical/episodes on first hit.

    await page.goto("/timeline?category=illness");

    // The episode card's title is a link — an "Illness" story headline with "day N".
    const link = page.getByRole("link", { name: /Illness · day \d+/ }).first();
    await expect(link).toBeVisible();
    await followLink(page, link, /\/medical\/episodes\//);

    // The detail page renders the full picture over the assembly.
    await expect(
      page.getByRole("heading", { name: /Illness episode/ })
    ).toBeVisible();
    await expect(page.getByTestId("episode-symptoms")).toBeVisible();
    await expect(page.getByTestId("episode-fever")).toBeVisible();
    await expect(page.getByTestId("episode-meds")).toBeVisible();
    const latest = page
      .getByTestId("episode-summary-header")
      .getByTestId("episode-latest-readings");
    await expect(latest.getByTestId("episode-last-temperature")).toContainText(
      /\d{2}:\d{2} \((?:just now|\d+ (?:min|mins|hr|hrs) ago)\)/
    );
    await expect(latest.getByTestId("episode-last-dose")).toContainText(
      /\d{2}:\d{2} \((?:just now|\d+ (?:min|mins|hr|hrs) ago)\)/
    );
  });

  test("create a tokenized episode share link and view the summary anonymously", async ({
    page,
    browser,
  }) => {
    test.slow();

    // Open the episode detail via the illness hero cockpit's "More details" link (#858 —
    // the active profile's cockpit is at hero position, expanded by default).
    await page.goto("/");
    const episodeLink = page
      .getByRole("link", { name: /^More details about / })
      .first();
    await followLink(page, episodeLink, /\/medical\/episodes\/\d+/);

    // Mint a share link from the Share modal.
    await page.getByRole("button", { name: "Share" }).click();
    await page.getByRole("button", { name: "Create link" }).click();
    const urlField = page.locator("input[readonly]");
    await expect(urlField).toBeVisible();
    const shareUrl = await urlField.inputValue();
    expect(shareUrl).toContain("/share/");

    // Open it with NO session — the summary renders, with no app chrome.
    const anonCtx = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const anon = await anonCtx.newPage();
    const resp = await anon.goto(shareUrl);
    expect(resp?.status()).toBe(200);
    // The episode share rides the SAME /share/* route, so it inherits the stricter
    // withShareHeaders hardening (issue #801 extends #391's header coverage here).
    const headers = resp?.headers() ?? {};
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-robots-tag"]).toContain("noindex");
    // Production (the CI webServer) must forbid storage. Next's dev server replaces
    // custom document Cache-Control with its own no-cache header after middleware;
    // local e2e accepts that development-only equivalent.
    if (process.env.CI) expect(headers["cache-control"]).toContain("no-store");
    else expect(headers["cache-control"]).toMatch(/no-store|no-cache/);
    await expect(
      anon.getByRole("heading", { name: /Illness episode/ })
    ).toBeVisible();
    await expect(anon.getByTestId("episode-fever")).toBeVisible();
    await expect(anon.getByText(/Show \d+ more/)).toHaveCount(0);
    expect(
      await anon.getByTestId("episode-severity-dots").count()
    ).toBeGreaterThan(5);
    // No app chrome / profile menu on the anonymous surface.
    await expect(anon.getByTestId("user-menu-trigger")).toHaveCount(0);
    await anonCtx.close();
  });

  test("the household page shows a 'sick' chip on the currently-ill profile's card", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/household");
    // Profile 1 is sick (seed), so at least one card carries the sick chip.
    await expect(page.getByTestId("household-sick-chip").first()).toBeVisible();
    await expect(page.getByTestId("household-sick-chip").first()).toContainText(
      /sick/i
    );
  });

  test("a granted member sees the sick profile's illness-hero accordion from a NON-sick active profile (#858)", async ({
    page,
    browser,
  }) => {
    test.slow();

    // Grant a fresh member both profile 1 (sick) and profile 2 (well) via Family.
    const creds = await createMemberWithGrants(page, [
      { profileId: 1, access: "write" },
      { profileId: 2, access: "write" },
    ]);
    const member = await loginAs(browser, creds);

    // Act as profile 2 ("Riley (child)" — scripts/seed.ts owns id 2; seed-events'
    // "Sam Rivers" insert is a documented no-op) — NOT the sick one — so the illness
    // hero's accordion is the only place the sick profile (id 1) surfaces.
    // Retry-click through the hydration window (#730): loginAs returns as soon as
    // the URL leaves /login, so an immediate click on the client-state menu trigger
    // can be a dead pre-hydration click — the popover never opens and the profile
    // button never appears. Re-click until the popover actually shows the target.
    const rileyButton = member
      .getByTestId("user-menu-popover")
      .getByRole("button", { name: "Riley (child)" });
    await expect(async () => {
      await member.getByTestId("user-menu-trigger").click();
      await expect(rileyButton).toBeVisible({ timeout: 2_000 });
    }).toPass();
    await rileyButton.click();
    await expect(member.getByTestId("user-menu-trigger")).toContainText(
      "Riley (child)"
    );

    await member.goto("/");
    // Profile 1 (sick) renders as a compact accordion cockpit in the illness hero,
    // regardless of which profile the member is acting as.
    await expect(member.getByTestId("illness-hero")).toBeVisible();
    const cockpit = member.getByTestId("illness-cockpit-1");
    await expect(cockpit).toBeVisible();
    await expect(cockpit).toContainText(/Illness/i);

    await member.context().close();
  });

  test("a READ-granted caregiver opens a household member's full episode from the hero — banner, no write controls (#879)", async ({
    page,
    browser,
  }) => {
    test.slow();

    // Grant a fresh member READ on profile 1 (sick) and WRITE on profile 2 (well), then
    // act as profile 2 — so profile 1's episode is a NON-active, view-only cross-profile
    // read reached via the hero link.
    const creds = await createMemberWithGrants(page, [
      { profileId: 1, access: "read" },
      { profileId: 2, access: "write" },
    ]);
    const member = await loginAs(browser, creds);

    // Switch the acting profile to Riley (profile 2) via the header switcher (retry
    // through the pre-hydration window — see the sibling test).
    const rileyButton = member
      .getByTestId("user-menu-popover")
      .getByRole("button", { name: "Riley (child)" });
    await expect(async () => {
      await member.getByTestId("user-menu-trigger").click();
      await expect(rileyButton).toBeVisible({ timeout: 2_000 });
    }).toPass();
    await rileyButton.click();
    await expect(member.getByTestId("user-menu-trigger")).toContainText(
      "Riley (child)"
    );

    await member.goto("/");
    const cockpit = member.getByTestId("illness-cockpit-1");
    await expect(cockpit).toBeVisible();

    // The named episode link remains directly reachable from the compact header — no
    // expansion or scroll through the logger controls is required.
    const fullLink = cockpit.getByRole("link", {
      name: "More details about admin's illness episode",
    });
    await expect(fullLink).toBeVisible();
    await followLink(member, fullLink, /\/medical\/episodes\/\d+/);

    // The page renders (no 404) with the subject-identity banner ON the page (#531/#534):
    // Avatar + the sick profile's name (profile 1 = "admin", the bootstrap profile).
    const banner = member.getByTestId("episode-identity-banner");
    await expect(banner).toBeVisible();
    await expect(member.getByTestId("episode-subject-name")).toHaveText(
      "admin"
    );
    // The explicit (never automatic) "switch to them" affordance is present.
    await expect(member.getByTestId("episode-switch-profile")).toBeVisible();

    // The episode story still renders read-tier.
    await expect(member.getByTestId("episode-symptoms")).toBeVisible();
    await expect(member.getByRole("button", { name: "Print" })).toBeVisible();

    // But EVERY write affordance is absent on a view-only grant (#879): no symptom log
    // panel, no Share (link minting is write-gated), no edit control.
    await expect(member.getByTestId("episode-log-panel")).toHaveCount(0);
    await expect(member.getByRole("button", { name: "Share" })).toHaveCount(0);
    await expect(
      member.getByRole("button", { name: "More episode actions" })
    ).toHaveCount(0);

    // Medication links retain the episode subject's grants-scoped context. Before this
    // boundary matched episode detail, following the linked dose tried only the ACTIVE
    // profile and incorrectly 404ed.
    const medicationLink = member
      .getByTestId("episode-last-dose")
      .getByRole("link")
      .first();
    await expect(medicationLink).toBeVisible();
    await followLink(member, medicationLink, /\/medications\/\d+/);
    await expect(member.getByTestId("medication-detail")).toBeVisible();
    await expect(member.getByTestId("medication-subject-name")).toHaveText(
      "admin"
    );
    await expect(member.getByTestId("medication-switch-profile")).toBeVisible();
    await expect(member.getByTestId("medication-overview")).toBeVisible();
    // Cross-profile medication detail stays read-only until the explicit profile switch.
    await expect(
      member.getByRole("button", { name: "Medication actions" })
    ).toHaveCount(0);
    await expect(
      member.getByRole("button", { name: "Log past dose" })
    ).toHaveCount(0);

    await member.context().close();
  });
});

// Create a member login granted the given profiles, driving Settings → Family exactly
// as an admin would (mirrors the household-rollup helper).
async function createMemberWithGrants(
  adminPage: Page,
  grants: { profileId: number; access: "read" | "write" }[]
): Promise<{ username: string; password: string }> {
  const username = `ep${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const password = "member-pass-1234";

  await adminPage.goto("/settings/family");
  await adminPage.getByPlaceholder("Username").fill(username);
  await adminPage.getByPlaceholder("Password").fill(password);
  // settledClick, not a raw click: a click in the hydration window is silently
  // swallowed (#830) and this exact step has flaked that way in full-suite runs —
  // the same hardening the view-only-access and two-factor specs carry.
  await settledClick(
    adminPage,
    adminPage.getByRole("button", { name: "Create login" })
  );

  const grantRow = adminPage.getByTestId(`grant-row-${username}`);
  await expect(grantRow).toBeVisible({ timeout: 15_000 });
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
