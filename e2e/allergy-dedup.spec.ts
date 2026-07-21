import { test, expect } from "@playwright/test";

// #384 — "Recorded allergies" must collapse cross-document twins like its
// clinical-list siblings. The e2e fixture (e2e/seed-events.ts) plants the same
// "E2E Ragweed" allergy twice (one manual, one from the browser document); the
// manager table must show it ONCE. The merged "Known allergies" card renders
// substances in <li>/<span> (not table cells), so scoping to table cells isolates
// the Recorded-allergies manager.
test("recorded-allergies manager collapses cross-document twins (#384)", async ({
  page,
}) => {
  await page.goto("/records/problems");
  await expect(
    page.getByRole("cell", { name: "E2E Ragweed", exact: true })
  ).toHaveCount(1);
});
