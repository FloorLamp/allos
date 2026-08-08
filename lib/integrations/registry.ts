import type {
  IntegrationDef,
  IntegrationId,
  IntegrationPagingTunables,
} from "@/lib/types";

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
    // killed, battery optimization suspended it, or the token was rotated. EXPLICIT
    // rather than derived — a push provider declares no poll cadence to derive from.
    //
    // 12 h, revised down from three days on evidence (#2263 decision 3b). Measured
    // over 1223 pushes across 19 days: median gap 16 min, p90 34 min, p99 67 min,
    // longest non-outage silence 1.6 h (the eight longest all sit in the 02:00–05:30
    // local window — Android Doze stretching the interval overnight, not the phone
    // going away). The one real outage was 16.2 h of pure ABSENCE: the phone-side
    // exporter pushed to a retired URL that answered 301, did not follow it, and
    // nothing ever reached the server — so there were no failure events to classify
    // and only the tolerance could catch it. At three days that went unreported for
    // two and a half more days; at 12 h it is named inside one waking period, while
    // the day's data is still recoverable. Not tighter: 3–6 h clears the measured
    // distribution too, but an 8-hour overnight with the phone off is plausible for
    // other installs and would be flagged before its owner woke.
    silenceToleranceMinutes: 12 * 60,
    stoppedConsequence:
      "Steps, workouts, and vitals from your phone have stopped arriving.",
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
    // Polled hourly — its declared pull cadence (cadenceMinutes below), whatever
    // rhythm the tick itself runs at (#2121) — and an ok event is recorded for EVERY
    // successful poll, including a quiet one that found no new activities
    // (isQuietSync). So the last successful sync tracks the CONNECTION's liveness,
    // not the user's training: a rest week is not staleness. Three days is ~72
    // missed polls. An OVERRIDE of the cadence-derived default, keeping the number
    // and the reason this provider already shipped with (#2263).
    silenceToleranceMinutes: 3 * 24 * 60,
    stoppedConsequence: "New runs and rides have stopped arriving.",
    docsUrl: "https://developers.strava.com/",
    pull: {
      // THE PROVIDER THAT SETS THE TICK FLOOR (#2121). Strava's default READ quota
      // is 100 requests / 15 min and 1,000/day for the whole API application, not
      // per athlete. The shared request budget learns upgraded limits from Strava's
      // X-ReadRateLimit headers and reserves headroom for another profile/process.
      // Quiet polls cost one list call; athlete/zones/streams are fetched only for a
      // ride whose stored details are missing. Hourly remains a deliberate quota
      // decision rather than a side effect of the scheduler getting faster.
      cadenceMinutes: 60,
      paging: {
        // Longer than the other pulls: the hourly tick processes profiles
        // SEQUENTIALLY and Strava's list+detail loop is the slowest of them (#476).
        timeoutMs: 30_000,
        // Historical name inherited from the shared paging facet. For Strava this
        // is an absolute per-operation REQUEST ceiling (lists, details, athlete,
        // zones, and streams all count); the provider's live read quota can stop a
        // run sooner and it resumes on the next invocation.
        maxPages: 150,
        // The cursor tracks an activity's START time, but a ride recorded offline
        // can be uploaded days later with an older start; a strict `after = cursor`
        // would skip it forever. Seven days of trailing re-scan catches those.
        rescanDays: 7,
        // No bounded backfill: a first-ever run pages Strava's whole history, a few
        // hundred detail calls at a time until the cursor catches up.
        backfillDays: 0,
      },
      revalidates: [
        "/",
        "/training",
        "/trends",
        "/integrations/strava",
        "/data",
      ],
    },
    backfills: [
      {
        id: "ride-details",
        label: "Ride detail backfill",
        itemNoun: "ride",
      },
    ],
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
    // Polled hourly like Strava (declared pull cadence, not the tick rate), and a
    // quiet poll still records an ok event, so the same three-day reading applies: nights without the ring off the charger are not
    // staleness, a connection that stopped answering is. An OVERRIDE of the
    // cadence-derived default, keeping this provider's shipped number and reason
    // (#2263).
    silenceToleranceMinutes: 3 * 24 * 60,
    stoppedConsequence:
      "Sleep, HRV, and workouts from your ring have stopped arriving.",
    docsUrl: "https://cloud.ouraring.com/personal-access-tokens",
    pull: {
      // A personal access token against Oura's own per-token budget. The data is
      // NIGHTLY — sleep, HRV, resting HR are written once when the night is
      // finalized — so polling more often than hourly could not surface anything
      // sooner than the ring uploads it. Hourly, unchanged.
      cadenceMinutes: 60,
      paging: {
        timeoutMs: 15_000,
        maxPages: 25,
        rescanDays: 3,
        // Oura requires an explicit start_date, so the first run names one.
        backfillDays: 30,
      },
      revalidates: ["/", "/training", "/trends", "/integrations/oura", "/data"],
    },
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
    // Polled hourly (declared pull cadence, not the tick rate), and a poll that
    // finds no new measurement still records an ok event — so a week between weigh-ins is NOT staleness (the scale is idle, the
    // connection is fine). Three days measures the poll, which is the thing that can
    // silently die. An OVERRIDE of the cadence-derived default, keeping this
    // provider's shipped number and reason (#2263).
    silenceToleranceMinutes: 3 * 24 * 60,
    stoppedConsequence:
      "Measurements from your scale and cuff have stopped arriving.",
    docsUrl: "https://developer.withings.com/",
    pull: {
      // Measurements arrive when someone steps on the scale or straps on the cuff —
      // a handful of events a day at most. Hourly already sees every one of them
      // within the hour, so a finer poll would buy latency nobody asked for at a
      // cost Withings' quota does charge.
      cadenceMinutes: 60,
      paging: {
        timeoutMs: 15_000,
        maxPages: 25,
        rescanDays: 3,
        backfillDays: 30,
      },
      revalidates: [
        "/",
        "/trends",
        "/timeline",
        "/integrations/withings",
        "/data",
      ],
    },
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
    silenceToleranceMinutes: null,
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
    silenceToleranceMinutes: null,
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
    // TWO SENTENCES: what this is, and what stays on your computer (#1756). The longer
    // version explained why allos cannot sign in for you and how proxy patients are
    // mapped — both of which "How it works" and the mapping card below it say again, in
    // more detail, a few centimetres further down the same page. A six-line wall at the
    // top of a setup page is read by nobody; the mechanics belong where the mechanics are.
    blurb:
      "Bring in visit summaries, labs, medications and immunizations from hospital " +
      "and clinic patient portals. A small companion tool signs in on your own " +
      "computer and pushes what it downloads here — your portal password, and even " +
      "the portal's web address, never leave that machine.",
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
    silenceToleranceMinutes: null,
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
    // NO override: weather takes the cadence-derived DEFAULT
    // (DEFAULT_SILENCE_TOLERANCE_POLLS × its declared 60-minute cadence = 12 h), the
    // one value #2263 actually decided, so the default is the number rather than a
    // number beside it.
    //
    // 12 h clears this provider's measured p90 success→success gap (6 h, over 171
    // runs) with headroom while still reporting a real outage inside half a day. It
    // REPLACES a two-day quiet-stop threshold that let a stopped feed degrade the
    // sun-exposure/UV math for two days before saying anything — and, more to the
    // point, it replaces a three-consecutive-failure escalation that sat BELOW this
    // provider's ordinary operating variance and read "Sync failing" for 29% of hours
    // while every successful run re-fetched the full 381-row window.
    stoppedConsequence:
      "UV and daylight readings for your home location have stopped arriving.",
    docsUrl: "https://open-meteo.com/",
    // Weather IS a pull provider — the hourly tick runs it and "Sync now" offers it —
    // so it dispatches like the rest. It carries NO `paging` block: there is no
    // credential, no cursor, and no pagination, just a fixed rolling window the module
    // owns (WEATHER_WINDOW_DAYS / WEATHER_FORECAST_DAYS). Declaring maxPages/rescanDays
    // here to make the shape uniform would be a fiction — which is exactly the "forcing
    // a non-OAuth provider into the facet" the consolidation was told not to do.
    pull: {
      // Keyless, but NOT free: Open-Meteo asks non-commercial users to stay under a
      // daily request budget, and the data itself is hourly-resolution forecast, so
      // a sub-hourly poll would re-fetch the same numbers. Hourly, like the rest.
      cadenceMinutes: 60,
      revalidates: ["/", "/timeline", "/integrations/weather", "/data"],
    },
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
    silenceToleranceMinutes: null,
    docsUrl:
      "https://support.google.com/calendar/answer/37100#subscribe_by_url",
  },
];

export function getIntegration(id: IntegrationId): IntegrationDef | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}

// A registered provider allos PULLS (#2040) — one that declares the `pull` facet AND
// is actually shippable. `planned` entries (Garmin) are excluded: the preview card is
// real, the runner is not.
export type PullIntegrationDef = IntegrationDef & {
  pull: NonNullable<IntegrationDef["pull"]>;
};

export function isPullIntegration(
  def: IntegrationDef
): def is PullIntegrationDef {
  return def.pull != null && def.status === "available";
}

// THE pull-provider list. The generic "Sync now" action and the hourly tick iterate
// this instead of naming providers by hand, so adding the fifth (Garmin) is a facet
// plus a runner — not a fifth copy of an action, a tick block, and a page loop.
export const PULL_INTEGRATIONS: PullIntegrationDef[] =
  INTEGRATIONS.filter(isPullIntegration);

export function getPullIntegration(
  id: IntegrationId
): PullIntegrationDef | undefined {
  return PULL_INTEGRATIONS.find((i) => i.id === id);
}

// The paging bounds a credentialed paged pull runs under. Throws for an id that
// declares none, because a pull module reaching for `maxPages` and silently getting
// `undefined` would fetch nothing at all — better to fail at module load, where a
// registry mistake is obvious, than to sync zero rows forever.
export function pullPaging(id: IntegrationId): IntegrationPagingTunables {
  const paging = getPullIntegration(id)?.pull.paging;
  if (!paging) throw new Error(`no paging tunables registered for '${id}'`);
  return paging;
}
