import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { settledClick } from "./helpers";
import { loginAs } from "./nav";
import { switchToProfile } from "./family-helpers";
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
// own rotating pin, which is also the zone the return offer has to recognise as home.
function homeZone(): string {
  return pinnedTimezone(frozenNow().toISOString()).zone;
}

// The traveller profile's travel-related settings, read straight out of the worker's
// isolated database — the server-side facts behind the banner, so an assertion is
// never satisfied by the UI alone.
//
// ONE SELECT over the whole travel key-set, read out by PROPERTY, so no call in
// this file passes "timezone" as an argument. The #3260 registry guard
// (lib/__tests__/e2e-fixture-time.test.ts) flags any e2e call carrying that literal,
// because a WRITE is exactly what it must never miss — and it cannot tell a read
// from a write by shape. Keeping the key-set inside one SELECT keeps that guard at
// full strength here instead of teaching it an exception it would then owe everyone.
interface TravellerSettings {
  timezone: string | null;
  timezone_home: string | null;
  timezone_travel_dismissed: string | null;
  timezone_switches: string | null;
  timezone_travel_tell: string | null;
}

function travellerSettings(): TravellerSettings {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const profile = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(TRAVELLER_PROFILE) as { id: number };
    const rows = db
      .prepare(
        `SELECT key, value FROM profile_settings
          WHERE profile_id = ?
            AND key IN ('timezone', 'timezone_home',
                        'timezone_travel_dismissed', 'timezone_switches',
                        'timezone_travel_tell')`
      )
      .all(profile.id) as { key: string; value: string }[];
    const byKey = Object.fromEntries(
      rows.map((r) => [r.key, r.value])
    ) as Partial<Record<keyof TravellerSettings, string>>;
    return {
      timezone: byKey.timezone ?? null,
      timezone_home: byKey.timezone_home ?? null,
      timezone_travel_dismissed: byKey.timezone_travel_dismissed ?? null,
      timezone_switches: byKey.timezone_switches ?? null,
      timezone_travel_tell: byKey.timezone_travel_tell ?? null,
    };
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
      // A NAMED CEILING, not a sleep. The banner cannot exist until React has
      // hydrated and the effect has read the device zone, and on a loaded runner
      // that chain outlasts the 5 s default — which surfaces as "element(s) not
      // found", the shape that reads like a missing feature instead of a slow one.
      // This still fails if the banner never comes.
      await expect(banner).toBeVisible({ timeout: 20_000 });
      // Names the PLACE, not the IANA path — and asks rather than announcing.
      await expect(banner).toContainText("Tokyo");
      await expect(banner).toContainText("move your day there?");
      // Shown, never sent: nothing has moved yet.
      expect(travellerSettings().timezone).toBeNull();

      await settledClick(page, page.getByTestId("travel-timezone-dismiss"));
      await expect(banner).toBeHidden();
      expect(travellerSettings().timezone_travel_dismissed).toBe(AWAY);

      // A dismissal survives a reload — this is the "no daily nag on a long trip"
      // half, and a banner that came back on the next page view would be exactly
      // the nag it exists to prevent.
      await page.reload();
      await expect(page.getByTestId("travel-timezone-banner")).toBeHidden();
      // Still nothing moved.
      expect(travellerSettings().timezone).toBeNull();
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
      await expect(banner).toBeVisible({ timeout: 20_000 });
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
        .poll(() => travellerSettings().timezone, { timeout: 10_000 })
        .toBe(SECOND_AWAY);
      // The zone it left is remembered, which is the whole reason the return can be
      // recognised without asking anybody anything.
      expect(travellerSettings().timezone_home).toBe(home);
      // And the seam it left in the wall clock is on record for the switch-day rules.
      expect(travellerSettings().timezone_switches).toContain(SECOND_AWAY);
      // A new zone is a new question, so the earlier dismissal is spent.
      expect(travellerSettings().timezone_travel_dismissed).toBeNull();
    } finally {
      await page.context().close();
    }
  });

  test("offers the return, survives navigation without moving, then moves on accept", async ({
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
      const banner = page.getByTestId("travel-timezone-banner");
      await expect(banner).toBeVisible({ timeout: 20_000 });
      await expect(banner).toContainText("Your device is back on");
      await expect(banner).toContainText("move your day back?");

      // A browser reporting home is only an offer. This is the VPN case: hydration
      // has definitely read the zone (the banner is visible), yet the profile's day
      // and trip marker remain away until the person accepts.
      expect(travellerSettings().timezone).toBe(SECOND_AWAY);
      expect(travellerSettings().timezone_home).toBe(home);

      // Navigate exactly where the old effect raced the outgoing document. The old
      // implementation could finish its write after this page was gone; now an
      // ordinary navigation has no write to race and the return offer simply renders
      // again on the destination.
      const navigation = await page.goto("/settings/display");
      expect(navigation?.status()).toBe(200);
      const navigatedBanner = page.getByTestId("travel-timezone-banner");
      await expect(navigatedBanner).toBeVisible({ timeout: 20_000 });
      expect(travellerSettings().timezone).toBe(SECOND_AWAY);
      expect(travellerSettings().timezone_home).toBe(home);
      expect(travellerSettings().timezone_travel_tell).toBeNull();

      await settledClick(page, page.getByTestId("travel-timezone-accept"));
      await expect(navigatedBanner).toBeHidden();
      await expect
        .poll(() => travellerSettings().timezone, { timeout: 10_000 })
        .toBe(home);
      expect(travellerSettings().timezone_home).toBeNull();
      expect(travellerSettings().timezone_travel_tell).toBeNull();
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

      // AND THE ABSENCE IS PROVEN, not merely observed. The banner is decided
      // entirely on the client — the device zone is read in an effect after mount —
      // so a page that has rendered but not yet HYDRATED shows no banner either,
      // and the two absences are the same DOM. A silence assertion that a slow
      // machine can satisfy is not testing the rule; it is testing the clock.
      //
      // So switch this same session to the login's OWN profile and show the banner
      // ARRIVING. Same browser, same device zone, same login, same page — the only
      // thing that changed is whose day is being acted for, which is exactly the
      // rule. The appearance proves the client logic was live all along, which is
      // what makes the silence above mean "refused" rather than "not ready yet".
      await switchToProfile(page, TRAVELLER_PROFILE);
      await expect(page.getByTestId("travel-timezone-banner")).toBeVisible({
        timeout: 20_000,
      });
    } finally {
      await page.context().close();
    }
  });
});
