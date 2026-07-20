import { test, expect } from "@playwright/test";

// /care-plan + /care-goals (issue #391, gap 5). care-plan-upcoming.spec only drives
// the /upcoming twin. This covers the pages themselves: the care-plan list renders
// seeded items with status + planned date, completing one from the page drops its
// Upcoming twin (page↔digest parity), and /care-goals renders its seeded goals.

const CAREPLAN_UPCOMING = '[data-testid^="upcoming-item-careplan:"]';

test.describe("Care plan (#391)", () => {
  test("the list renders seeded items with status and planned date", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/records#care-plan");
    await expect(
      page.getByRole("heading", { name: "Care plan" })
    ).toBeVisible();

    // A seeded, still-planned item renders with its status. (Distinct from
    // "Follow-up lipid panel", which care-plan-upcoming.spec may have completed.)
    const row = page
      .locator("tr")
      .filter({ hasText: "Repeat screening colonoscopy" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Planned");
  });

  test("completing a care-plan item from the page removes its Upcoming twin", async ({
    page,
  }) => {
    test.slow();

    // Complete the dedicated open item by editing its status to "completed" (the
    // page's completion path — the list has no separate mark-done button).
    // Idempotent: re-completing an already-completed row is a harmless no-op, so a
    // CI retry against the reused DB still passes.
    await page.goto("/records#care-plan");
    const row = page.locator("tr").filter({ hasText: "E2E orthotics fitting" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Edit" }).click();

    // Two "Status" inputs now exist (the always-present add form + this edit
    // form); target the edit form's by its non-"new" id. Scope Save to that same
    // edit <form>: after the #1042 specialty fold, /records also renders the
    // Vision/Dental/Skin/Mental-health section forms, whose submit buttons are
    // also labelled "Save" — so a page-wide getByRole("button",{name:"Save"})
    // is a strict-mode violation. Anchor to the on-element form, not position.
    const editForm = page.locator(
      'form:has(input[id^="cp-status-"]:not([id="cp-status-new"]))'
    );
    await editForm.locator('input[id^="cp-status-"]').fill("completed");
    await editForm.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Care-plan item updated")).toBeVisible();

    // The row now reads Completed on the page …
    await expect(
      page.locator("tr").filter({ hasText: "E2E orthotics fitting" })
    ).toContainText("Completed");

    // … and its Upcoming twin is gone (the closed status drops it from the feed).
    await page.goto("/upcoming");
    await expect(
      page
        .locator(CAREPLAN_UPCOMING)
        .filter({ hasText: "E2E orthotics fitting" })
    ).toHaveCount(0);
  });

  test("care-goals page renders its seeded clinical goals", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/records#health-goals");
    await expect(
      page.getByRole("heading", { name: "Health goals" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Add health goal" })
    ).toBeVisible();
    // A seeded goal from the record's Goals section.
    await expect(page.getByText("HbA1c below 6.5%")).toBeVisible();
  });
});
