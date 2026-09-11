# Features

Allos keeps health records, tracking, and reminders in one private, profile-scoped
app. AI and external integrations are optional. This is the product overview;
setup guides and internal contracts below carry details for the relevant task.
For development entry points and checks, use [Development](development.md).

## Daily use

| Feature         | Behavior                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home            | The record's day view at today plus what is owed: current care, a folded later row, current actions under a Now rule, the day's entries. Seats are fixed, nothing ranked, no score invented.                  |
| Record          | Dated records across domains, day by day. Keep when something happened apart from when it was logged.                                                                                                         |
| Symptoms        | Logs symptom severity, context, media, and illness episodes. Cited duration/trajectory findings can prompt review; symptom logging is not a diagnosis or combination-triage engine.                           |
| Daily wellbeing | Records mood and other self-reported context. Missing entries are unknown rather than evidence of poor wellbeing.                                                                                             |
| Upcoming        | Combines due work and review signals. Dismissal and snooze follow the shared finding lifecycle; safety items retain their own rules. A never-recorded screening is unknown rather than automatically overdue. |
| Sleep           | Tracks sleep sessions and related measurements, including imported data. Local-day attribution and source coverage matter when presenting trends.                                                             |

[Finding reach and attention](internals/findings.md), [reading placement](internals/reading-model.md),
[freshness](internals/freshness.md), and [time](internals/time-model.md) define the
shared behavior behind these surfaces. Home's layout is #5435's: fixed seats in
one list, no ranking; row identity comes from columns, not icons.

## Training and trends

| Feature                       | Behavior                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Training                      | Logs strength, cardio, sport, and mobility work; supports routines and live strength sessions. Planning considers existing goals, activity, recovery, and illness context.                              |
| Equipment                     | Records available equipment for training and planning.                                                                                                                                                  |
| Fitness checks and benchmarks | Records supported checks and compares measurements with the applicable reference data. A reference comparison is not a diagnosis.                                                                       |
| Trends                        | Shows saved metric series, training/nutrition analysis, comparisons, events, and insights. Windows must communicate their coverage; sparse or coincident windows should not imply independent evidence. |
| Goals                         | Tracks explicit targets and their cadence. Progress uses the same shared frequency/history calculations as other surfaces.                                                                              |
| Longevity                     | Presents supported preventive and risk-related context with underlying evidence and limitations.                                                                                                        |
| Year in review                | Summarizes longer-term history without treating missing coverage as zero activity.                                                                                                                      |
| Progress photos and video     | Keeps profile-owned media with dated records, viewing, and deletion behavior.                                                                                                                           |

The training hub's composition follows #4079: the log renders through the
record's machinery, overview cards rank by data presence, and Plan is one
targets ledger. See [workout UX](workout-ux-spec.md), [cadence](internals/cadence-ledger.md),
[charts](internals/charts.md), [retrospective](internals/retrospective.md),
[photos](internals/photo-core.md), and [video](internals/video-core.md).

## Nutrition and intake

Nutrition combines food logs, nutrients, regularity, and applicable dietary limits.
Meal timing and quantity are separate facts. A missing log does not establish that
someone skipped a meal. Findings distinguish care concerns from coaching
observations and report the evidence available. The page is Day | Manage
(#3987, #4477): one day ledger interleaving food and doses, same-tap doses
collapsed into a stack row, and one-day navigation to any past day.

Supplements and medications share intake identity, schedules, and dose history.
Each administration can carry its actual time, quantity, and product. Scheduled
status and PRN doses use their respective lifecycle rules. Past adherence is
judged against the schedule effective on that day.

Commitment (`must`, `should`, `may`) controls ordinary reminder reach. Reducing
reminders must not remove relevant exposure from safety assessment. Medication
and supplement checks use curated datasets and disclose incomplete coverage;
no flags does not mean every possible interaction was checked.

The medicine cabinet supports shared bottles and supply tracking. Linked items
share one stock count; dose transitions and refills update that owner. Household
visibility follows current access, not merely the existence of a shared bottle.

See [food regularity](internals/food-regularity.md), [food limits](internals/food-limit.md),
[intake and supply](internals/supplements.md), and [safety reach](internals/findings.md).

## Medical record

The record supports conditions, family history, allergies, immunizations,
procedures, appointments, care plans, providers, and imported documents. Clinical
results include units, reference information, status, provenance, and corrections.
A corrected result must not silently erase its earlier interpretation.

Specialized views cover imaging, vision, dental, skin, hearing, respiratory
measurements, and supported derived indices. A derived value needs its required
inputs and appropriate coverage; unavailable inputs must not become normal values.
Condition suggestions require confirmation before they enter the condition list.

Cycle and trying-to-conceive views present recorded patterns and supported
forecasts as observations. Mental-health and substance-use tracking preserve
profile ownership and the limits of self-report. Crisis-support content is
available as a dedicated resource. Reproductive-health observations do not create
new proactive coaching obligations.

Immunization and emergency-card views support sharing useful summaries. The
offline emergency card can carry code status, healthcare proxy, organ-donor, and
other recorded emergency information; it must reflect the saved record and its
availability limitations.

See [clinical terminology](internals/clinical-result-terminology.md),
[history](internals/history.md), [substances](internals/substances.md),
[findings](internals/findings.md), and [datasets](internals/datasets.md).

## Household and access

A profile is the person whose health data is recorded. A login is the identity
that signs in. Households can contain profiles without their own login and logins
with grants to several profiles. Read-only grants permit viewing, not writes.

The identity bar and profile switcher show whose record is active. Cross-profile
views resolve accessible profiles at the request boundary. Administrator access
does not automatically subscribe the administrator to every profile's reminders;
notification scope is an explicit choice.

Who a write is about follows a three-rung ladder (#4693, #4709); an ordinary
form never carries a subject picker or a `?subject=` parameter. The switcher
expresses intent for adds. A subject-scoped container (an illness cockpit
header, a cross-profile medication card) lends its subject to an add on it,
inherited rather than picked, only when the whole form is subject-keyed, never
from a row in a mixed list, and re-gated server-side by write access. A
multi-subject event fans out as ordinary rows through each subject's core,
linked by one event id, same payload only; mood, sleep, substances, and body
readings never fan. A correction control on another member's row appears
exactly when the login has write access, and acts on the row found.

See [identity](internals/identity-registry.md) and [notification routing](internals/notifications.md).

## Data, search, and portability

| Feature               | Behavior                                                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connected sources     | Supports registered sources such as Health Connect, Strava, Oura, Withings, and Fitbit imports, plus supported calendar/health-record connections. Availability and setup vary by source. |
| Data hub              | Groups source setup, imports, review, coverage, and export. Sync history distinguishes changes, no-ops, and incomplete/failed runs.                                                       |
| Import review         | Preserves provenance and manual corrections. Duplicate candidates require the appropriate review; re-sync must respect edit locks and deletion tombstones.                                |
| Documents             | Supports extraction, preview/apply, replay of saved extraction, and deletion with the document's associated records. Actions state whether they call AI or write data.                    |
| Search and record Q&A | Searches accessible records. AI-assisted answers are optional and follow the same profile authorization as other reads.                                                                   |
| Export                | Provides supported JSON, CSV, FHIR, and uploaded-file exports. Export scope and provenance follow each format's contract.                                                                 |
| Undo and trash        | Offers recovery for supported changes within the stated window. A bulk-correction inverse and deleted-row recovery have distinct semantics.                                               |
| Logs                  | AI activity, server errors, and audit events have separate purposes and access rules.                                                                                                     |

See [integrations](integrations.md), [sync semantics](internals/integrations-sync.md),
[MyChart](epic-mychart-integration.md), [import actions](internals/import-actions.md),
[search](internals/search.md), [AI](ai.md), [undo](internals/undo-contract.md), and
[backups](backups.md).

## Reminders and the app shell

Telegram, Web Push, Home Assistant, and email deliver configured notifications.
The shared dispatch path owns routing and delivery outcomes. A digest combines
eligible content; repeated review periods use the chosen cadence. Suggestions do
not gain permission to push merely because the app can compute them.

The mobile shell supports navigation, quick actions, touch interactions, and
installed-app behavior. Offline quick-log queues preserve supported writes for
replay. Pending work and app updates must not silently discard unsaved data.
Dialogs, sheets, navigation, and motion follow shared accessible patterns.

See [notification setup](notifications.md), [notification architecture](internals/notifications.md),
[navigation](internals/nav.md), [overlays](internals/overlays.md),
[stateful interactions](internals/stateful-affordances.md), and
[deployment compatibility](internals/deploy-skew.md).

## Limits

Allos organizes recorded information and offers informational context. It does
not replace professional care. Missing data, partial dataset coverage, unconfirmed
identity, and unavailable integrations must remain visible as limits rather than
being presented as reassuring conclusions.
