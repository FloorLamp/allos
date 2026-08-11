import type Database from "better-sqlite3";

// Per-profile timezone overrides are a fixture design decision, not incidental
// setup. The e2e clock rotates the instance timezone so frozen now reads near
// 13:00 local; a profile that opts out creates a second calendar in the same run.
// Declare that split here so anyone adding one has to account for its midnight.
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
