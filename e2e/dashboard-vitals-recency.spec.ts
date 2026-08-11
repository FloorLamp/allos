import { test, expect } from "./fixtures";
import { type TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { E2E_LOGIN_DAILY, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { createFixtureProfile, destroyFixtureProfile } from "./fixture-profile";
import { workerDbPath, frozenNow } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import { shiftDateStr } from "@/lib/date";
import { setFixtureTimezone } from "./fixture-timezones";

// THE LATEST-VITALS RECENCY FLOOR (issue #2303).
//
// The card had no date bound of any kind, so a profile's newest blood pressure rendered
// as a headline number with a trend arrow at ANY age — and because the tail is the last
// two readings by position, a single clinic visit's three sequential cuff readings
// produced an arrow claiming "up versus previous blood pressure" between reading #3 and
// reading #2 of one measurement. Beside a resting HR from yesterday, in identical
// typography, the whole card read as a snapshot of "my vitals now".
//
// The seeded shape here is exactly that: one visit's three same-day cuff readings, years
// old, plus a fresh resting HR. The assertions are what the card CLAIMS — the values
// themselves must still be on screen, because the fix is never to hide them.
//
// Fixture-OWNED (#868): its own login and profile, created and destroyed by the spec, so
// nothing depends on the shared seed and a --repeat-each run can't collide.

const DB_PATH = workerDbPath();
const TZ = pinnedTimezone(frozenNow().toISOString()).zone;
const TODAY = frozenNow().toISOString().slice(0, 10);
const day = (back: number) => shiftDateStr(TODAY, -back);

// Deep enough that the relative label rounds to whole years — the reported card's blood
// pressure was four and a half years old.
const BP_DAYS_AGO = 1600;

interface VitalsFixture {
  username: string;
  loginId: number;
  profileId: number;
}

function createVitalsFixture(testInfo: TestInfo): VitalsFixture {
  const handle = new Database(DB_PATH);
  handle.pragma("busy_timeout = 5000");
  try {
    const suffix = `${process.pid}-${testInfo.repeatEachIndex}`;
    const username = `e2e_vitals_age_${suffix}`;
    let loginId = 0;
    let profileId = 0;
    handle
      .transaction(() => {
        const passwordHash = (
          handle
            .prepare("SELECT password_hash FROM logins WHERE username = ?")
            .get(E2E_LOGIN_DAILY) as { password_hash: string }
        ).password_hash;
        profileId = createFixtureProfile(handle, `Vitals age ${suffix}`);
        loginId = Number(
          handle
            .prepare(
              "INSERT INTO logins (username, password_hash, role) VALUES (?, ?, 'member')"
            )
            .run(username, passwordHash).lastInsertRowid
        );
        handle
          .prepare(
            `INSERT INTO login_profiles (login_id, profile_id, access)
             VALUES (?, ?, 'write')`
          )
          .run(loginId, profileId);
        // Pin the profile's timezone to the run's, so the seeded days are the days the
        // card ages against.
        setFixtureTimezone(handle, profileId, "vitals-recency", TZ);

        // One visit, three sequential cuff readings on ONE day. SYNTHETIC values.
        const bp = handle.prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, unit, canonical_name, value_num)
           VALUES (?, ?, 'vitals', ?, ?, 'mmHg', ?, ?)`
        );
        for (const [sys, dia] of [
          [126, 82],
          [124, 80],
          [128, 84],
        ] as const) {
          const visit = day(BP_DAYS_AGO);
          bp.run(
            profileId,
            visit,
            "Blood Pressure Systolic",
            String(sys),
            "Blood Pressure Systolic",
            sys
          );
          bp.run(
            profileId,
            visit,
            "Blood Pressure Diastolic",
            String(dia),
            "Blood Pressure Diastolic",
            dia
          );
        }

        // A resting HR from yesterday, with a prior reading on a DIFFERENT day so it
        // legitimately carries a direction.
        const hr = handle.prepare(
          `INSERT INTO body_metrics (profile_id, date, resting_hr, source)
           VALUES (?, ?, ?, 'manual')`
        );
        hr.run(profileId, day(4), 59);
        hr.run(profileId, day(1), 61);
      })
      .immediate();
    return { username, loginId, profileId };
  } finally {
    handle.close();
  }
}

function destroyVitalsFixture(fixture: VitalsFixture): void {
  const handle = new Database(DB_PATH);
  handle.pragma("busy_timeout = 5000");
  try {
    handle
      .transaction(() => {
        handle
          .prepare("DELETE FROM sessions WHERE login_id = ?")
          .run(fixture.loginId);
        handle
          .prepare("DELETE FROM login_profiles WHERE login_id = ?")
          .run(fixture.loginId);
        handle
          .prepare("DELETE FROM login_settings WHERE login_id = ?")
          .run(fixture.loginId);
        handle.prepare("DELETE FROM logins WHERE id = ?").run(fixture.loginId);
        handle
          .prepare("DELETE FROM medical_records WHERE profile_id = ?")
          .run(fixture.profileId);
        handle
          .prepare("DELETE FROM body_metrics WHERE profile_id = ?")
          .run(fixture.profileId);
        handle
          .prepare("DELETE FROM profile_settings WHERE profile_id = ?")
          .run(fixture.profileId);
        destroyFixtureProfile(handle, fixture.profileId);
      })
      .immediate();
  } finally {
    handle.close();
  }
}

test("a years-old blood pressure is age-labeled and loses its arrow, while yesterday's resting HR is untouched", async ({
  browser,
}, testInfo) => {
  const fixture = createVitalsFixture(testInfo);
  const page = await loginAs(browser, {
    username: fixture.username,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    const card = page.getByRole("main").getByTestId("vitals-latest-widget");
    await expect(card).toBeVisible();

    const bp = card.getByTestId("vitals-latest-bp");
    // The VALUE stays — the newest of the visit's three readings, at full prominence.
    await expect(bp).toContainText("128/84");
    // ...and the raw ISO date is replaced by an age that reads as an age, amber, with a
    // title explaining the tint (the treatment #1216 established on Recent labs).
    const bpAge = card.getByTestId("vitals-latest-bp-age");
    await expect(bpAge).toHaveText("4 years ago");
    await expect(bpAge).toHaveAttribute("data-stale", "true");
    await expect(bpAge).toHaveAttribute("title", /Older than six months/);
    // No arrow: the direction it used to claim was between two readings of one sitting.
    await expect(bp).not.toContainText("versus previous blood pressure");

    // The fresh row is unaffected: plain date, no tint, and its arrow intact.
    const hr = card.getByTestId("vitals-latest-resting-hr");
    await expect(hr).toContainText("61");
    const hrAge = card.getByTestId("vitals-latest-resting-hr-age");
    await expect(hrAge).toHaveText(day(1));
    await expect(hrAge).not.toHaveAttribute("data-stale", "true");
    await expect(hr).toContainText("up versus previous resting heart rate");

    // Nothing is hidden and nothing is emptied: the header still says "Latest vitals"
    // (latest is a fact; current was the claim removed) and #1892's action is still the
    // obvious next move.
    await expect(card).toContainText("Latest vitals");
    await expect(card.getByTestId("vitals-log-reading")).toBeVisible();
  } finally {
    await page.context().close();
    destroyVitalsFixture(fixture);
  }
});
