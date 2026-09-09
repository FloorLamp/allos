import { test, expect } from "./fixtures";
import { appContent, settledFill } from "./helpers";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_WEEK_SPINE,
  E2E_MEMBER_PASSWORD,
  WEEK_SPINE_PROFILE,
} from "./fixture-logins";
import { frozenNow, workerDbPath } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import { utcMinute, zonedWallTimeToUtc } from "@/lib/date";

// Issue #159: training intensity distribution (HR zones). The seed profile is
// ~40y with a resting HR, so the zone model builds via Karvonen. e2e/seed-events
// layers a windowed cardio ride with per-minute HR (50 min Zone 2 + 10 min Zone 4)
// plus one out-of-window resting bucket that must NOT count (both dated within the
// hub's 90-day default window, so the section's shared range includes them). These
// specs prove the Training → Analyze zone section renders that distribution, and that the Settings →
// Profile inputs persist. Reads only + a self-cleaning settings round-trip, so no
// rows other specs assert on are disturbed. The first journey also adds and removes
// its own mixed-HR rows on the dedicated week-spine profile to compare both callers.

test("Training → Analyze renders the HR training-intensity section (#159/#3512)", async ({
  page,
  browser,
}) => {
  await page.goto("/training?tab=analyze");
  const main = page.getByRole("main");

  const zones = main.getByTestId("training-zones");
  await expect(zones).toBeVisible();
  await expect(zones.getByText("Training intensity (HR zones)")).toBeVisible();

  // The zone boundary table shows the formula (no black box) — Karvonen here.
  await expect(zones.getByText(/Karvonen/)).toBeVisible();
  // Zone names render in the boundary table.
  await expect(
    zones.getByText("Zone 2", { exact: false }).first() // eslint-disable-line no-restricted-properties -- first-ok: "Zone 2" labels a row in the scoped HR-zone table; assert the zone renders at all
  ).toBeVisible();

  // The easy/hard polarization split renders. The fixture is ~83/17, so "easy"
  // dominates — assert the split SUMMARY ("83% easy · 17% hard"). The full
  // pattern is required: the split element's own explanatory note ("...keeps
  // ~80% easy.") also matches a bare /% easy/, a strict-mode double-match.
  const split = zones.getByTestId("polarization-split");
  await expect(split).toBeVisible();
  await expect(split.getByText(/\d+% easy · \d+% hard/)).toBeVisible();

  // The current-week Zone 2 adherence line renders against the default target.
  await expect(zones.getByTestId("zone2-adherence")).toBeVisible();

  // The shared query already includes non-cardio HR. This leg must reach the
  // actual Overview caller too: the old cardio-only fork shows 100% / 0% here.
  const db = new Database(workerDbPath());
  try {
    const { id: profileId } = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(WEEK_SPINE_PROFILE) as { id: number };
    const { date } = db
      .prepare(
        "SELECT date FROM activities WHERE profile_id = ? AND external_id = 'e2e:week-spine-3'"
      )
      .get(profileId) as { date: string };
    const priorOverride = db
      .prepare(
        "SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'max_hr_override'"
      )
      .get(profileId) as { value: string } | undefined;
    const tz = pinnedTimezone(frozenNow().toISOString()).zone;
    const hr = [
      { ts: utcMinute(zonedWallTimeToUtc(tz, date, "08:00")!), bpm: 110 },
      ...Array.from({ length: 7 }, (_, minute) => ({
        ts: utcMinute(zonedWallTimeToUtc(tz, date, `09:0${minute}`)!),
        bpm: 150,
      })),
    ];
    // Cleanup owns only this committed transaction; a failed insert rolls back
    // before the cleanup scope, so a conflicting existing minute is never deleted.
    const activityIds = db.transaction(() => {
      db.prepare(
        `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'max_hr_override', '180')
         ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
      ).run(profileId);
      const activity = db.prepare(
        `INSERT INTO activities (profile_id, date, type, title, start_time, end_time, duration_min)
         VALUES (?, ?, ?, 'Synthetic shared zones', ?, ?, ?)`
      );
      const ids = [
        Number(
          activity.run(profileId, date, "cardio", "08:00", "08:01", 1)
            .lastInsertRowid
        ),
        Number(
          activity.run(profileId, date, "strength", "09:00", "09:07", 7)
            .lastInsertRowid
        ),
      ];
      const minute = db.prepare(
        "INSERT INTO hr_minutes (profile_id, ts, bpm, n, source) VALUES (?, ?, ?, 1, 'health-connect')"
      );
      for (const row of hr) minute.run(profileId, row.ts, row.bpm);
      return ids;
    })();
    let mixedPage: Page | undefined;
    try {
      mixedPage = await loginAs(browser, {
        username: E2E_LOGIN_WEEK_SPINE,
        password: E2E_MEMBER_PASSWORD,
      });
      await mixedPage.goto("/training?tab=analyze");
      const mixedContent = appContent(mixedPage);
      await expect(
        mixedContent
          .getByTestId("training-zones")
          .getByTestId("polarization-split")
          .getByText("13% easy · 88% hard", { exact: true })
      ).toBeVisible();
      await mixedPage.goto("/training?tab=overview");
      await expect(
        mixedContent
          .getByTestId("endurance-depth-suite")
          .getByText("Zone 2 1 min · 13% easy / 88% hard", { exact: true })
      ).toBeVisible();
    } finally {
      try {
        await mixedPage?.context().close();
      } finally {
        db.transaction(() => {
          const removeActivity = db.prepare(
            "DELETE FROM activities WHERE profile_id = ? AND id = ?"
          );
          for (const id of activityIds) removeActivity.run(profileId, id);
          const removeMinute = db.prepare(
            "DELETE FROM hr_minutes WHERE profile_id = ? AND ts = ? AND source = 'health-connect'"
          );
          for (const row of hr) removeMinute.run(profileId, row.ts);
          if (priorOverride) {
            db.prepare(
              "UPDATE profile_settings SET value = ? WHERE profile_id = ? AND key = 'max_hr_override'"
            ).run(priorOverride.value, profileId);
          } else {
            db.prepare(
              "DELETE FROM profile_settings WHERE profile_id = ? AND key = 'max_hr_override'"
            ).run(profileId);
          }
        })();
      }
    }
  } finally {
    db.close();
  }
});

test("Settings → Profile persists the max-HR override and Zone 2 target (#159)", async ({
  page,
}) => {
  await page.goto("/settings/training");
  const main = page.getByRole("main");

  const form = main.getByTestId("training-zones-form");
  await expect(form).toBeVisible();

  const maxHr = form.getByTestId("max-hr-override");
  const target = form.getByTestId("zone2-target-input");

  // Round-trip: set both, blur to save (the autosave check confirms), then reload
  // and confirm they stuck. SaveStatus is icon-only — match its aria-label.
  // settledFill: land the value in React state before the autosave reads it (a
  // pre-hydration fill of a controlled input reverts, no save fires — #1188).
  await settledFill(page, maxHr, "185");
  await maxHr.blur();
  await expect(form.getByLabel("Saved")).toBeVisible();
  await settledFill(page, target, "180");
  await target.blur();
  await expect(form.getByLabel("Saved")).toBeVisible();

  await page.reload();
  await expect(main.getByTestId("max-hr-override")).toHaveValue("185");
  await expect(main.getByTestId("zone2-target-input")).toHaveValue("180");

  // Self-clean: restore the defaults so other specs / re-runs see the seed state
  // (blank max-HR clears the override; 150 is the default Zone 2 target).
  const maxHr2 = main.getByTestId("max-hr-override");
  const target2 = main.getByTestId("zone2-target-input");
  await settledFill(page, maxHr2, "");
  await maxHr2.blur();
  await expect(main.getByLabel("Saved")).toBeVisible();
  await settledFill(page, target2, "150");
  await target2.blur();
  await expect(main.getByLabel("Saved")).toBeVisible();
});

test("Settings → Training persists the daily step target (#1723)", async ({
  page,
}) => {
  await page.goto("/settings/training");
  const main = page.getByRole("main");
  const form = main.getByTestId("training-zones-form");
  await expect(form).toBeVisible();

  // The declared daily step target starts EMPTY — nothing counts steps against a
  // number nobody chose, so blank is the honest resting state, not a defaulted 10k.
  const steps = form.getByTestId("steps-daily-target-input");
  await expect(steps).toHaveValue("");

  await settledFill(page, steps, "8000");
  await steps.blur();
  await expect(form.getByLabel("Saved")).toBeVisible();

  await page.reload();
  await expect(main.getByTestId("steps-daily-target-input")).toHaveValue(
    "8000"
  );

  // Clearing it is a first-class state, not an error: self-clean back to no target.
  const steps2 = main.getByTestId("steps-daily-target-input");
  await settledFill(page, steps2, "");
  await steps2.blur();
  await expect(main.getByLabel("Saved")).toBeVisible();
  await page.reload();
  await expect(main.getByTestId("steps-daily-target-input")).toHaveValue("");
});
