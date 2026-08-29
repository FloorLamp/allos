import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import {
  closePartOptions,
  comboboxRows,
  hydratedClick,
  openPartOptions,
  setRpeColumn,
  settledClick,
  settledFill,
} from "./helpers";

// Issue #743: the optional per-set RPE selector round-trips through the activity
// form — log a set with a rating, reload the page, reopen the stored session, and
// the selector shows the persisted value. Driven end-to-end against the seeded DB.
// Issue #3335: and the column is not there at all until you ask for it.
//
// #3335 made the column OPT-IN, so this spec now owns three claims the round-trip
// alone never made:
//
//   1. The set grid has no effort column for a profile that never opted in, and the
//      opt-in is one tap inside the editor — no settings trip.
//   2. Opting back OUT hides the column; it does not delete what was logged. The
//      proof needs a REAL SAVE while the column is hidden (the reps edit below), or
//      it passes vacuously — no save, nothing to lose.
//   3. The set row's tab order is IDENTICAL with the column on and off. That is what
//      "a conditional column must not strand tab order" means, and it is the reason
//      both stepper buttons carry tabIndex={-1}.
//
// FIXTURE POSITION (#3226's rule): no e2e seed writes exercise_sets.rpe, so every
// login here starts on the OPTED-OUT side of the new boundary. Each test that turns
// the column on turns it back off before it leaves, because the opt-in row is
// profile-scoped and outlives the spec — a leaked row would put an extra control in
// the set-options band that the phone-geometry specs measure.
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

// Training Log row(s) whose title contains `text`, scoped to the main content.
// The feed renders slim rows (#2897); the row button owns the #activity-N anchor.
function cardsByTitle(page: Page, text: string | RegExp) {
  return page
    .getByRole("main")
    .locator('[id^="activity-"]')
    .filter({ hasText: text });
}

// Open the stored session's canonical page, then launch its shared workspace.
async function openEditorFromRow(page: Page, row: Locator): Promise<void> {
  await hydratedClick(
    page,
    row.getByRole("link").first() // first-ok: the canonical title link precedes any exercise links in the row
  );
  await page
    .getByTestId("training-activity-page")
    .getByTestId("activity-page-edit")
    .click();
}

// Pick an activity in the editor's exercise combobox (same shape-tolerant matcher
// the entry-ergonomics / live-workout specs document).
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await comboboxRows(page)
    .filter({ hasText: name })
    .first() // first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
    .click();
}

// Confirm the dialog-scoped Delete and await the captureDelete Server Action POST.
async function confirmDelete(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await settledClick(
    page,
    page
      .getByTestId("confirm-dialog")
      .getByRole("button", { name: "Delete", exact: true })
  );
}

// Wait on the DEBOUNCED activity autosave by its OWN payload. Hoisted out of the
// round-trip test because the opt-out claim needs it too: matching on the
// `next-action` header alone still matches /training's background toaster poll, and
// a poller response resolving the wait early is how the #1189 census read a stale
// value back (see the long note at its original call site below).
function savePostWith(page: Page, marker: RegExp) {
  return page.waitForResponse(
    (r) => {
      if (r.request().method() !== "POST") return false;
      if (r.request().headers()["next-action"] == null) return false;
      if (!r.ok()) return false;
      const body = r.request().postData();
      return body != null && marker.test(body);
    },
    { timeout: 15_000 }
  );
}

// Sweep away any lingering probe cards from a prior FAILED run so the shared list
// stays clean (idempotent: a no-op when none exist). Every PROBE_PREFIX card is
// this spec's own fixture, so deleting them all is safe and order-agnostic.
async function sweepProbes(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/training?tab=log");
  const probes = cardsByTitle(page, PROBE_PREFIX);
  for (let guard = 0; guard < 12; guard++) {
    const n = await probes.count();
    if (n === 0) break;
    const row = probes.first(); // first-ok: every PROBE_PREFIX row is this spec's own leftover; cleanup is order-agnostic
    await openEditorFromRow(page, row);
    await confirmDelete(page);
    await page.goto("/training?tab=log");
    await expect(probes).toHaveCount(n - 1);
  }
}

test("RPE selector round-trips through the activity form (#743)", async ({
  page,
}) => {
  test.slow(); // local next dev compiles /training on first hit
  await sweepProbes(page);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed

  // Open a fresh CREATE editor from the Training page-header action.
  await page.getByTestId("training-log-add-activity").click();

  const title = `${PROBE_PREFIX} ${Date.now()}-${++probeSeq}`; // clock-ok: unique probe-name suffix, never a stored timestamp
  await page.getByRole("textbox", { name: "Activity name" }).fill(title);
  // Pick the fully-qualified variant, NOT the bare base "Bench Press": a bare
  // variant base needs a per-set equipment pick before it can save (#342), and the
  // frequency-ranked suggestion list reorders as sibling specs log activity, so a
  // bare-name best-match nondeterministically lands on the blocked base when the
  // full suite runs (save pauses → no persisted row → the spec times out).
  await pickActivity(page, "Barbell Bench Press");

  // Fill one complete working set (weight + reps) so the session auto-saves.
  // settledFill waits for the controlled inputs to hydrate before filling (a
  // pre-hydration fill is reverted and the set stays incomplete — the #1188
  // class; this block predates the helper and hand-rolled the same wait).
  const weight = page.getByTestId("set1-weight");
  const reps = page.getByTestId("set1-reps-stepper").locator("input");
  await settledFill(page, weight, "100");
  await settledFill(page, reps, "5");

  // The complete set auto-saves. Assert the Delete button appears BEFORE touching
  // RPE — a stable signal the row was created (it stays once the row exists, unlike
  // the fading "Saved" check) — so each RPE step below is an UPDATE with no create
  // POST still in flight.
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();

  // OPTED OUT: there is no effort column at all (#3335). Measured against a PRESENT
  // peer in the same band — the warm-up toggle — so this is "the options column
  // rendered and the effort control is not in it", not "nothing has rendered yet".
  // A bare retrying toHaveCount(0) would be satisfied by a set grid that had not
  // arrived, which is the failure this assertion exists to distinguish.
  await setRpeColumn(page, false);
  await expect(page.getByTestId("set1-warmup")).toBeVisible();
  await expect(page.getByTestId("set1-rpe")).toHaveCount(0);

  // Opt in, from the editor's own options row — one tap, no settings trip.
  await setRpeColumn(page, true);

  // RPE's expansion is information, not mouse chrome: the shared info affordance
  // exposes it by click/tap before a person decides whether to record the field. It
  // rides beside the opt-in, so since #3349 it is behind the part's fact chips too.
  await openPartOptions(page, 0);
  await page.getByTestId("rpe-help").click();
  await expect(page.getByRole("tooltip")).toContainText(
    "RPE means rate of perceived exertion"
  );
  // ESCAPE COMPOSES, which is the contract three nested layers share (#3222/#3409):
  // the first one belongs to the tooltip, and the editor it is inside stays open. If
  // it ever closed the panel instead, this next line is where that would surface.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("part-options-editor")).toBeVisible();
  await closePartOptions(page);

  // The RPE selector is BLANK by default (logging RPE is never required).
  const rpe = page.getByTestId("set1-rpe");
  const rpeValue = page.getByTestId("set1-rpe-value");
  await expect(rpeValue).toHaveText("RPE");

  // Stepping up from blank seeds the default working rating (8); a second step
  // nudges it a half point (8.5). Each step fires a debounced (700ms) autosave
  // Server Action POST whose FormData carries the sets JSON — so each waiter
  // matches the save by its OWN PAYLOAD ("rpe":8 / "rpe":8.5 in the body), never
  // a bystander. The prior next-action-header-only filter still matched /training's
  // background action-POST traffic (the ~6s doc/import toaster poll — the exact
  // bystander hazard settledClick's doc warns about): a poller response resolved
  // the wait EARLY, the spec navigated during the still-debouncing save, and the
  // hard goto ABORTED it — the census read back "8" because the 8.5 save never
  // fired, not because it lost a race (post-#1189 census, run 29925360046). Armed
  // BEFORE the click so the response can't be missed.
  // (savePostWith is hoisted to module scope — the opt-out claim below needs it too.)
  // "rpe":8 must not also match "rpe":8.5 — anchor the following delimiter.
  const firstSaved = savePostWith(page, /"rpe":8[,}]/);
  await rpe.getByRole("button", { name: "Increase RPE" }).click();
  await expect(rpeValue).toHaveText("8");
  await firstSaved;
  // The half-point save, matched by its own payload the same way, so 8.5 is
  // DURABLY persisted (the action response completes server-side) before the
  // Escape + reload below.
  const halfPointSaved = savePostWith(page, /"rpe":8\.5[,}]/);
  await rpe.getByRole("button", { name: "Increase RPE" }).click();
  await expect(rpeValue).toHaveText("8.5");
  await halfPointSaved;

  // Close the editor and RELOAD — the persisted rating must survive a fresh load.
  // 8.5 is committed above, so a single reload reads it (the toPass is a cheap
  // guard against a slow reopen render, not the persistence race the await closed).
  await page.keyboard.press("Escape");
  await expect(async () => {
    await page.goto("/training?tab=log");
    const row = cardsByTitle(page, title);
    await expect(row).toBeVisible();
    // Reopen the stored session for edit via its row → the pane's Edit.
    await openEditorFromRow(page, row);
    await expect(page.getByLabel("Activity name")).toHaveValue(title);
    // The RPE selector reloaded the persisted half-point value — the round-trip.
    await expect(page.getByTestId("set1-rpe-value")).toHaveText("8.5");
  }).toPass({ timeout: 20_000 }); // topass-ok: reopen-until-persisted: re-goto + reopen the stored session until the persisted half-point RPE renders — a reload-until-rendered nav, no single awaitable event

  // OPTING BACK OUT HIDES THE COLUMN; IT IS NOT A DELETE (#3335). Migrating a
  // shipped behaviour to opt-in must not take away what people already logged, and
  // the write boundary is deliberately blind to the opt-in for exactly this reason
  // (canonicalRpe takes no tracking — lib/rpe.ts).
  await setRpeColumn(page, false);
  await expect(page.getByTestId("set1-rpe")).toHaveCount(0);

  // THE SAVE IS THE WHOLE TEST. Turning the column off writes no activity, so
  // asserting straight after it would pass against a build that nulls RPE on every
  // save — nothing would have saved. So make a real edit with the column hidden
  // (5 reps → 6) and wait for the autosave that carries the full sets payload. If
  // the hidden column meant a dropped rating, this is the POST that drops it.
  const savedWithoutColumn = savePostWith(page, /"reps":6[,}]/);
  await settledFill(
    page,
    page.getByTestId("set1-reps-stepper").locator("input"),
    "6"
  );
  await savedWithoutColumn;

  // Opt back in: the rating logged before the column went away is still 8.5.
  await setRpeColumn(page, true);
  await expect(page.getByTestId("set1-rpe-value")).toHaveText("8.5");

  // Leave the profile on the side of the boundary every seed puts it on, so a
  // sibling spec measuring the set-options band sees the band it expects.
  await setRpeColumn(page, false);

  // Cleanup: delete the probe row from the still-open editor (dialog-scoped
  // confirm), restoring the seed state for order-independent sibling specs. The
  // start-of-test sweep tolerates the case where a failed run skipped this.
  await confirmDelete(page);
  await page.goto("/training?tab=log");
  await expect(cardsByTitle(page, title)).toHaveCount(0);
});

// #3335's keyboard clause: "a column that appears conditionally must not strand tab
// order." The check that actually means that is an EQUALITY — walk the set row with
// the column off, walk it again with the column on, and get the same stops in the
// same order. An absolute list would pass a build where the column swallowed the
// reps input, as long as the list was written to match.
//
// It holds because both stepper buttons carry tabIndex={-1}: the VALUES are the tab
// stops and the steppers are pointer sugar, so the column adds nothing to the
// sequence and removing it takes nothing away. Delete either tabIndex and this test
// is the one that says so.
//
// Nothing is filled: an incomplete set never auto-saves, so this test owns no
// persisted data and needs no cleanup beyond putting the opt-in back.
test("the set row's tab order is the same with the effort column on and off (#3335)", async ({
  page,
}) => {
  test.slow(); // local next dev compiles /training on first hit

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/training?tab=log");
  await page.getByTestId("training-log-add-activity").click();
  await pickActivity(page, "Barbell Bench Press");

  // How a focused control names itself: its testid, else its accessible label, else
  // its tag. Reported rather than compared inside the browser so a mismatch prints
  // BOTH sequences — a bare "not equal" on a tab walk tells you nothing about where
  // it diverged, and this is the assertion someone will be reading on a red.
  const walk = async (steps: number): Promise<string[]> => {
    await page.getByTestId("set1-weight").focus();
    const seen: string[] = [];
    for (let i = 0; i < steps; i += 1) {
      seen.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el) return "(none)";
          return (
            el.dataset.testid ??
            el.getAttribute("aria-label") ??
            el.tagName.toLowerCase()
          );
        })
      );
      await page.keyboard.press("Tab");
    }
    return seen;
  };

  await setRpeColumn(page, false);
  await expect(page.getByTestId("set1-rpe")).toHaveCount(0);
  const withoutColumn = await walk(5);
  // The walk reached real controls — a sequence of "(none)" would compare equal to
  // itself and prove nothing (the no-op mutant #3334 shipped and had to withdraw).
  expect(withoutColumn[0]).toBe("set1-weight");
  expect(new Set(withoutColumn).size).toBeGreaterThan(1);

  await setRpeColumn(page, true);
  await expect(page.getByTestId("set1-rpe")).toBeVisible();
  const withColumn = await walk(5);

  expect(
    withColumn,
    `the effort column changed the set row's tab order:\n  off: ${withoutColumn.join(
      " → "
    )}\n   on: ${withColumn.join(" → ")}`
  ).toEqual(withoutColumn);

  // Back to the side of the boundary every seed puts this profile on.
  await setRpeColumn(page, false);
  await page.keyboard.press("Escape");
});
