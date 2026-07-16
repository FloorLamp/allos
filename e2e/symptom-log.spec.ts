import { test, expect } from "@playwright/test";

// Symptom log (#799/#857). The seed activates the built-in illness-type "Illness"
// situation, so the dashboard Symptoms card is surfaced. These drive the real one-tap
// card in its ACTIVE-FIRST layout: the catalog collapses into an "＋ add symptom" picker,
// logged symptoms render expanded, lowering is an explicit inline confirm, and each
// logged row carries a note affordance.

test("active-first: catalog is collapsed into the picker; logging via the picker raises the worst severity", async ({
  page,
}) => {
  await page.goto("/");
  const bar = page.getByTestId("symptom-log-bar").first();
  await expect(bar).toBeVisible();

  // Collapse (#857 acceptance): with nothing logged, the ~20 catalog rows are NOT
  // rendered — only the collapsed picker toggle. A catalog symptom's severity chips
  // don't exist until the picker is opened, so the card stays compact.
  await expect(bar.getByTestId("symptom-add-picker-toggle")).toBeVisible();
  await expect(bar.getByTestId("symptom-headache-sev-3")).toHaveCount(0);
  await expect(bar.getByTestId("symptom-none-logged")).toBeVisible();

  // Open the picker and add Headache — it logs at severity 1 and becomes a logged row.
  await bar.getByTestId("symptom-add-picker-toggle").click();
  await bar.getByTestId("symptom-pick-headache").click();
  const headache1 = bar.getByTestId("symptom-headache-sev-1");
  await expect(headache1).toHaveAttribute("aria-pressed", "true");

  // Raise Headache to severity 3 (a tap only raises — worst-severity).
  const headache3 = bar.getByTestId("symptom-headache-sev-3");
  await headache3.click();
  await expect(headache3).toHaveAttribute("aria-pressed", "true");

  // Add Nausea at severity 2 the same way.
  await bar.getByTestId("symptom-pick-nausea").click();
  const nausea2 = bar.getByTestId("symptom-nausea-sev-2");
  await nausea2.click();
  await expect(nausea2).toHaveAttribute("aria-pressed", "true");

  // They render on the day: the Timeline shows a symptom-day event listing them.
  await page.goto("/timeline?category=symptom");
  await expect(page.getByText(/symptoms logged/i).first()).toBeVisible();
  await expect(page.getByText("Headache").first()).toBeVisible();
  await expect(page.getByText("Nausea").first()).toBeVisible();
});

test("explicit-lower: tapping a lower chip prompts an inline confirm; confirming lowers, cancel keeps the worst", async ({
  page,
}) => {
  await page.goto("/");
  const bar = page.getByTestId("symptom-log-bar").first();
  await expect(bar).toBeVisible();

  await bar.getByTestId("symptom-add-picker-toggle").click();
  await bar.getByTestId("symptom-pick-cough").click();
  const cough3 = bar.getByTestId("symptom-cough-sev-3");
  await cough3.click();
  await expect(cough3).toHaveAttribute("aria-pressed", "true");

  // Tapping a LOWER chip does not silently eat the tap — it prompts a confirm.
  await bar.getByTestId("symptom-cough-sev-1").click();
  const confirm = bar.getByTestId("symptom-cough-lower-confirm");
  await expect(confirm).toBeVisible();

  // Cancel keeps the worst (still 3).
  await bar.getByTestId("symptom-cough-lower-confirm-no").click();
  await expect(confirm).toHaveCount(0);
  await expect(cough3).toHaveAttribute("aria-pressed", "true");

  // Confirming an explicit lower actually lowers it to 1.
  await bar.getByTestId("symptom-cough-sev-1").click();
  await bar.getByTestId("symptom-cough-lower-confirm-yes").click();
  await expect(bar.getByTestId("symptom-cough-sev-1")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(cough3).toHaveAttribute("aria-pressed", "false");
});

test("note affordance: a logged row opens a one-line note that persists", async ({
  page,
}) => {
  await page.goto("/");
  const bar = page.getByTestId("symptom-log-bar").first();
  await expect(bar).toBeVisible();

  await bar.getByTestId("symptom-add-picker-toggle").click();
  await bar.getByTestId("symptom-pick-fever").click();
  await expect(bar.getByTestId("symptom-fever-sev-1")).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  await bar.getByTestId("symptom-fever-note-toggle").click();
  const noteInput = bar.getByTestId("symptom-fever-note-input");
  await noteInput.fill("spiked after nap");
  await bar.getByTestId("symptom-fever-note-save").click();

  // The saved note renders under the row.
  await expect(bar.getByTestId("symptom-fever-note")).toHaveText(
    "spiked after nap"
  );

  // It survives a reload (persisted server-side).
  await page.reload();
  const bar2 = page.getByTestId("symptom-log-bar").first();
  await expect(bar2.getByTestId("symptom-fever-note")).toHaveText(
    "spiked after nap"
  );
});
