import { test, expect, type Page, type Locator } from "@playwright/test";
import { settledCheck } from "./helpers";
import { createProfileViaFamily, switchToProfile } from "./family-helpers";

// The recomposed "How are you today?" check-in card (issues #1314 / #1311 / #1313).
// Covers the four-section CheckInSection grammar, the merged "What's going on?" chip
// group (sticky situations vs today-only day factors, two write paths), and the
// relevance-gated Calm scale (silent gate; the Settings opt-in reveals it).
//
// Fixture hygiene (#868): the shared seed makes profile 1 sick/mood-logged, so each
// test creates a FRESH profile via Settings → Family and switches to it — every
// mutation lands on a profile this spec owns. afterEach restores the admin profile.
// A fresh profile has NO anxiety signal, so it exercises the gated (Calm-absent)
// state directly; the opt-in test then flips the one signal it controls.

const ADMIN_PROFILE = "admin";

// Tap one mood face and wait until the SERVER acknowledges the write (the marker
// re-renders from the refreshed server prop). toPass retries the tap through the
// hydration window — a pre-hydration click is swallowed, and the write is an
// idempotent per-day upsert, so a re-tap is safe.
async function tapMood(page: Page, card: Locator, n: number): Promise<void> {
  await expect(async () => {
    await card.getByTestId(`mood-tap-${n}`).click({ timeout: 2_000 });
    await expect(card.getByTestId("mood-server-logged")).toHaveAttribute(
      "data-valence",
      String(n),
      { timeout: 4_000 }
    );
  }).toPass(); // topass-ok: re-tap until the server-logged valence reflects it past the pre-hydration swallow — idempotent per-day upsert, safe to re-drive
}

test.afterEach(async ({ page }) => {
  await page.goto("/");
  if (
    (await page.getByTestId("user-menu-trigger").textContent())?.includes(
      ADMIN_PROFILE
    )
  ) {
    return;
  }
  await switchToProfile(page, ADMIN_PROFILE);
});

test.describe("Check-in card recomposition (#1314/#1311/#1313)", () => {
  test("four-section grammar: sections render with collapsed summaries; expanding Rate edits and the summary updates", async ({
    page,
  }) => {
    test.slow();
    await createProfileViaFamily(page, "checkinshell");
    await page.goto("/");

    const card = page.getByTestId("how-are-you-card");
    await expect(card).toBeVisible();

    // Rate (hero, first in DOM) + Context + Report render; Act is absent (no PRN meds).
    await expect(card.getByTestId("checkin-section-rate")).toBeVisible();
    await expect(card.getByTestId("checkin-section-context")).toBeVisible();
    await expect(card.getByTestId("checkin-section-report")).toBeVisible();
    await expect(card.getByTestId("checkin-section-act")).toHaveCount(0);

    // Collapsed-informative summaries at rest.
    await expect(card.getByTestId("mood-status")).toHaveText(
      "Tap to log your day."
    );
    await expect(
      card.getByTestId("checkin-section-context-summary")
    ).toHaveText("Nothing noted.");
    await expect(card.getByTestId("checkin-section-report-summary")).toHaveText(
      "Feeling well."
    );
    // Report's escalation door is inline at rest (it's a report, not a sibling).
    await expect(card.getByTestId("feeling-sick-activate")).toBeVisible();

    // One tap completes the check-in without any expansion (the hero contract).
    await tapMood(page, card, 4);
    await expect(card.getByTestId("mood-status")).toContainText("Good");

    // Expand Rate → the detail edits, and the collapsed summary is a formatter over it.
    await card.getByTestId("checkin-section-rate-toggle").click();
    await expect(card.getByTestId("mood-detail")).toBeVisible();
    await card.getByTestId("mood-energy-3").click();
    await expect(card.getByTestId("mood-status")).toContainText("energy 3");
  });

  test("merged Context group: a sticky situation and a today-only day factor persist to their own stores", async ({
    page,
  }) => {
    test.slow();
    await createProfileViaFamily(page, "checkinctx");
    await page.goto("/");

    const card = page.getByTestId("how-are-you-card");
    // Log a mood first so the day-factor write has a valence to attach to.
    await tapMood(page, card, 3);
    await card.getByTestId("checkin-section-context-toggle").click();

    // The day-factor (today-only) half writes to the mood log's factors. The card is
    // hydrated (tapMood already round-tripped a write), so a single click is safe;
    // settle on the server-truth marker.
    const work = card.getByTestId("checkin-day-factor-work");
    await expect(work).toBeVisible();
    await expect(work).toHaveAttribute("aria-pressed", "false");
    await work.click();
    await expect(card.getByTestId("mood-server-logged")).toHaveAttribute(
      "data-factors",
      "work"
    );

    // Persisted: reload, re-expand Context, the day chip is still pressed.
    await page.reload();
    await card.getByTestId("checkin-section-context-toggle").click();
    await expect(card.getByTestId("checkin-day-factor-work")).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    // The sticky (ongoing) half writes to the situations store — a suggested chip
    // toggles active and survives a reload independently of the mood log.
    const travel = card.getByTestId("checkin-situation-Travel");
    await expect(travel).toHaveAttribute("aria-pressed", "false");
    await travel.click();
    await expect(travel).toHaveAttribute("aria-pressed", "true", {
      timeout: 10_000,
    });
    await page.reload();
    await card.getByTestId("checkin-section-context-toggle").click();
    await expect(card.getByTestId("checkin-situation-Travel")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  test("Calm scale is relevance-gated (silent) and the Settings opt-in reveals it", async ({
    page,
  }) => {
    test.slow();
    const name = await createProfileViaFamily(page, "checkincalm");
    await page.goto("/");

    const card = page.getByTestId("how-are-you-card");
    await card.getByTestId("checkin-section-rate-toggle").click();
    await expect(card.getByTestId("mood-detail")).toBeVisible();
    // Energy is universal; a fresh profile has no anxiety signal, so Calm is absent —
    // and NO copy explains its absence (the #716 silent-gate law).
    await expect(card.getByTestId("mood-energy-1")).toBeVisible();
    await expect(card.getByTestId("mood-anxiety-1")).toHaveCount(0);
    await expect(card).not.toContainText(/anxiety|Calm/i);

    // Flip the Settings → Profile opt-in (signal 6). Autosave-on-change is SILENT
    // (an empty/toggle save is valid), so confirm the PERSISTED effect before leaving
    // the page (the email-auth precedent): reload and assert the box stayed checked.
    await page.goto("/settings/profile");
    await settledCheck(page, page.getByTestId("anxiety-scale-enabled"), true);
    await page.reload();
    await expect(page.getByTestId("anxiety-scale-enabled")).toBeChecked();

    // Back on the dashboard the Calm scale now appears, relabeled so high = calm (the
    // good end), matching Energy's direction (#1313 axis fix).
    await page.goto("/");
    await card.getByTestId("checkin-section-rate-toggle").click();
    await expect(card.getByTestId("mood-anxiety-5")).toBeVisible();
    await expect(card.getByTestId("mood-detail")).toContainText("calm");
    await expect(card.getByTestId("mood-detail")).toContainText("anxious");
    expect(name).toContain("checkincalm");
  });
});
