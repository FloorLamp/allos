import { test, expect } from "@playwright/test";

// Situations are id-keyed rows (#560), not free-text string-keyed state. This drives
// the real situations bar on /medicine: the seed activates "Illness" (surfacing the
// situational Zinc supplement), so toggling the id-keyed situation off/on moves Zinc
// between "due" and "Not scheduled today" and the active state survives a reload.
// A casing-variant toggle resolves to the SAME vocabulary row (the exact fragility
// the promotion removes) rather than creating a duplicate chip.

test("situations bar toggles the id-keyed situation and gates its supplement", async ({
  page,
}) => {
  await page.goto("/medicine");

  const bar = page.getByTestId("situations-bar");
  const illness = bar.getByRole("button", { name: "Illness", exact: true });
  await expect(illness).toBeVisible();
  // Seeded active.
  await expect(illness).toHaveAttribute("aria-pressed", "true");

  // Zinc (situational, "Illness") is due while Illness is active.
  const zincDue = page
    .locator("section")
    .filter({ hasText: "Evening" })
    .locator("div.card")
    .filter({ hasText: "Zinc" });
  await expect(zincDue).toHaveCount(1);

  // Toggle Illness OFF → Zinc drops out of the due buckets into "Not scheduled
  // today" — a COLLAPSED <details> (app/(app)/medicine/page.tsx), so expand it via
  // its summary before asserting the row (contents aren't visible while closed).
  await illness.click();
  await expect(illness).toHaveAttribute("aria-pressed", "false");
  const notScheduled = page
    .locator("details")
    .filter({ hasText: /Not scheduled today/ });
  await expect(notScheduled).toBeVisible();
  await notScheduled.locator("summary").click();
  await expect(notScheduled.getByText("Zinc").first()).toBeVisible();

  // Active state persists across a reload (it's a real row, not request state).
  await page.reload();
  await expect(
    page.getByTestId("situations-bar").getByRole("button", {
      name: "Illness",
      exact: true,
    })
  ).toHaveAttribute("aria-pressed", "false");

  // Toggle back ON to restore the seeded state.
  await page
    .getByTestId("situations-bar")
    .getByRole("button", { name: "Illness", exact: true })
    .click();
  await expect(
    page.getByTestId("situations-bar").getByRole("button", {
      name: "Illness",
      exact: true,
    })
  ).toHaveAttribute("aria-pressed", "true");

  // The vocabulary is NOCASE-deduped: there is exactly one "Illness" chip, not a
  // separate lowercase one.
  await expect(
    page
      .getByTestId("situations-bar")
      .getByRole("button", { name: /^illness$/i })
  ).toHaveCount(1);
});
