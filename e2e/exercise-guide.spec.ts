import { test, expect, type Page } from "@playwright/test";

// #734 — the static how-to guide (content layer + accessor from #733) surfaced in
// the ONE per-exercise surface, `ExerciseDetailPanel`, as a "How to" section, plus
// an ⓘ entry point in the strength set editor that opens the SAME shared guide
// section in an overlay. Custom (non-catalog) lifts have no guide, so the section
// and the affordance simply don't render.
//
// Seeded fixtures (no new rows): "Back Squat" / "Barbell Bench Press" are catalog
// lifts (every catalog lift has a guide, enforced by #733's completeness test);
// "E2E Dismiss Press" is a seeded NON-catalog strength exercise (e2e/seed-events.ts,
// the #449 plateau fixture) — it appears in the Strength explorer but has no guide.

// Pick an activity in the editor's exercise combobox (same shape-tolerant helper
// as entry-ergonomics.spec.ts: an exact match collapses the dropdown to a single
// 'Use "…"' button, so match by SUBSTRING).
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: name })
    .first() // first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
    .click();
}

test("the exercise detail panel shows a How-to guide for a catalog lift, and none for a custom lift (#734)", async ({
  page,
}) => {
  // Trends → Fitness renders the Strength explorer + exercise detail panel (same
  // host strength-standards.spec.ts drives). The desktop side panel is visible at
  // the 1280-wide e2e viewport.
  await page.goto("/trends?tab=fitness");
  const main = page.getByRole("main");

  // A COVERED catalog lift → the panel carries the "How to" section with setup
  // steps and the medical disclaimer.
  await main.getByRole("cell", { name: /Back Squat/ }).click();
  const guide = main.getByTestId("exercise-guide").first(); // first-ok: asserts an exercise guide renders — order-agnostic presence
  await expect(guide).toBeVisible();
  await expect(guide).toContainText("How to");
  await expect(guide).toContainText("Form reference, not medical advice");
  await expect(guide.getByTestId("guide-setup")).toBeVisible();
  await expect(guide.getByTestId("guide-execution")).toBeVisible();

  // A custom (non-catalog) strength exercise → NO how-to section (the accessor
  // returns undefined, so the section renders nothing).
  await main.getByRole("cell", { name: /E2E Dismiss Press/ }).click();
  // The panel itself still renders (the est-1RM stat proves it swapped); the
  // guide section is simply absent.
  await expect(main.getByText("Est. 1RM").first()).toBeVisible(); // first-ok: asserts an Est. 1RM readout renders — order-agnostic presence
  await expect(main.getByTestId("exercise-guide")).toHaveCount(0);
});

test("the strength set editor's ⓘ opens the shared guide overlay for a catalog lift (#734)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  // Open a fresh create form (fields addressed by testid/role — the editor mounts
  // in the dock or the overlay portal; see entry-ergonomics.spec.ts's note).
  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();

  // Pick a catalog lift with per-implement guide notes (Barbell Bench Press →
  // "bench press" guide, which carries a Barbell equipment note).
  await pickActivity(page, "Barbell Bench Press");

  // The ⓘ "How to" affordance renders for a catalog lift; open the overlay.
  const openGuide = page.getByTestId("exercise-guide-open").first(); // first-ok: the How-to affordance for the lift this spec picked — order-agnostic
  await expect(openGuide).toBeVisible();
  await openGuide.click();

  // The overlay is the shared ExerciseGuideSection inside a modal dialog.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("How to: Barbell Bench Press");
  const guide = dialog.getByTestId("exercise-guide");
  await expect(guide).toBeVisible();
  await expect(guide).toContainText("Form reference, not medical advice");
  await expect(guide.getByTestId("guide-setup")).toBeVisible();
  // Bench Press carries a Barbell-specific note; the overlay is scoped to the
  // selected implement, so its equipment-notes block shows the Barbell cue.
  await expect(guide.getByTestId("guide-equipment-notes")).toContainText(
    "Barbell"
  );

  // Close the overlay. Nothing was logged (no set filled), so the shared seed DB
  // is left untouched — no cleanup needed.
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
