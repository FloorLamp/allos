import { test, expect } from "@playwright/test";
import { settledClick } from "./helpers";

// Pause-during-situation (#1296): the INVERSE situational condition. This spec OWNS its
// fixtures (create-and-clean, unique names) — it adds a daily supplement paused during a
// unique situation, activates that situation, and asserts the row moves into the visible
// "Held" section (out of the due buckets), then deactivates and confirms it returns.
// Finally it deletes the supplement so the shared-seed profile is left as it was found.

const SUPP = "E2E Pause Oil";
const SITUATION = "E2E Fasting";

test("a pause link holds the item while its situation is active, then resumes", async ({
  page,
}) => {
  await page.goto("/nutrition?tab=supplements");

  // ── Add a daily supplement paused during a unique situation ─────────────────
  const addCard = page
    .locator("div.card")
    .filter({ hasText: "Add supplement" });
  await addCard.getByLabel("Name").fill(SUPP);
  await addCard.getByLabel("Pause during situation").fill(SITUATION);
  await settledClick(
    page,
    addCard.getByRole("button", { name: "Add", exact: true })
  );

  // The item lands. Linking the pause created the situation ROW, so its chip now
  // exists in the situations bar (starts inactive).
  const bar = page.getByTestId("situations-bar");
  const chip = bar.getByRole("button", { name: SITUATION, exact: true });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("aria-pressed", "false");

  // ── Activate the situation → the item is HELD ───────────────────────────────
  await settledClick(page, chip);
  await expect(
    page.getByTestId("situations-bar").getByRole("button", {
      name: SITUATION,
      exact: true,
    })
  ).toHaveAttribute("aria-pressed", "true");

  const heldSection = page.getByTestId("held-section");
  await expect(heldSection).toBeVisible();
  await expect(
    heldSection.getByText(`Held — ${SITUATION} active`)
  ).toBeVisible();
  await expect(heldSection.getByText(SUPP)).toBeVisible();

  // ── Deactivate → the hold lifts the same day (item leaves the Held section) ──
  await settledClick(
    page,
    page.getByTestId("situations-bar").getByRole("button", {
      name: SITUATION,
      exact: true,
    })
  );
  await expect(page.getByTestId("held-section")).toHaveCount(0);

  // ── Clean up: delete the supplement this spec created ───────────────────────
  const row = page.locator("div.card").filter({ hasText: SUPP }).first(); // first-ok: the card for SUPP, a supplement THIS spec created (unique name)
  await row.getByRole("button", { name: "Supplement actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await settledClick(
    page,
    page.getByRole("button", { name: "Delete", exact: true })
  );
  await expect(page.locator("div.card").filter({ hasText: SUPP })).toHaveCount(
    0
  );
});
