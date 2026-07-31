import type { IntegrationDef, IntegrationId } from "@/lib/types";

// Declarative list of integrations. The Integrations page renders from this, so
// adding a provider is a matter of adding an entry (and, for 'available' ones, a
// parser + config page). Health Connect, Strava, Oura, and Withings are
// 'available' (plus the outbound calendar-feed subscription); Garmin is a
// 'planned' preview today.
export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: "health-connect",
    name: "Google Health Connect",
    kind: "push",
    status: "available",
    blurb:
      "Sync weight, body fat, resting heart rate, steps, heart rate, and workouts " +
      "from your Android phone. An exporter app on the phone pushes Health Connect " +
      "data to this app on a schedule. It's also the supported way to bring in " +
      "nutrition: food trackers like MyFitnessPal, Cronometer, Lose It!, and Yazio " +
      "write your logged macros to Health Connect, so calories and protein/carbs/fat " +
      "flow through here and chart on Trends → Body → Macros.",
    dataTypes: [
      "Weight",
      "Body fat",
      "Resting HR",
      "Heart rate",
      "Steps",
      "Distance",
      "Calories",
      "Sleep",
      "Workouts",
      "Blood pressure",
      "Glucose",
      "SpO2",
      "VO2 max",
      "Body composition",
      "Hydration",
      "Nutrition",
    ],
    // The phone exporter pushes on a schedule (typically hourly), so a connected
    // Health Connect goes quiet only when the phone stops: the exporter app was
    // killed, battery optimization suspended it, or the token was rotated. Three days
    // tolerates a phone off for a long weekend without tolerating a dead exporter.
    staleAfterDays: 3,
    docsUrl: "https://github.com/mcnaveen/health-connect-webhook",
  },
  {
    id: "strava",
    name: "Strava",
    kind: "oauth",
    status: "available",
    blurb:
      "Pull runs, rides, and other activities directly from Strava. Connect once " +
      "with OAuth and activities sync automatically — with heart rate, elevation, " +
      "pace, calories, and cycling power/cadence.",
    dataTypes: [
      "Workouts",
      "Distance",
      "Heart rate",
      "Elevation",
      "Calories",
      "Power",
      "Cadence",
    ],
    // Polled by the hourly tick, which records an ok event for EVERY successful poll —
    // including a quiet one that found no new activities (isQuietSync). So the last
    // successful sync tracks the CONNECTION's liveness, not the user's training: a
    // rest week is not staleness. Three days is ~72 missed polls.
    staleAfterDays: 3,
    docsUrl: "https://developers.strava.com/",
  },
  {
    id: "oura",
    name: "Oura Ring",
    kind: "token",
    status: "available",
    blurb:
      "Pull sleep, nightly heart-rate variability and resting heart rate, and " +
      "workouts from your Oura Ring. Create a personal access token in the Oura " +
      "developer portal and paste it here — no OAuth app or callback URL needed.",
    dataTypes: [
      "Sleep",
      "Sleep stages",
      "HRV",
      "Resting HR",
      "Workouts",
      "Distance",
      "Calories",
    ],
    // Polled hourly like Strava, and a quiet poll still records an ok event, so the
    // same three-day reading applies: nights without the ring off the charger are not
    // staleness, a connection that stopped answering is.
    staleAfterDays: 3,
    docsUrl: "https://cloud.ouraring.com/personal-access-tokens",
  },
  {
    id: "withings",
    name: "Withings",
    kind: "oauth",
    status: "available",
    blurb:
      "Pull weight and body composition, blood pressure, SpO2, temperature, resting " +
      "heart rate, and sleep from your Withings scale, blood-pressure cuff, and sleep " +
      "sensors. Connect once with OAuth and measurements sync automatically — blood " +
      "pressure lands as vitals alongside manual readings.",
    dataTypes: [
      "Weight",
      "Body composition",
      "Blood pressure",
      "SpO2",
      "Temperature",
      "Resting HR",
      "Sleep",
    ],
    // Polled hourly, and a poll that finds no new measurement still records an ok
    // event — so a week between weigh-ins is NOT staleness (the scale is idle, the
    // connection is fine). Three days measures the poll, which is the thing that can
    // silently die.
    staleAfterDays: 3,
    docsUrl: "https://developer.withings.com/",
  },
  {
    id: "garmin",
    name: "Garmin Connect",
    kind: "oauth",
    status: "planned",
    blurb:
      "Pull activities, daily steps, sleep, and heart rate from Garmin Connect. " +
      "Garmin's official Health API requires an approved partner account (the " +
      "developer program is currently paused) and a public webhook, so it's not " +
      "yet available for self-hosted use.",
    dataTypes: ["Workouts", "Steps", "Heart rate", "Sleep"],
    // Exempt: `planned`, so there is no connection to go stale.
    staleAfterDays: null,
    docsUrl: "https://developer.garmin.com/gc-developer-program/health-api/",
  },
  {
    id: "fitbit-takeout",
    name: "Fitbit (Google Takeout)",
    kind: "archive",
    status: "available",
    blurb:
      "Import a Fitbit account export downloaded from Google Takeout. This is the " +
      "only way to bring in body composition from a scale that syncs to Fitbit: " +
      "Fitbit does not forward weight or body fat to Health Connect, so those " +
      "readings — often years of them — are invisible to the phone exporter. Sleep, " +
      "workouts, resting heart rate, SpO2 and respiratory rate come along too, plus " +
      "Fitbit's own sleep and readiness scores, which are stored and shown as " +
      "Fitbit's numbers and never feed anything the app computes. Minute-level heart " +
      "rate, steps and distance come in too. Rows Fitbit itself received from Health " +
      "Connect are left to that connection rather than imported twice — that includes " +
      "the steps your phone counted alongside your watch, which would otherwise " +
      "double the day. A one-off import, not a live connection — re-import a fresher " +
      "export whenever you like; repeats are safe.",
    dataTypes: [
      "Weight",
      "Body fat",
      "Resting HR",
      "Heart rate",
      "Steps",
      "Distance",
      "Active calories",
      "Sleep",
      "Workouts",
      "SpO2",
      "Respiratory rate",
      "Skin temperature",
      "Sleep score",
      "Readiness score",
    ],
    // Exempt by nature: a one-off archive import, not a live connection. "You have not
    // re-imported your Takeout export in three days" is not a fault, and nagging about
    // it would be the exact false positive that teaches a user to ignore the signal.
    staleAfterDays: null,
    docsUrl: "https://takeout.google.com/",
  },
  {
    id: "patient-portals",
    name: "Patient portals",
    kind: "external-attended",
    status: "available",
    // Named for the DOCUMENT FAMILY, not for one vendor's tool. The CCD/C-CDA export is
    // a regulatory requirement (ONC View/Download/Transmit), so Cerner/Oracle Health,
    // athenahealth and NextGen emit the same thing Epic MyChart does. MyChart is simply
    // the first companion tool that implements the contract — a fact about tools, not
    // about the integration, which is why it is named here and nowhere structural.
    blurb:
      "Bring in visit summaries, labs, medications and immunizations from hospital " +
      "and clinic patient portals. Portal sign-in needs a person — two-factor codes, " +
      "and sessions that time out in minutes — so allos cannot log in for you. Instead " +
      "a small companion tool runs on your own computer, signs in the way you would, " +
      "downloads the portal's own export, and pushes it here through an API token. One " +
      "portal login often covers several family members through proxy access, so you " +
      "tell allos which patient on which login belongs to which profile; anything " +
      "unrecognized is refused rather than filed under a guess.",
    dataTypes: [
      "Visit summaries",
      "Labs",
      "Medications",
      "Immunizations",
      "Allergies",
      "Conditions",
    ],
    // Exempt: allos cannot make this sync happen. The tool runs attended, on the user's
    // machine, when they choose — "you have not signed in to your hospital portal in
    // three days" is not a fault, and nagging about it would be the same false positive
    // the Fitbit Takeout entry avoids. The card still shows per-(portal, login, patient)
    // last-synced from the tool's own sync reports; that is reporting, not a freshness
    // assertion.
    staleAfterDays: null,
  },
  {
    id: "weather",
    name: "Weather & UV (Open-Meteo)",
    kind: "public",
    status: "available",
    blurb:
      "Bring in the actual UV index and solar irradiance at your home location, so " +
      "your outdoor daylight time becomes a two-sided UV dose — enough sun for " +
      "vitamin D and circadian light, but a heads-up before you'd burn. Powered by " +
      "Open-Meteo: no API key or account, and its free historical archive backfills " +
      "the UV for activities you already logged. Needs only your home location " +
      "(Settings → Profile); works offline with a clear-sky estimate.",
    dataTypes: ["UV index", "Solar irradiance"],
    // Hourly, keyless, and the only prerequisite is a home location; UV backfill is
    // what the sun-exposure math reads, so a stopped weather sync quietly degrades a
    // computed signal. Two days — the tightest threshold here, because nothing about
    // this provider is bursty.
    staleAfterDays: 2,
    docsUrl: "https://open-meteo.com/",
  },
  {
    id: "calendar-feed",
    name: "Calendar feed",
    kind: "feed",
    status: "available",
    blurb:
      "Subscribe to your appointments in Google, Apple, or Outlook Calendar. " +
      "Enable the feed to get a private link your calendar app checks " +
      "automatically, so upcoming medical visits — with reminders — show up " +
      "alongside the rest of your schedule.",
    dataTypes: ["Appointments", "Reminders"],
    // Exempt: OUTBOUND. The calendar app pulls our feed; we never sync anything in,
    // so this provider records no sync events and has no freshness to assert.
    staleAfterDays: null,
    docsUrl:
      "https://support.google.com/calendar/answer/37100#subscribe_by_url",
  },
];

export function getIntegration(id: IntegrationId): IntegrationDef | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}
