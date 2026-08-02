import { test, expect } from "./fixtures";
import { followLink, openCommandPalette } from "./nav";

// Equipment registry (issue #343): equipment moved out of Settings into a
// top-level /equipment index + /equipment/[id] detail with usage history. This
// drives the rendered surfaces the move introduced: the index (grouped, with a
// per-item usage badge), the detail page (the usage payoff — sessions, last used,
// total distance for a bike), and the old-URL redirect that keeps bookmarks alive.
//
// Uses the dedicated seeded "E2E Registry Bike" (a Cardio implement with a
// session-level ride, see seed-events) so it never races the delete spec's
// "E2E Delete Bar".
test.describe("Equipment registry (#343)", () => {
  test("the index lists gear with a usage badge and links to its detail", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/equipment");
    await expect(page.getByTestId("equipment-index")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Your equipment" })
    ).toBeVisible();

    const row = page
      .getByTestId("equipment-row")
      .filter({ hasText: "E2E Registry Bike" });
    await expect(row).toBeVisible();
    // The seeded ride gives it exactly one session — the usage badge proves the
    // index reads the shared usage computation.
    await expect(row.getByTestId("equipment-usage")).toContainText("session");

    // Follow the name link into the detail page (a Next <Link> — use followLink,
    // raw .click() on Links is hydration-flaky).
    await followLink(
      page,
      row.getByRole("link", { name: /E2E Registry Bike/ }),
      /\/equipment\/\d+$/
    );

    await expect(page.getByTestId("equipment-detail")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "E2E Registry Bike" })
    ).toBeVisible();
    // A Bike shows its distance payoff, not lifted volume. Stat blocks are
    // asserted by testid — bare label text "Sessions" is a strict-mode trap (it
    // substring-matches the "Recent sessions" heading too).
    await expect(page.getByTestId("equipment-stat-distance")).toBeVisible();
    const sessionsStat = page.getByTestId("equipment-stat-sessions");
    await expect(sessionsStat).toBeVisible();
    // A POSITIVE session count proves the index/detail reads the shared usage
    // computation. Do NOT exact-count "1" (#868): "E2E Registry Bike" is a SHARED
    // profile-1 fixture, and a neighbor spec that logs a ride and picks a Bike from
    // the activity-equipment picker adds to its session count — the exact-count-on-a-
    // shared-row anti-pattern that made this go red suite-wide ("Sessions2" vs "1").
    await expect(sessionsStat).toContainText(/[1-9]/);
    // The specific seeded ride is among the counted sessions (the detail's Recent
    // sessions list) — proof the computation counts THIS bike's own activity, not a
    // brittle total a neighbor can bump.
    await expect(page.getByText("E2E Registry Ride")).toBeVisible();

    // Back link returns to the index.
    await followLink(
      page,
      page.getByRole("link", { name: "Back to equipment" }),
      /\/equipment$/
    );
    await expect(page.getByTestId("equipment-index")).toBeVisible();
  });

  test("the old Settings → Equipment URL 404s (the post-#1635 no-redirect doctrine)", async ({
    page,
  }) => {
    // The #343-era redirect stub is gone (#1869 item 5): a retired URL 404s, the
    // same call #1462 made for the much higher-traffic /settings/profile.
    const resp = await page.goto("/settings/equipment");
    expect(resp?.status()).toBe(404);
  });

  // #592: the command palette is the one discoverable, ungated door to the registry.
  // Its entry was retitled "Equipment" → /equipment (was the stale "Settings:
  // Equipment" → /settings/equipment) with keywords spanning every gear kind, so a
  // search for "sauna" surfaces it and selecting it navigates to /equipment.
  test("the command palette 'Equipment' entry navigates to the registry", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/");
    const input = await openCommandPalette(page);
    // A gear-kind keyword (not the title) — proves the extended keywords match.
    await input.fill("sauna");
    const results = page.getByRole("listbox", { name: "Results" });
    const hit = results.getByRole("option", { name: "Equipment", exact: true });
    // First-search warm-up ceiling (same as palette-actions.spec.ts): the debounced
    // search action costs 4-7s on a cold server under CI load, past the 5s default.
    // Not a sleep — this still fails if the hit never arrives.
    await expect(hit).toBeVisible({ timeout: 20_000 });
    await followLink(page, hit.first(), /\/equipment$/); // first-ok: the command-palette "sauna" search resolves to the single Equipment page result
    await expect(page).toHaveURL(/\/equipment$/);
    await expect(
      page.getByRole("heading", { name: "Your equipment" })
    ).toBeVisible();
  });
});
