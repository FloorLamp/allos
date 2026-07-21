import { test, expect } from "@playwright/test";
import { followLink } from "./helpers";

// #382 — an immunity-titer row on /immunizations must link to the biomarker
// detail page WITH its ?name= param. Without it the detail page rendered its
// "No biomarker selected" empty state, so every titer click dead-ended. The seed
// (scripts/seed.ts) plants a "Hepatitis B Surface Antibody" titer.
test("titer link lands on the populated biomarker detail page, not the empty state", async ({
  page,
}) => {
  await page.goto("/records/history/immunizations");

  const titerLink = page.getByRole("link", {
    name: "Hepatitis B Surface Antibody",
    exact: true,
  });
  await expect(titerLink).toBeVisible();
  // The href carries the marker name (the fix), so the detail page can resolve it.
  await expect(titerLink).toHaveAttribute(
    "href",
    "/biomarkers/view?name=Hepatitis%20B%20Surface%20Antibody"
  );

  // Navigate past the pre-hydration swallow (#500/#830) with followLink — a raw
  // click here intermittently lands in the hydration window and never advances
  // the URL, which is the source of this spec's retries=0 flake (#889/#868).
  await followLink(page, titerLink, /\/biomarkers\/view\?name=/);
  // Populated detail page — its heading names the marker; NOT the empty state.
  await expect(
    page.getByRole("heading", { name: "Hepatitis B Surface Antibody" })
  ).toBeVisible();
  await expect(page.getByText("No biomarker selected")).toHaveCount(0);
});
