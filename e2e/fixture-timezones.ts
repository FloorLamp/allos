import type Database from "better-sqlite3";

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
    why: "New York location fixture needs its weather and UV hour labels evaluated in the location timezone; sync instants are derived from the frozen clock so they cannot straddle an undeclared real-time midnight.",
  },
  "sun-outdoor": {
    why: "New York daylight fixtures need activity wall times evaluated in the location timezone; their calendar dates are derived in that same zone.",
  },
  "skin-temperature": {
    why: "Skin-temperature variation shares the New York sun fixture calendar so its nightly samples and chart days use one declared zone.",
  },
  "timeline-east": {
    why: "The multi-view Timeline test intentionally places one profile east of the date line to prove per-profile day grouping.",
  },
  "timeline-west": {
    why: "The multi-view Timeline test intentionally places one profile west of the date line to prove simultaneous profiles may have different local days.",
  },
  "rest-card": {
    why: "The seed and per-test reset both construct the recovery night from a UTC date and UTC wall times, so the dedicated profile is pinned to UTC too.",
  },
  "overview-rest": {
    why: "The Overview rest-state fixture constructs its short recovery night from UTC wall times, so its wake day must use that same calendar.",
  },
  "food-slot": {
    why: "The slot-ranking fixture uses fixed 08:00Z, 12:00Z and 18:00Z events whose intended meal windows are UTC.",
  },
  "food-usual": {
    why: "The usual-food fixture uses fixed UTC meal-window events and derives its anchor through the same UTC profile calendar.",
  },
  "sleep-phase": {
    why: "The phase fixture asserts explicit post-noon UTC wall-clock labels independently of the rotating instance timezone.",
  },
  "sleep-segmented": {
    why: "The segmented-night fixture constructs every sleep fragment through UTC and asserts those explicit wall-clock labels.",
  },
  "vitals-recency": {
    why: "This spec-owned profile follows the run's pinned timezone so its seeded historical days are the exact days the card ages against.",
  },
  "trends-day-gaps": {
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
  if (!FIXTURE_TIMEZONE_OVERRIDES[declaration].why.trim()) {
    throw new Error(`fixture timezone ${declaration} needs a reason`);
  }
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', ?)
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  ).run(profileId, timezone);
}
