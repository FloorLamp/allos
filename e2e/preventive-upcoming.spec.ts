import { test, expect } from "@playwright/test";

// Preventive visits/screenings in Upcoming (issues #82 + #86). The seeded
// profile 1 is a ~40-year-old with a birthdate (scripts/seed.ts), so the pure
// catalog assessor surfaces due/overdue preventive items — but record-driven
// inference (#86) now also runs against the SAME seeded fixture, so these specs
// must target rules the seed CANNOT infer-satisfy:
//   • "Dental check-up & cleaning" (visit) — no dental appointment/encounter/
//     procedure is seeded.
//   • "Hepatitis C screening" (screening) — no HCV test is seeded (the hepatitis
//     B titer does not match the hep C concept map).
// Both stay in their catalog windows for decades of profile-1 aging and the seed
// is fully relative-dated, so the specs are deterministic year-round.
//
// The rules the OLD (#82-era) specs used are now load-bearing inference cases:
// the completed "Annual physical" appointment satisfies the adult check-up, and
// the recent blood-pressure readings satisfy the BP screening — pinned below.
//
// These specs prove, end-to-end, that:
//   1. a due preventive item renders on /upcoming with the general-guidelines
//      disclaimer,
//   2. "Mark done" records a satisfaction and clears the item,
//   3. the "Not applicable" override hides a different item,
//   4. a rule already satisfied by seeded records does NOT render (inference).
// The default specs run authenticated as admin acting as profile 1 (storageState).

const VISIT_KEY = "upcoming-item-visit:dental_cleaning";
const SCREENING_KEY = "upcoming-item-screening:hepatitis_c";

// Rules the seeded records infer-satisfy (issue #86) — must NOT render.
const INFERRED_VISIT_KEY = "upcoming-item-visit:adult_physical";
const INFERRED_SCREENING_KEY = "upcoming-item-screening:blood_pressure";

test.describe("preventive care in Upcoming (issues #82 + #86)", () => {
  test("rules satisfied by existing records are inferred done and stay hidden", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/upcoming");

    // Anchor on a rendered preventive row first so the absence assertions below
    // check a fully-loaded list, not an unrendered page. The eye-exam visit is
    // used because no seeded record can satisfy it AND no other spec mutates it
    // (tests in this file may run in parallel workers locally).
    await expect(
      page.getByTestId("upcoming-item-visit:vision_exam")
    ).toBeVisible();

    // The seeded completed "Annual physical" appointment (~35 days ago) satisfies
    // the adult check-up; the seeded blood-pressure readings (~30 days ago)
    // satisfy the BP screening — neither needs a manual mark-done.
    await expect(page.getByTestId(INFERRED_VISIT_KEY)).toHaveCount(0);
    await expect(page.getByTestId(INFERRED_SCREENING_KEY)).toHaveCount(0);
  });

  test("a due preventive visit shows the disclaimer, marks done, and clears", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/upcoming");

    const visit = page.getByTestId(VISIT_KEY);
    await expect(visit).toBeVisible();
    await expect(visit).toContainText("Dental check-up & cleaning");

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
