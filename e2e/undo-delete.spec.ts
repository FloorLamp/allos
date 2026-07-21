import { test, expect, type Page } from "@playwright/test";
import { settledClick } from "./helpers";

// Issue #30: deleting a row keeps it in a short-lived holding table and offers an
// Undo toast. This drives the required end-to-end path — delete an activity in the
// UI, then Undo, and prove the row comes back — against the seeded DB. It exercises
// the whole chain: captureDelete (activity + its exercise_sets) → deleted_rows →
// restoreDeletedRow, plus the toast affordance and the RSC refresh.
//
// Fixture ownership (#868, docs/internals/e2e-hygiene.md failure class 1): the spec
// no longer reads the SHARED seeded activity list ([id^="activity-"]) and asserts a
// before/before-1/before global tally — that scheme drifts the instant a sibling
// spec (or a --repeat-each rerun) adds/removes an activity concurrently, the
// "Expected 34, Received 37" flake that reddened PR #1110 (run 29837494962). Instead
// it CREATES a uniquely-titled probe activity and drives delete→undo against THAT
// specific row's presence/absence, which survives any neighbor's concurrent write.

const PROBE_PREFIX = "Undo delete probe";
let probeSeq = 0;

// Journal card(s) whose title contains `text`, scoped to the main content.
function cardsByTitle(page: Page, text: string | RegExp) {
  return page
    .getByRole("main")
    .locator('[id^="activity-"]')
    .filter({ hasText: text });
}

// Confirm the dialog-scoped Delete and await the captureDelete Server Action POST.
async function confirmDelete(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await settledClick(
    page,
    page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true })
  );
}

// Sweep away any lingering probe cards from a prior FAILED run so the shared list
// stays clean (idempotent: a no-op when none exist). Every PROBE_PREFIX card is
// this spec's own fixture, so deleting them all is safe and order-agnostic.
async function sweepProbes(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/training");
  const probes = cardsByTitle(page, PROBE_PREFIX);
  for (let guard = 0; guard < 12; guard++) {
    const n = await probes.count();
    if (n === 0) break;
    const card = probes.first(); // first-ok: every PROBE_PREFIX card is this spec's own leftover; cleanup is order-agnostic
    await card.getByRole("button", { name: new RegExp(PROBE_PREFIX) }).click();
    await confirmDelete(page);
    await expect(probes).toHaveCount(n - 1);
  }
}

// Create a uniquely-titled cardio probe that auto-saves, then close the editor so
// the delete is driven from the CARD (the #30 path). Cardio + a duration auto-saves
// without the per-set equipment pick a bare strength variant needs (#342). Returns
// the unique title.
async function createProbe(page: Page): Promise<string> {
  const title = `${PROBE_PREFIX} ${Date.now()}-${++probeSeq}`;
  await page.goto("/training");
  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();
  await page.getByRole("textbox", { name: "Activity name" }).fill(title);
  await page.getByPlaceholder(/What did you do/).fill("Running");
  await page
    .getByRole("listbox")
    .getByRole("button", { name: "Running", exact: true })
    .click();
  await page.getByTestId("cardio-duration").fill("30");
  // The Delete button appears only once the auto-save created the row — a stable
  // persist signal (it stays while the row exists, unlike the fading "Saved" check).
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(cardsByTitle(page, title)).toHaveCount(1);
  return title;
}

test("delete an activity, then Undo restores it (#30)", async ({ page }) => {
  test.slow(); // local next dev compiles /training on first hit
  await sweepProbes(page);

  const title = await createProbe(page);
  const card = cardsByTitle(page, title);

  // Open the editor from the card's title button, then Delete (dialog-scoped).
  await card.getByRole("button", { name: title }).click();
  await confirmDelete(page);

  // The specific probe row is gone and the Undo toast appears.
  await expect(cardsByTitle(page, title)).toHaveCount(0);
  await expect(page.getByText("Activity deleted.")).toBeVisible();

  // Undo restores it (under a NEW id, so we match by title, not id): a "Restored."
  // toast, and the probe row is back on the feed.
  await settledClick(page, page.getByRole("button", { name: "Undo" }));
  await expect(page.getByText("Restored.")).toBeVisible();
  await expect(cardsByTitle(page, title)).toHaveCount(1);

  // Clean up: delete the restored probe for good (no undo) so the shared seed DB is
  // left exactly as the harness seeded it — order-independent for sibling specs.
  await cardsByTitle(page, title).getByRole("button", { name: title }).click();
  await confirmDelete(page);
  await expect(cardsByTitle(page, title)).toHaveCount(0);
});
