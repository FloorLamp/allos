import { test, expect } from "./fixtures";
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
  await page.getByTestId("supplement-add-toggle").click();
  const addDialog = page.getByRole("dialog", { name: "Add supplement" });
  await addDialog.getByLabel("Name").fill(SUPP);
  await addDialog.getByLabel("Pause during situation").fill(SITUATION);
  await settledClick(
    page,
    addDialog.getByRole("button", { name: "Add", exact: true })
  );

  // Linking the pause created the situation row. The dashboard context surface owns
  // activation; Supplements only consumes the resulting schedule state.
  await page.goto("/");
  const checkin = page.getByTestId("how-are-you-card");
  await checkin.getByTestId("checkin-section-context-toggle").click();
  const chip = checkin.getByTestId(`checkin-situation-${SITUATION}`);
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("aria-pressed", "false");

  // ── Activate the situation → the item is HELD ───────────────────────────────
  await settledClick(page, chip);
  // Server-truth budget (#1556): the chip's aria-pressed flips only after the
  // situation toggle's Server Action + RSC refresh round-trip, and this is the
  // dashboard — a bystander-POST surface where settledClick can resolve early
  // (see the caveat in e2e/helpers.ts). Twice observed losing the 5s default
  // under CI shard load at retries=0 (2026-07-31, runs 30663070912 and
  // 30664837925); the button sits disabled while the transition is pending, so
  // the wide window waits on the real commit and masks nothing.
  await expect(chip).toHaveAttribute("aria-pressed", "true", {
    timeout: 30_000,
  });

  await page.goto("/nutrition?tab=supplements");
  const heldSection = page.getByTestId("held-section");
  await expect(heldSection).toBeVisible();
  await expect(
    heldSection.getByText(`Held — ${SITUATION} active`)
  ).toBeVisible();
  await expect(heldSection.getByText(SUPP)).toBeVisible();

  // ── Deactivate → the hold lifts the same day (item leaves the Held section) ──
  await page.goto("/");
  const checkinAgain = page.getByTestId("how-are-you-card");
  await checkinAgain.getByTestId("checkin-section-context-toggle").click();
  await settledClick(
    page,
    checkinAgain.getByTestId(`checkin-situation-${SITUATION}`)
  );
  await expect(
    checkinAgain.getByTestId(`checkin-situation-${SITUATION}`)
  ).toHaveAttribute("aria-pressed", "false");
  await page.goto("/nutrition?tab=supplements");
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
