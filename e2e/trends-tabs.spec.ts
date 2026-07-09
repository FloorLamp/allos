import { test, expect } from "@playwright/test";

// #105: Trends sections are server-gated on the active ?tab= — hidden tabs ship
// no content, and a tab click is a router.replace navigation that fetches the
// newly selected section. These specs prove the client-side switching path still
// works end-to-end (the deep-link path is covered by trends-trajectory.spec.ts).

test("clicking through Trends tabs loads each section's content (#105)", async ({
  page,
}) => {
  await page.goto("/trends");

  // Biomarkers: the seeded eGFR decline renders the trajectory card.
  await page.getByRole("button", { name: "Biomarkers", exact: true }).click();
  await expect(page.getByTestId("trajectory-findings")).toBeVisible();

  // Body: the vitals quick-add form is part of the Body section.
  await page.getByRole("button", { name: "Body", exact: true }).click();
  await expect(page.getByTestId("vitals-quick-add")).toBeVisible();

  // Back to Overview: the Body section's content is gone again.
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.getByTestId("vitals-quick-add")).toHaveCount(0);
});

test("the Fitness section's inner tabs fetch their sections on click (#105)", async ({
  page,
}) => {
  await page.goto("/trends?tab=fitness");
  // The strength panel is the inner default.
  await expect(page.getByText("Full Training →")).toBeVisible();

  // Switching the inner strip navigates (?ftab=cardio) and loads the cardio
  // section, which the seed populates with cardio activities.
  await page.getByRole("button", { name: "Cardio", exact: true }).click();
  await expect(page).toHaveURL(/ftab=cardio/);
  await expect(
    page.getByRole("heading", { name: /weekly volume|intensity mix/i }).first()
  ).toBeVisible();
});
