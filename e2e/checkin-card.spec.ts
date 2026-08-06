import { test, expect } from "./fixtures";
import { type Page, type Locator } from "@playwright/test";
import Database from "better-sqlite3";
import {
  followLink,
  hydratedClick,
  settledCheck,
  settledClick,
} from "./helpers";
import { createProfileViaFamily, switchToProfile } from "./family-helpers";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_WELLSYM,
  E2E_MEMBER_PASSWORD,
  WELL_SYMPTOM_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

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
    (await page.getByTestId("profile-identity-bar").textContent())?.includes(
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
    // A ScaleRow chip: onPick only calls setEnergy, and it TOGGLES (a second tap
    // clears it), so this is hydratedClick — one click, after the handler exists.
    // mood-status re-renders from that same state, which the next line asserts.
    await hydratedClick(page, card.getByTestId("mood-energy-3"));
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

    // The day-factor (today-only) half writes to the mood log's factors. The chip fires
    // a Server Action whose RESULT the next assertion reads, so it goes through
    // settledClick — helpers.ts decision-tree case 1 (a bare click here was the #1464
    // flake's exposure).
    const work = card.getByTestId("checkin-day-factor-work");
    await expect(work).toBeVisible();
    await expect(work).toHaveAttribute("aria-pressed", "false");
    await settledClick(page, work);
    // The marker re-renders from the DASHBOARD's server props, so this waits on a full
    // RSC refresh of the app's heaviest page — not just the write. The write itself is
    // already done (settledClick awaited its POST; #1464 confirmed the row always lands,
    // 9/9 on failing runs), so the only thing left to tolerate is that refresh. Budgeted
    // like its sibling situation assertion below rather than the 5 s default, which a
    // loaded runner overshoots — the #1464 flake.
    await expect(card.getByTestId("mood-server-logged")).toHaveAttribute(
      "data-factors",
      "work",
      { timeout: 15_000 }
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
    await settledClick(page, travel);
    await expect(travel).toHaveAttribute("aria-pressed", "true", {
      timeout: 15_000,
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

    // The gate reaches the TREND too (#1408): the Calm metric page does not exist
    // for this profile, and it reads exactly like any unknown metric — a page that
    // explained its own absence would leak the gate the card keeps silent.
    await page.goto("/trends/metric/calm");
    await expect(page.getByText("Unknown metric.")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/anxiety/i);

    // Flip the Settings → Profile opt-in (signal 6). The form autosaves on change, but
    // settledCheck only guarantees the box reached React STATE — NOT that the fire-and-
    // forget Server Action POST committed (the documented settledCheck gap); a bare
    // reload can beat that write. Settle on the AnxietyScaleForm's OWN "Saved" check
    // instead: SaveStatus shows it only after this card's action fully resolves (write
    // + revalidate + router.refresh), so it's a form-owned signal immune to the
    // settings page's other POSTs and to any read-after-write timing. THEN reload and
    // confirm the persisted opt-in.
    await page.goto("/settings/coaching");
    const optIn = page.getByTestId("anxiety-scale-enabled");
    await settledCheck(page, optIn, true);
    await expect(
      page.getByTestId("anxiety-scale-form").getByLabel("Saved")
    ).toBeVisible({ timeout: 15_000 });
    // Confirm the persisted opt-in; retry the reload so any residual read-after-write
    // timing self-heals (the setting is committed and idempotent, so re-reading is safe).
    await expect(async () => {
      await page.reload();
      await expect(page.getByTestId("anxiety-scale-enabled")).toBeChecked({
        timeout: 3_000,
      });
    }).toPass({ timeout: 20_000 }); // topass-ok: re-read the reloaded opt-in until the committed autosave shows — idempotent setting, safe to re-read

    // Back on the dashboard the Calm scale now appears, relabeled so high = calm (the
    // good end), matching Energy's direction (#1313 axis fix).
    await page.goto("/");
    await card.getByTestId("checkin-section-rate-toggle").click();
    await expect(card.getByTestId("mood-anxiety-5")).toBeVisible();
    await expect(card.getByTestId("mood-detail")).toContainText("calm");
    await expect(card.getByTestId("mood-detail")).toContainText("anxious");

    // Rate the day, pick the calmest slot, save. Stored anxiety is 1 (the #1313
    // involution), which the server-truth marker reports in STORE semantics.
    await tapMood(page, card, 4);
    // The Rate detail is already open from the assertions above and stays open
    // across the tap's refresh (the expander is client state).
    await expect(card.getByTestId("mood-anxiety-5")).toBeVisible();
    await card.getByTestId("mood-anxiety-5").click();
    await card.getByTestId("mood-save").click();
    await expect(card.getByTestId("mood-server-logged")).toHaveAttribute(
      "data-anxiety",
      "1",
      { timeout: 15_000 }
    );

    // With the scale relevant AND rated, the Calm trend is reviewable — plotted on
    // the card's own axis, so the calmest day sits at the TOP of the 1–5 range
    // rather than the bottom.
    await page.goto("/trends");
    const calmTrend = page.getByTestId("calm-trend");
    await expect(calmTrend).toBeVisible();
    await expect(calmTrend).toContainText("never range-checked");
    await followLink(
      page,
      calmTrend.getByTestId("chart-card-header-link"),
      /\/trends\/metric\/calm/
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "Calm" })
    ).toBeVisible();
    await expect(page.getByTestId("metric-latest-value")).toHaveText("5");
    expect(name).toContain("checkincalm");
  });

  // #2128: mood was CORRECT-ONLY — a past rating was editable, a MISSED day
  // unrecoverable. The yesterday chip is the fix: pick the day, then the same
  // one-tap flow, and the write lands on THAT day without touching today.
  test("the yesterday chip backfills a missed day without touching today (#2128)", async ({
    page,
  }) => {
    test.slow();
    const name = await createProfileViaFamily(page, "checkinyday");
    await page.goto("/");

    const card = page.getByTestId("how-are-you-card");
    await expect(card).toBeVisible();

    // Today leads, pressed; the chips carry their server-resolved dates.
    const todayChip = card.getByTestId("mood-day-0");
    const yesterdayChip = card.getByTestId("mood-day-1");
    await expect(todayChip).toHaveAttribute("aria-pressed", "true");
    await expect(yesterdayChip).toHaveText("Yesterday");
    const yesterdayDate = await yesterdayChip.getAttribute("data-date");
    expect(yesterdayDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // A pure client toggle (no POST to settle on): hydratedClick, then the
    // pressed state proves the pick landed.
    await hydratedClick(page, yesterdayChip);
    await expect(yesterdayChip).toHaveAttribute("aria-pressed", "true");
    // The face row mirrors the selected (unlogged) day.
    await expect(card.getByTestId("mood-status")).toHaveText(
      "Tap to log your day."
    );

    // One tap logs YESTERDAY; the settle hook is the dated server marker that
    // only renders once the write committed and the refresh round-tripped.
    await expect(async () => {
      await card.getByTestId("mood-tap-2").click({ timeout: 2_000 });
      await expect(card.getByTestId("mood-server-logged-1")).toHaveAttribute(
        "data-valence",
        "2",
        { timeout: 4_000 }
      );
    }).toPass(); // topass-ok: re-tap until the dated server marker reflects it past the pre-hydration swallow — idempotent per-day upsert, safe to re-drive
    await expect(card.getByTestId("mood-server-logged-1")).toHaveAttribute(
      "data-date",
      yesterdayDate!
    );

    // Today stays unlogged — the backfill wrote one day, not two.
    await expect(card.getByTestId("mood-server-logged")).toHaveCount(0);

    // Durable server truth: exactly one row, on yesterday's date.
    const db = new Database(workerDbPath());
    try {
      db.pragma("busy_timeout = 5000");
      const rows = db
        .prepare(
          `SELECT date, valence FROM mood_logs
            WHERE profile_id = (SELECT id FROM profiles WHERE name = ?)`
        )
        .all(name) as { date: string; valence: number }[];
      expect(rows).toEqual([{ date: yesterdayDate, valence: 2 }]);
    } finally {
      db.close();
    }
  });
});

// Well-day symptom logging + the reported-burden coaching tilt (#1300). Driven against the
// dedicated WELL_SYMPTOM_PROFILE (a well profile with a small strength history and no
// illness / rest signals) so the tilt is purely the logged symptom and the write never
// perturbs a neighbor fixture. Signs in as its own member context (loginAs), independent of
// the admin storageState the recomposition tests use.

// The fixture's symptom / mood / coaching rows, reset before each test so --repeat-each
// starts clean (#868 fixture ownership) — the same direct-DB reset coaching-rest-card uses.
function resetWellSymptomState(): void {
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const row = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(WELL_SYMPTOM_PROFILE) as { id: number } | undefined;
    if (row) {
      db.prepare("DELETE FROM symptom_logs WHERE profile_id = ?").run(row.id);
      db.prepare("DELETE FROM mood_logs WHERE profile_id = ?").run(row.id);
      db.prepare(
        "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key LIKE 'coaching:%'"
      ).run(row.id);
    }
  } finally {
    db.close();
  }
}

test.describe("Well-day symptom logging + burden tilt (#1300)", () => {
  test.beforeEach(() => resetWellSymptomState());

  test("logging a severe symptom from the check-in Report entry tilts coaching, no illness required", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_WELLSYM,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.goto("/");

    const card = page.getByTestId("how-are-you-card");
    await expect(card).toBeVisible();

    // A mood tap hydrates the card and settles the server round-trip (idempotent per-day
    // upsert) — a stable start before the client toggles below.
    await tapMood(page, card, 3);

    // The Report section's illness door renders inline at rest (a well day) — the symptom
    // bar is NOT in the DOM until the well-day reveal is opened.
    await expect(card.getByTestId("feeling-sick-activate")).toBeVisible();
    await expect(card.getByTestId("symptom-log-bar")).toHaveCount(0);

    // Open the well-day symptom quick-log (client toggles) and log a SEVERE symptom.
    await card.getByTestId("checkin-symptom-toggle").click();
    const bar = card.getByTestId("symptom-log-bar");
    await expect(bar).toBeVisible();
    await bar.getByTestId("symptom-add-picker-toggle").click();
    await expect(bar.getByTestId("symptom-add-picker")).toBeVisible();
    // The pick logs at severity 1; raise it to 3 (severe). Both are Server Actions.
    await settledClick(page, bar.getByTestId("symptom-pick-headache"));
    await settledClick(page, bar.getByTestId("symptom-headache-sev-3"));
    await expect(bar.getByTestId("symptom-headache-sev-3")).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    // The suggest-only illness bridge renders — present, but NOT required (logging a
    // symptom activated no illness/situation).
    await expect(bar.getByTestId("symptom-illness-bridge")).toBeVisible();
    await expect(card.getByTestId("feeling-sick-activate")).toBeVisible();

    // The coaching card tilts toward an easier session, naming the actual report — retry the
    // reload so the router.refresh read-after-write settles (idempotent read).
    const coachingCard = page.locator(".card", {
      has: page.getByTestId("coaching-snooze"),
    });
    await expect(async () => {
      await page.reload();
      await expect(coachingCard).toContainText("severe headache", {
        timeout: 3_000,
      });
    }).toPass({ timeout: 20_000 }); // topass-ok: re-read the reloaded coaching card until the tilt reflects the committed symptom log — idempotent read
    await expect(coachingCard).toContainText("easier session");
  });
});

// ---- The auto-paused check-in, made visible (issue #1668) ----
//
// The evening reminder auto-pauses after quiet days. The mechanism is right (#992 — a
// disengaged user must not be nagged), but the SILENCE read as "notifications broke"
// and there was no in-app trace or way to resume short of remembering to log a mood.
// The paused state is DERIVED (the ignored streak), never a stored flag, so this drives
// it by setting that streak directly and asserting the card presents and clears it.
test.describe("mood check-in auto-pause visibility (#1668)", () => {
  // Set the profile's ignored-send streak, the state shouldSendMoodCheckin reads.
  function setIgnoredStreak(profileName: string, count: number): void {
    const db = new Database(workerDbPath());
    try {
      db.pragma("busy_timeout = 5000");
      const row = db
        .prepare("SELECT id FROM profiles WHERE name = ?")
        .get(profileName) as { id: number } | undefined;
      if (!row) throw new Error(`no profile ${profileName}`);
      db.prepare(
        `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'mood_checkin_enabled', '1')
         ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
      ).run(row.id);
      db.prepare(
        `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'mood_checkin_ignored', ?)
         ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
      ).run(row.id, String(count));
    } finally {
      db.close();
    }
  }

  test("a paused check-in says so on the card, and Resume clears it", async ({
    page,
  }) => {
    test.slow();
    // createProfileViaFamily uniquifies the label — use the name it actually made.
    const profile = await createProfileViaFamily(page, "checkinpause");
    setIgnoredStreak(profile, 5); // at the auto-pause line
    await page.goto("/");

    const card = page.getByTestId("how-are-you-card");
    await expect(card).toBeVisible();

    // The pause is stated — no guilt, no streak language.
    const banner = card.getByTestId("mood-checkins-paused");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("paused");

    // Resume is one tap, and the banner goes with it (the streak reset is the same
    // write logging a mood performs).
    await settledClick(page, card.getByTestId("mood-checkins-resume"));
    await expect(card.getByTestId("mood-checkins-paused")).toHaveCount(0, {
      timeout: 20_000, // named ceiling: server action + dashboard re-render
    });
  });

  test("a running check-in shows no paused state at all", async ({ page }) => {
    test.slow();
    const profile = await createProfileViaFamily(page, "checkinrunning");
    setIgnoredStreak(profile, 0);
    await page.goto("/");

    const card = page.getByTestId("how-are-you-card");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("mood-checkins-paused")).toHaveCount(0);
  });
});
