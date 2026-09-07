# Integrations: setup and sync

Open **Data → Import** and choose a source from **Connect a device or service**.
Device connections belong to the selected profile; patient-portal setup is
household-wide. Use **Data → Review** for imported documents and sync results.
Garmin remains a coming-soon entry. Oura's connector needs an authentication
update; see its limitation below.

## Google Health Connect

Health Connect data reaches Allos through an Android exporter:

1. Open **Data → Import → Google Health Connect** and choose **Generate token &
   enable**. Copy the endpoint URL and bearer token.
2. Install [Health Connect Webhook](https://github.com/mcnaveen/health-connect-webhook)
   and grant access to the health data you want to send.
3. Configure a webhook with that URL and an `Authorization: Bearer <token>`
   header. Choose an interval or schedule, then use **Sync Now** to test.

The exporter's default window covers the past 48 hours. Data outside that window
may need a historical export. Allos accepts body measurements, activity totals,
sleep, heart rate, HRV, exercise sessions, vitals, nutrition, and hydration.
Exercise sessions appear in training history; measurements appear in their
metric histories and clinical-result views.

Allos skips implausible values and timestamps, reports skipped/suppressed rows,
and rejects oversized batches. Repeated pushes deduplicate; manual corrections
and deletion suppression survive later syncs.

Rotate the token, set its expiry, and inspect last use on the setup page.
Rotation invalidates the previous token. Keep it secret: it permits uploads.
`HEALTH_CONNECT_TOKEN` is a headless-bootstrap fallback for profile 1, without
the UI token's expiry, rotation, or last-use tracking; prefer a UI-managed token.

## Strava

1. Create an application in [Strava API settings](https://www.strava.com/settings/api).
2. Set **Settings → Server → Public app URL** to the address where you sign in.
3. Open **Data → Import → Strava**, enter the client ID and secret, then choose
   **Connect with Strava** and authorize.
4. Use **Sync now** for an initial check. Automatic polling runs hourly.

Activities include available heart rate, elevation, pace, calories, cycling
power/cadence, and route data. Rides use the shared ride-detail destination;
other activities use training history. Route thumbnails use stored polylines
without requesting external map tiles. Missing or privacy-trimmed telemetry
stays absent. Syncing preserves manually entered and corrected records.

## Oura Ring

**Current limitation:** Allos still exposes a personal-access-token form and
has no Oura OAuth connection flow. Oura retired personal access tokens in
December 2025; those setup instructions no longer provide a supported connection.
See [Oura's authentication documentation](https://cloud.ouraring.com/v2/docs).

The existing importer handles nightly sleep/stages, HRV, resting heart rate,
and workouts. Reconnection requires an updated connector; previously imported
records remain available.

## Withings

1. Set **Settings → Server → Public app URL**.
2. Register an application in the
   [Withings developer dashboard](https://developer.withings.com/dashboard/).
   Use the callback URL shown by Allos:
   `https://<your-app-domain>/api/integrations/withings/callback`.
3. Open **Data → Import → Withings**, enter the client ID and secret, and
   choose **Connect with Withings**. Complete authorization while signed in
   to Allos as the intended profile.
4. Use **Sync now** to check the connection; subsequent polling runs hourly.

Imports include weight/body composition, blood pressure, pulse, SpO₂,
temperature, sleep, and supported clinical measurements. Repeated fetches
deduplicate and preserve manual corrections. Rate-limited runs retain their
cursor for another attempt. **Disconnect** removes connection tokens but keeps
client credentials for reconnection.

## Fitbit (Google Takeout)

1. Open **Data → Import → Fitbit (Google Takeout)**.
2. In [Google Takeout](https://takeout.google.com/), deselect other products,
   select **Fitbit** (which may appear as **Google Health**), and request ZIP files.
3. Upload each downloaded part separately.

This is an archive import, not a live connection. It includes body measurements,
heart rate, activity, sleep, workouts, and supported Fitbit scores. Vendor scores
remain attributed and do not feed Allos calculations. Records marked as received
from Health Connect are skipped to avoid importing that phone data twice.

The uploaded archive is deleted after processing. Re-imports deduplicate and
appear in **Data → Review**. A refresh reminder can appear when archive-only
weight, body-fat, sleep-score, or readiness-score data falls behind the declared
30-day horizon. It follows the newest imported data date: uploading the same old
archive does not refresh it. The dismissible reminder uses Upcoming and the
existing digest, without a dedicated notification.

## Patient portals

A companion tool runs on your computer, signs into the portal, and uploads its
exports through the [document API](api-tokens.md). Allos stores portal/login
names and patient mappings; portal URLs and credentials stay with the tool.
Two-factor prompts may require someone at that computer.

Under **Data → Import → Patient portals**:

1. Add the portal by name. Allos supplies its stable short ID.
2. Name separate logins when the household uses more than one portal account.
3. Create an API token with **Upload documents** capability under
   **Settings → Account & security → API tokens**. Use one token per computer.
4. Run the companion tool. It reports patient labels under the relevant login.
5. Map each reported patient to a profile. Nothing is preselected; unmapped
   patients' uploads are refused. A same-person suggestion still requires approval.

Patient labels retain the portal's exact spelling. A changed label arrives as a
new pending patient. Rename/manage portals and logins from their menus; change a
mapping through its profile picker. Reassignment requires write access to both
profiles. **Ignore** is durable and admin-only; **Not now** clears the prompt
until another report. Members see accessible logins; portal/login management is
admin-only. The setup checklist remains until the initial work is complete.

Documents appear in Review with their source portal and normal duplicate/type/
size checks. Each patient shows its own check status; failures before reaching a
patient appear on the login row. A successful check with no new documents still
updates **Last checked**. Delivery of files already on disk updates sync status
without claiming that the portal was checked.

**Request sync** asks a person or companion tool to run; it is not a scheduled
execution inside Allos. Automatic requests follow a month without a successful
check or a completed appointment, after the tool has reported its first run.
Requests expire after a week and use Upcoming and the existing digest. Dismissal
silences both; there is no dedicated notification. Unmapped logins raise no
automatic request.

An attended attempt answers the request even if it fails; successful scheduled
runs answer it too. Delivery-only reports and unattended failures leave it open.
A portal that refuses downloads for one proxy patient suppresses that patient's
requests without suppressing others; a later successful acquisition clears that
state. Tool authors should use the document API's discovery, reporting, and
request endpoints rather than keeping profile mappings in local configuration.

## Calendar feeds

Open **Data → Import → Calendar feed** to create a subscription link. Choose
categories, reminders, date windows, and minimal/full detail, then inspect the
preview before subscribing. Rotate or expire links from the same page.

The **Family calendar** combines feeds from profiles the current login can
access, respecting each profile's settings. Membership is resolved on every
fetch; revoked access removes that profile, and deleting the login invalidates
the feed. Treat subscription URLs as credentials.

## Weather & UV (Open-Meteo)

Set a coarse home location in profile settings, then enable **Weather & UV**
under **Data → Import**. No provider account or API key is required. Hourly
polling supplies UV, irradiance, precipitation, and daily weather context;
**Sync now** runs an immediate check. Optional skin type enables the
skin-type-dependent overexposure calculation.

Weather supports outdoor-time summaries and weather situations. Missing air
quality/pollen data does not disable temperature-based features. Missing live
UV falls back to available clear-sky estimates or minutes-only behavior;
without skin type, the overexposure signal stays silent. See the setup page for
current status and Review for sync failures.

## Comparing sources & picking a primary one

A metric's **Compare sources** view shows available streams. **Primary source**
selects a preference with fallback; **Only this source** leaves uncovered days
empty. **Documents** selects the document family, including future imports,
while individual reports retain their provenance.

Additive metrics choose a source's daily total rather than adding competing
devices together. Point readings remain available for comparison. For ingestion,
provenance, retries, and source-health implementation, use the
[integration sync contract](internals/integrations-sync.md); for document
preview/replay/deletion, use [import actions](internals/import-actions.md).
