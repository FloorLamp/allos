import { test, expect } from "@playwright/test";
import { followLink } from "./nav";

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
    // A Bike shows its distance payoff, not lifted volume.
    await expect(page.getByText("Total distance")).toBeVisible();
    await expect(page.getByText("Sessions")).toBeVisible();

    // Back link returns to the index.
    await followLink(
      page,
      page.getByRole("link", { name: "Back to equipment" }),
      /\/equipment$/
    );
    await expect(page.getByTestId("equipment-index")).toBeVisible();
  });

  test("the old Settings → Equipment URL redirects to the registry", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/settings/equipment");
    await page.waitForURL((u) => u.pathname === "/equipment", {
      timeout: 20_000,
    });
    await expect(page).toHaveURL(/\/equipment$/);
    await expect(
      page.getByRole("heading", { name: "Your equipment" })
    ).toBeVisible();
  });
});
