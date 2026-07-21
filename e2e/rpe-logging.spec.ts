import { test, expect, type Page } from "@playwright/test";
import { settledClick } from "./helpers";

// Issue #743: the optional per-set RPE selector round-trips through the activity
// form — log a set with a rating, reload the page, reopen the stored session, and
// the selector shows the persisted value. Driven end-to-end against the seeded DB.
//
// Fixture ownership (#868, docs/internals/e2e-hygiene.md failure class 1): the probe
// activity carries a UNIQUE per-run title and the spec keys every lookup/cleanup on
// it, so it owns its subject and a --repeat-each rerun (or a sibling spec) can't
// collide on a shared title. Two failure modes seen at retries=0 on PR #1110 (run
// 29837494962): (a) the half-point RPE hadn't durably saved before the reload, so
// the reloaded selector read "RPE" (not set) — fixed by settling each RPE step on
// its Server Action POST via settledClick before reloading; (b) a failed run left a
// probe behind — fixed by a start-of-test sweep that deletes any leftover probe.

const PROBE_PREFIX = "RPE round-trip probe";
let probeSeq = 0;

// Journal card(s) whose title contains `text`, scoped to the main content.
function cardsByTitle(page: Page, text: string | RegExp) {
  return page
    .getByRole("main")
    .locator('[id^="activity-"]')
    .filter({ hasText: text });
}

// Pick an activity in the editor's exercise combobox (same shape-tolerant matcher
// the entry-ergonomics / live-workout specs document).
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: name })
    .first()
    .click();
}

// Confirm the dialog-scoped Delete and await the captureDelete Server Action POST.
async function confirmDelete(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await settledClick(
    page,
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
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

test("RPE selector round-trips through the activity form (#743)", async ({
  page,
}) => {
  test.slow(); // local next dev compiles /training on first hit
  await sweepProbes(page);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  // Open a fresh CREATE editor from the journal actions toolbar.
  await page
    .getByTestId("journal-actions")
    .getByRole("button", { name: "New activity" })
    .click();

  const title = `${PROBE_PREFIX} ${Date.now()}-${++probeSeq}`;
  await page.getByRole("textbox", { name: "Activity name" }).fill(title);
  // Pick the fully-qualified variant, NOT the bare base "Bench Press": a bare
  // variant base needs a per-set equipment pick before it can save (#342), and the
  // frequency-ranked suggestion list reorders as sibling specs log activity, so a
  // bare-name best-match nondeterministically lands on the blocked base when the
  // full suite runs (save pauses → no persisted row → the spec times out).
  await pickActivity(page, "Barbell Bench Press");

  // Fill one complete working set (weight + reps) so the session auto-saves.
  // Retry the fills to ride out the hydration window: a value typed before the
  // form hydrates is silently dropped, which would leave the set incomplete and
  // the session unsaved (the full CI suite is slow enough to hit this).
  const weight = page.getByTestId("set1-weight");
  const reps = page.getByTestId("set1-reps-stepper").locator("input");
  await expect(async () => {
    await weight.fill("100");
    await reps.fill("5");
    await expect(weight).toHaveValue("100");
    await expect(reps).toHaveValue("5");
  }).toPass();

  // The complete set auto-saves. Assert the Delete button appears BEFORE touching
  // RPE — a stable signal the row was created (it stays once the row exists, unlike
  // the fading "Saved" check) — so each RPE step below is an UPDATE with no create
  // POST still in flight.
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();

  // The RPE selector is BLANK by default (logging RPE is never required).
  const rpe = page.getByTestId("set1-rpe");
  const rpeValue = page.getByTestId("set1-rpe-value");
  await expect(rpeValue).toHaveText("RPE");

  // Stepping up from blank seeds the default working rating; a second step nudges
  // it a half point. Each step fires a debounced autosave (a Server Action POST);
  // settledClick awaits that POST, so the half-point value is DURABLY persisted
  // before the reload below — closing the persist-before-reload race that made the
  // reloaded selector read "RPE" (not set) at retries=0 (PR #1110 run 29837494962).
  await settledClick(page, rpe.getByRole("button", { name: "Increase RPE" }));
  await expect(rpeValue).toHaveText("8");
  await settledClick(page, rpe.getByRole("button", { name: "Increase RPE" }));
  await expect(rpeValue).toHaveText("8.5");

  // Close the editor and RELOAD — the persisted rating must survive a fresh load.
  await page.keyboard.press("Escape");
  await page.goto("/training");

  const card = cardsByTitle(page, title);
  await expect(card).toBeVisible();

  // Reopen the stored session for edit by clicking its title.
  await card.getByRole("button", { name: title }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  // The RPE selector reloaded the persisted half-point value — the round-trip.
  await expect(page.getByTestId("set1-rpe-value")).toHaveText("8.5");

  // Cleanup: delete the probe row from the still-open editor (dialog-scoped
  // confirm), restoring the seed state for order-independent sibling specs. The
  // start-of-test sweep tolerates the case where a failed run skipped this.
  await confirmDelete(page);
  await expect(cardsByTitle(page, title)).toHaveCount(0);
});
