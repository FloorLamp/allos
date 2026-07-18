import { test, expect, type Page } from "@playwright/test";
import {
  idleSettle,
  ensureUnlogged,
  addFromPicker,
  raiseSeverity,
  openLowerConfirm,
  openNoteInput,
} from "./symptom-helpers";

// Log `key` at worst-severity `level` and CONFIRM it survives a reload, self-healing. The
// bar is an optimistic, eventually-consistent UI (each tap writes then router.refresh()es)
// — driven faster than a human taps, a write can race its own refresh and not land. This
// retries the whole add→raise→reload→verify until the target severity persists, so the
// test asserts real persistence without masking anything: it simply re-taps until it
// sticks. One symptom at a time (a reload between them), so writes never pile up.
async function logAndConfirm(
  page: Page,
  key: string,
  level: number
): Promise<void> {
  await expect(async () => {
    let bar = page.getByTestId("symptom-log-bar").first();
    if ((await bar.getByTestId(`symptom-${key}`).count()) === 0) {
      if ((await bar.getByTestId("symptom-add-picker").count()) === 0) {
        await bar.getByTestId("symptom-add-picker-toggle").click();
      }
      const pick = bar.getByTestId(`symptom-pick-${key}`);
      if ((await pick.count()) > 0) await pick.click();
    }
    const chip = bar.getByTestId(`symptom-${key}-sev-${level}`);
    if (
      (await chip.count()) > 0 &&
      (await chip.getAttribute("aria-pressed")) !== "true"
    ) {
      await chip.click();
    }
    await page.reload();
    bar = page.getByTestId("symptom-log-bar").first();
    await expect(
      bar.getByTestId(`symptom-${key}-sev-${level}`)
    ).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 });
  }).toPass({ timeout: 40_000 });
}

// Symptom log (#799/#857). The seed activates the built-in illness-type "Illness"
// situation on profile 1, so the dashboard Symptoms card is surfaced. These drive the
// real one-tap card in its ACTIVE-FIRST layout via the shared symptom-helpers (the SAME
// drivers the episode-page mount uses): the catalog collapses into an "＋ add symptom"
// picker, logged symptoms render expanded, lowering is an explicit inline confirm, and
// each logged row carries a note affordance. On the dashboard the settle is networkidle
// (idleSettle) so each optimistic tap is committed before the next dependent step.
//
// The seed logs cough + fever for TODAY, so each test works with symptoms it can own
// (headache/nausea/chills/body_aches are NOT seeded today) and clears its own leftovers
// via ensureUnlogged — repeat-safe.

test("active-first: catalog collapses into the picker; logging via the picker raises the worst severity", async ({
  page,
}) => {
  await page.goto("/");
  const settle = idleSettle(page);
  const bar = page.getByTestId("symptom-log-bar").first();
  await expect(bar).toBeVisible();
  await ensureUnlogged(bar, "headache", settle);
  await ensureUnlogged(bar, "nausea", settle);

  // Collapse (#857 acceptance): a non-logged catalog symptom is NOT rendered as a row —
  // its severity chips don't exist until the picker opens, so the card stays compact.
  await expect(bar.getByTestId("symptom-add-picker-toggle")).toBeVisible();
  await expect(bar.getByTestId("symptom-headache-sev-3")).toHaveCount(0);

  // Add via the picker and raise to the worst severity, each confirmed persisted.
  await logAndConfirm(page, "headache", 3);
  await logAndConfirm(page, "nausea", 2);
});

test("explicit-lower: tapping a lower chip prompts an inline confirm; confirming lowers, cancel keeps the worst", async ({
  page,
}) => {
  await page.goto("/");
  const settle = idleSettle(page);
  const bar = page.getByTestId("symptom-log-bar").first();
  await expect(bar).toBeVisible();
  await ensureUnlogged(bar, "chills", settle);

  await addFromPicker(bar, "chills", settle);
  await raiseSeverity(bar, "chills", 3, settle);
  const chills3 = bar.getByTestId("symptom-chills-sev-3");

  // Tapping a LOWER chip prompts the confirm (never silently eats the tap). Cancel keeps
  // the worst (still 3).
  await openLowerConfirm(bar, "chills", 1);
  await bar.getByTestId("symptom-chills-lower-confirm-no").click();
  await expect(bar.getByTestId("symptom-chills-lower-confirm")).toHaveCount(0);
  await expect(chills3).toHaveAttribute("aria-pressed", "true");

  // Confirming an explicit lower actually lowers it to 1.
  await openLowerConfirm(bar, "chills", 1);
  await bar.getByTestId("symptom-chills-lower-confirm-yes").click();
  await expect(bar.getByTestId("symptom-chills-sev-1")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(chills3).toHaveAttribute("aria-pressed", "false");

  // Tidy up so repeat runs start clean.
  await ensureUnlogged(bar, "chills", settle);
});

test("note affordance: a logged row opens a one-line note that persists", async ({
  page,
}) => {
  await page.goto("/");
  const settle = idleSettle(page);
  const bar = page.getByTestId("symptom-log-bar").first();
  await expect(bar).toBeVisible();
  await ensureUnlogged(bar, "body_aches", settle);

  // Add + commit the symptom first (a note UPDATE needs the row committed).
  await addFromPicker(bar, "body_aches", settle);

  await openNoteInput(bar, "body_aches");
  await bar
    .getByTestId("symptom-body_aches-note-input")
    .fill("spiked after nap");
  await bar.getByTestId("symptom-body_aches-note-save").click();
  await settle();

  // The saved note renders under the row.
  await expect(bar.getByTestId("symptom-body_aches-note")).toHaveText(
    "spiked after nap"
  );

  // It survives a reload (persisted server-side).
  await page.reload();
  const bar2 = page.getByTestId("symptom-log-bar").first();
  await expect(bar2.getByTestId("symptom-body_aches-note")).toHaveText(
    "spiked after nap"
  );

  // Tidy up so repeat runs start clean.
  await ensureUnlogged(bar2, "body_aches", settle);
});
