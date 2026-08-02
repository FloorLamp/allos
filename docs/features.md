# Features

Status: **shipped**. This is the canonical functional reference for Allos. The
[README](../README.md#what-can-it-track) stays intentionally short; this
document records the behavior, boundaries, and important caveats behind each
feature. Architecture and implementation invariants live in
[`docs/internals/`](internals/).

## Contents

- **Daily use:** [Dashboard](#dashboard), [Timeline](#timeline),
  [Symptom log](#symptom-log), [Daily wellbeing](#daily-wellbeing-check),
  [Upcoming](#upcoming), and [Sleep](#sleep)
- **Training and trends:** [Training](#training), [Equipment](#equipment),
  [Trends](#trends), [Longevity](#longevity), [Goals](#goals),
  [Benchmarks](#benchmarks), [Progress photos](#progress-photos), and
  [Video clips](#video-clips)
- **Nutrition and intake:** [Nutrition](#nutrition),
  [Supplements and medications](#supplements--medications), and the
  [Medicine cabinet](#medicine-cabinet)
- **Medical record:** [Medical](#medical), [Allergies](#allergies),
  [Immunizations](#immunizations), [Cycle](#cycle),
  [Mental health](#mental-health), [Crisis support](#crisis-support),
  [Substance use](#substance-use),
  [Health-record import](#health-record-import), and the
  [Emergency card](#emergency-card-offline)
- **Household and access:** [Household](#household)
- **Finding things:** [Global search and record Q&A](#global-search-and-record-qa)
- **Data and reliability:** [Data hub](#data-hub),
  [Offline quick-log queue](#offline-quick-log-queue),
  [App updates](#app-updates), [Mobile shell](#mobile-shell),
  [Undo delete](#undo-delete),
  [AI activity log](#ai-activity-log), [Server error log](#server-error-log),
  and [Audit log](#audit-log).

## Dashboard

Your health at a glance, attention-first.

### Needs attention

A pinned **Needs attention** banner leads every visit with the **act-now slice**
of one shared attention model — banded as **Past due / Today / Needs review** —
that merges everything needing you now: overdue and due-today
doses/appointments/care-plan items plus the "something's off" signals
(newly-flagged labs, low supply, failing integrations, review-inbox items). It
renders from the **same computation** as the **Upcoming** page — the banner is a
strict **subset** of it, so the numbers always reconcile: this-week and later
scheduled work isn't dropped, it moves to Upcoming behind a "**+N more in
Upcoming**" link. The banner is globally capped at five rows while preserving at
least one item from every populated band, so a large overdue backlog cannot bury
a new flagged result or failing sync. Mobile rows move status and actions below
the description instead of truncating the task into one crowded line; review
signals carry explicit **Review / Review result / Reconnect** actions on the
shared model. A flagged lab carries a verb ("Review HDL Cholesterol") and
deep-links to its series, never a dead-end "flagged result". Snooze or dismiss
any eligible item right there (it stays hidden on Upcoming and in the digest
too), and an empty banner collapses to a quiet one-line "all clear". Below it, a
login that reaches more than one profile gets a **household strip** of their
other people with a per-profile attention count, one tap to switch and view.

Just after an illness, the dashboard keeps the household's leftovers to **one
band at a time**. Each member whose episode is still inside its seven-day reopen
window gets a calm **"Recently resolved — reopen?"** line, and dismissing one
**stays dismissed** across reloads for that reader: the hide is a per-login
viewing preference, so another caregiver with access to the same person still
sees the line, and it never changes the episode or its reopen window. The link
to the household's illness history rides along inside whichever band is already
on screen — the reopen band's last row while those lines are showing, otherwise
the household strip's label row — instead of standing alone between them.

### Customizable overview

The customizable grid keeps only distinct overview questions: **recent labs**,
**next appointment**, a focused coaching suggestion (its secondary "Next:"
recommendation is a compact link to its own action), a compact two-item
**Coaching observations** preview (the rest reachable in place behind a "Show N
more" disclosure — the Data quality widget's top-3 overflows the same way, and
the opt-in Active protocols widget caps at three rows with a "+N more" link to
Longevity › Protocols; each finding family has exactly ONE dashboard home, so a
family with its own widget never also fills the rollup, and the rollup's count
is always what it renders), **weight trend**, combined **Goals and habits**,
**Healthspan pillars**, and the unified **"How are you today?"** daily check-in
— a one-tap 5-point mood log (expand for energy, calm, factor chips, and a note;
one entry per day, never range-checked, never gamified) composed with the
illness front door's quiet "Not feeling well?" branch, which keeps offering the
mood tap while an illness episode's cockpit is up in the hero; **Weekly recap**
remains opt-in. Standalone cards for quick stats, care-plan due, starred
biomarkers, biological age, recent activity, immunizations, today's insight,
streak, low supply, active goals, and weekly routine were retired because Needs
attention/Upcoming or a richer remaining card already answers them. Legacy saved
layouts discard those ids safely. Empty data-aware widgets still show a one-tap
setup CTA. Biomarker stars remain available on Biomarkers and Trends as personal
pins—what someone wants to follow even while normal—and are deliberately
separate from urgency. Healthspan pillars surfaces VO₂ Max percentile, strength
standard, sleep regularity, biological age, and biomarkers in optimal range as
separate signals, never one invented score.

The default order is **actionable first**: the cards you are meant to act on
today lead — the **"How are you today?"** check-in, the coaching train/rest call,
**Goals and habits**, **Data quality**'s one-time fixes, and today's nutrition
and steps gaps (plus **Active protocols** when you opt in, since its rows carry
pending log actions) — and the glance cards you read and move on from follow:
next appointment, recent labs, last night's sleep, latest vitals, weight trend,
healthspan pillars, cycle phase. **Coaching observations** closes the list, which
is what its own charter asks for — FYIs, not alerts — and the opt-in **Weekly
recap** stays last. Each card declares whether it is actionable, and a registry
test keeps the split honest as new widgets arrive, so a glance card cannot
quietly take a prime slot. This is the order a **fresh** dashboard starts in; a
dashboard you have already arranged keeps exactly the order you gave it, and a
card added by a later release joins in its default position.

**Edit dashboard** opens Customize, where every eligible widget — visible,
hidden, and temporarily without data — can be reordered by its grip and shown or
hidden by its eye, with Save persisting the layout and Cancel restoring the
state you entered with. On a wide screen you edit the live cards **in place**,
because there the grid really is six columns and spans and adjacency are part of
what you are arranging. On a phone the grid is a single column already and a
live card is half the screen, so Customize collapses each widget to a **compact
reorder row** — grip, label, eye, about 48px — which puts the whole list on one
screen and makes a move a flick instead of several screens of autoscroll. It is
the same editor either way: same order, same hidden set, same Save/Cancel, same
keyboard path on the grip.

### Data quality

A **Data quality** widget surfaces the _structural_ gaps that silently degrade
the engines — a missing birthdate (which hides every adult-population model), an
unset sex, medications with no confirmed RxNorm code (name-only safety
matching), a partial biological-age panel, a failed document extraction,
unreviewed risk factors — ranked by **leverage** (how many features each fix
unlocks, birthdate first), each with a one-line "here's what turns on" and a CTA
that deep-links the **exact form** that fixes the gap — the anchored
smoking-history / risk-factors forms on Records › Care › Overview, the biomarker
add form prefilled with the first missing biological-age analyte, a sole
unconfirmed medication's edit form (or the medication list filtered to the
unconfirmed ones when several need it), and the child profile's growth quick-add
focused on the height field — never a browse page. It's deliberately **not a
completeness score** (no percentage ring — the same pillars-not-a-composite
stance), covers **structural one-time fixes only** (never behavioral nagging
like "log more weigh-ins"), self-hides when a profile has none, and rides the
shared findings bus (declining a gap silences it on the widget, the coaching tab,
and the household line at once). The widget is the family's dedicated dashboard
home, so a gap is never also a row in the Coaching observations rollup — hide the
widget and the gaps fall back into that rollup rather than losing their dashboard
reach. The same gap model formats a compact
per-member line on the **Household** page — kids' profiles are where
birthdate/sex gaps cluster and the caregiver is who can fix them.

## Timeline

Day-by-day health history across activity, body metrics, labs, medications,
documents, visits, goals, protocol start/end, and milestones; each day header
also shows **sunrise/sunset daylight chips** once a home location is set
(**Settings → Health profile → Home location** — optional coarse coordinates
you enter or detect, stored rounded to ~11 km and used only for on-device sun
math, never sent anywhere; a US ZIP from an imported CCD suggests one). Solar
times come
from the NOAA algorithm computed locally — no location service, no external
calls. With the keyless **Weather & UV (Open-Meteo)** integration enabled, the
day's outdoor window also carries a **UV badge**, and your outdoor daylight time
becomes a two-sided **UV dose** (enough for vitamin D/circadian light, with a
burn-risk heads-up past your skin type's threshold) — degrading gracefully to a
clear-sky estimate, then to plain minutes, offline.

A brand-new account sees a Timeline empty state that names the next action —
links to log an activity, add a body metric, or import a document, the three
sources a timeline fills from. Once a category pill or a date window is applied,
an empty feed reports only that ("No immunization events yet."): a filter that
matched nothing is a different message from an account with nothing in it.

A single-day view adds previous/next navigation and horizontal swipe navigation.
Its intraday panel projects the day's timed data onto a midnight-to-midnight
clock: minute-level heart rate, sleep blocks and stages, workout spans, and
clock-timed entries. Tapping a mark jumps to the corresponding record below.
Layers render only when that day has relevant data; the scrolling multi-day feed
never pays the cost of an intraday chart. The selected day also offers one-tap
symptom backfill without requiring an illness episode.

## Symptom log

Symptoms are a standalone day-by-day record, not merely an illness feature.
Choose from the curated vocabulary or add a custom symptom, then record severity
from 1–4. Repeating a tap preserves the day's worst severity; lowering it is an
explicit edit.

### Quick entry and context

The Dashboard's **How are you today?** card has four stable intents: **Rate /
Context / Report / Act**. On a well day, **Report** reveals the symptom logger
without first declaring an illness. **Context** carries ongoing situations such
as Travel, High stress, and Poor sleep. **Act** offers quick logging for
as-needed medication when relevant. The same situation vocabulary drives
situational supplements, so a toggle has one meaning everywhere.

Body temperature can be recorded with an optional reading time. It joins the
same vital series as an imported thermometer reading and therefore builds a
fever curve instead of a separate symptom-only store. The card can also add an
over-the-counter medication without leaving the flow.

### Illness episodes

Choosing **Not feeling well?** opens the built-in Illness situation and promotes
the sick-day controls to a pinned Dashboard hero. Symptoms, temperatures, and
as-needed doses remain ordinary records; an illness episode groups them by the
dates on which the illness situation was active.

An episode page presents that range as a story:

- symptom-severity series and the temperature curve;
- as-needed doses and the next safe dose window;
- visits, appointments, documents, and medication courses during the range;
- linked visits across the whole care trail;
- a note, outcome, editable start/end dates, and comparison with prior episodes.

Users can backfill an episode, correct its range, end it with **Feeling
better**, or reopen a recently resolved episode. Reopening can restart the
medications that were stopped when the episode ended. An episode can also be
promoted to a Condition using the episode range as onset/resolution dates. These
are explicit actions; the app never silently closes or promotes an episode.

The episode can be printed or shared through a revocable public link. Symptom
photos and video/audio clips are excluded from that share and from the printable
by default.

### Care signals and household visibility

An open episode appears in the household Dashboard hero for every caregiver who
already has access to that profile. Other people remain compact accordions until
opened, but a caregiver can log a symptom, temperature, or dose without
switching the active profile. The household summary includes illness day,
temperature trend, and last as-needed dose to reduce accidental double dosing.

Care checks use cited, deterministic facts: for example, a fever lasting beyond
a published duration or a single age-banded temperature threshold. They are
informational and never infer a diagnosis from a combination of symptoms.
Eligible checks share the Upcoming dismissal identity, so dismissing one
silences the matching optional nudge. Medication safety reminders remain outside
that dismissal policy.

A per-profile fever-free interval drives the school/daycare return countdown. It
names the last reading and last fever-reducer dose and presents the configured
guideline as context, not medical clearance.

### Symptom media

Photos are dated and may be tagged to a particular symptom so unrelated symptoms
on the same day keep separate media sets. Video/audio clips are upload-only,
server-sniffed, limited to 60 seconds and 100 MB, and streamed only when opened.
Embedded-location presence produces a privacy warning; coordinates are not
decoded into app data. Symptom media uses the strictest privacy tier and is
excluded from public shares, the emergency card, and the default export.

## Daily wellbeing check

The daily check-in is a lightweight, non-clinical layer inside **How are you
today?** One tap records a five-point mood value. Expanding the card adds
energy, a note, and—when relevant to the profile—a five-point **Calm** scale.
The relevance gate considers prior use, recorded screening instruments, related
conditions or medications, active protocols, and the explicit setting under
**Settings → Coaching & AI**.

Context combines ongoing situations with today-only factors such as Work or
Social while clearly labeling which kind persists. There is one check-in per
day; another entry updates it.

Mood, Energy, and Calm each chart under **Trends → Body** as their own metric —
a card in the census, a sparkline tile, and a detail page at
`/trends/metric/mood`, `/trends/metric/energy`, and `/trends/metric/calm` with
the shared range control and an editable readings table. Each plots only the
days that carry that rating, since energy and Calm are answered behind the
card's expansion. Calm charts on the same relabelled axis the card offers (high
is calm) and carries the card's relevance gate everywhere: a profile the scale
was never offered has no Calm chart, tile, or page.

None of the three is ever reference-range checked. A low day is not an abnormal
result, does not create a retest, and never contributes to a streak, score,
badge, or milestone.

The coaching layer may show a calm, dismissible observation for a sustained
low-mood window or a sleep drop that co-occurs with one. It describes
co-occurrence rather than causation and never enters the attention hero or a
safety notification. The optional daily reminder is off by default,
automatically pauses after five ignored days, and re-arms after the next manual
check-in. An optional weekly recap reports the average as a summary, not a score
to improve.

## Longevity

Route: `/longevity`.

The healthspan pillars expand into one page of anchored sections: **biological
age** (the PhenoAge hero with pace-of-aging and a missing-inputs checklist),
**fitness-check percentiles** (a read view over your guided fitness checks, “Run
a fitness check” deep-links into Training), **sleep regularity** (SRI, timing
spread, trend), and the per-marker breakdown behind **“N of M biomarkers
optimal”** — the same pillar model the dashboard widget renders (each widget
card deep-links to its section), pillars and never a composite score, with
absent pillars simply not rendering. Its **#protocols** section absorbed the
former Protocols page (the old `/protocols` hub URL was removed in #1635 and
404s).

**Protocols** — run an **N-of-1 experiment**: name a dated intervention
(creatine, a sauna block, Zone 2 emphasis, time-restricted eating), pick the
**outcome metrics** you care about (any tracked biomarker, resting HR / weight /
body-fat, or a derived index like **PhenoAge** or the **Sleep Regularity
Index**), and Allos compares a **baseline window** against the **intervention
window** on its detail page — an honest mean/median shift with the n per window
("resting HR −3.2 bpm vs the 8 weeks prior"), no p-value theater; sparse labs
fall back to the nearest draw before/during. Starting a protocol can **activate
a situation** (reusing the supplements situations wiring so its situational
stack surfaces), and start/end land on your **Timeline**. A protocol's
delete/end reverses that situation activation. A protocol can also reference the
**recovery gear** it studies (which sauna / plunge, linking to its Equipment
detail) and declare a **practice** to track — an activity type **or a food
group** (#580, e.g. "fatty fish 2×/week" for an omega-3 protocol) × N/week —
whose **adherence** is the same weekly-count your Weekly routine targets use (so
"sauna 4×/week" shows "2 / 4 this week"), plus a usage-during-window tally ("23
sessions · last 3 days ago") over the protocol's dates; the practice reuses a
matching weekly routine target if you already have one, or creates one it cleans
up on delete. The experiment list adds a compact day-density heatmap bounded to
the most recent 53 weeks while its session and active-day summary still covers
the complete protocol window. A recently ended protocol can resume the same run;
an older one starts a new run without leaving its historical cadence active as a
second weekly reminder.

**Wellness practices** (`/wellness`) manage named modalities such as sauna,
meditation, breathwork, and light exposure independently of a protocol. Each
practice can carry a weekly floor and optional ceiling, log multiple detailed
sessions per day, and retain editable session history. **Stop tracking** removes
the weekly target and its reminders without deleting logged sessions; any
protocol using that target is explicitly unlinked.

Consistency over time is on **Trends → Practices** (see [Trends](#trends)):
weeks in range, cadence against your declared band, and session length.

A tracked practice is one tap away from anywhere: the quick-actions menu's **Log
practice** overlay lists each one with this week's standing, and the command
palette commits a session from `log sauna`. Both go through the same write the
practice card's **Log now** button uses, and both report what actually
happened — a session log is never confirmed unconditionally. A practice you have
stopped tracking keeps its card and history but is no longer offered by the
quick surfaces.

**Start from a template** prefills the form for a common experiment — the **Sun
exposure** template pairs daily **outdoor daylight minutes** (intersecting your
outdoor activities' time windows with the local daylight window from your home
location's sunrise/sunset) against your **vitamin D** family, so you can ask
"did my lunch-walk habit move my 25-OH D?"; when daylight-outdoor time has been
scarce over recent weeks and your last vitamin D was below optimal, a calm
**coaching observation** notes it (coaching tier only — never a notification,
and deliberately observational rather than prescriptive, since sun exposure is
dual-edged). Informational only, not medical advice.

## Upcoming

One forward-looking list of everything due soon.

### Due work and review signals

Items are bucketed by urgency (**Overdue / Today / This week / Later**), with
the orthogonal "something's off" signals the dashboard banner also surfaces —
newly-**flagged labs**, **failing integrations**, and **review-inbox** items —
grouped under their own **Flagged** / **For review** headings rather than mixed
into the date bands: supplement/medication doses, low refills, **supplement
intake-limit** warnings (a nutrient whose stack total exceeds its NIH upper
limit), **drug-interaction** warnings (two active stack items known to
interact), scheduled appointments, **planned care** (provider-ordered or
manually entered **care-plan items** with a planned date — e.g. an imported
"colonoscopy in March" — surfaced from the **Care plan** page, with an inline
**Mark done** that completes the item), **preventive well-visits & screenings**
(age/sex-appropriate checkups and screenings from curated general guidelines —
the adult screening set is the USPSTF grade A/B core baked into
`lib/screenings.json` (blood pressure, cholesterol, colorectal, diabetes/A1c,
**depression**, **anxiety**, **HIV**, hepatitis C, cervical, mammography,
osteoporosis, plus the risk-gated hepatitis-B/lung/AAA rules), regenerated with
`npm run gen:screenings`; **informational only, not medical advice** — mark one
**done**, or set it **not applicable** / **declined**, or hit **Book** to open
the appointment form prefilled with the visit's reason, kind, and a suggested
date — informational only, and shown only once a birthdate is on file; a
matching record already on file **satisfies a screening/visit automatically** —
a coded or named colonoscopy/mammogram/DEXA, a lab result (cholesterol, A1c,
glucose), a blood-pressure reading, or a completed physical/dental/eye visit is
detected and clears the reminder without a manual mark-done; once you **book a
matching visit** (an appointment whose **Kind** matches — e.g. a dental
appointment for the dental reminder) the item quiets to a **Scheduled** state
instead of nagging, and completing that kind-tagged visit offers to record the
preventive care as done; the smoking-related screenings (low-dose CT lung
screening, abdominal aortic aneurysm ultrasound) activate once a **smoking
history** is recorded under **Health record → Care → Overview → Background**,
seeded automatically from an imported CCD's tobacco status), immunizations due,
**biomarker retests** (each stated as an action — "Retest HDL Cholesterol" —
and, when the last reading was out of range or non-optimal, noting that status
so a flagged value isn't mistaken for a bare retest), goal deadlines, and
training targets.

### A never-recorded screening is unknown, not overdue

A preventive rule the app has **no history for** is not late — it is unrecorded.
Age plus a nominal interval says the rule _applies to you_; it says nothing about
whether you had the screening before you started using Allos. So a rule with
nothing on record reads as a calm **setup** state ("No record yet — add a past
date or schedule") rather than a red **Overdue**:

- On the dashboard the never-recorded rules collapse into **one** closed line —
  **"Set up your screening history (N)"** — below the Needs-attention card. They
  are outside the card's bands, its count, and the installed-app badge, so a
  brand-new profile's hero is not a wall of red about a person it met a minute
  ago.
- On **Upcoming** they get their own trailing **Set up your screening history**
  group, below everything that is genuinely due, in the quietest tone on the page.
- They are **never pushed**: no Telegram nudge, no morning-digest line. The push
  side is composed only from rules with a recorded date behind them.
- Every affordance is unchanged — the same deep link to the form that records the
  screening, the same **Mark done**, **Book**, **not applicable** / **declined**,
  and the same snooze/dismiss identity, so a dismissal made before this split
  still applies.

Recording **any** past date moves a rule onto the real clock: recent → up to
date, long ago → genuinely **Overdue**, with the red treatment it has always had.
Well-child milestones keep their own dated window — those lapse out of a narrow
age window rather than accumulating, so "overdue" there is a real statement.

### Routine folds, safety never does

A planning page that lists every scheduled dose and every pairwise
medication-safety note as its own full row buries the things actually worth
noticing. So the page **folds the routine, per band**: the band's scheduled doses
collapse into one row that always states the count and the day's progress
("**5 doses left · 1 of 6 taken**"), and its **interaction + PGx** notes collapse
into one "**N medication-safety notes**" row. Both are collapsed on every visit
(nothing is remembered), one tap opens the real rows, and every row behind the
fold is unchanged — the same **Mark taken**, the same per-item snooze/dismiss,
the same link.

The **count is never hidden**, and the **safety classes are never folded**: a
**PRN over its confirmed daily max** and any safety-tier reminder render as
individual rows **above** the fold, in both states. A **drug-allergy** match
keeps its own row too — it deliberately outranks a pairwise interaction — as do
the singular findings (a fever pattern, a screening, a pre-procedure note). A
band with only a couple of doses does not fold at all. `may` items are not
involved: they were never owed, so they live in the separate **"Available when
you want them"** disclosure and count toward neither number.

### Risk-aware timing

Retests, screenings, and immunizations are **risk-stratified**: your **family
history**, **active conditions**, life stage, smoking history, and the
self-declared factors under
**Health record → Care → Overview → Background → Health risk factors**
(healthcare worker, immunocompromised, on dialysis, pregnant, loud-noise
exposure) bring some labs due sooner and rank them higher with a calm one-line
reason (family history of heart disease → lipids retested sooner and
prioritized; immunocompromised / dialysis / healthcare worker → hepatitis-A
immunity checked sooner; pregnancy → gestational-diabetes (glucose) and anemia
(CBC/ferritin) checks brought due sooner and prioritized), rank up the vaccines
they make more important (immunocompromised / dialysis → pneumococcal &
meningococcal, healthcare worker → hepatitis B / influenza / MMR / varicella,
pregnancy → Tdap & influenza), and a birth-anchored newborn panel (e.g. a
newborn bilirubin) is treated as a one-time milestone rather than a recurring
retest. Only the **recurring-monitoring** analytes (lipids, A1c, thyroid,
kidney, liver, the core metabolic/CBC panels, and the commonly-tracked
nutritionals) carry a lipid-panel's standing; an incidental one-off from a
workup (a heavy metal, an allergen-specific IgE, an LDL subfraction) drops to a
low, dismissable tier, and a reading older than ~10 years reads as historical
baseline rather than "retest overdue". A documented **positive immunity titer**
(hepatitis A/B surface antibody, MMR/varicella IgG) is durable evidence — like a
genetic result it never nags for a yearly retest, while a **negative or
equivocal** titer keeps its normal clock (and the risk factors above can
prioritize revaccination) — informational only, not medical advice. On the
biomarker page that positive titer reads as a neutral **Immune** status (with a
cross-link to your immunity record) rather than a red "abnormal" flag, and other
context-neutral qualitative results (a blood type, a urinalysis color) are never
mis-flagged as abnormal or nagged for retest; a purely qualitative analyte
(positive/negative/immune) that has no numeric value renders as a dated timeline
instead of a blank chart.

### Lifecycle and delivery

Any item can be **snoozed** or **dismissed** (and restored later), and the same
list feeds the optional Telegram "what's due" digest and the calendar feed.

### Multi-profile viewing

When you toggle other accessible profiles into your **view** (the eye control on
each row of the profile switcher; the identity bar's stacked avatars name who's
in view), Upcoming **merges**
everyone's due items into one list with a **subject chip** on each row — each
member's dueness computed in that member's **own timezone/today** (never a
shared clock), so "Overdue" and "Today" stay correct per person. A row's actions
target that row's **own** profile and respect its grant (a read-only member's
rows show without edit buttons; a dose confirmed on another person's row logs to
_them_, never to the profile you're acting as), and names appear only while more
than one profile is in view — a single view stays exactly as it was.

## Training

The **Log** tab's journal feed loads the newest window of days and pages older
ones in on demand, but its **search and filters query the whole ledger**: typing
a name, picking an activity type, clicking a muscle/region badge, or switching on
"Can't be saved" re-asks the store, and the feed pages over _matches_ — so a
session from years back shows up on the first screen of results with no "Load
more" clicks. A **Source** filter sits alongside them, offering exactly the
providers your own history contains (Manual, Strava, Google Health Connect,
Document, …) labelled the same way the cards' provenance chips are.

**Weather-aware suggestions.** When the Weather & UV source is on, outdoor
activities are quietly **parked** in conditions you don't train in — the ride
drops out of today's suggestion, the message says why, and the indoor stand-in
takes its slot ("Too cold for cycling (−2°C) — Stationary Bike instead"). The
threshold is _yours_: it's derived from the conditions you've actually logged
sessions in, so someone who rides at 3°C keeps being offered the ride and
someone whose rides all sit above 15°C doesn't. Until there's enough history to
tell, only genuinely hostile conditions park anything. Nothing is ever banned —
logging the outdoor session anyway is normal, and it teaches the engine. An
alternative is only offered if you've logged it before or own the gear;
otherwise you get the normal next-best suggestion with the explanation intact.
Parked activities also stop counting as "stale" while parked, so winter can't
push a ride _harder_ precisely when the weather is worst.

**Planning the week around the weather.** When a weekly cardio target is behind
and the coming week's outdoor viability is _scarce_ — one dry day among five wet
ones, say — the morning digest and Upcoming both note the best window: "This
week: Saturday looks like the best window for your cycling (cycling 1/2)." It
appears only when there's a real choice to make: a week where every day works
says nothing, and a week where no day works says nothing either — there's no
session to recommend, and nagging about weather nobody can change isn't the
point. Past about five days out it hedges rather than promising you next
Wednesday's sunshine, and with no forecast cached it stays quiet. No new
notification is created: the line rides the morning message you already get.

**Conditions on the record.** An outdoor session's journal card shows what it
was like outside ("31°C · clear"), and Timeline days carry a short conditions
note when the weather was notable — a heatwave, cold snap, pressure swing, high
pollen or poor air day. It's read from the cached weather at display time and
never written onto the workout, so a gap in the data simply shows nothing. This
is context, not judgement: a slow run at 31°C explains itself.

Workout history, goals, strength analysis, cardio records, sport summaries, and
per-exercise history; the Overview tab carries a **Training watch** card of
calm, dismissible observations over your recent training — a push/pull volume
imbalance, an exercise that's gone quiet (in your rotation but untrained for a
few weeks), and a lift whose estimated 1RM has **plateaued** (~6 weeks flat →
try a deload or a variation) — kept separate from the next-workout suggestion; a
workout's **⋯ → Merge with…** menu folds that day's duplicates into one for
cases no auto-detector caught (undoable) — absorb one in a click, or combine
several and choose which record survives — and when the records genuinely
disagree on a field (e.g. duration 42 vs 51 min) a quick preview lists every
record's value (the keeper's pre-selected) so you pick which to keep per field.
Manually logged activities also get an
**estimated calorie burn** — computed from a baked MET (metabolic-equivalent)
table, the activity's type/intensity/duration, and your nearest bodyweight —
which auto-fills on the activity form (editable, so you can override it) and
rolls into the weekly recap; it's always shown as an estimate (`≈`) and kept
separate from device-measured calories (imported activities keep their device
value). For logging at the gym rather than after the fact, **Start workout**
(the command palette, the Journal header, or the mobile top bar) opens the same
editor in a **live** layout: today's date and start time are pre-stamped, each
lift's coached next set is pre-seeded so you just confirm it, and a client-side
**rest timer** (a lift-appropriate default — longer for heavy compounds, shorter
for accessories — with preset chips and a beep/vibrate at zero) starts
automatically when you log the next set; **Finish workout** stamps your end time
and drops back to the normal form for notes and intensity. While a session is
running, every one of those entry points — including "Log this session" on
Today's session — reads **Resume workout** and reopens the session you already
have going, with its clock and its logged sets intact; you can never restart a
workout you're in the middle of by tapping the wrong thing. It's a
strength-focused surface, so it's hidden for age-restricted profiles. A
non-strength session can also be tagged with the **gear** it used — a bike for a
ride, shoes for a run — picked from your **Equipment** registry, with the picker
filtered to what fits the activity (only bikes for a ride, only shoes for a run)
and defaulting to the last gear you used for that kind of activity (your
last-worn shoes for a run, your last-ridden bike for a ride); the linked gear
shows as a chip on the workout card that links to its detail page (strength
keeps its separate per-set implement tags).

### Planning and coaching

The Overview separates **Today's session**, **This week**, and **Training
watch**. The recommendation core is shared by the Dashboard, Training, and
notification surfaces so the app cannot suggest three different workouts for the
same day. It considers the active routine, recent muscle coverage, goals,
available equipment, an open illness recovery hold, recorded injuries, and
curated condition-specific training considerations. These considerations are
informational and cite their source; they never silently forbid an activity.

Recovery is judged on a rolling per-region window, not on the calendar week.
Weekly counts still reset with the week — that is what a weekly target means —
but which region to train next is decided by how long ago it was actually
trained: larger groups want a couple of days, smaller ones a day, and within
that constraint the least-recently-trained region leads. When every region you
train is still inside its window the day is framed as a recovery day rather than
forced into a suggestion. A week that can no longer be met without today
overrides the window, and says so — naming both the recent session and the pace.

Routines may come from templates or be built from custom workouts. They carry
weekly targets and a mesocycle/deload context without replacing the user's own
exercise choices. Repeating a prior session, accepting today's recommendation,
or choosing a custom workout all produce the same activity representation and
therefore the same history and analysis.

### Live strength sessions

A live session persists independently of the page. It can be minimized to the
app-wide dock, resumed after navigation or refresh, and only ends through an
explicit **Finish workout** or discard action. The header distinguishes active
movement time from elapsed wall-clock time.

Each set supports weight, reps or duration, optional equipment, and RPE. The
equipment you pick is a **load context**: loads aren't comparable across two
machines logged under one exercise name, so seeds, recent history, records,
plateau signals and the progression charts all stay within the implement they
were performed on, and a machine with no history of its own seeds nothing rather
than borrowing another's numbers. The next-set suggestion uses prior comparable
sets and the current RPE; **repeat last session** remains available when coaching
inputs are sparse. Plateau language stays a hint, not an automatic program
rewrite. Completing a set starts
the local rest timer, and finishing the workout presents one in-place session
summary before returning to the journal.

Form-check clips attach to the activity and may be tagged to an exercise. They
use the shared video constraints—upload-only, 60 seconds, 100 MB, stored as-is,
and streamed on open—rather than a second media pipeline.

### Fitness checks, endurance, and mobility

The guided Fitness check turns a battery of strength, aerobic, and functional
markers into one step-by-step flow. A recent compatible value already recorded
or synced can satisfy a step. Each completed test shows its outcome in place;
the final summary keeps every marker separate and links into its trend or
age/sex percentile. Rough or estimated values are labeled accordingly.

Endurance event plans work backward from a target date through a safe weekly
volume trajectory, long-session progression, and taper. If the available time is
too short, the plan says so instead of compressing unsafe growth into the
calendar. Mobility sessions log against body regions, build their own coverage
strip, and can satisfy weekly mobility habits.

Exercise how-to guides, muscle vocabulary, routine semantics, recommendation
rules, and the coaching model are specified in the
[workout UX specification](workout-ux-spec.md).

## Equipment

Your per-profile registry of bars, implements, cardio gear, and recovery
devices, at **/equipment** (reached from the activity form's "Manage
equipment"/"Add equipment" link — shown even before you own any gear, so it's a
bootstrap door — a link in the Training page header, the command palette, a
workout card's gear chip, or a protocol's gear reference — it's an
occasionally-visited inventory, not a top-level nav item; visiting it highlights
**Training** in the sidebar so the page still says where you are). The index groups gear
by kind (strength / cardio / recovery / other) with an active/retired split and
a per-item **usage** badge; each item's **detail page** shows its category, own
weight, when it was added, and the usage payoff — sessions count, last used,
total volume lifted (or total distance for shoes/bikes) with a small trend chart
— and is where you **retire** (soft-hide, keeping history) or **delete** it.
Gear you no longer own is retired rather than deleted so "which bar did I PR on"
survives. Your registry also **shapes suggestions**: once you own gear, the
exercise picker and the "train today" recommendation (dashboard, Training
overview, and the Telegram nudge — one shared computation) **prefer lifts you
can actually do**, gently de-ranking (never hiding) ones whose implement you
don't have; an **empty** registry means "everything's available" (the gym-goer
default), so gating only kicks in once you've listed some gear.

## Trends

Charts and analysis live in four tabs:

- **Overview** is the landing surface, and answers "how am I doing" in one
  scroll: the **"what's trending" digest**, then your **starred grid** — your own
  cross-domain set of saved, drag-orderable tiles, the one curated area where
  nothing appears unless you put it there — then the **Practices** lens, and
  finally the **body census**: vitals, acute temperature, sleep and outdoor-time
  signals, body composition, and the shared **Log measurements** form. A **Data
  check** card catches probable weight-entry errors before they skew charts.
- **Fitness** combines the workout-density heatmap, strength/cardio/sport
  progress, heart-rate-zone volume, the Zone 2 target, and polarization. Zones
  use Karvonen heart-rate reserve when resting HR is known, otherwise percent of
  max HR; the manual max-HR override is under **Settings → Training**.
- **Nutrition** charts macros, fiber, hydration, and related intake trends.
- **Insights** combines comparison tools with daily analysis and weekly/monthly
  recap narratives.

**Practices** (`/trends#practices`) is the wellness lens: for each practice you
have given a weekly cadence, one cell per completed week — at your weekly
maximum, floor met, or under floor — a consistency line with the current streak,
sessions per week charted against the min–max band you declared, and an average
session length for the modalities that record minutes. It renders only where you
track a practice, is calm by design (an under-floor week is a neutral cell, never
a warning), and every card taps through to **Wellness**, which still owns
logging, editing, and the full session history. A practice with sessions but no
weekly cadence has no range to be in and stays on Wellness.

The body census **streams in below** the digest and starred grid, so the landing
surface paints as fast as it did when Body was its own tab. Links that used to
target that tab now target its anchor (`/trends#body`); `?tab=body` is gone, and
lands on the Overview surface that carries the census. The three remaining tabs
are permanent — the deliberate asymmetry is the design: the landing surface
answers "how am I doing", the tabs answer "how is my training or nutrition
specifically".

Biomarker tables, flags, trajectories, reference ranges, food-first context,
fitness percentiles, and pediatric interpretation live under
**Medical → Results → Biomarkers**, not in Trends. Functional-fitness readings
are entered through the Training **Fitness check**.

The default window is the last 90 days. Every tab uses the same range model and
event overlays, and every starred tile opens the corresponding full chart rather
than maintaining a second interpretation. A hub configuration is carried by the
URL — the range, tab, and compare params are shareable and bookmarkable — not by
a stored view list.

**Trailing averages cover complete days.** A metric's detail page carries a
**Rolling summary** — 7, 30, and 90-day windows with an average, range, and
change each, independent of the chart's range control and collapsed into one
card wherever the windows genuinely hold the same readings. Those windows end
**yesterday**: today is not history until it ends, and for a cumulative metric
such as steps an included today used to drag the average down all afternoon and
silently correct itself at midnight. **Latest** is the exception and still shows
today's reading — recency is today's job, the average is history's — and the
card's note says both. The dashboard's Steps-today card compares today against
its own baseline, the last seven days that carry a reading, and labels it
**"prior 7 days"** rather than a second "7-day average": the two surfaces answer
different questions, so they no longer wear the same name. Both compute through
one shared helper whose window basis and today-inclusion are declared per
caller.

### The Overview surface: starred grid and body census

The starred grid answers two questions: **what you saved** and **what changed**.
Tiles
lead with the latest reading and its age, distinguish current value from trend,
and can be pinned and reordered. The mobile layout uses compact cards; the
overflow menu owns secondary controls instead of crowding the chart.

The census is organized into Vitals, acute temperature, sun/outdoor time, composition,
and wellbeing. **Today** can switch dense sensor series to a 1-day intraday
view, while longer ranges show the appropriate aggregate. Mood and other
self-reported wellbeing values appear as observations and are never
range-flagged. The shared **Log measurements** action writes to the same stores
used by integrations.

The star is the **one arrangement gesture** across both halves of the surface —
which is why they are one surface. Starring a body metric — on its own page, which
every card opens — is the same save as starring a grid tile, and starred cards
lead the census in the order the grid holds them, so pinned cards are re-sequenced
by dragging them (or using their overflow arrows) in the grid one scroll above.
There is no second reorder surface in the census.

Everything unstarred follows a **ranked default** built from stable subject
facts — life stage, live goals, monitored conditions, and whether a series has
data at all — never today's values, so the page never reshuffles because a
device synced. Its base reading order is everyday-first: composition, then daily
activity and the heart-rate family, then the daily subjective and environment
cards, then clinical vitals, then the synced composition tail. Clinical cards
rise when a monitored condition or a live goal actually watches them. A
growth-tracked profile still leads with its percentile card whatever is starred:
which cards exist for an age, and the pediatric lead, are membership decisions
that the star does not override.

### Fitness and Nutrition

Fitness separates:

- **Volume & cadence** for workout density and weekly volume;
- **Zones & cardio** for heart-rate-zone minutes, Zone 2, pace, and endurance;
- **Strength progression** for exercise history and estimated 1RM — a lift's
  variants count as one, while each piece of registry equipment is its own
  labeled progression;
- **Sport** for repeated sport/activity series;
- **PRs this window**, linked to the underlying sessions.

Deeper analysis and benchmark ladders remain under **Training → Analyze**, where
a lift logged on more than one machine keeps a single entry and offers its
machines as labeled choices, defaulting to the one used most recently. Trends
shows change over time rather than duplicating the coaching workspace.

Nutrition shows macros and fiber, food-group frequency, goal adherence, and
intake history over the selected range. Clinical results stay under **Medical →
Results**, even when nutrition may influence them.

### Compare, events, and Insights

**Compare** puts two ranges or sources on the same metric without summing
overlapping provider streams. A chosen primary source drives the authoritative
series while alternatives remain inspectable. All document-extracted readings can
be elected together as one **Documents** source, and any choice can be made
strict ("only this source"), which leaves honest gaps on the days it did not
cover instead of falling back.

Event overlays shade medication, appointment, situation, and protocol windows.
**Situation impact** compares values during and outside a selected situation as
an observational difference, not a causal result.

Insights can add optional AI narration to the deterministic charts. The chart,
units, source selection, and flags remain authoritative when AI is unavailable.
Chart interaction and visual rules are documented in
[the chart specification](internals/charts.md).

## Sleep

Route: `/sleep`.

A dedicated reading surface in the sidebar between **Trends** and **Upcoming**,
shown once any sleep session has been recorded (a data-gated nav entry). It
composes the sleep signals that already exist, as calm formatters over the same
computations — never an invented sleep score: a **last-night hero** (duration, a
stage bar, bed/wake, and how the night compares to your trailing-30-night
average, all of the **main overnight session** — a same-day **nap** appears as a
separate small line, never folded into the total), the **Sleep Regularity
Index** (SRI) trend (the same signal the Healthspan pillar reads — that pillar
card now deep-links here), a **consistency strip** (each night's bed→wake window
on a shared noon-to-noon axis, weekends tinted), **stage composition** over
recent nights, and — when both are logged — an inline **sleep ↔ mood** view
(observational co-occurrence, never a diagnosis); every night links to its
**Timeline** day view. A compact **last-night tile** ships on the dashboard
(duration + regularity, linking here), and Trends → Body keeps a compact
**Sleep** summary tile pointing at this page rather than the full charts.

## Progress photos

Route: `/progress`.

Progress photos are the physique use case of the shared photo core. Capture with
the **onion-skin in-app camera**: a live preview ghosts the series' last
same-pose photo at low opacity so every "front" is framed like the last "front"
(front-camera preview mirrored; a `<input type="file">` fallback covers
denied/absent cameras — both paths land in one confirm/retake step with pose,
date, and caption). Every stored photo runs one server ingest pipeline:
server-sniffed MIME, EXIF **capture-date harvest first** (an old photo defaults
to the day it was taken — GPS is deliberately never read), then auto-orient, a
**full metadata strip**, a ~2048px downscale + JPEG re-encode, and a grid
thumbnail; identical captures dedup per profile, and the nearest logged
body-weight (≤7 days back) is snapshotted onto the row so a compare reads "82.1
kg → 78.4 kg" beside the visual.

**Browse** is a date-grouped thumbnail gallery with a pose sub-filter and a
lightbox (original loads only on open, prev/next paging, caption + weight,
delete); **Compare** is a two-date timeline — side-by-side or an **onion-skin
overlay** with a blend slider — over the same series. Factual only,
product-decided: no pose detection, no body-fat estimate, no scoring. The nav
entry is data-gated (appears with the first photo; the command palette's **Add
progress photo** action is the ungated entry that also auto-opens capture), the
page itself never hard-blocks, and photos sit in the strictest privacy tier —
excluded from share links, the emergency card, and the full export, with files
under per-profile directories served only to a session on that profile.

## Video clips

The upload-first video core (`lib/video/*`) is the sibling of the photo core
with the parts video needs that photos don't. Two domains: **symptom / episode
clips** (`symptom_videos`) attached to a symptom-day on the illness episode page
(a tremor, tic, seizure, gait episode, or a cough/breathing audio note — the
clip a clinician actually asks for), and **training form-check clips**
(`activity_videos`) attached to an activity from its Journal card (optional
exercise tag for per-lift filtering). Phase 1 is **upload-only** (a native file
picker with `capture`, so a phone opens the camera/mic; in-app MediaRecorder
recording is phase 2). Deliberately **no `ffmpeg`-class dependency** — pure
byte-level container sniffing (`lib/video-sniff.ts`): the container is detected
by magic (MP4/MOV `ftyp` brands, WebM EBML, m4a/ogg/mp3 audio), the MIME is
**server-derived not client-declared**, the **duration is parsed from the
`mvhd`/EBML header** so the **60s cap is enforced server-side without
decoding**, the container **creation time** becomes the clip's default capture
date, and an embedded **location atom** (`©xyz` / ISO-6709) sets a flag that
drives a visible privacy note (the coordinate is never decoded or stored; the
file is stored **as-is**, no remux — the note steers toward the metadata-clean
phase-2 recording path). Caps: **60s / 100 MB**. A poster frame is extracted
client-side to a canvas and run through the photo core's EXIF strip; the grid
shows the poster and the `<video>`/`<audio>` element (with **HTTP Range**
scrubbing) loads only on open. Strictest privacy tier: per-profile grants,
id-AND-profile-scoped serving, **excluded from share links, the emergency card,
and the default export**, files unlinked with the profile. No AI (matches the
photo core) — factual capture, tagging, and playback only.

## Household

For any login that can reach more than one profile (an admin, or a caregiver
**member** granted several profiles), a cross-profile overview: one card per
person showing today's **attention items** — supplement/medication doses due,
low refills, and the next scheduled visit — alongside at-a-glance stats.
**Confirm** a due dose for anyone straight from their card **without switching
profiles** (the button shows only where you have write access; a read-only grant
sees the card but no actions), or tap a card to open that profile. Hidden for
single-profile logins. The cross-household **illness + visit trail** lives on
**Medical → Illness episodes** (`/medical/episodes`) — the view-set-driven
care-trail surface that superseded the removed `/household/history` (#1373): the
session view-set drives whose data shows (grant-scoped like the rest of
Household), and a URL-driven **Illness / Illness + visits** toggle drives what
shows. It merges every in-view profile into one date-ordered, month-grouped,
person-tagged stream led by a **trailing-12-month swimlane band** (a lane per
member; episodes as duration bars, visits as point markers on a shared axis) and
a **per-member stats strip**. "Illness" (default) nests each episode's **linked
visits** (#1198) and prescribed **medication courses** in episode-relative time
("Day 2 — Urgent care, Dr. Ng"; "Day 2 — started Amoxicillin · Completed" —
course membership reuses the episode-end reconcile's `classifyEpisodeMed` window
classification, and a course whose prescriber matches a linked visit reads
"prescribed at the Day-2 visit"); "Illness + visits" also interleaves the
unlinked routine visits. It's promoted with a calm dashboard link whenever
anyone in the house is **currently or recently sick** (and receding when the
house is well) — the link rides inside the recently-resolved band or the
household strip rather than occupying a band of its own; each illness-episode
page carries an **"Around the household"**
card of other members' overlapping or closely adjacent illnesses (a dated fact —
"overlapped by 4 days", never a cause) and a **Care** line linking the resulting
doctor/urgent-care visit — a visit dated within the episode's range is suggested
for one-tap linking (two in range become a picker; a "Link a visit…" affordance
covers the rest), and the linked visit shows a "During illness episode: …, day
N" back-link — the same suggest-and-accept mechanism as record↔visit, no
auto-link and no notification. The per-person **Visits** page gains an **Illness
episodes** link for multi-profile logins.

### The identity bar and the profile switcher

On a **multi-profile** instance one **identity bar** answers "whose data is this,
and who am I acting as?" everywhere: stacked avatars of the profiles currently in
your **view** plus a name line — `Alice`, `Alice, Bob`, `Alice, Bob +2 more`. The
**acting** profile is always **first** and visually distinct (ringed avatar,
emphasized name), because the bar shows who is _visible_ while writes land on who
is _acting_. If your grant on the acting profile is read-only, the bar says so.

It sits at the **top of the desktop sidebar**, and on a phone it takes the
**wordmark's slot in the top bar** — the brand line spent ~90px of a 390px bar
saying nothing while "whose data is this?" had no answer on that screen at all
(home stays one tap away in the drawer, and the desktop sidebar and login screen
keep the wordmark).

Tapping it opens one **switcher panel** — a drawer dropping from the bar on a
phone, a container dropping below it on desktop, both rendering the same rows.
On either viewport the panel **overlays** what is behind it: opening the desktop
switcher never pushes the nav, calendar or footer below it out of the way.
Every accessible profile gets a row with **two** controls, never one ambiguous
tap: the **name** switches who you are acting as, and the **eye** toggles that
profile in and out of your view. You cannot un-view the profile you are acting
as, and a read-only profile carries its hint on its own row.

A **single-profile** instance grows none of this: the phone keeps its wordmark
and the sidebar is unchanged — identity chrome when identity is ambiguous, brand
chrome when it isn't.

**Whose record am I acting on? (#1013)** You can mark one accessible profile as
**your own** under **Settings → Account & security** (optional — a
caregiver-only login leaves it unset; an admin can set it for anyone under
**Settings → People & access**). It
grants no access — it's purely a label — but once set, any write whose target
**isn't** your own profile **names the person right on the button**: a household
card's dose confirm reads "Confirm — Mia", the dashboard weigh-in "Log today's
weight for Mia", the live workout editor "Finish workout — Mia". No confirmation
interstitial (routine caregiving stays one-tap) — the passive naming just makes
a wrong-profile dose or weigh-in obvious at the point of action. The sidebar (or
drawer) footer also shows **"Signed in as …"** beside Log out, so it's clear
which login is acting. Deleting a profile or revoking a grant clears the own-profile link
automatically.

## Goals

Set targets, track progress bars, mark achieved/archived. An exercise goal can be
scoped to one piece of equipment; a weight target on a lift you've logged on more
than one machine asks which one rather than quietly taking the best across them,
and a goal that names no machine measures the movement however it was performed.
A body-weight goal
that's off pace for its target date surfaces a calm **Goal pacing** note
(trending away, or landing well past the deadline at your current robust trend),
alongside a gentle safe-rate caution when weight is dropping faster than
~1%/week — each dismissible.

A goal can also target a **lab or vital**: "LDL under 100 by June", "A1c below
7", "BP systolic under 120". Pick the marker, a direction (under / over), a
number and an optional date. The picker is the same relevance-ranked biomarker
list every other biomarker field uses — markers due for retest or flagged lead,
then your own markers, then the full vocabulary — and it states the analyte's
reference range beside the number so a target is set next to the thresholds the
app already holds. The value is stored with the unit the marker's own chart is
labelled in, so a mg/dL target is never compared against an mmol/L result.

Progress reads the same series the marker's detail page charts, matched by
biomarker family (an A1c goal is advanced by the eAG re-expression of the same
draw), and the target renders on that page too — beside the series it describes.
Weight, body fat and resting HR keep their own **Body metric** goal and are not
offered here, so each measure has exactly one kind of goal.

**A lab goal paces per result, not per day.** A body-weight goal is measured
every morning, so its pace can fairly be judged every morning; a lab value
changes when a tube is drawn. Between draws the verdict is held where the last
result left it — a lab goal never slides to "behind" on a day nothing was
measured — and the card says when the next result is due instead, on the
marker's own retest cadence. An off-pace lab goal joins the same calm,
dismissible **Goal pacing** note; it never escalates and never notifies.

## Nutrition

Route: `/nutrition`.

Nutrition is a food-group serving log at the **habit tier**, deliberately _not_
a calorie counter. A curated ~24-group catalog (fatty fish, leafy greens,
legumes, nuts & seeds, whole grains, red/processed meat, sugary drinks, alcohol,
…; `lib/food-groups.json`, regenerated with `npm run gen:food-groups`) is logged
as **servings, one tap each** (undo decrements), grouped by whether the guidance
is to eat _more_, _balance_, or _less_. A **weekly rollup** — ONE pure
computation (`lib/food-log.ts`) — feeds both the on-page "this week" card and
the **Trends → Nutrition** tab, and food-habit target progress, so the surfaces
can't disagree. The page also surfaces the deterministic food suggestions from
your flagged labs (#577) as "food before pills," each offering a one-tap **Track
as weekly habit**. A **Weekly habits** card makes "fatty fish 2×/week" a
first-class **food-habit target** — a `food_group` scope on the same
`frequency_targets` table the training weekly-routine uses, so its progress is
the same weekly serving rollup (one question, one computation) and it can be
adopted by a **Protocol** as an intervention. A behind-target habit surfaces as
a calm, dismissible **coaching** observation (never a notification). A **protein
gauge** draws today's intake and the weekly average against a goal-scaled g/kg
band (lean mass preferred when it's tracked); the goal behind that band is yours
to set — **Settings → Nutrition → Protein goal** (RDA baseline / Active / Muscle
gain / Cut), an informational range rather than a prescription, seeded to Active
when onboarding's fitness path is chosen. This
granularity is where dietary evidence actually lives ("2 servings of fatty fish
a week") and is sufficient for the biomarker→food and habit-target features;
full macro tracking stays possible later as an additive tier. Informational, not
medical advice.

## Benchmarks

Estimated 1-rep maxes (Epley) and a single **bodyweight-band strength-standard**
model that drives every "Level" surface from one computation: the per-lift
**Level** badge, the Analyze **Benchmarks** ladder, an exercise-detail coaching
line, and a healthspan pillar all agree because they read the same source. It
places your estimated 1RM among beginner→elite standards **for your exact
bodyweight and sex** and tells you how far to the next level ("at the
intermediate standard for men at your bodyweight — 12 kg to advanced").
Thresholds are **derived, not scraped** (no proprietary tables): the project's
own anchor ratios scaled by bodyweight^(2/3) — the cross-sectional-area law
(Lietzke 1956) — and interpolated between bodyweight bands, baked into
`lib/strength-standards.json` (regenerated with
`npm run gen:strength-standards`). Covers the main barbell lifts (back/front
squat, bench, incline bench, overhead press, deadlift) and the weighted
pull-up/chin-up; shown only when sex and a bodyweight are on file, informational
only.

## Medical

Vitals, labs, genomics — the **Biomarkers** browser, **imaging studies**, and
**genomic variants** share one merged **Results** page (#1042 phase 5, retabbed
to route-per-tab in #1079: `/results`, Medical → Results, as three tabs
`/results/biomarkers` / `/results/imaging` / `/results/genomics` — bare
`/results` lands on Biomarkers; the old `/biomarkers`, `/imaging`, and
`/genomics` index routes were removed in #1635 and 404, and the per-biomarker
detail page `/biomarkers/view` survives at its own route). The record-style
index pages (conditions, allergies, procedures, immunizations, family history,
visits, providers, background, care plan, and health goals) likewise share one
merged **Health record** page (#1042 phase 6, retabbed in #1079: `/records`,
Medical → Health record, organized as two-level tabs — a group tab **History** /
**Problems** / **Care** / **Specialty** then a section sub-tab. History → Visits
· Procedures · Immunizations; Problems → one stacked pane Conditions +
Allergies; Care → Overview (Background + Family history + Care plan + Health
goals) · Providers; Specialty → Vision · Hearing · Dental · Skin · Mental
health · Substance use. Bare `/records` lands on `/records/history/visits`; the old
`/conditions`, `/allergies`, `/procedures`, `/immunizations`, `/family-history`,
`/encounters`, `/providers`, `/care-plan`, `/care-goals`, and
`/medical/background` index routes were removed in #1635 and 404, while the
per-provider, per-encounter, and per-vaccine detail pages survive at their own
routes; (**Coverage gaps** was briefly a section here through #1042 phase 6 —
#1086 moved it to Data → Coverage as a catalog/data-management workflow, and the
old `/coverage` route is likewise gone;) the six specialty surfaces — Vision /
Hearing / Dental / Skin / Mental health / Substance use — are the Specialty group's
sub-tabs; the old `/vision`, `/dental`, `/skin`, and `/medical/instruments`
routes were removed too (as was `/medical/substance-use`, ahead of #1635), with Vision/Dental
data-gated on data presence (a hidden sub-tab's route re-gates server-side),
Substance use life-stage-gated to adults + unknown-age profiles (hidden for a
known minor, its instruments being adult-validated), and Skin/Mental health
always rendered — the latter because their in-page forms are the only creation
path, and Mental health's crisis line travels with its pane).

### Biomarkers browser

The Biomarkers tab (`/results/biomarkers`) is a collapsed **panel index**, not a
scroll: every reading is grouped under its normalized clinical panel ("Lipids ·
7 analytes · 3 flagged"), and a group opens on tap to reveal its readings. A
panel whose current readings include an out-of-range one says so on its header,
so a flagged group self-identifies while collapsed.

The index is the **whole** filtered set — there is no pager. A row cap would be
the wrong unit here (one panel with a few years of draws can be dozens of rows,
so a page could split a panel and print partial counts on each half); the panel
taxonomy is a closed set, so the list of headers has a hard ceiling by
construction. Groups arrive collapsed unless the result set is short, there is
only one group, or a filter is active — any narrowing means you already asked
for the rows, so every matching group opens and a search can never read as
"no results" because its hit was folded.

The **readings** are bounded separately from the headers: a group that arrives
collapsed is sent none of them, and one that arrives open is sent at most
twenty-five, saying how many it is holding back ("Showing 25 of 72 readings").
Opening a group, or asking a truncated one for the rest, loads that one panel's
readings on the spot. So the page you land on costs the index, never the whole
lab history, however many years of it there are.

Readings sort by **name** (A–Z, newest reading first within an analyte) or by
date; panel is not a sort, because the groups are already emitted in clinical
order. Filters are free-text search, category, clinical **panel**, an
all/non-optimal/out-of-range lens, and "current values only". The panel facet
offers a stable list — the taxonomy minus the panels whose analytes live in
categories this browser deliberately doesn't list (mental-health screening
scores, which are re-homed to Medical → Health record → Specialty, and blood
type, which lives in the passport), so it never offers a filter that returns
nothing for anyone.

**On a phone the index leads.** The trajectory-watch card keeps its place above
it — a warning has to find you rather than be looked up — showing its headline
("N analytes trending before a single reading crosses a line", and which) with
its per-analyte rows one tap away. The filter bar and the panel table come next,
then the two cards you go _to_: the starred lens and the biological-age hero,
rendered whole, a scroll below the index rather than hidden. "+ Add result"
stays last. Those two cards also stay capped at phone width — the starred card
shows its first three tiles behind a "Show all N starred" toggle, and the
biological-age card folds its nine-input "built from" list, never its estimate
caveat.

From a small-tablet width up, none of that applies: every card renders whole in
the original order, glance first and index below it.

### Imaging studies

The Imaging tab (`/results/imaging`), under Medical → Results — your radiology
studies as a first-class record type: modality (X-ray / CT / MRI / ultrasound /
DEXA / PET / nuclear medicine / fluoroscopy), body region, laterality, contrast,
and above all the radiologist's **impression** captured verbatim; extracted from
an uploaded radiology report or added manually, newest-first and filterable by
modality/region, each a first-class **Timeline** event. Allos holds the
_report_, not the images — DICOM/pixels are out of scope. Numeric imaging
metrics (DEXA T-scores, coronary calcium, ejection fraction, carotid IMT) keep
trending as **biomarkers**; the study is the narrative + metadata home that
links to them. A **cumulative radiation-dose** read sits atop the section: each
study can carry an effective **dose (mSv)** — rare on consumer reports, so
entered manually or, when a report actually prints one, pulled by extraction —
and studies without a recorded dose fall back to a curated
**typical-dose-by-modality** estimate (chest X-ray ~0.1 mSv, abdominal/pelvic CT
~10 mSv, whole-body PET/CT ~25 mSv, cardiac SPECT ~12 mSv,
fluoroscopy/interventional study-dependent; MRI/ultrasound are 0 — non-ionizing;
cited to the Mettler et al. catalog and RadiologyInfo.org). A calm,
informational **trailing-3-year total** shows the recorded and estimated
portions **separately labeled** (never one summed figure) with a
natural-background comparison, framed as context for a provider conversation —
never alarmist, never a "you've had too much" verdict; a child profile carries
the age-appropriate pediatric framing. The `indication` (why the study was
ordered) is captured for the record and the FHIR feed. The
**screening-vs-diagnostic** question — whether a diagnostic mammogram (done for
a lump) should satisfy the routine _screening_ reminder the same way a screening
mammogram does — is a **deliberately-kept behavior** (#703): any imaging still
satisfies its screening reminder exactly as before, because the person _was_
imaged and a finding, if any, is tracked separately via the follow-up loop; the
`indication` is intentionally **not** gated on here.

### Vision

The Vision tab (`/records/specialty/vision`), under Medical → Health record —
your eyeglass and contact-lens prescriptions as a first-class record type:
per-eye refraction in standard optometry notation (OD = right, OS = left) —
sphere / cylinder / axis / add — plus pupillary distance and, for contacts, base
curve / diameter / brand; extracted from an uploaded Rx slip or eye-exam report
via AI (the primary entry — a printed Rx is bounded, highly structured, easy
extraction territory) or added manually, newest-issued-first with a per-eye
**sphere-over-time progression** answering "is my myopia getting worse?", and an
Rx **expiry** surfaced as plain "expires soon" / "expired" UI text — the
recurring eye-exam reminder itself lives on the existing `vision_exam`
preventive rule, not duplicated here. Degrades without an AI key: the document
is stored and the record entered manually via the same form. The **Vision
section is data-gated** (#1042): it appears on Health record once a prescription
is on file — Data → Import creates rows too, so the empty section never strands
creation. The FHIR `VisionPrescription` structured-import mapper is a separate
follow-up (#708); this table is its destination.

### Dental

The Dental tab (`/records/specialty/dental`), under Medical → Health record —
tooth-anchored procedures with tooth number (FDI/Universal), surface, and
CDT/ADA code, plus dental exam **findings** ("watch #14, recheck in 6 months")
that seed a resolvable follow-up (the same finding→follow-up→resolution loop as
imaging); periodontal **measurements** (probing depth, bleeding-on-probing)
reuse the biomarker store and trend/flag alongside labs; extracted from an
uploaded dental exam/treatment record via AI (dental has no FHIR feed) or added
manually. Dental X-rays are imaging studies, not modeled here. Like Vision, the
**Dental section is data-gated** (#1042) — it appears on Health record once a
record is on file. When an **invasive** dental procedure is _planned_
(extraction / implant / oral or periodontal surgery), a **safety cross-check**
surfaces a calm, cited pre-procedure note against your record — an
antiresorptive (bisphosphonate/denosumab) → MRONJ caution, a high-risk cardiac
condition → AHA antibiotic-prophylaxis note, or an anticoagulant → bleeding note
— informational, never prescriptive; a routine cleaning triggers nothing.

### Skin

The Skin tab (`/records/specialty/skin`), under Medical → Health record — always
rendered, since the in-page lesion form is the only creation path — track moles
and spots over time as a first-class record type: a coarse body-map region +
side, size in mm, and the five **ABCDE** observations (asymmetry / border /
color / diameter>6mm / evolving) captured as user-recorded checkboxes, plus
**serial dated photos** per lesion rendered adjacently for a side-by-side "is
this mole changing?" comparison; each lesion groups its observations by identity
(region+side+label), and flagging one **watch** with a recheck interval seeds a
resolvable follow-up on Upcoming — the same finding→follow-up→resolution loop as
imaging/labs/dental — that a later record of the same lesion resolves
stable/changed/removed (a changed lesion, re-entered as watch, keeps a fresh
recheck rather than aging out); added manually with photo upload (the primary
path — AI extraction from a dermatology report is a deferred follow-up), photos
ride the per-profile upload posture (sha256 dedup, profile-scoped serving) in
their own store. A lesion record also names the **visit it was checked at** (a
picker beside its provider field): the finding and recheck interval are what a
dermatologist tells you at an appointment, so the row reads **Checked at:** that
visit and the visit's detail lists the lesion — the same provenance chain a
biopsy from the same appointment already had.

**Scope boundary, by design:** this is a self-monitoring record for you and your
dermatologist — it tracks and compares, it never assesses malignancy or scores
the ABCDE observations into a verdict.

### Hearing

The Hearing tab (`/records/specialty/hearing`), under Medical → Health record,
sits beside Vision and is **always rendered** — its in-page audiogram form is
the only creation path today, so a data gate would make the first hearing test
unreachable (audiometry import is a later change). Enter one dated hearing test
at a time: a pure-tone air-conduction threshold in dB HL per ear per test
frequency (250 Hz–8 kHz), any of the twelve fields left blank meaning "not
tested". Each test lists with its per-ear **pure-tone average** and descriptive
grade, thresholds above the normal band marked, and a **threshold-shift** card
when the numbers have significantly moved since the earliest test on file (the
ASHA ototoxicity-monitoring criteria: 20 dB at one frequency, or 10 dB at two
adjacent frequencies).

**Where the readings live (#1600):** an audiogram is dated per-subject readings,
so it reuses the **observation store** rather than minting a table — each
threshold is a canonical `vitals` `medical_records` row
("Hearing Threshold, Right Ear 4 kHz", `dB HL`), which is the same store, the
same curated WHO ≤25 dB HL band, and the same rows that already trend and flag
on Results → Biomarkers. Each ear/frequency stays its own independently-flagging
series (deliberately never collapsed into one "hearing" family, so a normal
frequency can't hide a flagged one). This change added **no migration**.

Around the record: a new age-related **hearing screening** preventive rule (a
`hearing` audiology appointment/audiogram satisfies it) that recorded **noise
exposure** (Settings → Health risk factors) or an active **ototoxic medication**
brings due sooner; and an **ototoxic-medication** awareness note — an active
aminoglycoside / cisplatin / high-dose loop diuretic / high-dose salicylate /
vancomycin / quinine surfaces a calm, cited hearing-safety note on Medications,
Supplements, and Upcoming. That note now **cites the newest audiogram** when one
is on file, and names a documented threshold shift when there is one — the
"on an ototoxic drug _and_ the thresholds have moved" conjunction it previously
could not see. With no audiogram on file it says nothing extra: the note may
become more specific, never more insistent. Informational and never
prescriptive throughout. Hearing aids are tracked in the **Equipment** registry
rather than a second medical-device table.

### The problem list and family history carry their clinical detail

A problem is more than a name. A condition records its **side** (left / right /
bilateral), its **severity** (mild / moderate / severe) and its **stage** (free
text, because AJCC "IIIA", CKD "stage 3b" and NYHA "II" are different
vocabularies) — all optional, all unstated by default, and none of them ever
inferred from the diagnosis name. The side is **identity, not decoration**: the
problem list labels a sided condition with its side ("Osteoarthritis of knee
(left)"), the delete confirmation names the side it is about to remove, and the
left-knee and right-knee rows survive de-duplication separately even though they
share a name and an ICD-10 code. The passport carries the side and grade too, so
a handoff document reads the same as the app. Imports stop dropping what they
already parse: the CCD Problem Severity observation and `targetSiteCode`, and
FHIR `Condition.severity` / `.bodySite` / `.stage`, land in these columns and
export back out the same way.

Family history records **how and how young** a relative died — `age at death` and
`cause of death`, distinct from the age at onset — and **whether they are a
genetic relative at all**: genetic, half sibling, adopted, or step, plus the
maternal/paternal line where it applies. Left unstated a relative reads as
genetic, which is what every entry made before the field meant, so nothing
changes retroactively. The distinction is not cosmetic: the **risk and
screening-cadence engine** now excludes an explicitly non-genetic relative
entirely (an adopted parent's coronary disease no longer tightens a cardiac
screen), and it reads a genetic relative's cause of death as a condition in its
own right, aged at death — so "father, MI at 52", the exact input the cadence
rules key on, finally reaches them. The row and the passport label the relative
with the discriminator ("Father (adopted)", "Grandmother (maternal)") and render
the death as one line ("Died at 52 — Myocardial infarction"). The FHIR importer
maps `FamilyMemberHistory.deceasedAge`, `condition.contributedToDeath` and the
v3 relationship role codes; the CCD importer reads the death observation's
nested age observation and the `relatedSubject` code.

### Result status, corrections, and how a draw was collected

A lab result carries more than a number. Each reading can record its **result
status** — the lab's own lifecycle, _preliminary / final / corrected / amended_
(FHIR `Observation.status`) — plus whether the draw was **fasting** (a real
tri-state: fasting, non-fasting, or unstated — a fasting glucose is read against a
different band than a random one), the **specimen** it came from (serum, plasma,
whole blood, urine, RBC…), and the clinician who **ordered** it, separately from
the lab that **performed** it. All four are optional on every reading: unstated
stays unstated, never a guessed "final" or "non-fasting". The record form offers
them on both the add and edit paths, the AI document extractor fills them from what
a report actually prints (a "CORRECTED REPORT" banner, a "Fasting: Yes" line, a
printed specimen), and the deterministic FHIR importer maps `Observation.status`.

**A corrected result no longer erases the one it replaces.** When a source
re-issues a reading it already sent — same `external_id`, a changed value, or a
status the lab itself calls corrected/amended — the value being replaced is
preserved beside the reading before the overwrite, and the biomarker detail page
shows it ("Corrected — was 5.2 mmol/L"). The reading itself keeps its identity, so
everything linked to it survives; the preserved value is provenance only and never
charts, counts, or flags. A hand-corrected reading is still never overwritten at
all (the import edit-lock), and an ordinary re-send of an unchanged value stays a
silent no-op.

### Visits and record provenance

The Visits page pairs **Upcoming** appointments—booking, kinds, and
reminders—with **Past** encounter history. A single **Add visit** entry branches
on tense: a future date books an appointment and a past date logs a visit, so
the user never chooses between two near-identical forms. Completing an
appointment can **log a linked visit**, and a synced encounter auto-completes
the appointment it matches.

Each past visit's raw HL7 **encounter class** (AMB/IMP/EMER/…) now renders as a
friendly label (**Ambulatory**, **Inpatient**, **Emergency**, …) on the list
badge, detail page, and import review instead of the bare code, and the visit
list carries a **canonical-kind filter** ("show ED visits") — one pure
classifier (`lib/encounter-kind.ts`) that folds the fine class plus the
preventive type code (CPT 9938x/9939x → Preventive) into a coarse set
(Preventive / Ambulatory / Emergency / Inpatient / Observation / Virtual / Home
health / Other) that every surface keys on; the stored source `type` text is
never rewritten. Records connect to the visit they belong to: a visit's detail
page shows a **From this visit** section (meds started, diagnoses, procedures,
imaging, immunizations given, skin lesions checked, allergies documented) plus a
**From this visit?** suggestion block that
batch-links records sharing the visit's date (a matching provider reads
_strong_; two visits on one day become a **picker**, never a guess) — and where
a source health record carries the reference outright (a FHIR
`MedicationRequest.encounter`, an `Observation.encounter`, a visit diagnosis)
the link is set deterministically at import. A linked medication's detail page
shows **Prescribed at:** that visit (resolved through its source prescription
record when the med itself carries no direct visit link). A medication also
links to its **prescriber** (an individual in the shared providers registry —
the picker enters individuals, the free-text prescriber resolves to an exact
registry match, and historical rows get a one-tap suggest-and-accept for a
likely match; the pharmacy free text holds the org half) and to the **condition
it treats** — a **"For:"** line on the med and a **"Treated with:"** line on the
problem list, set deterministically from an imported prescription's FHIR reason,
from a text-match suggest-and-accept, or from the "For condition…" picker.
Accept/decline decisions survive a document reprocess (keyed on stable
identities); nothing gates on the links — they are provenance and navigation
only. The Passport summary carries the offline **Emergency Card** as its
`#emergency` section.

### Providers

The Providers tab (`/records/care/providers`) is the instance-wide directory of
your clinicians and organizations, minted automatically from imported Care
Teams: a provider name links wherever it renders (records, visits, prescribers)
to a detail page with a global identity card (name, NPI, phone, address —
admin-only to edit) and the active profile's activity with that provider
(visits, labs, medications, immunizations, procedures, care plan). A stored
address (on the provider card, and on visits/appointments that resolve to a
facility) gets an **Open in Maps / Directions** link that opens the address in
your own maps app — the only thing that leaves the box is the address you
clicked, sent by your browser (no geocoding, no stored coordinates, no map
tiles). Import-minted duplicates ("John Smith MD" / "Dr. John Smith") can be
**merged** by an admin — one transaction re-points every linked record onto the
survivor. The registry also carries **specialty** (the NUCC taxonomy code
captured from a CCDA performer's `<code>` or a FHIR
`PractitionerRole.specialty`/`Practitioner.qualification`, resolved to a display
label from a curated NUCC subset with the document's own text as fallback,
editable by hand), **individual↔organization affiliations** (derived from
co-occurrence — every visit pairing a clinician with a facility — and offered as
suggest-and-accept links, never silently auto-linked; the directory then renders
**grouped**, organizations as cards with their affiliated clinicians nested and
unaffiliated individuals separate, recency-sorted with `tel:` affordances and
the specialty chip, falling back to the flat list when no affiliations exist
yet; a detail page shows **Practices at** / **People**), a **lifecycle archive**
(an admin can archive a retired clinician or closed practice — it drops out of
the default directory behind an "archived (N)" disclosure and out of picker
suggestions, but keeps every record's link; a re-import that resolves to it
un-archives it), and a **contact edit-lock** (a manually corrected phone/address
survives a later import — only manual edits lock; import-vs-import stays
last-write-wins). A provider is now settable **on the Vision, Dental, Skin, and
Imaging record forms** too (imaging carries both the ordering clinician and the
reading radiologist), so a manually-entered record can be attributed to a
clinician and shows up in that provider's activity — nullable per record, never
nagged. When you enter a **condition** by its everyday name without a code,
Allos suggests a matching **ICD-10-CM** diagnosis code from a baked
common-conditions map (`lib/icd10-common.json`, regenerated with
`npm run gen:icd10`) that you confirm with one tap — public-domain ICD-10-CM
only (SNOMED deliberately avoided), so the code travels with the record into the
FHIR export and sharpens cross-document de-duplication.

### Coverage gaps

The **Coverage** tab of `/data`, Data → Coverage — #1086; formerly `/coverage`,
then briefly a `/records` section) surfaces the biomarkers, medications, and
conditions on your record that the curated catalogs _don't_ cover yet — a
catalog / data-management workflow about the app's coverage of your data, not a
clinical record — where the app would otherwise silently fall back to defaults
(no reference range, flag, retest cadence, interaction, or description). Track
one to fill it two ways: **generate descriptive context with your configured
AI** (with `AI_BASE_URL` pointed at a local inference server this stays on the
box — zero egress) — labeled "AI-generated, unverified" and **descriptive only**
(it never sets a reference range, flag, or interaction; curated data drives all
clinical logic) — or file a **de-identified catalog request** to the maintainer
(a copy-to-clipboard blurb or a prefilled GitHub-issue link you review and
submit yourself, carrying only the item's public name/code — never your values,
dates, or profile). A tracked gap that a later catalog update covers shows a
**"now available"** state. Informational, not medical advice.

### Derived indices

Standard derived indices (Non-HDL cholesterol, the cholesterol/HDL, LDL/HDL and
triglyceride/HDL ratios, HOMA-IR,
race-free CKD-EPI 2021 eGFR, and Levine **PhenoAge** — a biological-age estimate
in years) are computed from your existing labs and shown alongside them, marked
"derived" with their formula (eGFR/HOMA-IR/PhenoAge only appear when the needed
labs and age/sex are on file; PhenoAge requires a full nine-analyte draw and an
adult profile). PhenoAge is also surfaced as a **biological-age card** pinned
above the Biomarkers table: your estimated biological age, how it compares to
your calendar age (younger is better), your pace of aging across draws, and the
nine inputs it's built from (folded behind a toggle on a phone) — with a
checklist prompt when the panel is incomplete. It's framed as a population-level estimate (Levine 2018,
NHANES-validated adults ~20–84) and is hidden for child profiles.

## Allergies

Documented allergies merged with allergen-specific IgE sensitizations detected
from your labs (RAST / ImmunoCAP), plus informational **cross-reactivity** notes
from a curated reference dataset of well-established families (birch-pollen oral
allergy syndrome, latex-fruit, crustacean/mollusk shellfish, cashew-pistachio &
walnut-pecan tree nuts, mammalian milk). Shown on the Allergies page and the
Passport, framed as "commonly cross-reacts with" — reference only, never a
diagnosis.

Each allergy also carries **criticality** (FHIR `AllergyIntolerance.criticality`:
low / high / not assessable — the potential for a _future_ exposure to be
life-threatening, a different question from how bad the recorded reaction was), a
**verification status** (unconfirmed / suspected / confirmed / refuted / entered
in error), and **multiple graded reactions** (a peanut allergy that causes both
hives _and_ anaphylaxis is two manifestations, each with its own grade). All are
optional: unstated stays unstated and is never guessed. Verification status is
load-bearing, not decoration — a **refuted** or **entered-in-error** allergy
stays on the Recorded-allergies manager (so you can see and undo the refutation)
but stops gating: it leaves the drug-allergy safety matcher, the food and
supplement screens, the Passport's known-allergy list, and the emergency card. A
**high-criticality** allergy leads the emergency card, ahead of the free-text
severity ordering. The FHIR export carries all three
(`criticality` / `verificationStatus` / `reaction[]`), and the document importer
maps criticality and verification status when a document states them.

An allergy also carries its **attribution** — the clinician who documented it and
the **visit** it was recorded at, both optional and both set from the allergy
form (a create-on-type provider picker and a visit picker). The row then reads
**Recorded at:** that visit, deep-linked, and the visit's own detail lists the
allergy under _From this visit_. This is the companion to verification status: a
_confirmed_ allergy means more when you can see who confirmed it and when. An
imported `AllergyIntolerance.encounter` sets the visit link deterministically;
a dangling reference imports unlinked rather than wrongly linked. The link is
provenance only — nothing gates on it, and deleting the visit or merging the
provider away leaves the allergy intact with the link honestly cleared or
re-pointed.

## Immunizations

Record vaccines and doses, track them against the CDC schedule (due / overdue /
up to date), and see immunity titers pulled from your labs. Age-inappropriate
childhood-only vaccines with no adult catch-up (rotavirus, the childhood PCV/Hib
series) are shown as **not applicable** for adults rather than surfaced as gaps,
and the self-declared **Health risk factors** rank up the vaccines they make
more important with a calm reason line (immunocompromised / dialysis →
pneumococcal & meningococcal, healthcare worker → hepatitis B / influenza / MMR
/ varicella, pregnancy → Tdap & influenza) — informational only, not medical
advice.

A dose records the administration facts school, travel, camp, and employer forms
ask for: **lot number**, **route** (IM / SC / ID / oral / intranasal / other),
**site**, and any **adverse reaction** to that dose. All optional — an unstated
field prints an em dash, never a guess — and all shown on the recorded-dose
table, the per-vaccine dose history, the CSV export, and the FHIR `Immunization`
resource (`lotNumber` / `route` / `site` / `reaction`). A per-vaccine
**declination** additionally carries a structured **exemption type** (medical /
religious / philosophical) alongside its free-text reason; an "immune" override
never carries one, because it is not an exemption.

## Cycle

A manual menstrual-cycle log at **Medical → Cycle** (`/medical/cycles`). Log a
period with one tap ("Period started today" / "Period ended today", acting on
today for the active profile) or with a dated form (start, optional inclusive
end, a light/medium/heavy flow, and a note); each recorded period lists in the
history with its bleeding length and is editable/deletable inline.

The **quick action is for the common case; the form owns the exceptions**
(#1681). With no period open the control shows the derived cycle state ("Day 6 ·
Follicular") rather than an always-on start button — "Period started today" only
returns once a plausible gap has elapsed since the last period ended, because a
period ending and the next one starting are ~2–3 weeks apart and a tap in
between would mint a back-to-back period that corrupts the start-to-start cycle
lengths. In the same slot sits a one-tap **"Still bleeding"**, which reopens a
period ended by mistake within a small recency window (it refuses an older one
rather than silently merging two cycles). Every quick action answers from its
write core's **typed outcome** — a tap that changes nothing says so, and never
reports success.

Cycle writes carry **plausibility guards** (#1682), all in one pure module so
the form, the quick actions, and any future import path share them:

- A period left open past a plausible maximum (~10 days) **stops resolving as
  `menstrual`** — the forgotten "Period ended" tap no longer claims menses
  forever through the phase, the Timeline chip, the derived Period situation, or
  the phase-specific reference ranges. **Nothing is written**: the record stays
  exactly as recorded and the surface prompts _"Still bleeding? Set the end
  date."_ The app withdraws its own claim; only the user's tap edits the row.
- A **too-long recorded period is stored, not refused** — prolonged bleeding is
  real, and an app that can't record it can't record an emergency. It surfaces a
  calm, dismissible coaching-tier finding ("N days of bleeding — worth
  discussing with a clinician"), never a notification.
- **Future dates are refused** on every path; arbitrarily old backfill stays
  allowed, because people legitimately reconstruct history.
- **Overlaps and a second simultaneously-open period are refused**, with the
  conflicting period named in the message. No inferred repair — the user
  resolves the conflict explicitly. Per-day
  **cycle symptoms** (cramps, bloating, breast tenderness, mood swings, low back
  pain) ride the SAME shipped symptom bar (#799/#815/#857) — a small `domain` tag
  (illness/cycle/general) on the symptom vocabulary leads each mount with its
  context's slugs, so the Cycle bar surfaces the menstrual symptoms first while
  every symptom stays loggable; phase membership is derived by DATE, so a symptom
  during a period during a cold belongs to both the illness episode and the cycle
  phase, correct by construction (no second symptom store). The **cycle phase**
  (menstrual/follicular/luteal) is DERIVED from the logged period history — one
  pure computation shared by the Cycle page's "current phase" card and a
  phase/period **chip on the Timeline day view** — and a **cycle-length +
  variability** read (average/shortest/longest/spread, a regular-vs-irregular
  verdict within a 7-day threshold, and a length trend chart) answers "is it
  regular / changing." The **phase stays retrospective**: the luteal phase is
  only assigned once the following period is logged, because a phase says what
  the body did, not what it will do. It also feeds cycle-phase-aware biomarker
  reference ranges (the phase on a lab's collection date). Informational only, not medical advice or
  diagnosis. The **Cycle nav entry is relevance-gated** (#1042): any logged cycle
  always keeps it visible — data wins, including for trans or unset-sex profiles —
  else it shows for a female profile that is premenopausal (explicit reproductive
  status beats the age proxy; with no status set, the #494 life-stage fallback
  shows it for adolescents and adults). An explicit postmenopausal status (absent
  data) hides it, as does an unknown sex or age. The gate is cosmetic —
  `/medical/cycles` never hard-blocks.

### Next-period forecast

**The #714 tracking-only exclusion was reversed by owner ruling (#1679).** The
app forecasts the next period — always as a **confidence-framed range, never a
date**. The window's width comes from the profile's own measured variability, so
honesty scales with evidence: a regular history gets a **narrow** window (±2 days
at the tightest), an irregular one gets an explicitly **wide** one, and a history
with fewer than three completed cycles gets **no forecast at all**, with a "log a
couple more cycles" note — silence, with a reason, beats a fabricated date. Width
is monotonic in variation by construction: more spread can only ever widen it.

If the current cycle outruns its own projected window the forecast **degrades
rather than re-predicts**: the projected start and the window's start stay put,
the end stretches to cover the overrun, and the confidence drops to "less
certain". Widen, never shift.

An **ovulation estimate** rides along at projected start − 14 days, carrying the
same window and the same confidence tier — labelled as an estimate from history,
never an observation. It is the weakest of the four standard methods and says so;
the TTC evidence below is what makes a window actionable.

One pure computation (`forecastNextPeriod`, `lib/cycle.ts`) produces the window,
the confidence tier, and the evidence (cycles used, mean, spread, anchoring
period), and every surface formats THAT — the Cycle page's "Next period" card and
the dashboard Cycle-phase tile cannot disagree. The forecast is **informational
reach only**: it never becomes an Upcoming item and never notifies. It **suspends
entirely** while a pregnancy is recorded, and for a profile whose recorded
reproductive status is postmenopausal.

### Trying to conceive

TTC (#1680) is **off until you declare it** — a start date on the Cycle page, and
nothing else turns it on. Recording an ovulation test is an observation, not a
statement of intent: the app never infers that someone is trying to conceive.
Stopping is as easy as starting and removes only the declaration; the
observations already recorded stay. The section is **adult-gated** (the same
`!isMinor` line the other adult topics use).

Three observations, each **reusing a shipped store** rather than earning a table:

- **Ovulation (LH) test** → `medical_records`, a dated positive/negative result.
  Deliberately NOT filed as the serum LH analyte — a urine strip carries no
  canonical name, so it is never flagged against serum reference ranges.
- **Waking temperature (BBT)** → `metric_samples` (`bbt_f`), stored in the app's
  one canonical temperature scale and displayed in the login's preferred unit.
- **Cervical mucus** → `symptom_logs`, a categorical daily observation
  (dry / sticky / creamy / egg-white) stored as its 1–4 ordinal. The symptom
  vocabulary gained an optional **ordinal scale** for exactly this, so the stored
  value renders as "Egg-white" and never as "moderate", and the entry stays out
  of the generic symptom picker (it has its own bar).

Each write goes through the shared observation substrate: the edit lock (a
hand-corrected row is never overwritten, and the tap says so rather than claiming
success), `classifyUpsert` / `tallyUpsert` accounting (a re-tap of the same value
is `unchanged`, not a write), and `latestByGroup` on the domain's own identity
function for "what is current per observation kind".

The **fertile window** is built from the best available evidence and always names
which: a **positive LH test** (ovulation within ~24–36 h) beats a **fertile mucus
pattern**, which beats the **calendar estimate** from the forecast above. Every
rendering carries the non-negotiable line that this is **not a contraceptive
method**. There is no fertility score and no "chance today" percentage — the app
states evidence and windows, and manufactures no probability it cannot support.

**Ovulation confirmation** is retrospective by nature: a sustained temperature
rise (the classic three-readings-over-six rule, 0.4 °F above the pre-rise
baseline, gap-tolerant because it counts readings rather than calendar days)
dates ovulation to the day before the first high reading. From there the app
reports the **luteal-phase length** to the next period start — the number a short
luteal phase shows up in — and can describe a progesterone draw's timing relative
to estimated ovulation ("drawn 7 days after estimated ovulation"), leaving the
interpretation to the existing cycle-phase reference ranges.

A **months-trying counter** reports elapsed months and cycles attempted since the
declared start, and a calm, dismissible **coaching-tier** prompt appears at 12
months of trying (6 from age 35) suggesting that a clinician conversation is the
usual next step. It never pushes and never escalates. Everything here is
deliberately un-gamified: no streaks, no milestones, no encouraging tone — a
cycle that ends without a pregnancy is a neutral fact. TTC **stops entirely**
while a pregnancy is recorded; the counter freezes at the declared start and is
kept for history.

## Mental health

Validated screening **instruments** on **Health record → Specialty → Mental
health** (`/records/specialty/mental-health`; the old `/medical/instruments`
route is gone — the pane always renders, since the in-app instrument
flow is the only creation path and the crisis line travels with it): **PHQ-9**
(depression) and **GAD-7** (anxiety) tracked as numeric, **severity-banded**
scores (PHQ-9 minimal / mild / moderate / moderately-severe / severe; GAD-7
minimal / mild / moderate / severe) — the app's measurement DNA, **not** a
subjective mood diary. Administer the public-domain questionnaire **in-app** (a
9/7-item tap-through that computes the total from per-item answers) — the
guided-battery pattern (#834) — or enter an outside total-only score; the score
is stored as a biomarker-shaped reading (canonical name `PHQ-9`/`GAD-7`) so it
**trends like any biomarker** (no parallel value store — the observation
substrate), and a recorded score **satisfies** its preventive depression/anxiety
**screening** (stronger evidence than a bare visit). A completed **Mental
health** appointment kind (#997 — therapy/psychiatry as a first-class one-off
visit, with
`therapy|therapist|psychiatr|psycholog|counsel|behavioral health|mental health`
FHIR/concept-map inference synonyms; no therapy-vs-psychiatry split, no standing
cadence) **also satisfies** both screenings through the SAME shared
preventive-satisfaction stream (`lib/preventive-inference.ts`) a physical uses
for its check-up — the `mental_health` appointment folds its kind text into the
inference record and widens its `allow` to reach the screening matchers, so a
person in active behavioral-health care isn't also nagged to get screened.
Item-level answers are stored (needed for the PHQ-9 item-9 handling below) in
the one small `instrument_responses` table; an outside total-only score degrades
gracefully to total-only.

A recorded score can be **corrected or removed** from the History list on both
instrument surfaces (Mental health and Substance use). This is a safety
affordance, not a convenience: a fat-fingered outside total — a GAD-7 of 21 typed
where 12 was meant — used to distort the trend permanently and could permanently
trip the non-dismissible crisis line below, with no recovery path. Correcting the
score releases that line by construction, because the banner and the History list
read the same computation over the same stored rows. A score administered
**item by item** in-app refuses a total edit and says so — its total is derived
from the answers, which are the source of truth (correct it by removing it and
answering again). Removal goes through the shared **undo** toast, and the undo
restores the item answers with the score, so a restored PHQ-9 keeps its item-9
signal.

**Sensitivity is deliberate** (#716): this domain is **exempt from the
milestone/streak machinery** — no streaks, no "improve your score" nudges, no
celebratory copy on a depression score. A **severe** total, or a **positive
PHQ-9 item 9** (suicidal ideation) from an in-app administration, renders a
**NON-DISMISSIBLE** crisis-resources line (the operator-configured resources,
plus a gentle "discuss with a clinician" note) — structurally outside the
dismissal bus, the same standing as a safety dose reminder — and joins the
**care tier** (Upcoming + the dashboard **Needs attention** hero) for the
profile's own on-screen view, but is **NEVER** sent as a notification on any
channel (Telegram / Web Push / Home Assistant): the app informs on-screen, it
does not push crisis content to a possibly-shared or locked device. A
mental-health **appointment** additionally defaults to **minimal detail**
("Medical appointment") on shared/exported surfaces — the household strip and
the `.ics` family calendar feed — via the ONE `sharedSurfaceDetail` decision
(`lib/appointment-sensitivity.ts`) every shared surface consults, overridable
per profile; the profile's OWN surfaces always show full detail. Informational,
a screening instrument, **never a diagnosis**.

## Crisis support

This is the highest-stakes mental-health surface and the one place the "calm by
default" ethos deliberately yields toward visibility. A **passive**
crisis-resources surface (`/crisis-resources`) is always reachable — its
standalone **Crisis support** nav slot was removed when Mental health folded
into Health record (#1042 final tail): the link now travels with the
`/records/specialty/mental-health` pane (the safety contract is content, not
route), while the route itself stays. The same resources surface **calmly
inline** where a crisis trigger fires: a positive **PHQ-9 item 9** on a recorded
instrument (reusing the #716 item-9 machinery — never a severe total alone,
never a low-mood trend), and an **explicit user affordance** (the "Crisis
resources" link in the Mental health section). The resource list is
**configurable** — a global instance default on **Settings → Server** (admin,
`requireAdmin`) with an optional **per-profile override** on **Settings →
Profile** — with **no hardcoded `988`**: an unconfigured instance shows a
neutral "contact your local emergency services / a local crisis line" fallback
plus an admin-visible pointer to configure, never a fabricated number
(`lib/crisis-resources.ts` + `lib/settings/crisis.ts`). The reach is **passive +
reactive inline only** — no notification, no outreach, no auto-surfacing: a
crisis signal **stays with the profile**, is never shown to a caregiver login,
never written to a shared surface, and never transmitted anywhere. Informational
— the app surfaces a resource, it never intervenes.

## Substance use

Substance use is behavioral health's other half, on **Health record → Specialty
→ Substance use** (`/records/specialty/substance-use`, beside Mental health;
shown for adults + unknown-age profiles and hidden for a known minor, since
AUDIT/DAST are adult-validated): the full **screen → track → support reduction**
ladder, deliberately **without gamification**.

**Screening**: **AUDIT-C** (alcohol, 3 items, per-item 0–4 options — public
domain, Bush et al. 1998 / VA) and, since #1085, the **DAST-10** (drug use, 10
yes/no items scored 0/1 — item text © Skinner 1982 / CAMH, reproduced with
attribution under CAMH's clinical/educational permission per the owner-recorded
reversal of the #998 total-only call; the one reverse-scored item is encoded
purely by flipping its option values, so the shared sum-the-answers scorer has
no special case) both administered **in-app** as tap-throughs, plus the full WHO
**AUDIT** (0–40) as **outside-total entry only** — its item text is deliberately
**not reproduced** (the WHO grant is non-commercial-scoped; the published
severity thresholds — uncopyrightable facts — are baked: PHE/NHS AUDIT-C bands,
WHO AUDIT risk zones, Skinner DAST bands). An in-app instrument's total can
still be entered from elsewhere — an outside/imported total and an in-app
administration land in the SAME canonical series, and the preventive CTA verb
("Complete the DAST-10" vs "Enter your … score") stays data-driven off the entry
mode (#1083). Scores ride the **observation substrate** exactly like PHQ-9/GAD-7
(a biomarker-shaped reading under canonical name `AUDIT-C`/`AUDIT`/`DAST-10`,
all-null flag bands so a score can never enter the flagged-biomarker digest
push), trend like any biomarker, and a recorded score **satisfies** its
preventive **alcohol/drug-use screening** (USPSTF grade B, 2018/2020, both added
to the curated screenings dataset).

**Consumption** (per substance since #1078): one tap logs a **standard drink**
into the SAME `food_log`/`food_log_events` ledger as Nutrition's `alcohol` food
group (the group's serving is literally one standard drink — one store, two
surfaces, no parallel table), and a **nicotine** or **cannabis** use into the
dedicated non-food `substance_log` counter ledger (migration 096 — they aren't
foods, so they never pollute the nutrition ledger or the one-tap bar; units are
plain per-use counts — a cigarette/pouch/vape session or a cannabis session —
deliberately never normalized to mg across product types), each with this-week
count + a trailing 8-week trend.

**Reduction**: a user-set weekly **cap** per substance ("≤ 7 drinks/week", "≤ 10
uses/week"; 0 = a substance-free week — Dry January, a quit target) on the
existing `frequency_targets` machinery (scope_kind `substance`, migration 072 —
already substance-parameterized, so nicotine/cannabis targets were first-class
the moment the catalog grew) — CAP semantics, the inverse of every other
target's floor, so substance rows are **excluded** from the floor-semantics
progress rollup (which would otherwise nag toward MORE) and read by a dedicated
computation; progress is the calm per-substance "5 of your 7-drink weekly cap
used" / "…7-use weekly cap…" line, and a week over the cap surfaces ONE
**coaching-tier** observation per substance (hideable rollup + coaching tab —
**never** a notification, never the hero). **No gamification is a hard
contract** (the #716/#992 no-streaks law applied deliberately even though
recovery culture uses chips): no streaks, badges, milestones, or celebratory
copy — silence is the success state, pinned by a DB-tier structural-exemption
test (no `activities` rows → the milestone/streak machinery is blind to the
domain) and a finding-copy guard. A high score gets the calm "worth discussing
with a clinician" note on the surface itself — **never** wired to the crisis
surface (#996 is item-9/explicit only). The structured smoking **status**
(Health record → Background: tri-state, quit year, pack-years) stays the
separate risk-factor / screening-eligibility source of truth — pack-years is
never recomputed from the nicotine consumption log; they answer different
questions and deliberately coexist (#83/#1078). Standard per-profile grants;
non-judgmental, informational framing throughout — never a diagnosis, and
absence of a flag is not clearance.

## Health-record import

Pull immunizations, labs, and vitals straight from a MyChart “Download Summary”
(CCD/XDM), a SMART Health Card, or an Epic / Apple Health FHIR bundle; a FHIR
bundle's **Appointment** resources also import into your scheduled appointments
(they appear on the Visits page and Upcoming), and its **`ImagingStudy`**
resources + radiology **`DiagnosticReport`** narratives (the impression /
conclusion, plus any inline-text rendered report) import as first-class
structured **imaging studies** — pure deterministic parsing, no AI and no model
cost (a non-radiology `DiagnosticReport`'s conclusion is captured as its report
record's narrative; a rendered report that's only a binary or remote attachment
is recorded but never auto-fetched).

## Supplements & medications

### Doses and adherence

Schedule intake and check off each dose as **taken**, **skipped**, or clear (a
tri-state — a deliberate skip is a decision, not a missed dose), with adherence
and refill tracking. Skips are excluded from the adherence percentage and shown
as their own count, never decrement your on-hand supply, and never trigger a
missed-dose escalation; each reminder (web and Telegram) offers a **✅ take**
and a **⏭ skip** beside each dose.

### Nutrient reference values

The page checks your **stack totals against safe upper limits** — it sums the
active stack's daily dose per nutrient (across products, e.g. two magnesium
forms) and warns when a total exceeds the NIH **Tolerable Upper Intake Level
(UL)** for your age/sex ("800 mg supplemental magnesium/day — the UL is 350
mg"), respecting whether each UL is defined over _supplemental_ intake
(magnesium, niacin, folic acid) or _total_ intake from all sources (vitamin A,
D, calcium, iron). It's informational ("discuss with your clinician", never
prescriptive) and the same warning surfaces as a dismissible **Upcoming**
finding. Reference values are a baked, public-domain dataset from the NIH Office
of Dietary Supplements / National Academies DRI tables (`lib/dri.json`,
regenerated with `npm run gen:dri`). The same data drives a calm
**RDA-adequacy** read alongside the UL warnings — for a nutrient your stack
supplements _below_ its NIH **Recommended Dietary Allowance**, it notes the
share your supplements alone provide ("your supplements alone provide about 50%
of the calcium RDA") and, where a food-first source exists, links it — worded
carefully as _what your supplements contribute_, **never "you are deficient"**
(food intake is unknown, so a low supplemental share is not a shortfall), the
deliberate inverse of the definite over-UL case.

### Medication safety

The page runs **drug-interaction checking** across your active stack — because
supplements and medications live in one place, it catches the
**supplement-drug** interactions pharmacy systems miss (St. John's Wort × an
SSRI, vitamin K × warfarin, calcium/iron × levothyroxine) alongside the classic
drug-drug ones (warfarin × NSAIDs, statins × macrolides, an SSRI × an MAOI).
Each interacting pair shows a **severity-ranked** warning (major / moderate /
minor) with a one-line mechanism and a source citation, there's an inline notice
when you **add or edit** an item that would interact, and the same finding is a
dismissible **Upcoming** item — all **informational, "discuss with your
prescriber or pharmacist", never prescriptive** (absence of a flag doesn't mean
a combination is safe). A **medication monitoring-lab bridge**
(`lib/datasets/data/medication-monitoring.json`, regenerated with
`npm run gen:medication-monitoring`) turns an active drug that requires periodic
lab surveillance into a **due-retest on a med-driven cadence**: each entry
(lithium → serum level + TSH + renal, clozapine → ANC, warfarin → INR,
valproate/carbamazepine → CBC + LFTs, plus antipsychotic metabolic panels,
amiodarone, methotrexate, ACEi/ARB, metformin — matched by RxNorm ingredient)
carries its required labs, a baseline flag, and init/maintenance cadences; the
med's row shows a "Requires monitoring: …" note, and a lab whose clock has run
out surfaces as an **Upcoming** retest item that a matching result satisfies
family-aware (an eAG satisfies an HbA1c requirement) — care-tier for the
high-consequence drugs (a Telegram digest highlight), calm for the rest,
informational and cited, never prescriptive. Detection runs against a bundled,
public-domain-sourced dataset (`lib/datasets/data/drug-interactions.json`,
regenerated with `npm run gen:interactions`); to match on a stable code rather
than only the name, an item's name can be normalized to an **RxNorm** concept
(RxCUI) you **confirm** on its edit form (see **Privacy** below).

**Combination medications** are handled too: confirming a code also resolves and
caches the product's **active-ingredient** RxCUIs (so a combo like losartan/HCTZ
matches every ingredient's interactions, not nothing), and common combination
brand names (Hyzaar, Zestoretic, Vytorin, Glucovance, …) are in the
name-matching vocabulary for items without a code. Alongside drug–drug checking,
each item also carries **food–drug guidance** — the classic per-item food notes
that need no second medication (grapefruit × statins / calcium-channel blockers,
vitamin-K foods & alcohol × warfarin, dairy/minerals × tetracyclines,
fluoroquinolones & levothyroxine, tyramine foods × MAOIs, alcohol ×
metronidazole): a short line on the medication/supplement row ("Grapefruit:
avoid grapefruit juice — it raises statin blood levels"), the same notice when
you **add or edit** a matching item, and a food note folded into the
dose-reminder message. These are also **informational, never prescriptive**,
from a curated, cited, hand-maintained public-domain dataset
(`lib/food-drug-interactions.json`, keyed on RxNorm ingredient CUIs with a
name/synonym fallback).

### Scheduling and adherence patterns

The page surfaces **adherence patterns** — calm, dismissible observations over
your recent dose history that say _where_ your misses cluster and suggest a
concrete schedule tweak: a specific weekday you tend to slip ("you miss your
evening dose most Fridays — moving it earlier tends to help") or a
weekend-vs-weekday gap. Pure, threshold-based detection
(`lib/adherence-patterns.ts`) over the same taken/skipped/missed states the
adherence strip is built from; each one can be dismissed through the shared
findings bus. Each item can also carry a **schedule context** so it surfaces
only when it applies: **daily**, **pre-workout** / **post-workout** / **rest
day** (a pre-workout supplement is due on the days you _usually_ train —
inferred from your recent cadence — so its reminder can land before the session,
not only after you log it; a post-workout item waits until an actual session is
logged), or **situational** — a lightweight, non-clinical context toggle
(**Illness**, **Travel**, **High stress**, **Poor sleep**) you flip on the
**Situations** bar; a situational supplement shows only while its situation is
active, and an active **illness/injury condition** on your record suggests
turning the matching situation on so you don't toggle it twice.

Each item carries one thing you choose: its **obligation** — **Must**, **Should**,
or **May** — and everything else follows from it.

- **Must** — a miss is an incident. Reminders, plus a follow-up nudge if a dose
  goes unconfirmed.
- **Should** — a miss is a shortfall worth tracking. Reminders and adherence, but
  never chased twice.
- **May** — no expectation at all. It is never reminded and never counts as
  missed; it stays on your list and one tap away in its usual slot. This is where
  as-needed items live — a PRN painkiller and a magnesium you take when you feel
  like it are the same shape, so they are the same setting.

Marking something **May** does not hide it. It keeps its schedule as a _hint_ for
where to offer it, it still shows on Supplements & Meds, and on Upcoming it moves
into an "available when you want them" section rather than disappearing. If you
only use the app through Telegram, the daily digest carries a
**"Log other (3 for midday)"** button that opens into whatever is available right
now — so a May item is always one tap away even though it never interrupts you.

**Medications start as Must**, and moving one lower asks first, spelling out
exactly what you would be giving up ("no reminders, no escalation, no missed-dose
safety net"). Interaction, pharmacogenomic and upper-limit warnings ignore
obligation entirely — they fire the same way whether an item is a Must or a May.

The two nutrient totals treat a **May** item differently on purpose, and in each
case the cautious direction wins. An **upper-limit** warning is about risk, so a
May item counts at its full amount and the warning simply says it did ("including
as-needed items") — your obligation setting can never make an exposure look
smaller than it is. The **"% of the RDA" adequacy** note is reassurance, so the
share counts only what you have committed to taking, and anything from as-needed
items is named beside it rather than folded in. The nutrient still appears either
way; nothing goes quiet because you asked not to be nudged.

If a Must or Should supplement goes untaken for long enough, Supplements & Meds
offers a calm **"move it to May?"** suggestion with the numbers behind it, and the
same option appears as a third button on that item's own reminder — so it reaches
you even if you never open the app. It is only ever a suggestion: nothing changes
until you tap it, taking the supplement again makes it go away on its own, and the
app never suggests moving anything _up_.

Your daily digest and weekly recap lead with **what changed** rather than a bare
fraction — "Missed: magnesium (3 days) · Resumed: vitamin D (2 days)" — covering
only the things you have actually committed to. A quiet week says nothing at all;
the taken/due count stays alongside as supporting detail.

Supplements live under **Nutrition → Supplements**; medications have their own
**Medications** surface. They intentionally share one intake model so dose
history, reminders, interactions, and refill logic cannot disagree across two
stores. Cross-kind interaction and pharmacogenomic warnings render on both
surfaces.

A dose edit updates the existing dose in place so old adherence history and
in-flight reminder buttons remain valid. Removing a dose that already has logs
retires it rather than deleting it. Every confirmation snapshots the amount
taken. A retired dose, paused item, or invalid reminder action is refused with a
typed outcome rather than acknowledged optimistically. As-needed medication is
never treated as scheduled-due.

See [the supplements and medications deep dive](internals/supplements.md) for
the persistence, reminder, interaction, and safety contracts.

## Medicine cabinet

The household medicine cabinet (`/supplies`) tracks one physical bottle once. A
supplement or medication can link its refill tracking to a shared supply, moving
its current count into that pool.

Like the **Equipment** registry, the cabinet is a registry of physical objects and
is reached from the surfaces that use it rather than from the sidebar: a
**Medicine cabinet** link — showing the bottle count once you have any ("3 shared
bottles") — sits in the **Medications** and **Nutrition → Supplements** headers and
in the **Household** header, a linked item's refill section offers "See all shared
bottles", and a linked item's shared-bottle chip opens it directly. It has no
navigation row of its own; visiting it highlights **Medications** in the sidebar,
the way `/equipment` highlights **Training**.

Every linked person's confirmed dose decrements the same count using that
person's own units per dose. An adult taking two tablets and a child taking one
therefore consume three units from one bottle. Days-left estimates sum every
linked schedule, and a low bottle creates one household finding rather than one
warning per profile. Managing caregivers receive a deduplicated notification;
dismissing the finding anywhere silences that shared reminder everywhere.

Anyone with write access to at least one linked profile may edit the bottle's
name, count, notes, or refill threshold. Deleting a pool unlinks its intake
items instead of deleting them. If exactly one item remains, it can inherit the
remaining count; several items return to untracked supply so the app never
duplicates one physical count across multiple people. An unlinked bottle is
retained as **No longer linked** until a user explicitly deletes it.

## Global search and record Q&A

**Cmd/Ctrl-K** (or the sidebar's Search button) opens one command palette over
the **active profile's** data — never another profile you can reach. Typing
does three things at once: it parses an inline quick log (`weight 82.5` commits a
body-metrics entry on Enter, and `log sauna` commits a session for a practice you
track), offers create **actions** (start a workout, add a result, add a document),
and runs a debounced search across every record domain.
Arrows and Enter walk one flat list; results are grouped by domain in a fixed
order, best match first (exact beats prefix beats substring, ties broken by
recency).

Searchable domains: **biomarkers, imaging studies, genomic results, documents,
conditions, allergies, procedures, immunizations, visits, appointments,
providers, illness episodes, dental records, skin lesions, activities,
supplements and medications, protocols, wellness practices, equipment, family
history, care plan, care goals, goals** — plus every page, so the palette
doubles as a jump-to-page bar. A hit is named exactly as its own page names it
("MRI Left Knee", "Composite filling · #14"), carries the attribute that tells
near-identical rows apart (a study's date, a lesion's side and size, a
same-named provider's NPI), and lands on the most precise destination the row
supports — the record's own page where one exists, otherwise the list surface
that renders it. Some domains are entity-shaped rather than row-shaped: serial
observations of one mole are a single result, as are the spellings of one
practice, and a provider surfaces only when your own records name them (the
registry itself is shared, and browsing all of it is the Providers directory's
job). A few hits carry an inline action, so you can log a dose, mark a refill,
or complete an appointment without leaving the palette.

The inline quick log only recognizes practices you already track, and only
behind a verb — `log sauna`, `did sauna` — so typing a practice name to find it
stays a search. **Add document** answers to whichever word you have in mind
(upload, scan, lab report, a photo of a result) and opens the same upload
overlay the quick-actions menu opens, in place.

**Ask about your records** answers a natural-language question — "when did I
last take antibiotics?" — from those same rows and nothing else. The retrieval
is deterministic and profile-scoped: the app picks the matching records, then the
model may only narrate what it was handed, citing each row by number with a link.
No matching record means an honest _Nothing found in your records_ rather than a
guess, and with no AI configured the same retrieved rows are still listed as
links. Retrieval matches the words your records actually contain (including the
singular of a plural you typed), so naming the thing you are looking for works
better than naming its category.

## Undo delete

Deleting an activity, body-metrics entry, biomarker record, or
supplement/medication offers a one-tap **Undo** toast; the row (and its
children) is held for 24 hours and restored intact if you undo, then purged.

## AI activity log

Every AI call and failure is recorded to a file and streamed live under
**Settings → Logs & audit → AI logs**.

## Server error log

Unexpected server errors (an unhandled exception in a Server Action, a route
500, a crashed background task) are persisted to `data/logs/errors.jsonl` and
shown newest-first under **Settings → Logs & audit → Errors** (admin only), so a recurring
failure is visible after the fact instead of only in `docker logs`. Clients
still see a generic error; the cause lands in this log only, and the size-capped
file self-trims so a crash loop can't fill the disk.

## Audit log

A durable record of who accessed or modified which profile's data (logins
in/out, profile switches, medical-file and share-link views, document
uploads/deletes, and admin/family changes), reviewable with filters under
**Settings → Logs & audit → Audit** (admin only); identifiers only, never medical content,
retained for a configurable window (default **24 months**, set under **Settings
→ Server → Audit-log retention**; the hourly notify tick prunes older events).

## Data hub

Bring data in (upload documents, paste logs, connect a device or service) under
**Data → Import**, then see everything that has ever imported in one place under
**Data → Review**.

### Connected sources

Connected sources is an **inbox**: it lists only the recurring providers you've
actually set up, and it expands the ones that need you. A provider whose last run
failed, whose token expired or was revoked (**Needs reconnect** — a dead
connection self-marks and stops silently retrying forever, instead of looking
healthy while never syncing), whose run stopped early (**Partial sync**), or that
you connected before and later removed (**Not connected**, with its historical
logs and a **Reconnect** link) gets a card with the reason, the action —
**Sync now** for connected pull providers (Strava, Oura, Withings, Weather;
Health Connect is push-only, so its card explains the phone exporter drives it) —
and a link to its full history. Everything healthy collapses to a single line
showing the same badge and the same outcome sentence. A provider you never
configured is left out entirely.

The provider's **own page** is its home: the same status header, its
connect/disconnect/sync controls, and the full **Sync history** table — when each
run happened (absolute _and_ relative), whether it worked, what it changed, and
the window it covered where that differs from the norm. Every failed run states
its reason, not just "Failed"; a stretch of hourly runs that brought nothing new
collapses to one line; and an admin **View raw** inspects the exact provider
payload. A run that actually wrote records offers **What this wrote**, which
lists them with links; a provider that legitimately records none — Weather
refreshes a shared forecast cache, which contains no records of yours — simply
doesn't offer it, and reports its runs in its own words ("Forecast refreshed · 16
readings revised") instead of counting cache cells as if they were your data.

### Imports

Imports is the chronological one-off feed of uploaded documents + pasted/CSV
jobs, each showing what it produced and linking to its detail/verify view, with
a **Re-extract all documents** button in its header that previews the AI cost
before running (e.g. "9 health records re-imported instantly, no AI · 5
scans/PDFs — 5 AI extractions, 43 of 50 daily remaining"; an all–health-record
run has no AI cost and skips the confirmation.

An AI-extracted document also shows how many of its rows the extractor itself
was unsure about — **"· N to check"** beside the produced count — and its detail
view opens a **Check these first** card listing exactly those rows,
lowest-confidence first with the extractor's short reason ("unit could be mg/dL
or mmol/L"). It only decides what a human looks at first: every row is imported
and editable either way, nothing is auto-accepted or auto-rejected, and a
document with no such signal (a MyChart/FHIR import, or an upload extracted
without an AI key) shows neither.

### Failures and duplicates

Spanning both sections at the top are any integration that's **currently
failing**, and **possible duplicates**—a Strava run and a manual/Health Connect
run on the same day, two same-source imports of one workout (upstream
double-feeding, e.g. Strava ingesting the same session from both Garmin and
Health Connect), or two body-metric rows that would double-count, detected
across sources and resolved by **Merge**, **Keep both**, or **Dismiss** (a
group of three-plus copies collapses to one card with a keeper radio, and when
the rows disagree on a value Merge shows a per-field preview listing every
copy's value — the keeper's pre-selected — so any copy's number can win), with the
decision remembered so a later re-sync won't undo it — a device row you merge
away or delete stays gone instead of silently re-importing on the next
rolling-window sync (counted as **suppressed** in the feed split), and if a
resync ever does re-form a merged pair it resurfaces here rather than hiding —
all surfaced with a badge on the **Data** nav entry.

### Coverage and export

Track the catalog **coverage gaps** — the biomarkers/medications/conditions the
curated catalogs don't cover yet, with the track / local-AI-enrich /
de-identified-catalog-request paths — under **Data → Coverage** (#1086; moved
here from the Health record page as a catalog/data-management workflow).
Finally, browse and export everything you've logged under **Data → Manage &
Export** — the "Export all my data" download is one portable ZIP (every dataset
as JSON + CSV, the clinical passport as a FHIR bundle, and copies of your
uploaded files), captured as a consistent point-in-time snapshot; it is a
**portability artifact you can read or take elsewhere, not the restore path** —
restoring an instance uses the [server backups](backups.md) (`npm run restore`),
not this ZIP. Integrations available today are **Google Health Connect**,
**Strava**, **Oura Ring**, **Withings**, **Fitbit via Google Takeout**, and
**Weather & UV (Open-Meteo)**; Garmin remains planned.

## Emergency card (offline)

The emergency card is a terse, printable summary of the facts a first responder
needs when you can't speak for yourself: allergies (worst first), active
medications with doses, major conditions, blood type, and an emergency contact —
with an "as of" date so a reader knows how fresh it is. It lives as the
**Emergency Card section of the Passport page** (**Medical → Passport**,
`/profile#emergency`; the old `/emergency` route was removed in #1635).
It reuses the same records as the Passport, so it never disagrees with them.
Print it with the section's **Print** button — the printout is scoped to the
card alone (the passport summary above it is dropped, and the passport's own
Print button likewise drops the card).

Because the moment you most need it is often the moment you have no signal, the
card can be kept **offline**: enable **Medical → Passport**
(`/profile#emergency`) **→ "Keep an offline copy on this device"** and the card
is cached (in this browser's localStorage) on each visit while online, so it
stays readable with no network. When you're offline, the app's reconnect screen
offers a **View emergency card** button instead of dead-ending.

Offline caching is **off by default** and strictly opt-in, per profile: a cached
card is readable on that device _without logging in_ — which is the whole point
in an emergency, but also the trade-off if the phone is lost while unlocked. The
offline copy is wiped automatically on logout and when you switch profiles, and
it refreshes on your next online visit so a medication or allergy change
propagates. Set your blood type and emergency contact right there on **Medical →
Passport** (`/profile#emergency`, inline with the card) — the blood type there
overrides one derived from lab records.

## Offline quick-log queue

Logging often happens exactly where the signal doesn't: a set at a gym with dead
reception, a dose on a flight, a weigh-in during an outage. For a small set of
**idempotent quick-logs** — confirming a **dose taken** or **skipped**
(Supplements & Meds), a **body-metric** weigh-in (Trends → Body), a **vitals**
entry (Trends → Body), a daily **mood check-in** (the Dashboard "How are you
today?" card — idempotent per day, so a replay updates the day's one entry), a
**workout session** logged entirely offline (the Training editor: if the
connection is gone for the whole session, closing the editor queues the
complete workout — sets, loads, times — instead of stranding it on the device),
and the **food quick-adds** (a one-tap food-group serving or protein grams on
Nutrition) — the app no longer fails when you're offline: it **queues the entry
on your device** (in this browser's IndexedDB) and shows a "Saved offline —
will sync when you reconnect" confirmation plus a **pending badge** counting
the queued writes.

On reconnect the queue **replays automatically** — on the browser's `online`
event, on the next page load, and (on Chromium/Android, where it's supported)
via the Background Sync API even if the tab was closed. Each queued write
carries a client-generated key and the **date you captured it**, so a late sync
lands on the right day and can never double-log: replays are applied exactly
once and build on the existing per-dose/day and per-metric dedup. If your
session expired while you were away, the queue is **kept** and you're prompted
to log back in — nothing is silently dropped. If an entry can't be applied on
replay — the server rejects it, or it keeps failing after several tries — it is
**never silently discarded**: it's moved to a small **review panel** (with the
reason) so you can re-enter it, rather than the badge just decrementing under a
"synced" toast. As with the emergency card, the queue (and the review panel) are
cleared on logout and profile switch.

Everything else still needs connectivity: this is a queue for a few one-tap
logs, not a general offline mode. Forms with server-derived state (anything that
reads or computes against your existing data) stay online-only, and page
navigation while offline still shows the reconnect screen. Two nearby cases are
deliberately excluded (documented in the queue's scope): **editing a workout
that already reached the server** relies on the editor's own retrying auto-save
and local draft rather than the queue (a replayed stale edit would overwrite a
session that may have moved), and the food/protein **"−" undo taps** are
online-only (an undo is a decrement against the current total, not a captured
entry).

## App updates

When the instance is updated while you have the app open, a new build never
takes over the page you're on — your open tab keeps running the version it
loaded, with everything you've typed. Instead a small **Update ready** notice
appears at the bottom of the screen. It names the deployed change when the
server can tell the app what shipped, and it is the **only** notice for that
event: one deploy, one notice, one **Reload** button.

Nothing happens until you tap it. Dismissing the notice leaves the page alone,
and users who never tap get the new version on their next natural cold start.
When a form is holding unsaved input the notice says so rather than hiding —
the entry is kept on the device, so the reload is safe either way. Taking the
reload lands you on the new build, and nothing re-offers the update you just
took.

## Mobile shell

The responsive web app has phone-specific chrome rather than a compressed
desktop sidebar. The top bar hides while scrolling down and returns on any
upward scroll. A multi-profile **Viewing N profiles** banner travels with it so
the visible subjects remain clear.

### Quick actions

The top bar includes Search and a contextual add action. The primary action
matches the current page—food on Nutrition, a dose on Medications, weight on
Trends → Body, and activity elsewhere. Its menu opens the existing forms as
overlays for:

- food;
- a dose;
- an activity;
- measurements including weight, body fat, blood pressure, glucose, oxygen,
  temperature, sleep, HRV, and resting heart rate;
- a **wellness practice** — every practice you track, with this week's standing
  and today's count, one tap from logging a session;
- **a document** — the same upload form the Data page carries, including the
  camera input, so a lab report or a photo of an after-visit summary can be
  filed without leaving the page you were on.

Saving closes the overlay and leaves the underlying page in place. Practice and
food logging deliberately keep the overlay open — a session or a serving is
rarely the only one — while an upload closes it. Confirmation
dialogs render as bottom sheets on phones and centered dialogs on larger
screens.

### Installed-app behavior

When installed to the home screen, Allos adds pull-to-refresh, home-screen
shortcuts for common actions, and an icon badge mirroring the **Needs
attention** count. The badge reflects the last app refresh; notifications remain
responsible for proactive delivery.

The navigation drawer may show locally stored **Frequent** destinations.
Visitation history stays on the device and is not added to the health database.

Allos also registers as a share target. Sharing a PDF or document photo from
another app opens the medical-document pipeline for the active profile. The
resulting document page offers **Wrong person?** so a caregiver can reassign it.
Sharing while signed out routes through login and stores nothing before
authentication. The regular import page also exposes a camera-first paper
document picker.

### Touch and motion

Every gesture supplements a visible control:

- swipe from the left edge to open the navigation drawer;
- drag a bottom sheet down by its handle to dismiss it;
- drag a live workout down to minimize it, never to discard it;
- swipe horizontally on a single-day Timeline view to move between days.

Vertical scrolling wins over an ambiguous drag, and short or slow gestures
settle without acting. Reduced-motion mode removes finger-following animation
while preserving the resulting action.

A button showing only an icon names its action in a hover tooltip. A phone has
no hover, so every destructive icon action—delete, remove, retire—asks for
confirmation before it acts.

### Dense data on small screens

Wide biomarker and training tables become one card per row, preserving fields
that a narrow table would otherwise drop. A compact **Sort by** control replaces
sortable column headers.

Date-range chips are the primary control on Trends and Timeline. Overflow fades
indicate that the row can scroll, while custom From/To fields stay behind
**Custom…** and automatically open for a custom shared range. On Trends, a
compact context line such as **Overview · 90D** expands to the full tab, range,
saved-view, and event-overlay controls.

Starred metric tiles lead with the latest value, support touch drag reordering,
and retain menu-based move actions for keyboard users. A dragged tile or card
**translates**, it never rescales — a reorder moves an item, it does not resize
it — and the dashboard lifts the card you are carrying into a size-locked ghost
above the list. The dashboard's Customize shows compact reorder rows on a phone
and in-place cards on a wide screen. Responsive spacing and all drawer, sheet,
and toolbar animation honor the operating system's reduced-motion preference.

The proposed native companion is a separate future surface; see
[the mobile companion specification](mobile-companion-spec.md). This section
describes the shipped responsive web/PWA behavior.

## Disclaimer

The app's medical-disclaimer posture lives in ONE place — the **Disclaimer**
page at `/disclaimer`, reachable from a persistent footer link in the sidebar
(both viewports) and from the **Settings** index. It states the whole thing
plainly: informational, not medical advice; not a diagnosis; the bundled
reference datasets are a curated subset, not clinical software (a quiet screen
is never clearance); automated document extraction can be wrong; in an emergency
call your local emergency number; and your records stay on your own instance.
The canonical wording is maintained once in `lib/disclaimers.ts` and rendered
only by that page: the ~40 hand-written inline disclaimer banners that used to
drift across domain pages, and the disclaimer tails appended to
finding/notification text, were **removed** — the domain surfaces carry no
disclaimer prose at all. A pure source-scan guard
(`lib/__tests__/disclaimers.test.ts`) fails the build if a disclaimer literal
reappears anywhere under `app/`/`components/`, and pins that zero surfaces still
import the canonical module. Two things deliberately stay: the crisis-resources
line on the mental-health screening instruments (a non-dismissible safety
surface shown at the moment of need — it renders crisis _resources_, not a
disclaimer), and the point-of-action "discuss with your prescriber / pharmacist
/ clinician" clause a medication-safety finding carries as its action framing.
