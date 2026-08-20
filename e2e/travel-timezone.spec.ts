import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { settledClick } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_TRAVEL,
  E2E_LOGIN_TRAVEL_CARER,
  TRAVELLER_PROFILE,
} from "./fixture-logins";
import { frozenNow, workerDbPath } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";

// Travel banner (#3263) — the browser half of "the app notices you have moved".
//
// It is a PAGE SURFACE and nothing else: it appears when you open the app somewhere
// your day is not, and no notification is ever sent about a timezone (#3084's
// sibling doctrine). So the only place it can be observed is a real browser, in a
// real zone, which is what these drive.
//
// TIMEZONE DISCIPLINE. Neither fixture profile opts out of the run's pinned
// timezone (e2e/pinned-timezone.ts, e2e/fixture-timezones.ts) — the pin is what
// makes "the profile's zone" a known quantity for the comparison this feature IS,
// and #3260 is the receipt for what opting out of it costs. The zones below are set
// on the BROWSER CONTEXT, which is exactly the signal the product reads.
//
// SERIAL, and spec-owned. The accept case MOVES the traveller profile's timezone, so
// these tests share one evolving world and must run in order; no other spec reads
// these profiles (e2e/logins/travel.ts).
test.describe.configure({ mode: "serial" });

const AWAY = "Asia/Tokyo";
const SECOND_AWAY = "Europe/Paris";

// The zone the traveller profile's day runs on before anything moves it: the run's
// own rotating pin, which is also the zone the auto-revert has to recognise as home.
function homeZone(): string {
  return pinnedTimezone(frozenNow().toISOString()).zone;
}

// Read one of the traveller profile's stored settings straight out of the worker's
// isolated database — the server-side fact behind the banner, so an assertion is
// never satisfied by the UI alone.
function travellerSetting(key: string): string | null {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const profile = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(TRAVELLER_PROFILE) as { id: number };
    const row = db
      .prepare(
        "SELECT value FROM profile_settings WHERE profile_id = ? AND key = ?"
      )
      .get(profile.id, key) as { value: string } | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

test.describe("travel timezone banner (#3263)", () => {
  test("offers the switch, remembers the dismissal, and re-raises in a new zone", async ({
    browser,
  }) => {
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_TRAVEL, password: E2E_MEMBER_PASSWORD },
      { timezoneId: AWAY }
    );
    try {
      await page.goto("/");
      const banner = page.getByTestId("travel-timezone-banner");
      await expect(banner).toBeVisible();
      // Names the PLACE, not the IANA path — and asks rather than announcing.
      await expect(banner).toContainText("Tokyo");
      await expect(banner).toContainText("move your day there?");
      // Shown, never sent: nothing has moved yet.
      expect(travellerSetting("timezone")).toBeNull();

      await settledClick(page, page.getByTestId("travel-timezone-dismiss"));
      await expect(banner).toBeHidden();
      expect(travellerSetting("timezone_travel_dismissed")).toBe(AWAY);

      // A dismissal survives a reload — this is the "no daily nag on a long trip"
      // half, and a banner that came back on the next page view would be exactly
      // the nag it exists to prevent.
      await page.reload();
      await expect(page.getByTestId("travel-timezone-banner")).toBeHidden();
      // Still nothing moved.
      expect(travellerSetting("timezone")).toBeNull();
    } finally {
      await page.context().close();
    }

    // A NEW zone is a new question, so the dismissal does not answer it.
    const paris = await loginAs(
      browser,
      { username: E2E_LOGIN_TRAVEL, password: E2E_MEMBER_PASSWORD },
      { timezoneId: SECOND_AWAY }
    );
    try {
      await paris.goto("/");
      const banner = paris.getByTestId("travel-timezone-banner");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("Paris");
    } finally {
      await paris.context().close();
    }
  });

  test("moves the day on one tap and remembers home", async ({ browser }) => {
    const home = homeZone();
    // The SECOND zone, deliberately: the first one carries a live dismissal from the
    // test above, and the offer is suppressed there — which is the point of it.
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_TRAVEL, password: E2E_MEMBER_PASSWORD },
      { timezoneId: SECOND_AWAY }
    );
    try {
      await page.goto("/");
      await settledClick(page, page.getByTestId("travel-timezone-accept"));
      // The banner has nothing left to ask once the day is where the device is.
      await expect(page.getByTestId("travel-timezone-banner")).toBeHidden();
      await expect
        .poll(() => travellerSetting("timezone"), { timeout: 10_000 })
        .toBe(SECOND_AWAY);
      // The zone it left is remembered, which is the whole reason the return can be
      // recognised without asking anybody anything.
      expect(travellerSetting("timezone_home")).toBe(home);
      // And the seam it left in the wall clock is on record for the switch-day rules.
      expect(travellerSetting("timezone_switches")).toContain(SECOND_AWAY);
      // A new zone is a new question, so the earlier dismissal is spent.
      expect(travellerSetting("timezone_travel_dismissed")).toBeNull();
    } finally {
      await page.context().close();
    }
  });

  test("reverts on its own when the device comes home, and says so afterwards", async ({
    browser,
  }) => {
    const home = homeZone();
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_TRAVEL, password: E2E_MEMBER_PASSWORD },
      { timezoneId: home }
    );
    try {
      await page.goto("/");
      // NO PROMPT. Coming home is lossless and reverses a state the person entered
      // deliberately, so it happens and then tells (#2471).
      const notice = page.getByTestId("travel-timezone-notice");
      await expect(notice).toBeVisible();
      await expect(page.getByTestId("travel-timezone-accept")).toHaveCount(0);
      // The tell names BOTH zones — "back on home time" alone leaves the person
      // guessing which of the trip's zones the app had been running on.
      await expect(notice).toContainText("Paris");
      await expect(notice).toContainText("Back on");

      await expect
        .poll(() => travellerSetting("timezone"), { timeout: 10_000 })
        .toBe(home);
      // The trip is over, so the marker that said "away" is gone.
      expect(travellerSetting("timezone_home")).toBeNull();
    } finally {
      await page.context().close();
    }
  });

  test("says nothing to a member acting for somebody else's profile", async ({
    browser,
  }) => {
    // Same browser, same zone, same household — but this session is acting for the
    // COMPANION, who is not the login's own profile. This device's location says
    // nothing about where that person's day should run.
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_TRAVEL_CARER, password: E2E_MEMBER_PASSWORD },
      { timezoneId: AWAY }
    );
    try {
      await page.goto("/");
      // The shell really rendered — an absent banner on a blank page proves nothing.
      await expect(page.getByTestId("app-content-container")).toBeVisible();
      await expect(page.getByTestId("travel-timezone-banner")).toHaveCount(0);
      await expect(page.getByTestId("travel-timezone-notice")).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
});
