import { expect, type Locator, type Page } from "@playwright/test";
import { hydratedClick } from "./helpers";

// Shared drivers for the /medical/cycles dated add form, used by every spec that writes
// through it (cycle.spec, cycle-guards.spec). ONE flow, no per-spec drift.
//
// This module exists because #2583 was about to make a duplication worse:
// `fillPeriodDate` was already copy-pasted verbatim into both specs, and folding the
// form behind a disclosure adds a second step every one of those call sites needs. Two
// copies of two steps is where a per-spec settle divergence starts, so both moved here.

// The dated add form is behind <AddEntryPanel> since #2583 (the #1497 rare-cadence-entry
// rule), so a spec that drives it opens it first.
//
// Called after EVERY `goto`, never once per file: the panel's open state is client state
// with `useState(false)`, so a fresh document always arrives collapsed. It asserts the
// collapsed precondition rather than tolerating either state, because a helper that
// silently accepts "already open" would let the fold quietly stop happening and every
// spec would still pass. `hydratedClick` (not `settledClick`) because opening the panel
// fires no Server Action — and a toggle is the non-idempotent case a retry loop must not
// touch.
export async function openAddPeriodPanel(page: Page): Promise<Locator> {
  const panel = page.getByTestId("cycle-add-panel");
  await expect(panel).toHaveAttribute("data-open", "false");
  await hydratedClick(page, page.getByTestId("cycle-add-panel-toggle"));
  await expect(panel).toHaveAttribute("data-open", "true");
  const form = page.getByTestId("cycle-add-form");
  await expect(form).toBeVisible();
  return form;
}

// DateField DISPLAYS a friendly date ("Jun 15, 2026") while SUBMITTING the canonical ISO
// through a hidden input, so settledFill's same-field readback can't express the wait.
// Fill the visible field and settle on the hidden value instead — only React state can
// produce it, so it is the same hydration guarantee, read where the form actually reads
// it. Then dismiss the calendar popover, which otherwise floats over the submit button.
export async function fillPeriodDate(
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
