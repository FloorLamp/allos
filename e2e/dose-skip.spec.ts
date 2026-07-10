import { test, expect } from "@playwright/test";

// The web dose check-off is a TAKEN / SKIPPED / CLEAR tri-state (#232): a
// deliberate skip is a first-class decision, distinct from a silent miss, with
// its own control beside the ✅ take. This drives the whole cycle in the real app
// against a freshly-created, uniquely-named supplement so it never disturbs the
// seeded intake rows other specs rely on, and deletes it at the end.

const NAME = "Skip State Zinc";

test("dose check-off cycles taken → skipped → clear as a tri-state", async ({
  page,
}) => {
  await page.goto("/medicine");

  // ── Create a single daily Morning dose ──────────────────────────────────────
  const addCard = page
    .locator("div.card")
    .filter({ hasText: "Add supplement or medication" });
  await addCard.getByLabel("Name").fill(NAME);
  await addCard.getByLabel("Amount").first().fill("15 mg");
  await addCard.getByLabel("Time of day").first().selectOption("Morning");
  await addCard.getByRole("button", { name: "Add", exact: true }).click();

  const row = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Morning" }) })
    .locator("div.card")
    .filter({ hasText: NAME });
  await expect(row).toHaveCount(1);

  const take = row.getByRole("button", { name: "Mark taken" });
  const skip = row.getByRole("button", { name: "Skip this dose" });
  await expect(take).toBeVisible();
  await expect(skip).toBeVisible();

  // ── Skip the dose: the skip control latches, take stays unmarked ─────────────
  await skip.click();
  const skipOn = row.getByRole("button", { name: "Undo skip" });
  await expect(skipOn).toBeVisible();
  await expect(skipOn).toHaveAttribute("aria-pressed", "true");
  // The dose is NOT counted as taken.
  await expect(row.getByRole("button", { name: "Mark taken" })).toHaveAttribute(
    "aria-pressed",
    "false"
  );

  // ── Undo the skip → back to clear ───────────────────────────────────────────
  await skipOn.click();
  await expect(
    row.getByRole("button", { name: "Skip this dose" })
  ).toHaveAttribute("aria-pressed", "false");
  await expect(row.getByRole("button", { name: "Mark taken" })).toHaveAttribute(
    "aria-pressed",
    "false"
  );

  // ── Take it, then flip taken → skipped (an explicit toggle) ──────────────────
  await row.getByRole("button", { name: "Mark taken" }).click();
  await expect(
    row.getByRole("button", { name: "Mark not taken" })
  ).toHaveAttribute("aria-pressed", "true");

  await row.getByRole("button", { name: "Skip this dose" }).click();
  // Now skipped, and no longer taken.
  await expect(row.getByRole("button", { name: "Undo skip" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(row.getByRole("button", { name: "Mark taken" })).toHaveAttribute(
    "aria-pressed",
    "false"
  );

  // ── Clean up: delete the supplement so the fixture is left as found ──────────
  await row.getByRole("button", { name: "Supplement actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator("div.card").filter({ hasText: NAME })).toHaveCount(
    0
  );
});
