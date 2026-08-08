import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { settledClick, settledFill } from "./helpers";
import { workerDbPath } from "./worker-env";

// Issue #838 — the injury layer. Logging a user-declared injury makes the shared
// recommendation model TRAIN AROUND the affected region and DISCLOSE why on the card
// ("Avoiding Chest (… injury)"), never silently; resolving the injury restores normal
// coaching. Coaching-tier: no notifications — this is a pure read/log surface.
//
// OWNS ITS FIXTURE (create-and-clean, #868): injuries is a brand-new table with no seed
// rows, and the spec logs its own injury on the default (admin/profile-1) session and
// wipes profile 1's injuries in beforeAll AND afterAll, so it never asserts against a
// shared-seed row and leaves the DB as it found it (the exclusion disclosure is derived
// purely from the active injury the test just logged, independent of seeded history).

function wipeInjuries(): void {
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare("DELETE FROM injuries WHERE profile_id = 1").run();
  } finally {
    db.close();
  }
}

test.beforeAll(() => wipeInjuries());
test.afterAll(() => wipeInjuries());

test("log an injury → recommendation avoids the region and names why → resolve → normal (#838)", async ({
  page,
}) => {
  // The injury bar lives on the Training → Overview tab (the Log tab is the default).
  await page.goto("/training?tab=overview");

  const bar = page.getByRole("main").getByTestId("injury-bar");
  await expect(bar).toBeVisible();

  // Open the quick-log form (a pure client toggle — no POST).
  await bar.getByTestId("injury-add-toggle").click();
  const form = bar.getByTestId("injury-form");
  await expect(form).toBeVisible();

  // Log a right-shoulder injury that puts Chest off the table.
  await form.getByTestId("injury-label-input").fill("right shoulder");
  await form.getByTestId("injury-region-Chest").check();
  await settledClick(page, form.getByTestId("injury-submit"));

  // The injury chip is listed as Active, naming Chest.
  const chip = bar
    .getByTestId("injury-chip")
    .filter({ hasText: "right shoulder" });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Active");
  await expect(chip).toContainText("Chest");

  // The recommendation disclosure NAMES the excluded region — never silent.
  const notes = page.getByRole("main").getByTestId("training-context-notes");
  await expect(notes).toBeVisible();
  await expect(page.getByTestId("injury-exclusion-note")).toContainText(
    "Avoiding Chest (right shoulder injury)"
  );

  // Resolve the injury — the record is kept but the exclusion lifts.
  await settledClick(page, chip.getByTestId("injury-set-resolved"));

  // The active chip is gone (resolved injuries drop out of the current list) and the
  // exclusion disclosure no longer names Chest — normal coaching resumes.
  await expect(
    bar.getByTestId("injury-chip").filter({ hasText: "right shoulder" })
  ).toHaveCount(0);
  await expect(page.getByTestId("injury-exclusion-note")).toHaveCount(0);
});

// Issue #2024 — the constraint can be declared at the level the user means. A
// MOVEMENT-scoped constraint takes out the affected pattern and DISCLOSES it per
// exercise, while the coarse region it falls under stays available: the whole point is
// that one sore press no longer costs every chest recommendation. Same create-and-clean
// discipline as the spec above (the beforeAll/afterAll wipe covers this test too).
test("a movement-scoped constraint narrows the exclusion and says so (#2024)", async ({
  page,
}) => {
  await page.goto("/training?tab=overview");

  const bar = page.getByRole("main").getByTestId("injury-bar");
  await expect(bar).toBeVisible();
  await bar.getByTestId("injury-add-toggle").click();
  const form = bar.getByTestId("injury-form");
  await expect(form).toBeVisible();

  // "Pressing hurts" — the region is Chest, but only the PUSH pattern is affected.
  await form.getByTestId("injury-label-input").fill("pressing pain");
  await form.getByTestId("injury-region-Chest").check();
  await form.getByTestId("injury-movement-push").check();
  await form.getByTestId("injury-laterality").selectOption("right");
  await settledClick(page, form.getByTestId("injury-submit"));

  // The chip names what the user actually declared — the pattern and the side — rather
  // than only the coarse region it falls back to.
  const chip = bar
    .getByTestId("injury-chip")
    .filter({ hasText: "pressing pain" });
  await expect(chip).toBeVisible();
  const scope = chip.getByTestId("injury-scope");
  await expect(scope).toContainText("Pushing");
  await expect(scope).toContainText("right side");

  // The WHOLE-REGION exclusion note is absent: a movement constraint does not take the
  // region off the table, which is the regression #2024 exists to fix.
  await expect(page.getByTestId("injury-exclusion-note")).toHaveCount(0);

  // Clean up so the file's other test (and a --repeat-each rerun) starts from zero.
  await settledClick(page, chip.getByTestId("injury-set-resolved"));
  await expect(
    bar.getByTestId("injury-chip").filter({ hasText: "pressing pain" })
  ).toHaveCount(0);
});

// Issue #2199 — the FINEST level of the #2024 precedence finally has a door. The picker
// writes into the `exercises` field the actions already accepted, at the identity the read
// side already expects: a variant collapses to its base on the way in (exerciseHistoryKey),
// and the stored key renders back in the catalog's own casing on the chip. An
// exercise-scoped constraint takes out THOSE lifts and leaves their region alone.
test("an exercise-scoped constraint is loggable from the form and names the lift (#2199)", async ({
  page,
}) => {
  await page.goto("/training?tab=overview");

  const bar = page.getByRole("main").getByTestId("injury-bar");
  await expect(bar).toBeVisible();
  await bar.getByTestId("injury-add-toggle").click();
  const form = bar.getByTestId("injury-form");
  await expect(form).toBeVisible();

  await form.getByTestId("injury-label-input").fill("tender elbow");
  await form.getByTestId("injury-region-Arms").check();

  // The picker is the shared Combobox, so the lift is found the way a user finds it:
  // typed, then chosen from the listbox by its accessible name. The pick lands as a
  // removable chip, not in the input. settledFill owns the hydration retry.
  const field = form.getByLabel("Add an affected lift");
  await settledFill(page, field, "Curl");
  const option = page
    .getByRole("listbox")
    .getByRole("button", { name: "Curl", exact: true });
  await expect(option).toBeVisible();
  await option.click();
  await expect(
    form.getByTestId("injury-exercise-chip").filter({ hasText: "Curl" })
  ).toBeVisible();

  // A typed VARIANT is offered as the base it collapses to — exerciseHistoryKey folds
  // "Dumbbell Curl" onto "curl", so the row promises exactly the lift the engine can
  // keep apart — and choosing it is therefore not a second constraint.
  await settledFill(page, field, "Dumbbell Curl");
  const collapsed = page
    .getByRole("listbox")
    .getByRole("button", { name: /^Use .Curl.$/ });
  await expect(collapsed).toBeVisible();
  await collapsed.click();
  await expect(form.getByTestId("injury-exercise-chip")).toHaveCount(1);

  // Naming lifts is the precedence-winning level, and the form says so before saving.
  await expect(form.getByTestId("injury-exercise-precedence")).toBeVisible();

  await settledClick(page, form.getByTestId("injury-submit"));

  // The saved constraint reads back at the level declared — the LIFT, in the catalog's
  // own casing, not the lowercase key it is stored as and not the Arms fallback.
  const chip = bar
    .getByTestId("injury-chip")
    .filter({ hasText: "tender elbow" });
  await expect(chip).toBeVisible();
  const scope = chip.getByTestId("injury-scope");
  await expect(scope).toContainText("Curl");
  await expect(scope).not.toContainText("Arms");

  // …and the whole-region exclusion never fires: naming one lift must not cost the user
  // every Arms recommendation.
  await expect(page.getByTestId("injury-exclusion-note")).toHaveCount(0);

  // Clean up so this file's other tests (and a --repeat-each rerun) start from zero.
  await settledClick(page, chip.getByTestId("injury-set-resolved"));
  await expect(
    bar.getByTestId("injury-chip").filter({ hasText: "tender elbow" })
  ).toHaveCount(0);
});
