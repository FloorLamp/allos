import { test, expect } from "@playwright/test";

// #544/#549 — a POSITIVE durable-immunity titer must present as a neutral "Immune"
// status, never a red "Abnormal". The fixture (e2e/seed-events.ts) plants
// "E2E Hepatitis B Surface Antibody" = Positive, stored flag "abnormal", which the
// qualitative-classifier flag reconcile corrects to "immune" before render.
test("a positive durable-immunity titer shows an Immune status, not Abnormal (#544)", async ({
  page,
}) => {
  await page.goto(
    "/biomarkers/view?name=E2E%20Hepatitis%20B%20Surface%20Antibody"
  );

  await expect(
    page.getByRole("heading", { name: "E2E Hepatitis B Surface Antibody" })
  ).toBeVisible();

  // Neutral "Immune" status chip is shown…
  await expect(page.getByTestId("immune-status")).toBeVisible();
  await expect(page.getByTestId("immune-status")).toContainText("Immune");
  // …and the cross-link to the immunization/immunity surface (#544 part 2).
  await expect(page.getByTestId("immunity-crosslink")).toBeVisible();
  // A positive immunity result is durable, so it is never marked stale.
  await expect(page.getByText("These results are stale.")).toHaveCount(0);
});

// #548 §2 — an IMMUTABLE identity attribute (blood type) never goes stale, the way
// genomics and durable immunity already don't. The fixture plants
// "E2E ABO Blood Group" = A POSITIVE dated ~2 years ago (past the flat 365-day
// clock); the classifier exempts it, so no "retest overdue / stale" nag.
test("an immutable blood type is not marked stale for retest (#548)", async ({
  page,
}) => {
  await page.goto("/biomarkers/view?name=E2E%20ABO%20Blood%20Group");

  await expect(
    page.getByRole("heading", { name: "E2E ABO Blood Group" })
  ).toBeVisible();

  // Immutable attribute — exempt from the retest-stale clock despite being 2y old.
  await expect(page.getByText("These results are stale.")).toHaveCount(0);
});
