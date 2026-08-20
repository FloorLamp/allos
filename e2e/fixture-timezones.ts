import type Database from "better-sqlite3";
import { pinnedTimezone } from "./pinned-timezone";

// Per-profile timezone overrides are a fixture design decision, not incidental
// setup. The e2e clock rotates the instance timezone so frozen now reads near
// 13:00 local; a profile that opts out creates a second calendar in the same run.
// Declare that split here so anyone adding one has to account for its midnight.
//
// AND FOR ITS TIME OF DAY (#3260). The pin does more than fix a calendar: 13:mm
// local is `DEFAULT_INTAKE_REMINDER_MINUTES.Midday`, so a profile that follows it
// sits at the centre of a `mealTimeWindows` window at every UTC start hour. A
// profile pinned to UTC instead has a local minute-of-day equal to the run's real
// UTC start hour, so any dashboard candidate carrying meal-window timing (the
// composed-morning offer, protein-today) resolves `expired` for it once the last
// meal window closes — and an expired candidate is dropped from EVERY lane, so
// `openDashboardAll` cannot rescue it. That made one spec red for the ~3 hours of
// each day a run started in [21:00, 24:00) UTC and green the other 21. So: do NOT
// opt a profile out here if its spec asserts a dashboard atom. Only fixtures whose
// assertions are confined to their own pages belong below.
//
// THAT RULE IS NOW CHECKED, and it did not used to be (#3337). It went unenforced
// long enough to cost a third red: `sleep-segmented` opted out to UTC, its seeded
// wake landed at 08:00 UTC, and `sleepArrivedInWakeWindow`'s 180-minute promotion
// lifted `sleep.duration` out of its Standing family for runs starting in
// [08:00, 11:00) UTC — red 3 hours a day, green 21, for as long as it stood. Its
// recorded `why` claimed wall-clock label assertions that no longer existed
// anywhere; the only spec still driving that profile asserted a dashboard atom,
// which is exactly what the paragraph above forbids. Prose beside the data it
// governs, with nothing reading it, is a comment.
// `lib/__tests__/fixture-timezone-atoms.test.ts` now derives, from this table and
// the seeds, which specs can reach each opted-out profile, and fails if one of them
// asserts a dashboard atom.
//
// EVERY ENTRY DECLARES WHICH KIND IT IS, because two different things were living
// in one table and only one of them is dangerous:
//
//   "own-zone" — a SECOND CALENDAR, deliberately not the run's. This is the opt-out
//     the paragraph above is about, and the only kind the guard polices.
//   "run-pin"  — the run's OWN pinned zone, set explicitly. Needed for profiles a
//     spec creates at runtime, which have no seeded default to inherit. These do
//     not create a second calendar and their specs may assert dashboard atoms
//     freely; `dashboard-vitals-recency` is one and is correct.
//
// The kind is verified against the zone actually passed, so the declaration cannot
// quietly stop describing the call — the failure mode that produced this bug.
//
// AND FOR THE TRAVEL BANNER (#3263). The BROWSER is now pinned to the run's zone
// too (`timezoneId` in playwright.config.ts's `use:`), so the fixture device and a
// pin-following profile agree. A profile that opts out below no longer differs only
// from its neighbours' calendars — it differs from the DEVICE it is being viewed
// on, and that is precisely the condition the travel banner exists to announce. So
// its pages carry the banner, above the content, wherever the session is acting as
// that profile's OWN login (the banner is gated on that; a member acting for
// someone else still sees nothing).
//
// THAT IS CORRECT, NOT A BUG, and the distinction is the whole reason the browser
// was pinned rather than the banner suppressed: a profile pinned to UTC while the
// device runs on the instance zone genuinely IS somewhere its device is not. The
// banner is describing the fixture accurately. Suppressing it for the suite's
// convenience would have made every travel assertion in the suite meaningless.
//
// What it costs you: an extra element at the top of the shell on those pages. A
// spec that measures vertical geometry, or that assumes the first child of the
// content container is its own surface, will read the banner instead. If yours
// does, either follow the pin (most fixtures should) or give the spec's context the
// same zone as the override so device and profile agree again — per-context
// `timezoneId`, the way e2e/travel-timezone.spec.ts sets its own.
export const FIXTURE_TIMEZONE_OVERRIDES = {
  weather: {
    kind: "own-zone",
    why: "New York location fixture needs its weather and UV hour labels evaluated in the location timezone; sync instants are derived from the frozen clock so they cannot straddle an undeclared real-time midnight.",
  },
  "sun-outdoor": {
    kind: "own-zone",
    why: "New York daylight fixtures need activity wall times evaluated in the location timezone; their calendar dates are derived in that same zone.",
  },
  "skin-temperature": {
    kind: "own-zone",
    why: "Skin-temperature variation shares the New York sun fixture calendar so its nightly samples and chart days use one declared zone.",
  },
  "timeline-east": {
    kind: "own-zone",
    why: "The multi-view Timeline test intentionally places one profile east of the date line to prove per-profile day grouping.",
  },
  "timeline-west": {
    kind: "own-zone",
    why: "The multi-view Timeline test intentionally places one profile west of the date line to prove simultaneous profiles may have different local days.",
  },
  "overview-rest": {
    kind: "own-zone",
    why: "The Overview rest-state fixture constructs its short recovery night from UTC wall times, so its wake day must use that same calendar.",
  },
  "food-slot": {
    kind: "own-zone",
    why: "The slot-ranking fixture uses fixed 08:00Z, 12:00Z and 18:00Z events whose intended meal windows are UTC.",
  },
  "food-usual": {
    kind: "own-zone",
    why: "The usual-food fixture uses fixed UTC meal-window events and derives its anchor through the same UTC profile calendar.",
  },
  "sleep-phase": {
    kind: "own-zone",
    why: "The phase fixture asserts explicit post-noon UTC wall-clock labels independently of the rotating instance timezone.",
  },
  "vitals-recency": {
    kind: "run-pin",
    why: "This spec-owned profile follows the run's pinned timezone so its seeded historical days are the exact days the card ages against.",
  },
  "trends-day-gaps": {
    kind: "run-pin",
    why: "This spec-owned profile follows the run's pinned timezone so every absolute sample lands on the chart day named by the fixture.",
  },
} as const;

export type FixtureTimezoneOverride = keyof typeof FIXTURE_TIMEZONE_OVERRIDES;

export function setFixtureTimezone(
  db: Database.Database,
  profileId: number,
  declaration: FixtureTimezoneOverride,
  timezone: string
): void {
  const entry = FIXTURE_TIMEZONE_OVERRIDES[declaration];
  if (!entry.why.trim()) {
    throw new Error(`fixture timezone ${declaration} needs a reason`);
  }
  // The declared KIND has to describe the call, or the guard that reads this table
  // is reasoning about something the seed does not do (#3337). Checked here rather
  // than in a test because this is the moment both halves are in hand: a "run-pin"
  // entry that is handed anything but the run's pinned zone is a second calendar
  // wearing the label that exempts it from the dashboard-atom rule.
  if (entry.kind === "run-pin" && process.env.ALLOS_TEST_NOW) {
    const { zone } = pinnedTimezone(process.env.ALLOS_TEST_NOW);
    if (timezone !== zone) {
      throw new Error(
        `fixture timezone ${declaration} is declared "run-pin" but was set to ${timezone}, not the run's pinned zone ${zone}. ` +
          `Either pass the pinned zone, or declare it "own-zone" — and then it may not appear in a spec that asserts a dashboard atom.`
      );
    }
  }
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', ?)
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  ).run(profileId, timezone);
}

// Undo an override so the profile resolves to the instance default — the run's
// rotating pin — at read time.
//
// Needed because seeds are IDEMPOTENT over an existing database: dropping a
// `setFixtureTimezone` call removes the write but not the row a previous seed left
// behind, so a reused dev database would keep honouring an override the source no
// longer contains. CI builds a fresh template every run and would never notice.
export function clearFixtureTimezone(
  db: Database.Database,
  profileId: number
): void {
  db.prepare(
    `DELETE FROM profile_settings WHERE profile_id = ? AND key = 'timezone'`
  ).run(profileId);
}
