import { test, expect } from "@playwright/test";

// Preventive visits/screenings in Upcoming (issue #82). The seeded profile 1 is a
// ~40-year-old with a birthdate (scripts/seed.ts), so the pure catalog assessor
// surfaces several due/overdue preventive items with no completion on record —
// among them the "Routine adult check-up" visit and a "Blood pressure screening".
// These specs prove, end-to-end, that:
//   1. a due preventive item renders on /upcoming with the general-guidelines
//      disclaimer,
//   2. "Mark done" records a satisfaction and clears the item,
//   3. the "Not applicable" override hides a different item.
// The default specs run authenticated as admin acting as profile 1 (storageState).

const VISIT_KEY = "upcoming-item-visit:adult_physical";
const SCREENING_KEY = "upcoming-item-screening:blood_pressure";

test.describe("preventive care in Upcoming (issue #82)", () => {
  test("a due preventive visit shows the disclaimer, marks done, and clears", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/upcoming");

    const visit = page.getByTestId(VISIT_KEY);
    await expect(visit).toBeVisible();
    await expect(visit).toContainText("Routine adult check-up");

    // The informational disclaimer is present whenever preventive items show.
    await expect(page.getByText("your provider's advice wins")).toBeVisible();

    // Mark it done → the satisfaction advances the next-due out of the window and
    // the row drops off the list on revalidate.
    await visit.getByRole("button", { name: "Mark done" }).click();
    await expect(page.getByTestId(VISIT_KEY)).toHaveCount(0);
  });

  test("the Not applicable override hides a preventive screening", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/upcoming");

    const screening = page.getByTestId(SCREENING_KEY);
    await expect(screening).toBeVisible();

    // Open the row's override menu and choose "Not applicable".
    await screening.getByLabel("Not applicable or declined").click();
    await screening.getByRole("button", { name: "Not applicable" }).click();

    await expect(page.getByTestId(SCREENING_KEY)).toHaveCount(0);
  });
});
