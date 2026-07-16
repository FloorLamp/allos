import { test, expect, type Locator, type Page } from "@playwright/test";

// Symptom log (#799/#857). The seed activates the built-in illness-type "Illness"
// situation on profile 1, so the dashboard Symptoms card is surfaced. These drive the
// real one-tap card in its ACTIVE-FIRST layout: the catalog collapses into an "＋ add
// symptom" picker, logged symptoms render expanded, lowering is an explicit inline
// confirm, and each logged row carries a note affordance.
//
// The seed logs cough + fever for TODAY, so each test works with symptoms it can own
// (headache/nausea/chills/body_aches are NOT seeded today) and clears any of its own
// leftovers first via ensureUnlogged — so the picker-add flow is deterministic even under
// repeat-each (a prior run's add can't hide the picker chip).

// Click something that fires a Server Action, then wait for the network to fully drain
// before proceeding. The bar's click handlers are async: they POST the action AND then
// fire a router.refresh() (an RSC GET) which re-renders the dashboard. Waiting only for
// the action POST isn't enough — that trailing refresh can re-render mid-interaction and
// detach the element the next step is about to touch (the inline confirm / note input),
// which is exactly what breaks under load when the dashboard render is heavier. Waiting
// for networkidle drains both the POST and the refresh GET, so the DOM is stable (and the
// write committed) before the next interaction or reload. The dashboard has no persistent
// connection (VersionWatcher polls every 60s), so networkidle settles reliably.
async function tapSettled(page: Page, locator: Locator): Promise<void> {
  await locator.click();
  await page.waitForLoadState("networkidle", { timeout: 15_000 });
}

// Clear a symptom-day if it's currently logged, so the symptom starts in the picker.
async function ensureUnlogged(
  page: Page,
  bar: Locator,
  key: string
): Promise<void> {
  const clear = bar.getByTestId(`symptom-${key}-clear`);
  if ((await clear.count()) > 0) {
    await tapSettled(page, clear);
    await expect(bar.getByTestId(`symptom-${key}`)).toHaveCount(0);
  }
}

// Open the picker and add a catalog symptom (logs it at severity 1 → a logged row).
async function addFromPicker(
  page: Page,
  bar: Locator,
  key: string
): Promise<void> {
  if ((await bar.getByTestId("symptom-add-picker").count()) === 0) {
    await bar.getByTestId("symptom-add-picker-toggle").click();
  }
  await tapSettled(page, bar.getByTestId(`symptom-pick-${key}`));
  await expect(bar.getByTestId(`symptom-${key}-sev-1`)).toHaveAttribute(
    "aria-pressed",
    "true"
  );
}

test("active-first: catalog collapses into the picker; logging via the picker raises the worst severity", async ({
  page,
}) => {
  await page.goto("/");
  const bar = page.getByTestId("symptom-log-bar").first();
  await expect(bar).toBeVisible();
  await ensureUnlogged(page, bar, "headache");
  await ensureUnlogged(page, bar, "nausea");

  // Collapse (#857 acceptance): a non-logged catalog symptom is NOT rendered as a row —
  // its severity chips don't exist until the picker opens, so the card stays compact
  // (only the collapsed toggle is present for the ~18 unlogged catalog symptoms).
  await expect(bar.getByTestId("symptom-add-picker-toggle")).toBeVisible();
  await expect(bar.getByTestId("symptom-headache-sev-3")).toHaveCount(0);

  // Add Headache from the picker (logs severity 1), then raise to 3 (a tap only raises).
  await addFromPicker(page, bar, "headache");
  await tapSettled(page, bar.getByTestId("symptom-headache-sev-3"));
  await expect(bar.getByTestId("symptom-headache-sev-3")).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  // Add Nausea at severity 2 the same way.
  await addFromPicker(page, bar, "nausea");
  await tapSettled(page, bar.getByTestId("symptom-nausea-sev-2"));
  await expect(bar.getByTestId("symptom-nausea-sev-2")).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  // They render on the day: the Timeline shows the logged symptoms.
  await page.goto("/timeline?category=symptom");
  await expect(page.getByText("Headache").first()).toBeVisible();
  await expect(page.getByText("Nausea").first()).toBeVisible();
});

test("explicit-lower: tapping a lower chip prompts an inline confirm; confirming lowers, cancel keeps the worst", async ({
  page,
}) => {
  await page.goto("/");
  const bar = page.getByTestId("symptom-log-bar").first();
  await expect(bar).toBeVisible();
  await ensureUnlogged(page, bar, "chills");

  await addFromPicker(page, bar, "chills");
  const chills3 = bar.getByTestId("symptom-chills-sev-3");
  await tapSettled(page, chills3);
  await expect(chills3).toHaveAttribute("aria-pressed", "true");

  // Tapping a LOWER chip opens the confirm (client-only — no write yet), never silently
  // eats the tap.
  await bar.getByTestId("symptom-chills-sev-1").click();
  const confirm = bar.getByTestId("symptom-chills-lower-confirm");
  await expect(confirm).toBeVisible();

  // Cancel keeps the worst (still 3).
  await bar.getByTestId("symptom-chills-lower-confirm-no").click();
  await expect(confirm).toHaveCount(0);
  await expect(chills3).toHaveAttribute("aria-pressed", "true");

  // Confirming an explicit lower actually lowers it to 1.
  await bar.getByTestId("symptom-chills-sev-1").click();
  await expect(confirm).toBeVisible();
  await tapSettled(page, bar.getByTestId("symptom-chills-lower-confirm-yes"));
  await expect(bar.getByTestId("symptom-chills-sev-1")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(chills3).toHaveAttribute("aria-pressed", "false");

  // Tidy up so repeat runs start from a clean slate.
  await ensureUnlogged(page, bar, "chills");
});

test("note affordance: a logged row opens a one-line note that persists", async ({
  page,
}) => {
  await page.goto("/");
  const bar = page.getByTestId("symptom-log-bar").first();
  await expect(bar).toBeVisible();
  await ensureUnlogged(page, bar, "body_aches");

  await addFromPicker(page, bar, "body_aches");

  await bar.getByTestId("symptom-body_aches-note-toggle").click();
  await bar
    .getByTestId("symptom-body_aches-note-input")
    .fill("spiked after nap");
  await tapSettled(page, bar.getByTestId("symptom-body_aches-note-save"));

  // The saved note renders under the row.
  await expect(bar.getByTestId("symptom-body_aches-note")).toHaveText(
    "spiked after nap"
  );

  // It survives a reload (persisted server-side) — the note write above already settled
  // (tapSettled awaited its POST), so the reload can't race it.
  await page.reload();
  const bar2 = page.getByTestId("symptom-log-bar").first();
  await expect(bar2.getByTestId("symptom-body_aches-note")).toHaveText(
    "spiked after nap"
  );

  // Tidy up so repeat runs start from a clean slate.
  await ensureUnlogged(page, bar2, "body_aches");
});
