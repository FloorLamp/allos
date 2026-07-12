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
      "data to this app on a schedule.",
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
    docsUrl: "https://developer.garmin.com/gc-developer-program/health-api/",
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
    docsUrl:
      "https://support.google.com/calendar/answer/37100#subscribe_by_url",
  },
];

export function getIntegration(id: IntegrationId): IntegrationDef | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}
