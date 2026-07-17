import { test, expect, type Page } from "@playwright/test";
import { loginAs, followLink } from "./nav";

// Illness-episode view (issue #801). The seed makes profile 1 currently sick — an
// ongoing "Illness" situation with day-by-day symptoms, a fever curve (#800), and PRN
// ibuprofen administrations (#797). These specs drive the surfaces that tell that story:
//   1. the Timeline episode card + its detail page (over the shared assembly);
//   2. the tokenized /share link rendering the summary anonymously;
//   3. the "Sick in the household" cross-profile card for a granted member.
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
  });

  test("create a tokenized episode share link and view the summary anonymously", async ({
    page,
    browser,
  }) => {
    test.slow();

    // Open the episode detail via the illness hero cockpit's "Full episode" link (#858 —
    // the active profile's cockpit is at hero position, expanded by default).
    await page.goto("/");
    const episodeLink = page
      .getByRole("link", { name: "Full episode", exact: true })
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
    expect(headers["cache-control"]).toContain("no-store");
    await expect(
      anon.getByRole("heading", { name: /Illness episode/ })
    ).toBeVisible();
    await expect(anon.getByTestId("episode-fever")).toBeVisible();
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
    await expect(cockpit).toContainText(/sick/i);

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
