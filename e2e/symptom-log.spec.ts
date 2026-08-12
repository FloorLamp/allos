import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { settledClick } from "./helpers";
import {
  settledTap,
  ensureUnlogged,
  addFromPicker,
  raiseSeverity,
  lowerSeverity,
  saveNote,
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
  // The write-bearing taps (picker add, severity chip) MUST be settled: a bare
  // .click() followed by the reload below can abort its own Server-Action POST
  // before it commits, so every retry of this loop repeats the same self-race and
  // the 40s window can spin without ever persisting (#1400 — the census failure).
  // The picker TOGGLE stays a bare click: it's client-only and fires no POST for
  // settledTap to await.
  const tap = settledTap(page);
  await expect(async () => {
    let bar = page.getByTestId("symptom-log-bar").first(); // first-ok: the acting profile's own symptom bar (top of the dashboard) — order-agnostic
    if ((await bar.getByTestId(`symptom-${key}`).count()) === 0) {
      if ((await bar.getByTestId("symptom-add-picker").count()) === 0) {
        await bar.getByTestId("symptom-add-picker-toggle").click();
      }
      const pick = bar.getByTestId(`symptom-pick-${key}`);
      if ((await pick.count()) > 0) await tap(pick);
    }
    const chip = bar.getByTestId(`symptom-${key}-sev-${level}`);
    if (
      (await chip.count()) > 0 &&
      (await chip.getAttribute("aria-pressed")) !== "true"
    ) {
      await tap(chip);
    }
    await page.reload();
    bar = page.getByTestId("symptom-log-bar").first(); // first-ok: the acting profile's own symptom bar (top of the dashboard) — order-agnostic
    await expect(
      bar.getByTestId(`symptom-${key}-sev-${level}`)
    ).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 });
  }).toPass({ timeout: 40_000 }); // topass-ok: reload-until-persisted: confirm the async severity write survives a reload; no single event marks 'persisted AND reflected'
}

// Symptom log (#799/#857). The seed activates the built-in illness-type "Illness"
// situation on profile 1, so the dashboard Symptoms card is surfaced. These drive the
// real one-tap card in its ACTIVE-FIRST layout via the shared symptom-helpers (the SAME
// drivers the episode-page mount uses): the catalog collapses into an "＋ add symptom"
// picker, logged symptoms render expanded, lowering is an explicit inline confirm, and
// each logged row carries a note affordance. On the dashboard the taps are settled
// (settledTap — the settledClick idiom) so each optimistic tap's Server-Action POST is
// committed before the next dependent step.
//
// The seed logs cough + fever for TODAY, so each test works with symptoms it can own
// (headache/nausea/chills/body_aches are NOT seeded today) and clears its own leftovers
// via ensureUnlogged — repeat-safe.

test("active-first: catalog collapses into the picker; logging via the picker raises the worst severity", async ({
  page,
}) => {
  // BUDGET, not flake. Alone in this file this test runs TWO full logAndConfirm
  // loops, and each one is a settled write plus a reload of the dashboard — the
  // app's heaviest render. Measured end to end at ~43–45s on a 4-core box, so it
  // was over the 30s default whatever the machine was doing (its siblings, with one
  // loop each, come in at 11s and 20s). Confirmed against the pre-#1560 merge base:
  // the same test fails there 2/2 at the default budget with the identical error,
  // and passes 1/1 at 120s — so this is the test's real cost, not a regression.
  //
  // test.slow() is a declared budget (×3), NOT a retry: at retries=0 the test still
  // has to pass on its first attempt, so nothing is masked.
  test.slow();
  await page.goto("/");
  const tap = settledTap(page);
  const bar = page.getByTestId("symptom-log-bar").first(); // first-ok: the acting profile's own symptom bar (top of the dashboard) — order-agnostic
  await expect(bar).toBeVisible();
  await ensureUnlogged(bar, "headache", tap);
  await ensureUnlogged(bar, "nausea", tap);

  // Collapse (#857 acceptance): a non-logged catalog symptom is NOT rendered as a row —
  // its severity chips don't exist until the picker opens, so the card stays compact.
  await expect(bar.getByTestId("symptom-add-picker-toggle")).toBeVisible();
  await expect(bar.getByTestId("symptom-headache-sev-3")).toHaveCount(0);

  // Add via the picker and raise to the worst severity, each confirmed persisted.
  await logAndConfirm(page, "headache", 3);
  await logAndConfirm(page, "nausea", 2);
});

test("explicit-lower: tapping a labeled lower chip saves directly", async ({
  page,
}) => {
  await page.goto("/");
  const tap = settledTap(page);
  const bar = page.getByTestId("symptom-log-bar").first(); // first-ok: the acting profile's own symptom bar (top of the dashboard) — order-agnostic
  await expect(bar).toBeVisible();
  await ensureUnlogged(bar, "chills", tap);

  await addFromPicker(bar, "chills", tap);
  await raiseSeverity(bar, "chills", 3, tap);
  const chills3 = bar.getByTestId("symptom-chills-sev-3");

  // A labeled lower chip is already an explicit, reversible edit; no second prompt.
  await lowerSeverity(bar, "chills", 1, tap);
  await expect(bar.getByTestId("symptom-chills-lower-confirm")).toHaveCount(0);
  await expect(bar.getByTestId("symptom-chills-sev-1")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(chills3).toHaveAttribute("aria-pressed", "false");

  // Tidy up so repeat runs start clean.
  await ensureUnlogged(bar, "chills", tap);
});

test("note affordance: a logged row opens a one-line note that persists", async ({
  page,
}) => {
  await page.goto("/");
  const tap = settledTap(page);
  const bar = page.getByTestId("symptom-log-bar").first(); // first-ok: the acting profile's own symptom bar (top of the dashboard) — order-agnostic
  await expect(bar).toBeVisible();
  await ensureUnlogged(bar, "body_aches", tap);

  // Add + commit the symptom first (a note UPDATE needs the row committed).
  await addFromPicker(bar, "body_aches", tap);

  // Fill + blur-save + reload-verify as one idempotent retry loop (the note save
  // is optimistic-with-revert and can race the pick action's commit — saveNote's
  // header has the full story). Persistence is asserted inside.
  await saveNote(page, "body_aches", "spiked after nap");

  // It survives a reload (persisted server-side).
  await page.reload();
  const bar2 = page.getByTestId("symptom-log-bar").first(); // first-ok: the acting profile's own symptom bar (top of the dashboard) — order-agnostic
  await expect(bar2.getByTestId("symptom-body_aches-note")).toHaveText(
    "spiked after nap"
  );

  // Tidy up so repeat runs start clean.
  await ensureUnlogged(bar2, "body_aches", tap);
});

test("the one-tap × offers an Undo that brings the symptom-day back (#2124)", async ({
  page,
}) => {
  // The × used to be a one-tap delete with no confirm and nothing to take it back —
  // and it reached OFF-DB, unlinking the day's photo files. It stays one tap (a
  // confirm on every symptom clear is the wrong tax); the safety net is the toast.
  test.slow();
  await page.goto("/");
  const tap = settledTap(page);
  const bar = page.getByTestId("symptom-log-bar").first(); // first-ok: the acting profile's own symptom bar (top of the dashboard) — order-agnostic
  await expect(bar).toBeVisible();
  await ensureUnlogged(bar, "nausea", tap);

  await addFromPicker(bar, "nausea", tap);
  await raiseSeverity(bar, "nausea", 3, tap);

  // Clear it — the row leaves the bar, and the Undo affordance appears with it.
  await settledClick(page, bar.getByTestId("symptom-nausea-clear"));
  await expect(bar.getByTestId("symptom-nausea")).toHaveCount(0);
  await expect(page.getByText("Symptom removed.")).toBeVisible();

  await settledClick(page, page.getByRole("button", { name: "Undo" }));
  await expect(page.getByText("Restored.")).toBeVisible();

  // The day is genuinely back at the severity it was cleared at — asserted after a
  // reload so this is the persisted row, not the optimistic chip.
  await page.reload();
  const bar2 = page.getByTestId("symptom-log-bar").first(); // first-ok: the acting profile's own symptom bar (top of the dashboard) — order-agnostic
  await expect(bar2.getByTestId("symptom-nausea-sev-3")).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  // Tidy up so repeat runs start clean.
  await ensureUnlogged(bar2, "nausea", tap);
});
