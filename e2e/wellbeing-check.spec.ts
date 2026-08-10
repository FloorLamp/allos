import { test, expect } from "./fixtures";
import { type Page, type Locator } from "@playwright/test";
import { createProfileViaFamily, switchToProfile } from "./family-helpers";
import {
  followLink,
  hydratedClick,
  settledClick,
  settledClickApplied,
} from "./helpers";

// The unified "How are you today?" daily check-in card (issue #992): the one-tap
// mood log composed with the illness front door in ONE shell. Covered states:
//   1. no-episode — mood tap leads, the quiet "Not feeling well?" branch shows;
//   2. one tap logs the day, persists, and a same-day re-tap UPDATES (idempotent
//      per profile+date — one row, never a duplicate);
//   3. expand — energy + note save and persist, and the mood series reaches the
//      Trends → Body chart (the merged Context chip group and the relevance-gated
//      Calm scale (#1311/#1313/#1314) are covered in e2e/checkin-card.spec.ts —
//      a fresh profile here has no anxiety signal, so Calm is intentionally absent);
//   4. active-episode — the illness cockpit takes the hero, the card defers with
//      a quiet note, and the mood tap STILL works (the two coexist).
//
// SETTLE DISCIPLINE: the card renders a SERVER-truth marker
// (`mood-server-logged`, built from the server prop, not client state) that
// appears/updates only once the write committed and the refresh round-tripped,
// and every mood mutation here settles on that marker.
//
// That marker used to be the ONLY settle, because settledClick once armed on ANY
// same-origin POST and the dashboard's steady background action traffic
// (watchers/pollers) could resolve it on a bystander request while the mood write
// was still in flight. #1952 replaced that with correlation — a POST that started
// AFTER the click and targets this route — so the action-level wait is sound here
// now and composes with the marker rather than being replaced by it.
//
// Fixture hygiene (#868): the shared seed makes profile 1 already sick (and
// already mood-logged), so each test creates a FRESH profile via Settings →
// Family and switches to it — every mutation lands on a profile this spec owns.
// afterEach switches the shared session back to the admin profile.

const ADMIN_PROFILE = "admin";

// Tap one mood face and wait until the SERVER acknowledges the write (the marker
// re-renders from the refreshed server prop). toPass retries the tap through the
// hydration window — a pre-hydration click is swallowed, and no single expect can
// both re-click and await the server marker; the re-tap is safe because the write
// is an idempotent per-day upsert.
async function tapMood(page: Page, card: Locator, n: number): Promise<void> {
  await expect(async () => {
    await card.getByTestId(`mood-tap-${n}`).click({ timeout: 2_000 });
    await expect(card.getByTestId("mood-server-logged")).toHaveAttribute(
      "data-valence",
      String(n),
      { timeout: 4_000 }
    );
  }).toPass(); // topass-ok: re-tap the mood until the server-logged valence reflects it past the pre-hydration swallow — idempotent per-day upsert, safe to re-drive
}

test.afterEach(async ({ page }) => {
  await page.goto("/");
  if (
    (await page.getByTestId("profile-identity-bar").textContent())?.includes(
      ADMIN_PROFILE
    )
  ) {
    return;
  }
  await switchToProfile(page, ADMIN_PROFILE);
});

test.describe("Daily wellbeing check (#992)", () => {
  test("no-episode state: mood tap logs, persists, and a same-day re-tap updates", async ({
    page,
  }) => {
    test.slow();
    await createProfileViaFamily(page, "moodwell");
    await page.goto("/");

    // State 1 — the unified shell: mood row + the quiet illness branch.
    const card = page.getByTestId("how-are-you-card");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("mood-status")).toHaveCount(0);
    await expect(card.getByTestId("feeling-sick-activate")).toBeVisible();
    await expect(page.getByTestId("symptom-log-bar")).toHaveCount(0);
    await expect(card.getByTestId("mood-server-logged")).toHaveCount(0);

    // One tap logs the day (settled on the server-truth marker).
    await tapMood(page, card, 4);
    await expect(card.getByTestId("mood-tap-4")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(card.getByTestId("mood-status")).toContainText("Good");

    // Persisted server-side: a fresh render shows the logged state.
    await page.reload();
    await expect(card.getByTestId("mood-tap-4")).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    // Idempotent per day: a re-tap UPDATES the day's one entry.
    await tapMood(page, card, 2);
    await page.reload();
    await expect(card.getByTestId("mood-tap-2")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(card.getByTestId("mood-tap-4")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  test("expand: energy and note save — and reach the Trends chart", async ({
    page,
  }) => {
    test.slow();
    await createProfileViaFamily(page, "moodmore");
    await page.goto("/");

    const card = page.getByTestId("how-are-you-card");
    // Pick a valence (settled on the marker), then expand the Rate section detail.
    await tapMood(page, card, 3);
    await hydratedClick(page, card.getByTestId("checkin-section-rate-toggle"));
    await expect(card.getByTestId("mood-detail")).toBeVisible();
    // Energy is universal; Calm is relevance-gated (#1313) and absent for this fresh,
    // signal-free profile — its presence/gating is covered in checkin-card.spec.ts.
    await expect(card.getByTestId("mood-anxiety-4")).toHaveCount(0);
    await hydratedClick(page, card.getByTestId("mood-energy-2"));
    await card.getByTestId("mood-note").fill("short night");
    await settledClick(page, card.getByTestId("mood-save"));
    // The save settles when the server marker reflects the expanded fields — a
    // declared 15s budget: the marker updates only after the write committed AND
    // the refresh round-tripped, which loses the default 5s window under load
    // (observed locally 6/9 on clean main, the #1556 family).
    await expect(card.getByTestId("mood-server-logged")).toHaveAttribute(
      "data-energy",
      "2",
      { timeout: 15_000 }
    );
    await expect(card.getByTestId("mood-server-logged")).toHaveAttribute(
      "data-note",
      "short night"
    );

    // Persisted: reload, re-expand, everything is still there.
    await page.reload();
    await expect(card.getByTestId("mood-tap-3")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await hydratedClick(page, card.getByTestId("checkin-section-rate-toggle"));
    await expect(card.getByTestId("mood-energy-2")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(card.getByTestId("mood-note")).toHaveValue("short night");

    // The logged series surface on Trends → Body (never flag-checked — the card
    // copy says so in plain words). Energy charts beside mood since #1408: it was
    // stored from the start and plotted nowhere, so a profile that just rated it
    // must be able to find it.
    await page.goto("/trends");
    const trend = page.getByTestId("mood-trend");
    await expect(trend).toBeVisible();
    await expect(trend).toContainText("never range-checked");
    const energyTrend = page.getByTestId("energy-trend");
    await expect(energyTrend).toBeVisible();
    await expect(energyTrend).toContainText("never range-checked");
    // Calm has no card here: this fresh profile never got the gated scale, so it
    // rated no anxiety — and a trend may not be what surfaces a scale the card
    // itself withheld.
    await expect(page.getByTestId("calm-trend")).toHaveCount(0);

    // Each card taps through to its own detail page, where the reading is listed
    // and correctable — the treatment mood already had.
    await followLink(
      page,
      energyTrend.getByTestId("chart-card-header-link"),
      /\/trends\/metric\/energy/
    );
    await expect(page.getByTestId("metric-detail-page")).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: "Energy" })
    ).toBeVisible();
    await expect(page.getByTestId("metric-latest-value")).toHaveText("2");
  });

  test("active-episode state: the cockpit takes the hero, and the mood tap coexists", async ({
    page,
  }) => {
    test.slow();
    await createProfileViaFamily(page, "moodsick");
    await page.goto("/");

    const card = page.getByTestId("how-are-you-card");
    // Branch into the illness flow (door A, one tap). This used to be a bare click
    // under a declared 15s budget, because settledClick once armed on ANY
    // same-origin POST and the dashboard's bystander traffic made it unreliable.
    // #1952 replaced that with correlation — an action POST that started AFTER the
    // click and targets this route — so the objection no longer holds, and the
    // cockpit marker is exactly the "revalidated render" case (#1858).
    // illness-front-door.spec.ts drives this same control the same way.
    await settledClickApplied(
      page,
      page.getByTestId("feeling-sick-activate"),
      page.getByTestId("symptom-log-bar")
    );

    // State 2 — the shell stays for the mood tap, the illness branch defers to
    // the hero with a quiet note, and the front-door affordance is gone.
    await expect(card).toBeVisible();
    await expect(card.getByTestId("mood-episode-note")).toBeVisible();
    await expect(card.getByTestId("feeling-sick-activate")).toHaveCount(0);

    // Mood during illness still logs (illness never hides the mood layer).
    await tapMood(page, card, 2);
    await page.reload();
    await expect(card.getByTestId("mood-tap-2")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});
