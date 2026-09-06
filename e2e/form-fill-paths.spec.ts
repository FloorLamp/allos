import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import {
  comboboxRows,
  deleteActivityFromForm,
  expectPhoneTapTargets,
  settledClick,
} from "./helpers";
import {
  E2E_LOGIN_FORM_DELOAD,
  E2E_LOGIN_FORM_PLATEAU,
  E2E_MEMBER_PASSWORD,
  FORM_PLATEAU_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// Issue #923 — the strength editor's two clickable fill paths + inline plateau hint,
// each driven against its OWN dedicated fixture (#868 hygiene):
//   1. Deload-aware next-set suggestion: on the FORM_DELOAD profile (active PPL routine
//      in its deload week + Bench history), the coached load is run through the shared
//      deloadAdjust — the Next-set card shows the deload rationale, and the ghost + Use
//      carry the shaved load. No drift from the Training-overview card (pinned pure).
//   2. Repeat last session: each Recent row states that session's literal sets as this
//      session's PLAN (FORM_PLATEAU's flat Skullcrusher, 30 kg × 8), which a confirm
//      turns into the record (#5373).
//   3. Inline plateau hint: the plateaued Skullcrusher shows a calm hint at load
//      selection; dismissing it through the shared bus silences the Training-watch
//      surface too.

// Pick an activity in the editor's exercise combobox (the exact-match dropdown collapses
// to a single 'Use "…"' button, a partial filter lists name+badge — match by substring).
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  // eslint-disable-next-line no-restricted-properties -- first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
  await comboboxRows(page).filter({ hasText: name }).first().click();
}

// Clear the FORM_PLATEAU profile's plateau dismissals so the hint is guaranteed present
// before a hint/dismiss assertion — regardless of retries or a prior run's dismiss
// against the shared seeded DB (the resetPreventiveFixture pattern from #206). Scoped to
// this fixture profile so it never touches profile 1's Skullcrusher plateau dismissals.
function resetFormPlateauDismissals(): void {
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const row = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(FORM_PLATEAU_PROFILE) as { id: number } | undefined;
    if (row)
      db.prepare(
        "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key LIKE 'training-obs:plateau:%'"
      ).run(row.id);
  } finally {
    db.close();
  }
}

async function openNewActivity(page: Page) {
  await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed
  await page
    .getByRole("main")
    .getByRole("button", { name: "Add activity" })
    .click();
}

// Delete the auto-saved draft so the shared fixture is left untouched across repeats.
// CRITICAL for repeat-safety: filling a set makes the part savable, and the debounced
// auto-save creates a NEW row. We must WAIT for the Delete button to appear (which only
// happens once that row has persisted) BEFORE deleting — otherwise remove() takes its
// no-row branch (just closes) and the pending unmount-flush save leaks an ORPHAN today
// session, which shifts the next repeat's suggestion seed.
//
// THE DISCARD ITSELF SETTLES ON THE SERVER (#3454). This used to end on
// `expect(activity-form).toBeHidden()`, which is a `setState` — true the instant the
// editor unmounts and silent about whether `deleteActivity` has run. The delete was
// therefore still in flight while the next test, and the shared-profile teardown
// guard, went looking. `deleteActivityFromForm` waits for the "Activity deleted."
// toast, which `useUndoableDelete` raises only after `await action(fd)` resolved, and
// takes it down again so it cannot intercept a later bottom-right click (#2861).
async function cleanUpDraft(page: Page) {
  const del = page.getByRole("button", { name: "Delete", exact: true });
  await expect(del).toBeVisible();
  await deleteActivityFromForm(page, { trigger: del });
}

test("deload week shaves the routine lift's next-set suggestion (#923)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_FORM_DELOAD,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await openNewActivity(page);
    // Barbell Bench Press is a Push-day slot (a routine lift) with prior history: the
    // progression holds 100 kg, the deload week shaves it to ~90 kg.
    await pickActivity(page, "Barbell Bench Press");

    // The Next-set card carries the shared deload rationale + the shaved load, not the
    // full progression.
    const card = page.getByTestId("next-set-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Deload week");
    await expect(card).toContainText("90");

    // Add activity is a desktop entry point. Resize only after that real flow
    // mounted and populated the editor, immediately before measuring the migrated
    // phone target.
    await page.setViewportSize({ width: 390, height: 844 });
    const plateSuggestion = card.getByRole("button", {
      name: "Load these plates on the bar",
    });
    await expect(plateSuggestion).toHaveAttribute("data-icon-button", "");
    await expectPhoneTapTargets(page, "suggested-load plate builder", [
      plateSuggestion,
    ]);

    // The set-1 ghost placeholder shows the SAME shaved load (auto-seed, #335).
    const weight = page.getByTestId("set1-weight");
    await expect(weight).toHaveAttribute("placeholder", /^90/);

    // Use fills the shaved load into the set (create-and-clean, mirroring #335).
    await card.getByRole("button", { name: "Use" }).click();
    await expect(weight).toHaveValue(/^90/);

    await cleanUpDraft(page);
  } finally {
    await page.close();
  }
});

// #1115 Fix B — the exercise-detail / Analyze panel is exactly where the "Today's
// workout" nudge's "How to" button deep-links, so on a deload week it must seed the
// SAME shaved load the nudge frames — not the full progression (the "clearest bug" the
// issue calls out). The panel now routes its next-set through the shared
// contextualNextSet, so the FORM_DELOAD fixture's Bench shows the deload load here too.
test("the Analyze detail panel seeds the deload-shaved next-set (#1115 Fix B)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_FORM_DELOAD,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto(
      "/training?tab=analyze&kind=strength&item=Barbell%20Bench%20Press"
    );
    // The panel's Next-set card carries the SHARED deload rationale + shaved load (90),
    // not the full 100 kg progression the un-tempered panel used to seed — the same card
    // (testid next-set-card) the live logger renders, so the reason is visible on both
    // surfaces (#221 parity: a deload the user can see the number for but not the reason
    // would be its own mini-gap).
    const card = page.getByTestId("next-set-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("90");
    await expect(card).toContainText(/deload/i);
  } finally {
    await page.close();
  }
});

test("each Recent row repeats that session into the set editor (#923)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_FORM_PLATEAU,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await openNewActivity(page);
    // Skullcrusher has several logged sessions (30 kg × 8 × 3); each Recent row is a
    // "repeat this session" fill while the part is pristine.
    await pickActivity(page, "Skullcrusher");

    const recent = page.getByTestId("recent-sessions");
    await expect(recent).toBeVisible();
    // Tap the STATED line's Fill — the primary "repeat last session" gesture, and
    // since #5370 the only history row on the default view (the rest are behind the
    // chevron, still a tap away and still fills).
    await recent.getByTestId("recent-session-fill").first().click(); // eslint-disable-line no-restricted-properties -- first-ok: prefills from the most-recent session (this spec's own logged session) — order-agnostic

    // The set editor now states that session's LITERAL work (30 kg × 8) as this
    // session's PLAN (#5373): a repeat replaces the ghosts, not the record, so the
    // numbers are painted in the placeholder and nothing is written until a row is
    // confirmed. Distinct from the coached suggestion, which would build a rep to 9.
    const load = page.getByTestId("set1-weight");
    await expect(load).toHaveValue("");
    await expect(load).toHaveAttribute("placeholder", "30");
    const reps = page.getByTestId("set1-reps-stepper").getByRole("spinbutton");
    await expect(reps).toHaveValue("");
    await expect(reps).toHaveAttribute("placeholder", "8");
    // Confirming row 1 turns the plan it states into the record.
    const row1 = page.getByTestId("set-row-1"); // testid-scope-ok: the set grid is inside the held editor overlay, one copy
    await row1.getByTestId("set-confirm-1").click();
    await expect(load).toHaveValue("30");
    await expect(reps).toHaveValue("8");

    await cleanUpDraft(page);
  } finally {
    await page.close();
  }
});

test("a plateaued lift shows the inline plateau hint (#923)", async ({
  browser,
}) => {
  resetFormPlateauDismissals();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_FORM_PLATEAU,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await openNewActivity(page);
    await pickActivity(page, "Skullcrusher");

    // The note rides behind the history line's fold since #5370 — one tap, and the
    // chevron is what states there is something behind it.
    await page.getByTestId("recent-more-toggle").click(); // testid-scope-ok: the exercise block's history fold in the open editor, one copy
    const hint = page.getByTestId("plateau-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(/flat ~6 weeks/i);

    // Open/pick on the desktop surface that owns the entry flow; the target's
    // phone geometry is the only thing this resize is meant to exercise.
    await page.setViewportSize({ width: 390, height: 844 });
    const dismiss = hint.getByTestId("plateau-hint-dismiss");
    await expect(dismiss).toHaveAttribute("data-icon-button", "");
    await expectPhoneTapTargets(page, "plateau-hint dismissal", [dismiss]);
  } finally {
    await page.close();
  }
});

// Training-watch rows on Training → Overview: the capped-open slice and the "show
// all" overflow slice carry different testids since the #1496 rollup, and a finding
// can legitimately be in either.
const TRAINING_FINDING_ITEM = /^training-findings(-more)?-item$/;

test("dismissing the form's plateau hint silences it on Training → Overview (#923)", async ({
  browser,
}) => {
  resetFormPlateauDismissals();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_FORM_PLATEAU,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // The Training-watch card shows the Skullcrusher plateau to begin with. Since
    // #1496 that card caps at three rows + a "show all" disclosure, so match BOTH the
    // open rows and the overflow ones — the assertion is about the finding existing,
    // not about which slice of the cap it happened to land in.
    await page.goto("/training?tab=overview");
    await expect(
      page
        .getByTestId(TRAINING_FINDING_ITEM)
        .filter({ hasText: "Skullcrusher" })
    ).toHaveCount(1);

    // Dismiss it from the FORM's inline hint (same dedupeKey → shared suppression bus).
    await openNewActivity(page);
    await pickActivity(page, "Skullcrusher");
    await page.getByTestId("recent-more-toggle").click(); // testid-scope-ok: the exercise block's history fold in the open editor, one copy
    const hint = page.getByTestId("plateau-hint");
    await expect(hint).toBeVisible();
    await settledClick(page, hint.getByTestId("plateau-hint-dismiss"));
    await expect(hint).toBeHidden();

    // Back on Training → Overview the plateau finding is gone too (the dismissal wrote
    // to the shared suppression bus under the same dedupeKey the card reads).
    await page.goto("/training?tab=overview");
    await expect(
      page
        .getByTestId(TRAINING_FINDING_ITEM)
        .filter({ hasText: "Skullcrusher" })
    ).toHaveCount(0);
  } finally {
    await page.close();
  }
});
