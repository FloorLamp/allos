import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import { E2E_LOGIN_CYCLE, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Menstrual cycle tracking (issue #714): the Cycle surface (derived phase + cycle-length /
// variability trend), one-tap period logging, and the Timeline day-header phase/period
// chip. Deliberately tracking, not forecasting.
//
// Fixture-OWNED per e2e hygiene (#868): runs as E2E_LOGIN_CYCLE in its OWN cookie context
// on a dedicated adult profile seeded with three completed, roughly-regular periods (NO
// open period) plus one activity on a period day (so the Timeline renders a day + chip).
// The log/end/delete test is self-contained: it records the starting row count, mutates,
// then restores it, so --repeat-each stays clean. Interactions settle via settledClick.

// DateField DISPLAYS a friendly date while SUBMITTING the canonical ISO through a
// hidden input, so settledFill's same-field readback can't express the wait. Fill the
// visible field and settle on the hidden value instead, then dismiss the calendar
// popover (the cycle-guards precedent).
async function fillPeriodDate(
  page: Page,
  field: "start" | "end",
  iso: string
): Promise<void> {
  const form = page.getByTestId("cycle-add-form");
  const input = page.locator(`#cycle-${field}-new`);
  const hidden = form.locator(`input[type="hidden"][name="period_${field}"]`);
  await expect(input).toBeVisible();
  await expect(async () => {
    await input.fill(iso);
    await expect(hidden).toHaveValue(iso, { timeout: 2_000 });
  }).toPass({ timeout: 10_000, intervals: [200, 500, 1000] }); // topass-ok: hydration gate for a DateField whose display reformats a valid ISO, so a same-field value assertion can't express the wait (the #794 precedent)
  await input.press("Escape");
}

test.describe("menstrual cycle (#714)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_CYCLE,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("seeded cycles render the derived phase and the length trend", async () => {
    test.slow();
    await page.goto("/medical/cycles");
    const phase = page.getByTestId("cycle-current-phase");
    await expect(phase).toBeVisible();
    await expect(phase).toHaveText(/Menstrual|Follicular|Luteal/);

    await expect(page.getByTestId("cycle-trend")).toBeVisible();
    await expect(page.getByTestId("cycle-regularity")).toBeVisible();
    expect(
      await page.getByTestId("cycle-history-row").count()
    ).toBeGreaterThanOrEqual(3);
  });

  test("one-tap start → end withdraws the start CTA; 'Still bleeding' repairs it (#1681)", async () => {
    await page.goto("/medical/cycles");
    const rows = page.getByTestId("cycle-history-row");
    const before = await rows.count();

    // Start a period today.
    await settledClick(page, page.getByTestId("period-started-button"));
    await expect(page.getByTestId("period-ended-button")).toBeVisible();
    await expect(page.getByTestId("cycle-current-phase")).toHaveText(
      "Menstrual"
    );
    await expect(rows).toHaveCount(before + 1);

    // End it. The old control flipped straight back to "Period started today" —
    // a biologically meaningless action whose tap minted a back-to-back period.
    // Now the derived cycle state renders instead, with the recovery affordance.
    await settledClick(page, page.getByTestId("period-ended-button"));
    // The count is the server having revalidated into the ended state; the generous
    // window is for `next dev` under parallel workers (CI's production build settles fast).
    await expect(page.getByTestId("period-started-button")).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(page.getByTestId("cycle-state-line")).toBeVisible();
    await expect(page.getByTestId("period-reopen-button")).toBeVisible();

    // "Still bleeding" reopens the period just closed — the one-tap undo that makes
    // removing the wrong CTA safe.
    await settledClick(page, page.getByTestId("period-reopen-button"));
    await expect(page.getByTestId("period-ended-button")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("cycle-current-phase")).toHaveText(
      "Menstrual"
    );
    await expect(rows).toHaveCount(before + 1); // reopened, never duplicated

    // Cleanup: close it again, then delete the just-created (newest, first) row —
    // restoring the starting count AND the seeded state line / start CTA.
    await settledClick(page, page.getByTestId("period-ended-button"));
    await settledClick(page, page.getByTestId("cycle-delete-button").first()); // first-ok: deletes the cycle THIS spec is exercising (its own fixture data)
    await expect(rows).toHaveCount(before);
    await expect(page.getByTestId("period-started-button")).toBeVisible({
      timeout: 20_000,
    });
  });

  test("a stale page's start tap reports the refusal instead of toasting success (#1681)", async () => {
    // The unconditional-confirm bug in one screenshot: a page that still shows the
    // start CTA while a period has since been opened elsewhere. The tap writes
    // nothing, so it must SAY so.
    await page.goto("/medical/cycles");
    await expect(page.getByTestId("period-started-button")).toBeVisible();

    // A second tab of the same session opens a period behind this page's back.
    const other = await page.context().newPage();
    try {
      await other.goto("/medical/cycles");
      await settledClick(other, other.getByTestId("period-started-button"));
      await expect(other.getByTestId("period-ended-button")).toBeVisible();

      // The stale page's tap: refused, and reported as a refusal.
      await settledClick(page, page.getByTestId("period-started-button"));
      const alert = page.getByTestId("period-quick-actions").getByRole("alert");
      await expect(alert).toBeVisible({ timeout: 20_000 });
      await expect(alert).toContainText(/already open/);

      // Cleanup: close and delete the period this test created.
      await settledClick(other, other.getByTestId("period-ended-button"));
      await settledClick(
        other,
        other.getByTestId("cycle-delete-button").first() // first-ok: deletes the cycle THIS spec just created (its own fixture data)
      );
      await expect(other.getByTestId("period-started-button")).toBeVisible({
        timeout: 20_000,
      });
    } finally {
      await other.close();
    }
  });

  test("deleting a period offers Undo, and Undo restores the row (#2127)", async () => {
    // The row feeds cycle-length history and the forecast, so its delete is
    // restorable (#2127): the standard useUndoableDelete toast, the shared
    // undoDelete core — no bespoke path.
    await page.goto("/medical/cycles");
    const rows = page.getByTestId("cycle-history-row");
    const before = await rows.count();

    // A dated period far in the past — clear of the seeded recent history, so the
    // plausibility gate can't refuse it — marked with a unique note so this test
    // only ever targets its own fixture row.
    const note = `e2e undo period ${Date.now()}`; // clock-ok: unique-note suffix, never a stored timestamp
    const form = page.getByTestId("cycle-add-form");
    await fillPeriodDate(page, "start", "2024-01-01");
    await fillPeriodDate(page, "end", "2024-01-05");
    await form.getByLabel("Note (optional)").fill(note);
    await settledClick(page, form.getByRole("button", { name: "Add period" }));
    const row = rows.filter({ hasText: note });
    await expect(row).toBeVisible({ timeout: 20_000 });

    // Delete it: the toast offers Undo.
    await settledClick(page, row.getByTestId("cycle-delete-button"));
    await expect(row).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByText("Period deleted")).toBeVisible();

    // Undo restores the row (new id, same period) and the list re-renders it.
    await settledClick(page, page.getByRole("button", { name: "Undo" }));
    await expect(page.getByText("Restored.")).toBeVisible({ timeout: 20_000 });
    await expect(rows.filter({ hasText: note })).toBeVisible({
      timeout: 20_000,
    });
    await expect(rows).toHaveCount(before + 1);

    // Cleanup: delete the restored row (this test's own fixture data), restoring
    // the seeded count for --repeat-each.
    await settledClick(
      page,
      rows.filter({ hasText: note }).getByTestId("cycle-delete-button")
    );
    await expect(rows).toHaveCount(before, { timeout: 20_000 });
  });

  test("Timeline day header shows the cycle phase/period chip", async () => {
    await page.goto("/timeline");
    await expect(page.getByTestId("cycle-phase-chip").first()).toBeVisible(); // first-ok: asserts a cycle phase chip renders — order-agnostic presence
  });
});
