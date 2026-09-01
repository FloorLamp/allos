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
// UTC start hour, so any dashboard candidate carrying meal-window timing
// (protein-today; the composed-morning offer carried it too until #3265 gave it the
// food-slot window it is actually about) resolves `expired` for it once the last
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
// The kind is verified against the zone each call site actually passes, so the
// declaration cannot quietly stop describing the call — the failure mode that
// produced this bug. That check is a source scan in the same test rather than a
// throw here, because this module is evaluated by the standalone seed process:
// reading the frozen instant from the environment inside it would put it under
// scripts/load-env's env-first obligation (lib/__tests__/script-env-bootstrap.test.ts)
// for a value that never comes from a .env file at all.
//
// AND FOR THE TRAVEL BANNER (#3263). The BROWSER is now pinned to the run's zone
// too (the `timezoneId` fixture in e2e/fixtures.ts — in the WORKER, from the
// instant global-setup persisted, and #3364 is the receipt for why it cannot live
// in playwright.config.ts's `use:`), so the fixture device and a pin-following
// profile agree. A profile that opts out below no longer differs only
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
// WHAT IT COSTS YOU, WITH THE NUMBER (#3364): the banner is 130px tall at phone
// width — 110px box plus the 20px its `mb-5` displaces with — and it renders
// between `</ShellChrome>` and `{children}` in app/(app)/layout.tsx. So on these
// profiles' pages EVERY vertical offset below the app shell is 130px larger than it
// is on a pin-following profile. That is a real element that is legitimately there,
// not slack to absorb: a geometry assertion on one of these pages has to account
// for it, and one that quietly widens its tolerance instead stops measuring the
// thing it exists for.
//
// The number is measured, not estimated, and it was expensive: the Trends context
// bar read `Expected: 57  Received: 187` on CI three times before anyone put a
// ruler on the banner, and 187 − 57 is this element exactly. It is a PHONE-width
// reading (390px) — the layout wraps differently at other widths, so measure rather
// than assume if your spec runs wider.
//
// A spec that measures vertical geometry, or that assumes the first child of the
// content container is its own surface, will read the banner instead. If yours
// does, either follow the pin (most fixtures should) or give the spec's context the
// same zone as the override so device and profile agree again — per-context
// `timezoneId`, the way e2e/travel-timezone.spec.ts sets its own. And when a band
// you did not expect opens up between two elements, `bandStory` in e2e/helpers.ts
// names what is standing there instead of leaving you an integer.
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
  "trash-east": {
    kind: "own-zone",
    why: "Data \u2192 Trash prints the profile-local day of a delete INSTANT, which is only observable where the local day and the UTC day differ \u2014 and a pin-following profile can never differ, because the pin puts local time at 13:mm precisely so the two agree. This profile sits at UTC+13 so a capture stamped at 11:30 UTC has already rolled into the next local day.",
  },
  "trash-west": {
    kind: "own-zone",
    why: "The other direction of the same fixture: at UTC\u221212 the same 11:30 UTC capture has not yet left the previous local day, so one planted instant renders three different days across west, UTC and east. It is also the bin e2e/trash.spec.ts empties, which is why it must be a profile nothing else writes to (#3547).",
  },
  "practice-midnight": {
    kind: "own-zone",
    why: "A live practice session that crossed local midnight is only observable where the profile's local time is just PAST midnight, and a pin-following profile can never be: the pin puts local time at 13:mm precisely so the local and UTC days agree. This spec-owned profile sits in the zone where the frozen instant reads 00:mm, so a session started three hours earlier is on the PREVIOUS local day and still running — the row the End button used to be hidden from. It asserts on /wellness only.",
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
  if (!FIXTURE_TIMEZONE_OVERRIDES[declaration].why.trim()) {
    throw new Error(`fixture timezone ${declaration} needs a reason`);
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
