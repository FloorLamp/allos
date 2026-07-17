import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_LOGIN_FORM_DELOAD,
  E2E_LOGIN_FORM_PLATEAU,
  E2E_MEMBER_PASSWORD,
  FORM_PLATEAU_PROFILE,
} from "./fixture-logins";

// Issue #923 — the strength editor's two clickable fill paths + inline plateau hint,
// each driven against its OWN dedicated fixture (#868 hygiene):
//   1. Deload-aware next-set suggestion: on the FORM_DELOAD profile (active PPL routine
//      in its deload week + Bench history), the coached load is run through the shared
//      deloadAdjust — the Next-set card shows the deload rationale, and the ghost + Use
//      carry the shaved load. No drift from the Training-overview card (pinned pure).
//   2. Repeat last session: each Recent row fills the set editor with that session's
//      literal sets (FORM_PLATEAU's flat Skullcrusher, 30 kg × 8).
//   3. Inline plateau hint: the plateaued Skullcrusher shows a calm hint at load
//      selection; dismissing it through the shared bus silences the Training-watch
//      surface too.

// Pick an activity in the editor's exercise combobox (the exact-match dropdown collapses
// to a single 'Use "…"' button, a partial filter lists name+badge — match by substring).
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: name })
    .first()
    .click();
}

// Clear the FORM_PLATEAU profile's plateau dismissals so the hint is guaranteed present
// before a hint/dismiss assertion — regardless of retries or a prior run's dismiss
// against the shared seeded DB (the resetPreventiveFixture pattern from #206). Scoped to
// this fixture profile so it never touches profile 1's Skullcrusher plateau dismissals.
function resetFormPlateauDismissals(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
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
  await page.goto("/training"); // default "Log" tab renders the Journal feed
  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();
}

// Delete the auto-saved draft so the shared fixture is left untouched across repeats.
// CRITICAL for repeat-safety: filling a set makes the part savable, and the debounced
// auto-save creates a NEW row. We must WAIT for the Delete button to appear (which only
// happens once that row has persisted) BEFORE deleting — otherwise remove() takes its
// no-row branch (just closes) and the pending unmount-flush save leaks an ORPHAN today
// session, which shifts the next repeat's suggestion seed. Then assert the form closed,
// so the flush can't re-create the row mid-teardown (remove() guards its signature).
async function cleanUpDraft(page: Page) {
  const del = page.getByRole("button", { name: "Delete", exact: true });
  await expect(del).toBeVisible();
  await del.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(page.getByTestId("activity-form")).toBeHidden();
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
    // Tap the newest row's Fill — the primary "repeat last session" gesture.
    await recent.getByTestId("recent-session-fill").first().click();

    // The set editor is filled with the session's LITERAL work (30 kg × 8), distinct
    // from the coached suggestion (which would build a rep to 9).
    await expect(page.getByTestId("set1-weight")).toHaveValue("30");
    await expect(
      page.getByTestId("set1-reps-stepper").getByRole("spinbutton")
    ).toHaveValue("8");

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

    const hint = page.getByTestId("plateau-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(/flat ~6 weeks/i);
  } finally {
    await page.close();
  }
});

test("dismissing the form's plateau hint silences it on Training → Overview (#923)", async ({
  browser,
}) => {
  resetFormPlateauDismissals();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_FORM_PLATEAU,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // The Training-watch card shows the Skullcrusher plateau to begin with.
    await page.goto("/training?tab=overview");
    await expect(
      page
        .getByTestId("training-findings-item")
        .filter({ hasText: "Skullcrusher" })
    ).toBeVisible();

    // Dismiss it from the FORM's inline hint (same dedupeKey → shared suppression bus).
    await openNewActivity(page);
    await pickActivity(page, "Skullcrusher");
    const hint = page.getByTestId("plateau-hint");
    await expect(hint).toBeVisible();
    await settledClick(page, hint.getByTestId("plateau-hint-dismiss"));
    await expect(hint).toBeHidden();

    // Back on Training → Overview the plateau finding is gone too (the dismissal wrote
    // to the shared suppression bus under the same dedupeKey the card reads).
    await page.goto("/training?tab=overview");
    await expect(
      page
        .getByTestId("training-findings-item")
        .filter({ hasText: "Skullcrusher" })
    ).toHaveCount(0);
  } finally {
    await page.close();
  }
});
