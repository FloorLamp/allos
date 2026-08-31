import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import {
  comboboxRows,
  deleteActivityFromForm,
  expectNoClippedContent,
  settledBoxes,
  settledFill,
} from "./helpers";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";
import { TAP_FLOOR_PX } from "@/lib/tap-floor-tokens";

// Issue #1613 — the activity form's sticky exercise header at phone width.
//
// It used to be ONE non-wrapping row: the name combobox plus three activity
// actions (move up / move down / remove). At 390px the actions took ~110px off
// the combobox, the combobox spends another 36 + 144px on its search icon and
// its muscle-badge/clear reserve, and "Barbell Bench Press" rendered as
// "Barbell Bench Pre". The actions themselves were 28–32px — under a phone
// touch target — and the exercise guide consumed yet another, mostly empty,
// right-aligned row below.
//
// The contract now: below `sm` the header is TWO rows. The combobox owns the
// whole first row (badge and clear intact); "How to" plus the reorder/remove
// actions share one second-row toolbar, each at least 44×44. From `sm` up the
// header is the single compact row it always was, so this lives in the mobile
// project (by filename) and asserts geometry rather than a pixel snapshot.
//
// Fixture hygiene (#868): the spec builds its own two-part draft and deletes the
// row it auto-saves, so it owns everything it touches.

async function pickActivity(
  page: Page,
  field: Locator,
  name: string
): Promise<void> {
  await field.fill(name);
  await comboboxRows(page)
    .filter({ hasText: name })
    .first() // first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
    .click();
}

async function box(locator: Locator) {
  await expect(locator).toBeVisible();
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

// Delete the auto-saved draft (the completed set makes the activity savable, so
// the debounced autosave creates a row). Waiting for the Delete button is what
// proves the row exists before removing it — see form-fill-paths' note.
//
// The discard itself goes through `deleteActivityFromForm` (#3454): the form going
// away is a `setState`, so `toBeHidden()` was satisfied by the browser alone and the
// DELETE it started was still in flight when the test — and the shared-profile
// teardown guard — moved on.
async function cleanUpDraft(page: Page): Promise<void> {
  const del = page.getByRole("button", { name: "Delete", exact: true });
  await expect(del).toBeVisible();
  await deleteActivityFromForm(page, { trigger: del });
}

test("a multi-part exercise header reads and taps at 390px (#1613)", async ({
  page,
}) => {
  await page.goto("/training?tab=log");
  const sheet = await openLogSheet(page);
  await (await showLogRow(sheet, "log-activity")).click();

  const firstName = page.getByPlaceholder(/What did you do/);
  await pickActivity(page, firstName, "Barbell Bench Press");

  // Complete set 1 so a second part can be added. The weight field is plain now:
  // #1971 retired the focus-applied suggestion, so a typed value is the value.
  const weight = page.getByTestId("set1-weight");
  await weight.fill("60");
  await expect(weight).toHaveValue("60");
  await settledFill(page, page.getByTestId("set1-reps"), "5");

  // Wait for the draft row to exist BEFORE adding the second part, so the
  // teardown has something deterministic to delete.
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();

  await page.getByRole("button", { name: "+ Add another activity" }).click();
  const parts = page.getByTestId("activity-part");
  await expect(parts).toHaveCount(2);
  const second = parts.nth(1); // nth-ok: the part this spec just added, addressed by the order it created
  await pickActivity(
    page,
    second.getByPlaceholder(/Add another activity/),
    "Running"
  );

  const first = parts.nth(0); // nth-ok: the lift this spec entered first
  const header = first.getByTestId("part-header");
  const actions = first.getByTestId("part-actions");
  const viewport = page.viewportSize()!;

  // 1. The lift name is fully readable — the reported truncation. The input
  //    scrolling its own value is the direct expression of "clipped", and it
  //    holds whatever the font metrics are.
  await expect(firstName).toHaveValue("Barbell Bench Press");
  expect(
    await firstName.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
    "the exercise name is clipped inside its own input at 390px"
  ).toBe(false);
  // Its muscle badge and clear action are still there.
  await expect(first.getByText("Chest", { exact: true })).toBeVisible();
  await expect(first.getByRole("button", { name: "Clear" })).toBeVisible();

  // 2. Two rows: the combobox spans the first, the toolbar sits under it, and
  //    the actions take no width from the name.
  const headerBox = await box(header);
  const nameBox = await box(firstName);
  const actionsBox = await box(actions);
  expect(nameBox.width).toBeGreaterThanOrEqual(headerBox.width - 12);
  expect(actionsBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 1);
  // The toolbar stays inside the viewport.
  expect(actionsBox.x).toBeGreaterThanOrEqual(0);
  expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(viewport.width);

  // 3. "How to" shares that toolbar — there is no guide-only row any more, and
  //    there is exactly one trigger for this part.
  await expect(first.getByTestId("exercise-guide-open")).toHaveCount(1);
  await expect(actions.getByTestId("exercise-guide-open")).toHaveCount(1);

  // 4. Every action meets the phone touch-target minimum, including the DISABLED
  //    reorder control (part 1 cannot move up) and its enabled sibling, and each
  //    keeps its accessible name.
  const up = first.getByRole("button", { name: "Move activity up" });
  const down = first.getByRole("button", { name: "Move activity down" });
  const removePart = first.getByRole("button", { name: "Remove activity" });
  const guide = first.getByTestId("exercise-guide-open");
  await expect(up).toBeDisabled();
  await expect(down).toBeEnabled();
  await expect(
    second.getByRole("button", { name: "Move activity down" })
  ).toBeDisabled();
  for (const control of [up, down, removePart, guide]) {
    const b = await box(control);
    expect(
      b.width,
      `action target is narrower than ${TAP_FLOOR_PX}px`
    ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    expect(
      b.height,
      `action target is shorter than ${TAP_FLOOR_PX}px`
    ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    // All on one band with the toolbar.
    expect(b.y).toBeGreaterThanOrEqual(actionsBox.y - 1);
    expect(b.y + b.height).toBeLessThanOrEqual(
      actionsBox.y + actionsBox.height + 1
    );
  }

  // 5. The set schema still clears the (now taller) sticky header instead of
  //    scrolling underneath it: its sticky offset IS the header's height.
  const stickyTop = await first
    .getByTestId("set-column-headings")
    .evaluate((el) => parseFloat(getComputedStyle(el).top));
  expect(Math.abs(stickyTop - headerBox.height)).toBeLessThanOrEqual(2);

  // 6. The callbacks are untouched: reordering still swaps the parts.
  await down.click();
  await expect(page.getByPlaceholder(/What did you do/)).toHaveValue("Running");
  await parts
    .nth(1) // nth-ok: the bench part this spec just moved down
    .getByRole("button", { name: "Move activity up" })
    .click();
  await expect(page.getByPlaceholder(/What did you do/)).toHaveValue(
    "Barbell Bench Press"
  );

  // 7. The relocated guide trigger still opens the ONE shared overlay.
  await guide.click();
  const dialog = page.getByRole("dialog", {
    name: "How to: Barbell Bench Press",
  });
  await expect(dialog).toContainText("How to: Barbell Bench Press");
  await expect(dialog.getByTestId("exercise-guide")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);

  await expectNoClippedContent(page);

  // Teardown: drop the second part (through the action under test), then delete
  // the auto-saved row so the worker DB is left as it was found.
  await parts
    .nth(1) // nth-ok: the Running part this spec added
    .getByRole("button", { name: "Remove activity" })
    .click();
  await expect(parts).toHaveCount(1);
  await cleanUpDraft(page);
});

// Issue #4515 — the same two sticky rows, pinned against the phone's top edge.
//
// The workspace overlay is `fixed inset-0 … overflow-y-auto`, so it IS the scroll
// container at the viewport: a child at `top: 0` pins UNDER the status bar, which
// is #4282's page-strip defect one layer in. The panel's own top padding clears
// the notch at REST and says nothing about where a pinned row stops.
//
// Headless Chromium reports a ZERO safe-area inset, so the defect is invisible to
// every ordinary measurement here and would stay green forever. Overriding
// `--top-edge-inset` (app/globals.css) on <html> is the same substitution a notched
// device performs — the same forge e2e/trends-context-bar.mobile.spec.ts uses for
// #4282 — so this exercises the arithmetic `top-edge-safe` actually does.
test("pinned part header and set schema park BELOW a notch band (#4515)", async ({
  page,
}) => {
  const NOTCH = 44; // an iPhone-class status-bar inset, in CSS px
  const forge = (px: number) =>
    page.evaluate(
      (v) =>
        document.documentElement.style.setProperty("--top-edge-inset", `${v}px`),
      px
    );

  await page.goto("/training?tab=log");
  const sheet = await openLogSheet(page);
  await (await showLogRow(sheet, "log-activity")).click();

  const firstName = page.getByPlaceholder(/What did you do/);
  await pickActivity(page, firstName, "Barbell Bench Press");
  const weight = page.getByTestId("set1-weight");
  await weight.fill("60");
  await expect(weight).toHaveValue("60");
  await settledFill(page, page.getByTestId("set1-reps"), "5");
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();

  // A second part is what makes the defect REACHABLE: #4515 records it as
  // unreachable today because a one-part form does not scroll far enough for
  // anything to pin. The assertion below is what says so out loud.
  await page.getByRole("button", { name: "+ Add another activity" }).click();
  const parts = page.getByTestId("activity-part");
  await expect(parts).toHaveCount(2);
  await pickActivity(
    page,
    parts
      .nth(1) // nth-ok: the part this spec just added, addressed by the order it created
      .getByPlaceholder(/Add another activity/),
    "Overhead Press"
  );

  const workspace = page.getByTestId("activity-workspace");
  const first = parts.nth(0); // nth-ok: the lift this spec entered first
  const header = first.getByTestId("part-header");
  const schema = first.getByTestId("set-column-headings");

  // Park the first part's header: scroll far enough into that part that its
  // header is pinned while the part itself is still on screen. Re-derived after
  // every forge — changing the token relays the panel.
  const pin = async () => {
    const depth = await workspace.evaluate((root) => {
      const part = root.querySelector<HTMLElement>(
        '[data-testid="activity-part"]'
      )!;
      const into =
        part.getBoundingClientRect().top - root.getBoundingClientRect().top;
      root.scrollTop += into + 160;
      return root.scrollHeight - root.clientHeight;
    });
    // The overlay must actually be scrollable, or every reading below is taken on
    // a row that never pinned and the whole test passes vacuously.
    expect(
      depth,
      "the workspace overlay should scroll at 390x844 with two parts"
    ).toBeGreaterThan(160);
    await settledBoxes([header, schema]);
  };

  // The control runs through the SAME locators as the assertion: with no notch
  // the header parks flush, so a 44 below cannot be anything else at that offset.
  await pin();
  const [flushHeader, flushSchema] = await settledBoxes([header, schema]);
  expect(flushHeader.y).toBe(0);
  // The schema row parks directly under the header — `--set-schema-top` — and that
  // relationship is what must survive the inset, not the absolute number.
  expect(Math.abs(flushSchema.y - flushHeader.height)).toBeLessThanOrEqual(2);

  await forge(NOTCH);
  await pin();
  const [notchedHeader, notchedSchema] = await settledBoxes([header, schema]);
  expect(
    notchedHeader.y,
    "the pinned exercise header sits under the status bar"
  ).toBe(NOTCH);
  expect(
    Math.abs(notchedSchema.y - (NOTCH + notchedHeader.height))
  ).toBeLessThanOrEqual(2);

  await expectNoClippedContent(page);

  await forge(0);
  await parts
    .nth(1) // nth-ok: the Overhead Press part this spec added
    .getByRole("button", { name: "Remove activity" })
    .click();
  await expect(parts).toHaveCount(1);
  await cleanUpDraft(page);
});
