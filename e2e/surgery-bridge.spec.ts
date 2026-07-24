import { test, expect } from "@playwright/test";
import { settledClick } from "./helpers";

// Pre-surgery / Post-op suggest-only bridge (#1299): the producer for the #1296 pause.
// This spec OWNS its fixtures (create-and-clean): it schedules a surgical visit for
// today, then asserts the Nutrition → Supplements situations bar surfaces the
// suggestion chip ("activate Pre-surgery"), confirming activates the Pre-surgery
// situation. An afterEach cancels every visit it scheduled and deactivates
// Pre-surgery — on the failure path too — so the shared-seed profile is left
// unchanged (robust across --repeat-each and across a mid-test red).

const VISIT_TITLE = "E2E Arthroscopy";

// Cancel every still-scheduled visit this spec created (loop until none remain) so
// repeated runs on the same seeded DB don't accumulate surgical visits. Uses a plain
// click + a retrying count-decrement (not settledClick, whose armed POST-wait races the
// cancel's `startTransition` server action in fast production timing) — the row leaves
// the upcoming section once its status settles to Cancelled.
// The still-SCHEDULED rows this spec created. A cancelled visit stays on the page in
// the settled/history list, so a bare title filter would keep counting a previous
// --repeat-each pass's leftovers; the live Cancel button is what marks a row as still
// scheduled (and it's the same thing the bridge query selects on).
function ourScheduledRows(page: import("@playwright/test").Page) {
  return page
    .getByTestId("appointment-row")
    .filter({ hasText: VISIT_TITLE })
    .filter({ has: page.getByRole("button", { name: "Cancel appointment" }) });
}

async function cancelOurVisits(page: import("@playwright/test").Page) {
  await page.goto("/records/history/visits");
  const cancelBtns = ourScheduledRows(page).getByRole("button", {
    name: "Cancel appointment",
  });
  for (let n = await cancelBtns.count(); n > 0; n--) {
    await cancelBtns.first().click(); // first-ok: loop-cancel of the visits THIS spec scheduled (unique title)
    await expect(cancelBtns).toHaveCount(n - 1);
  }
}

// Deactivate Pre-surgery if this spec left it on. The situations bar renders the
// built-in chip only once it is active OR suggested, so a plain count check drives
// the toggle. Runs from afterEach, so a mid-test FAILURE can never hand the shared
// seed profile an active Pre-surgery — which would suppress the very suggestion this
// spec (and its next run in the same shard) asserts (`surgeryBridgeSuggestion`
// returns null in the "pre" branch while Pre-surgery is active), i.e. turn one red
// into a cascading one.
async function clearPresurgery(page: import("@playwright/test").Page) {
  await page.goto("/nutrition?tab=supplements");
  const toggle = page
    .getByTestId("situations-bar")
    .getByRole("button", { name: "Pre-surgery", exact: true });
  if ((await toggle.count()) === 0) return;
  if ((await toggle.getAttribute("aria-pressed")) !== "true") return;
  await settledClick(page, toggle);
  await expect(toggle).not.toHaveAttribute("aria-pressed", "true");
}

// Leave the shared seed profile exactly as found even when the test body throws
// (#868 fixture ownership: a spec owns — and unwinds — its own writes).
test.afterEach(async ({ page }) => {
  await clearPresurgery(page);
  await cancelOurVisits(page);
});

test("a scheduled surgical visit suggests activating Pre-surgery", async ({
  page,
}) => {
  test.slow();

  // Start clean (a prior repeat may have left visits) so the held-count copy is stable.
  await cancelOurVisits(page);

  // ── Schedule a surgical visit for TODAY (the form's default date) ───────────
  // Leave the DateField untouched: it defaults to the app's frozen "today", which is
  // both a scheduled (non-past → appointment branch) visit AND trivially inside the
  // 7-day lead window (0 days out). Deriving the date in the browser (isoInDays) would
  // race the app's frozen/pinned-timezone clock in CI and mis-place the visit — the
  // whole "date defaults to today" pattern the visits specs use avoids that.
  await page.goto("/records/history/visits");
  const addCard = page.getByTestId("visits-add");
  await expect(addCard).toBeVisible();
  await addCard.getByLabel("Reason / title").fill(VISIT_TITLE);
  await settledClick(
    page,
    addCard.getByRole("button", { name: "Add", exact: true })
  );
  // Settle on the DURABLE server-rendered row before navigating away (#1437).
  // Every app page carries steady background Server-Action POST traffic — the
  // app-wide import + extraction watchers each poll on a 6s timer, and both POST to
  // the CURRENT route URL, so `settledClick`'s armed same-origin POST wait can
  // resolve on a bystander poll while the create is still in flight (the hazard
  // helpers.ts documents). The `goto` below would then ABORT the create — measured:
  // the appointment never lands, the chip never renders, and the failure reads
  // "element(s) not found" exactly as CI saw twice. Asserting the row here holds the
  // page still until the write is durable, and the poll can't fake it.
  await expect(ourScheduledRows(page)).toHaveCount(1);

  // ── The bridge chip appears on the Supplements situations bar ───────────────
  await page.goto("/nutrition?tab=supplements");
  const chip = page.locator('[data-testid^="surgery-bridge-pre-"]').first(); // first-ok: the pre-surgery chip for the single visit this spec just scheduled
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("activate Pre-surgery");

  // Confirm → Pre-surgery becomes active.
  await settledClick(
    page,
    chip.getByRole("button", { name: "Activate Pre-surgery" })
  );
  await expect(
    page
      .getByTestId("situations-bar")
      .getByRole("button", { name: "Pre-surgery", exact: true })
  ).toHaveAttribute("aria-pressed", "true");

  // Cleanup (deactivate Pre-surgery, cancel the visit) is the afterEach above — it
  // runs on the failure path too, and its own settles are navigation-free.
});
