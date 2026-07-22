import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_FORM_INJURY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Issue #1144 — the residual cross-surface divergence #1115 left open on the INJURY axis.
// #1115 routed every server-resolved next-set surface (coaching card, Training-overview
// session card, Analyze/detail panel) through the shared contextualNextSet so they compose
// BOTH the deload shave and the recovering-injury 0.6× temper (#838). The live logger's
// client tree only received `deloadContext`, not the recovering-region set, so OUTSIDE a
// deload week a recovering-injury lift seeded the UN-tempered progression in the form while
// the Analyze deep-link recommended the tempered load. This spec pins that, on the
// dedicated FORM_INJURY fixture (a RECOVERING Chest injury + Barbell Bench Press history,
// NO routine → not a deload week), both surfaces now seed the SAME tempered 60 kg
// (100 kg progression × RECOVERING_LOAD_FACTOR 0.6) — the #221 "same answer everywhere".

// Pick an activity in the editor's exercise combobox (match by substring).
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: name })
    .first() // first-ok: the exercise combobox dropdown on this spec's own FORM_INJURY session (mirrors form-fill-paths' pickActivity)
    .click();
}

async function openNewActivity(page: Page) {
  await page.goto("/training"); // default "Log" tab renders the Journal feed
  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();
}

// Delete the auto-saved draft so the shared fixture is left untouched across repeats
// (mirrors the FORM_DELOAD spec's cleanUpDraft): wait for the persisted row's Delete
// button, delete it, then assert the form closed so the unmount flush can't re-create it.
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

test("live logger tempers a recovering-injury lift's next-set outside a deload week (#1144)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_FORM_INJURY,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await openNewActivity(page);
    // Barbell Bench Press is a Chest lift with prior history; the recovering Chest injury
    // backs the 100 kg progression down to 60 kg. NO routine → this is NOT a deload week,
    // so the injury temper is the ONLY modifier (the axis #1115 left open).
    await pickActivity(page, "Barbell Bench Press");

    // The Next-set card carries the injury rationale + the tempered load, not the full
    // progression — and NOT the deload rationale (the profile has no cycle).
    const card = page.getByTestId("next-set-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText(/easing back from injury/i);
    await expect(card).toContainText("60");
    await expect(card).not.toContainText(/deload/i);

    // The set-1 ghost placeholder shows the SAME tempered load (auto-seed, #335).
    const weight = page.getByTestId("set1-weight");
    await expect(weight).toHaveAttribute("placeholder", /^60/);

    // Use fills the tempered load into the set (create-and-clean, mirroring #335).
    await card.getByRole("button", { name: "Use" }).click();
    await expect(weight).toHaveValue(/^60/);

    await cleanUpDraft(page);
  } finally {
    await page.close();
  }
});

// The Analyze detail panel is the deep-link target the "Today's workout" nudge points at,
// so it must seed the SAME tempered load the live logger now does. Before #1144 the panel
// already tempered (via contextualNextSet) while the form did not — this pins that they
// finally AGREE on the injury axis (the same next-set-card testid on both surfaces).
test("the Analyze detail panel seeds the SAME injury-tempered next-set (#1144)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_FORM_INJURY,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto(
      "/training?tab=analyze&kind=strength&item=Barbell%20Bench%20Press"
    );
    const card = page.getByTestId("next-set-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("60");
    await expect(card).toContainText(/easing back from injury/i);
  } finally {
    await page.close();
  }
});
