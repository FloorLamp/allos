import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";
import {
  settledCheckSave,
  settledFillSave,
  settledSelectSave,
} from "./helpers";

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

// Wake-aware mornings (issue #1117) at minute grain (#2121): the wake-derived
// "Auto" state on the Morning intake slot, a manual minute-precise time, the
// sub-hourly honesty warning, and the sleep-summary opt-in, on Settings →
// Notifications. The DIGEST no longer has an Auto — #2211 replaced it with two
// modes, covered by digest-modes.spec.ts. Runs as admin acting as the seeded profile
// 1 (shared storageState). As of #1072 the schedule is per-SUBJECT and always
// visible; #1462 §6 split it into a "Schedule" card (slot times, quiet hours) and
// a "Message kinds" card (one row per kind: enable + config + channel routing),
// both autosaving on change. Since #2121 each slot renders a MODE select
// (Off/Auto/At time) plus a native time input once a concrete time is chosen.
// BLAST RADIUS: it drives the Morning/digest controls + the sleep toggle, then
// RESETS them (Morning back to Auto — profile 1's default, digest off, sleep off)
// so the shared fixture is left as found.
test.describe("wake-aware mornings (issue #1117, minute grain #2121)", () => {
  test("Auto option, minute-precise manual time + sleep-summary opt-in round-trip", async ({
    page,
  }) => {
    test.slow(); // local `next dev` compiles the route on first hit

    await page.goto("/settings/notifications");

    const scheduleCard = page.getByTestId("notify-schedule");
    const kindsCard = page.getByTestId("notification-kinds");
    await expect(scheduleCard).toBeVisible();
    await expect(kindsCard).toBeVisible();

    const morning = page.getByTestId("supp-morning-hour");

    // The wake-aware option is offered on the Morning intake slot. It is NOT offered
    // on the digest any more (#2211) — that slot needs you awake, the digest needs
    // your tracker synced, and welding the two together is the defect #2214 measured.
    await expect(morning.getByRole("option", { name: /^Auto \(/ })).toHaveCount(
      1
    );
    await expect(
      page.getByTestId("digest-hour").getByRole("option", { name: /^Auto/ })
    ).toHaveCount(0);

    // Pick a concrete Morning time at MINUTE precision → it persists as a manual
    // choice. Switching the mode to "At time" reveals the time input seeded with
    // the slot default; the fill then lands the sub-hourly minute.
    await settledSelectSave(page, morning, "time", scheduleCard);
    const morningTime = page.getByTestId("supp-morning-hour-time");
    await expect(morningTime).toBeVisible();
    await settledFillSave(page, morningTime, "09:15", scheduleCard);
    await page.reload();
    await expect(page.getByTestId("supp-morning-hour")).toHaveValue("time");
    await expect(page.getByTestId("supp-morning-hour-time")).toHaveValue(
      "09:15"
    );

    // The sub-hourly honesty warning (#2121 constraint 4): the seeded instance has
    // no recorded tick cadence, so it reads as hourly — which cannot land on 09:15
    // — and the warning names the affected time.
    await expect(page.getByTestId("sub-hourly-tick-warning")).toContainText(
      "09:15"
    );

    // Switch the Morning slot back to Auto and turn the digest on, then set the sleep
    // summary (it's the opt-out default as of #1378; check() pins that it round-trips
    // as an explicit "1").
    await settledSelectSave(
      page,
      page.getByTestId("supp-morning-hour"),
      "auto",
      scheduleCard
    );
    await settledSelectSave(
      page,
      page.getByTestId("digest-hour"),
      "static",
      kindsCard
    );
    // Back on the hour: the warning clears with the sub-hourly time.
    await expect(page.getByTestId("sub-hourly-tick-warning")).toHaveCount(0);
    // #1378: the sleep summary is an opt-OUT (on by default WITH the digest). #1462 §6
    // nests it under the digest row as one of that kind's extras, so it appears only
    // once the digest is on — which it now is. (The default-on read is pinned in the
    // pure/action/DB tiers; this spec RESETS the toggle at the end, so the shared
    // profile-1 checkbox state isn't stable across --repeat-each and can't be asserted
    // here per e2e hygiene, #868.)
    await expect(
      page.getByText("Include last night’s sleep summary")
    ).toBeVisible();
    await settledCheckSave(
      page,
      page.getByTestId("digest-sleep-enabled"),
      true,
      kindsCard
    );

    // All three round-trip across a reload.
    await page.reload();
    await expect(page.getByTestId("supp-morning-hour")).toHaveValue("auto");
    await expect(page.getByTestId("digest-hour")).toHaveValue("static");
    await expect(page.getByTestId("digest-sleep-enabled")).toBeChecked();

    // Reset the shared fixture: Morning back to Auto (its default), digest off,
    // sleep off.
    await settledCheckSave(
      page,
      page.getByTestId("digest-sleep-enabled"),
      false,
      kindsCard
    );
    await settledSelectSave(
      page,
      page.getByTestId("digest-hour"),
      "",
      kindsCard
    );
  });

  // #2216: the time picker's grid follows the scheduler's OBSERVED cadence — as
  // guidance (the input's step), never validation (a typed off-grid time is
  // saved, and the warning names it rather than any control refusing it).
  // BLAST RADIUS: `notify_tick_interval_min` (global settings; restored to its
  // prior state in the finally) and the Morning slot (reset to Auto).
  test("picker grid follows the observed cadence; an off-grid typed time saves and warns", async ({
    page,
  }) => {
    test.slow(); // local `next dev` compiles the route on first hit

    // The scheduler RECORDS its observed cadence each tick; the grid reads that
    // record — never TICK_SECONDS — so this is exactly how a live 5-minute
    // sidecar presents.
    const prev = withDb(
      (db) =>
        db
          .prepare("SELECT value FROM settings WHERE key = ?")
          .get("notify_tick_interval_min") as { value: string } | undefined
    );
    withDb((db) =>
      db
        .prepare(
          `INSERT INTO settings (key, value) VALUES ('notify_tick_interval_min', '5')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        )
        .run()
    );
    try {
      await page.goto("/settings/notifications");
      const scheduleCard = page.getByTestId("notify-schedule");
      await expect(scheduleCard).toBeVisible();

      await settledSelectSave(
        page,
        page.getByTestId("supp-morning-hour"),
        "time",
        scheduleCard
      );
      const morningTime = page.getByTestId("supp-morning-hour-time");
      // The observed 5-minute cadence renders a 5-minute grid (step is seconds).
      await expect(morningTime).toHaveAttribute("step", "300");

      // A typed off-grid time is SAVED — it round-trips a reload — and the
      // warning then NAMES it, with the grid the steps copy points at.
      await settledFillSave(page, morningTime, "07:42", scheduleCard);
      await page.reload();
      await expect(page.getByTestId("supp-morning-hour-time")).toHaveValue(
        "07:42"
      );
      await expect(page.getByTestId("supp-morning-hour-time")).toHaveAttribute(
        "step",
        "300"
      );
      const warning = page.getByTestId("sub-hourly-tick-warning");
      await expect(warning).toContainText("07:42");
      await expect(warning).toContainText("5-minute steps");

      // A grid-aligned minute is silent: the cadence can hit 07:40 exactly.
      await settledFillSave(
        page,
        page.getByTestId("supp-morning-hour-time"),
        "07:40",
        scheduleCard
      );
      await expect(page.getByTestId("sub-hourly-tick-warning")).toHaveCount(0);

      // Reset the shared fixture: Morning back to Auto (profile 1's default).
      await settledSelectSave(
        page,
        page.getByTestId("supp-morning-hour"),
        "auto",
        scheduleCard
      );
    } finally {
      withDb((db) => {
        if (prev === undefined) {
          db.prepare("DELETE FROM settings WHERE key = ?").run(
            "notify_tick_interval_min"
          );
        } else {
          db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
            prev.value,
            "notify_tick_interval_min"
          );
        }
      });
    }
  });
});
