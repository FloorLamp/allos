# Supplements & medications — domain deep-dive

Status: **shipped** · extracted verbatim from AGENTS.md (#597)

Pediatric product selections reuse `intake_items.product`: the form stores the
human-readable formulation label (for example,
`Children's oral suspension (160 mg / 5 mL)`) and restores its stable picker
slug when the medication is edited. The shared medication-dose formatter carries
that formulation through Today and quick-log rows, illness history/status,
Upcoming, passport/emergency views, print/share, and medication reminder text.
Selecting a different label weight band updates the saved dose amount and
recalculates the matching package volume. Migration 079 snapshots the
formulation onto each administration so history keeps what was actually used;
migration 076 records whether a historical edit adjusted current supply.
Maintainer documentation for the intake domain (`intake_items` and its
children): the shared supplement/medication model, PRN semantics, refill
tracking, the adherence-history-preserving dose-edit reconcile,
`DoseTakenOutcome`, workout-conditioned dueness, and the static-priority
decision — with the full design history and issue trail. The load-bearing
invariants are summarized in AGENTS.md.

---

**Supplements & medications.** Both live in the one `intake_items` table
(renamed from `supplements` once it held both kinds), distinguished by `kind`
(`'supplement' | 'medication'`), so the shared
dose/schedule/adherence/escalation/refill machinery serves both; medication-only
fields (`prescriber`/`pharmacy`/`rx_number`/`as_needed`) are nullable columns on
the same table. **Surfaces (#746):** the two kinds render on separate pages —
supplements on **Nutrition → Supplements** (`/nutrition?tab=supplements`, a tab
of the Food | Supplements umbrella), medications on the standalone
**Medications** page (`/medications`, Medical nav group). The former combined
intake route was removed outright (#1635) and now 404s — historical deep
links to it are not kept alive. This is a UI/route split only: one `intake_items` table, and the write
cores are shared — the kind-agnostic dose/item CRUD lives in
`app/(app)/nutrition/intake-actions.ts` (imported by both surfaces), the
medication-lifecycle actions (stop/restart/side effects) in
`app/(app)/medications/actions.ts`. **Medications-page shape (#817).** The page
is built around what's unique to meds, not a supplement-shaped lifecycle card: a
**Today panel** leads (scheduled dose check-offs via the shared
`DoseStatusControl` + PRN administration rows via the reused
`QuickLogPrnControl` — the daily-use job first), then a **safety strip**
(surface-scoped interaction/PGx warnings plus an honest curated-coverage summary
when no flags are found), then **scannable rows** (`MedicationRow` — name/dose ·
\#747 adherence + refill · course status · PRN/critical badges · next-window
chip) each linking to a per-med **`/medications/[id]` detail page** (the
clinical-record home — reuses the rich `MedicationCard` as its body; widened to
`AppRoute` by `medicationHref` per #285). (A **"From your records" bridge** once
surfaced imported prescription records (`medical_records`
category='prescription') with no matched tracked med as suggest-only "Track
this" (#560/#817). Migration 092 (#1178) consolidated every such row into the
single medication entity (`intake_items`), leaving the bridge unreachable by
construction, so it was **removed** — UI, actions, and the `med-bridge:`
suggestion generator — as an owner decision (#1270). Its only vestige:
`MED_BRIDGE_PREFIX` in `lib/medication-record-match.ts`, kept so an
already-stored `med-bridge:` dismissal row still labels/clears in the suppressed
center (#203 — dismissal rows outlive their feature); no code mints new ones.)
The form's name combobox is **medication-aware**
(`medicationCatalogNames`/`splitMedicationName` over the framework-backed
medication-descriptions dataset — `lib/medication-info.ts` accessors on
`lib/datasets/medication-descriptions.ts`, 208 generics + brands; picking a
brand splits into name+brand and seeds the RxNorm lookup / #798 prefill on the
clean generic); the supplement catalog stays out of the med form. All
Medications surfaces read one server loader
(`app/(app)/medications/med-data.ts`) so the list rows, Today panel, and detail
card are formatters over one computation. `intakeHref('medication')` stays the
kind-level `/medications` target for every deep-linker (Upcoming/Timeline/dose
reminders land on the daily list); the detail page is linked only from a list
row. Interaction warnings render only on surfaces represented by an involved
item: cross-kind findings appear on both with the same `dedupeKey`
(dismiss-once-silence-both), while PGx (#710), drug-allergy, and ototoxic notes
stay on Medications (shared `components/IntakeWarnings.tsx`); UL/RDA stack
checks stay on the Supplements tab. The `nav` gate keeps the Nutrition entry
visible for an infant profile that tracks any intake item (the Food-logging gate
applies to the Food tab only — infant supplements are real). An `as_needed`
(PRN) med is never scheduled-due (`isDueOn` returns false), so it produces no
reminders/escalation/adherence-miss — but it CAN be logged on demand (see the
per-administration ledger below). Refill tracking is opt-in per row
(`quantity_on_hand`/`qty_per_dose`): a confirmed dose (or PRN administration)
decrements on-hand supply, the page shows "≈N days left" (pure math in
`lib/refill.ts`), and the hourly tick sends a low-supply nudge deduped once per
low-supply episode (`notify_last_refill_<id>`, cleared on refill).

**The dose log is a per-ADMINISTRATION ledger (#797).** `intake_item_logs` is
one row per actual intake event with a real `recorded_at` (the intake time), not
one row per (dose, date). Scheduled adherence ("was dose D resolved on day X?")
is a DERIVED view over it — an administration exists for that dose+day. The
`UNIQUE(dose_id, date)` constraint that used to enforce one-per-day was dropped
(migration 041), so **idempotency moved from the constraint into the write
cores**: the scheduled paths (`markDoseTaken`, `markDoseSkipped`,
`setDoseStatusCore`) keep one-taken-row-per-(dose,date) via an explicit
exists-check inside their `writeTx` (BEGIN IMMEDIATE serializes the
SELECT-then-INSERT, so a double-tap/replica race no-ops), while the PRN path is
a NEW auth-blind core `logAdministration(profileId, itemId, recordedAt?)` that
ALLOWS multiples/day and carries its own double-tap guard — a short-window
(`ADMIN_DEDUP_WINDOW_SEC`) dedup on `recorded_at` proximity, so a re-tapped button
/ retried callback / double-click collapses to one row while two
genuinely-different intake times both land. `recorded_at` is user-suppliable for
retro entry ("gave it at 4pm"), bounded by the #614-style `isGivenAtAccepted`
window guard (`lib/dose-log-window.ts`, pure): not meaningfully in the future,
and its profile-local date within the dose-log window of today. "Now" is a
REQUIRED argument to that guard and to `isHistoricalDoseTimeAccepted`, and every
call site passes the clock seam's `now()` (#2031) — the guard's other half
compares against a `today()`-derived date, and a predicate reading two different
clocks refused the app's own frozen-clock timestamps for ~30 minutes a day under
e2e. Production is unchanged (the override is unset, so `now()` is real time). Each accepted,
non-duplicate administration decrements supply once. The medication detail
History section can backfill and edit a taken dose at any past date in the
recorded medication course; scheduled doses retain one-per-day semantics, PRN
doses retain multiple-administration semantics, amount and formulation are
snapshotted, and changing current supply is explicit. **Entrypoints:** the
dashboard **Log a PRN dose** atom (`quick-log-prn`) with time
offsets (now / 30m / 1h / custom time — the retro-entry home) and the Telegram
**`/dose`** command (lists the chat's active PRN meds as one-tap "💊 <med>"
buttons through the ONE chokepoint; the callback carries a dedup token and
answers from the typed `AdministrationOutcome`, never unconditionally). The
Medications page surfaces a PRN med as a Today-panel administration row + the
day's ledger on its detail page ("2 today · last 4:02pm") instead of a binary
check-off pill; a SCHEDULED med keeps the tri-state `DoseStatusControl` (in the
Today panel). Migration #2876 gives the ledger the same vocabulary as food:
`recorded_at` is the immutable tap/capture instant and `occurred_at` is the
administration instant. Existing rows preserve both meanings through the rename.

**A late Telegram confirm can be corrected in place (#2020).** A scheduled confirm
stamps `recorded_at` = the tap moment and `occurred_at` = the administration moment, so a bedtime dose confirmed at 07:00 told the PRN
redose window it was nine hours fresher than it was, and the chat had no way to say
otherwise. The rebuilt reminder now carries burst-collapsed `dosetime` chips —
`−1h · −2h · −3h` plus the 🕐 absolute-hour picker, the same model #2019 gave the food
ledger, over mutable `occurred_at`. The
correction moves the administration INSTANT only: the row's `date` is schedule-owned
(#614), so a bedtime dose corrected across midnight still counts for the day the
reminder was asking about. It does not re-run the `ADMIN_DEDUP_WINDOW_SEC` proximity
guard (that runs at insert time, and a correction may legitimately move two real
administrations together — merging one away would destroy a record of something that
was taken) and it never re-arms an escalation (#1933). Direction of safety: every
offer moves the instant EARLIER, so the computed freshness only ever shrinks. See
`docs/internals/notifications.md` for the shared chip/picker model. The passport
reads structured `kind='medication'` rows as its primary medication source, with
`medical_records` `category='prescription'` still a fallback for un-modeled
extracted prescriptions. **PRN redose notice + pediatric label dosing (#798).**
Three nullable/defaulted columns on `intake_items` — `min_interval_hours`,
`max_daily_count`, `redose_notice` (opt-in flag) — carry a per-item,
administration-armed **redose reminder** ("6h since Ibuprofen — 2 of 4 today").
The numbers are the user's OWN confirmed OTC-label values: **PRE-FILLED** from
the curated, cited `lib/prn-defaults` dataset (the `food-drug-interactions`
treatment — keyed by RxNorm ingredient CUI with a #279 name fallback;
`prnDefaultsFor`) via the med form's "Use label defaults" button, but never
applied silently — an unconfirmed/empty field means **no notice, ever** (the
liability line). The tick's `runRedoseNotices` fires the safety-tier one-shot
(see `docs/internals/notifications.md`: administration-armed, re-arms on the
next dose, suppressed at the daily max, and DELIBERATELY overnight-capable). A
day that **exceeds** the confirmed max surfaces a bus-suppressible **care-tier**
finding (`prn-max:<itemId>`, the #148 UL-warning shape per-day).
**The daily max is amount-aware (#1854, migration 140):** beside
`max_daily_count`, the med form carries a user-confirmed `max_daily_amount_mg`
(mg/day, never pre-filled), and the pure `prnDayExposure` (`lib/prn-redose.ts`)
decides the day's basis — when the mg max is confirmed and EVERY family
administration's snapshotted amount parses to a mass (`parseAmountMg`), the
counters compare summed MILLIGRAMS (3 × 800 mg Rx = 2400 mg fires a 1200 mg/day
ceiling that "3 of 6 doses" would miss, and 6 × 200 mg = 1200 mg stays calm
under a 2400 mg ceiling a 6-dose count would trip); the confirmed COUNT remains
the fallback for unparseable amounts, and with a mg max but NO count fallback
the known sum is judged as an explicit "at least" lower bound. The exposure is
computed once in `getMedicationFamilyStates` and formatted everywhere —
`prnOverMaxDetail` (the finding), `exposureFragment` (card / widget / Telegram
"N of M" line), and the redose notice's at-max suppression — so every surface
states the basis it actually used and never implies mg precision it doesn't
have. **The PRN safety counters are ingredient-FAMILY-wide (#1027):** the same active
ingredient tracked as two items (OTC ibuprofen 200 mg + Rx ibuprofen 800 mg) is
ONE family (`lib/medication-family.ts`, the #482 identity function — cached #279
ingredient CUIs first, cleaned-generic-name fallback, no resolution ⇒ own
family), and the ONE gather `getMedicationFamilyStates`
(`lib/queries/intake/prn-family.ts`) feeds every counter surface: the redose
interval clock arms from the FAMILY's latest administration (a sibling's dose
holds "Redose OK" — the false-GO fix), the day exposure totals the family
(summed mg or count per the basis above), and over-max compares it against the
most conservative confirmed ceiling among members (the finding stays keyed
`prn-max:<itemId>` on the member holding the binding max). The
per-item ONE-SHOT marker semantics are unchanged, and a member with UNCONFIRMED
fields still gets no notice of its own (the liability line stands) while its
logged administrations count into a sibling's family math — a logged dose is a
fact regardless of config. The gather is memoized on BOTH lifetimes (#2111) —
`cache()` for a render, `tickCached` for a tick (`lib/tick-cache.ts`) — because
several of those counter surfaces render together and each used to pay for the
whole gather; neither lifetime can outlive a dose confirm, which is the only
thing a memo over a safety counter may not do. Its arming-administration read is
served by `intake_item_logs(item_id, recorded_at)` (migration 156) rather than a
scan of the append-only ledger. A multi-item family also emits ONE calm coaching-tier
duplication note (`med-dup:<familyKey>`, `buildMedicationDuplicationFindings` —
never a push, never dashboard Now). **Pediatric dosing** (`lib/prn-dosing.ts`, pure)
reproduces the OTC label's **weight-BAND chart** (never a mg/kg computation)
from the profile's latest recorded weight + age: `pediatricDoseSuggestion` gates
on the ingredient's hard **age refusal** ("under 6 months — ask a doctor",
rendered as a refusal not a dose), a **weight-freshness** prompt (a stale weight
under-doses a growing child), and lands a weight BETWEEN two label bands on the
LOWER (conservative) band; the full label chart remains selectable even outside
the recorded band, selecting a band updates the saved dose, mg is canonical, and
**mL surfaces only through a user-picked formulation/concentration**. **Aspirin
structurally has NO pediatric entry** (Reye's) — the dataset omits it, pinned by
`lib/__tests__/prn-defaults.test.ts`. All pediatric framing is informational
("from the product label — confirm against your package"). **Dose edits never
destroy or rewrite adherence history:** the edit reconcile updates dose rows in
place by id (so in-flight Telegram buttons, which carry the dose id, stay
valid), **retires** (`intake_item_doses.retired = 1`) a removed dose that has
logs instead of hard-deleting it (a delete would `ON DELETE CASCADE` away its
whole taken history), and every confirm **snapshots the dose amount and
formulation onto the log** (`intake_item_logs.amount` / `product`) so history
keeps showing what was actually taken after a dosage or product change.
The retire-or-delete rule is executed by the dose-lifecycle core
(`lib/queries/intake/dose-lifecycle.ts`, #2131), registered in
`STATEFUL_WRITE_TABLES` for the `retired` column: retiring appends a schedule
version that CLOSES the dose's dueness window as of the retire day, and the
guarded inverse — `unretireDose`, surfaced as the edit form's "Retired doses →
Restore to schedule" affordance — reopens the SAME dose id (typed refusals:
`not-found` / `not-retired` / `schedule-conflict` when a live dose covers the
slot) with dueness resuming from the restore day, never retroactively.
`getIntakeDoses` is the "current schedule" read and excludes retired doses;
history reads join `intake_item_doses` directly. `markDoseTaken` returns a
`DoseTakenOutcome`
(`logged`/`already-taken`/`already-skipped`/`stale-dose`/`inactive`; an
already-resolved dose reports the status that actually stands — #280) — it
refuses retired doses and paused items — and the Telegram tap handler answers
from that outcome instead of an unconditional "Logged ✅" (a tap on a stale
button must not falsely confirm a possibly-critical medication). **The OFFLINE
queue's replay is the same tap with a longer gap (#1427)**, so it rides the same
cores (`markDoseTaken`/`markDoseSkipped`) rather than a private writer — there
is no offline-only dose write — and it answers from the same typed outcome: an
already-taken dose resolves as already-done (idempotent, one log row, one supply
decrement), while a retired dose, a paused item, the OTHER resolution already
standing, or an entry that outlived the `isDoseDateAccepted` window is
dead-lettered into the queue's review panel with its own reason instead of being
reported as synced. A replayed confirm carries the CAPTURED tap instant
(`clientTakenAt`) and stamps it as `recorded_at` — the untrusted client clock
validated by the pure `resolveQueuedTakenAt` (not future beyond
`GIVEN_AT_FUTURE_SKEW_MS`, and its profile-local date must be the log row's own
day), falling back to the replay instant when unusable, since a skewed phone
clock must cost the minute and never the dose log. The amount snapshot still
comes from the dose row at replay, per the snapshot-on-confirm rule. **Dueness
for workout-conditioned items keys on the PREDICTED training day, not "was a
workout logged" (#558):** `isDueOn` takes an optional `predictedWorkoutDay`
(from `isPredictedWorkoutDay`/`inferWorkoutSchedule` — the same cadence the
notify workout reminder uses) so a `pre_workout`/`rest_day` item surfaces before
the session (falling back to the logged signal only when no cadence can be
inferred), while `post_workout` keeps the logged-session gate and is held until
the session's end time (`isPostWorkoutReady`); the predicted signal is wired
only into the SURFACING paths (the Supplements tab / Medications page, morning
digest, Upcoming, dose reminder) — historical adherence strips keep the logged
reality, and `daily` (safety-tier meds) stays unconditional. **No dynamic
obligation ENGINE for supplements (#559 → #1505):** the user's `must/should/may`
(`IntakeObligation`) is a STATIC, user-owned declaration — never recomputed from
context. Unlike a screening/retest priority (#517), which
derives a clinical judgment the user can't encode, a supplement's importance is
the user's own explicit tag, so context only GATES dueness (`isDueOn`), it never
INVENTS obligation; the only legitimately-dynamic axis is time-urgency (a
due-but-unconfirmed time-critical dose), and that rides the EXISTING
dose/escalation lattice. Supplement `doseItems` is therefore a justified,
documented exemption on the #553 risk-layer allowlist
(`lib/__tests__/upcoming-risk-layer.test.ts`) — it is user-prioritized, not
risk-prioritized.

**Calendar cadence (#1602, migration 126).** `condition` answers "is this the
item's KIND of day?"; the cadence answers the orthogonal "is today one of its
days at all?" — weekly (`cadence_weekdays`, a CSV in the repo's 0=Sun … 6=Sat
numbering, NOT ISO), every-N-days (`cadence_interval_days` +
`cadence_anchor_date`), plus a per-dose weekday subset and an inclusive
`start_date`/`end_date` window. The pure rules live in `lib/intake-cadence.ts`
and are ANDed into the SAME gate as the condition: `isDueOn` consults
`cadenceOn`, and `doseDueOn` adds the row's own `doseOnDay`. Every surface
inherits it (#221) — nothing filters by cadence locally.

Why it exists: before it, a weekly methotrexate either nagged DAILY or had to be
demoted to `may` to shut it up, which also stripped reminders, missed-dose
escalation and adherence tracking from exactly the narrow-therapeutic drugs that
need them. The cadence lets the item stay `must` while the machinery says "not
today". `#1505` guards the wrong door; this builds the right one.

Invariants:

- **The day context carries a REQUIRED `date`** (`IntakeDayContext`). Optional,
  with a "no date ⇒ no cadence" fallback, would let a forgotten argument silently
  revert a weekly med to daily nagging — invisible in review. Required makes it a
  compile error.
- **Cadence only SUBTRACTS days.** It never invents obligation, so it can never
  make a `may` item due.
- **On a `may` item cadence is a LABEL, never a gate.** Nothing is owed on any
  day, so there is nothing to subtract from, and guaranteed access says a
  collapsed item stays one tap away — hiding it six days in seven would make an
  accepted demotion indistinguishable from a deletion.
- **Every branch FAILS OPEN.** A weekly item with no weekday, or an interval with
  no anchor, stays daily. Reminding too often is visible and correctable; a
  silent blackout is not.
- **Alternating amounts are two dose ROWS of one item** (warfarin 5 mg
  Mon/Wed/Fri + 2.5 mg the rest), each keeping its own adherence history under
  its own `dose_id`.
- **A taper is windowed rows, and an expiring window is NOT a retire.** The row
  stops being due; its logs read untouched. That is what keeps "editing a dose
  never rewrites adherence history" true by construction for a mid-course change.

## One intake form (#3216)

`components/IntakeItemForm.tsx` is the single add/edit form for both kinds. It
replaced three shells over one write path — `MedicationForm` (1,356 lines),
`SupplementForm` (703) and `QuickAddMedication` (407) — which were the #2184
drift class standing armed: every field, label and gate fixed in one had to be
remembered in two others, and only medications had a frictionless door at all.

**Name first; the kind is derived.** The form opens on one field. A pick from
the medication vocabulary or the supplement catalog sets the kind and renders it
as a correctable chip; a name in BOTH (melatonin) or in neither asks once, and
those are different questions with different copy. A shared bottle lends the
kind of the items already drawing on it — a bottle has none of its own — and one
nobody links yet falls through to the ask. A kind-locked door (`/medications`,
Nutrition → Supplements) answers it outright and offers nothing to change.
`lib/intake-kind.ts` is the whole decision; the form renders it.

**Summary-first, facts with editors.** After a pick the form renders NO editors.
It renders the facts it will save as tappable sentences — dose, timing,
importance, OTC/Rx, the rules — and one editor opens at a time behind whichever
fact you disagree with. This is not a preference: front-loading every field is
what made the OTC quick-add necessary, and a consolidation attempt during
prototyping that put every field on screen at once hit the same wall. A missing
ESSENTIAL renders as a prompt; an absent OPTIONAL renders nothing and stays
reachable behind one trailing affordance that names what it holds.
`lib/intake-facts.ts` computes the row; assertions name the fact KEYS, never the
chip copy.

**The form posts whole, structurally.** Every value is React state and every
submit serializes all of it through `lib/intake-form-fields.ts`, a pure function
that is never told which editor was open. That is #2014's hidden-not-unmounted
rule made unbreakable rather than remembered: a field whose editor was never
opened still saves its seeded value. The sub-editors (notes, escalation, refill
counts, provider) are controlled for the same reason.

**Rules are sentences over columns that already exist.** Five of them, in
`lib/intake-rules.ts`: take only when X (`condition` + `situation`), pause while
X (`pause_situation`), with food / empty stomach (the dose rows' `food_timing`),
keep N h apart from an item and take together with one (the two
`intake_item_pairs` relations). There is no rules store: delete the UI and the
data model is unchanged. The keep-apart interval has no column and #3216 forbids
adding one, so it rides in the pair's own free-text `note` in a canonical
leading form and parses back out; a note written by hand keeps its whole text.
Food timing became an item-level rule, so `DoseRowsEditor` hides its per-row
food select for this form — one field, one editor.

**Two capabilities were deliberately withdrawn from the FORM, not from the
model.** Both are decisions, not gaps.

- _Per-dose-row food timing._ The form now writes `food_timing` per ITEM, to
  every dose row. "With food in the morning, without at night" remains
  expressible in the schema and still arrives from import and from
  `supplement-suggest`, and every reader (reminders, `foodTimingCheck`,
  `intake-format`) still reads it per dose — but the form no longer mints rows
  that differ. Restoring it means giving the food sentence a per-row scope, not
  a migration.
- _Free-text notes on a keep-apart / take-together pair._ `intake_item_pairs.note`
  is no longer editable from any surface: the pairs repeater that owned that
  input (`KeepApartPairsEditor`) was deleted with the merge, and the two pair
  SENTENCES carry the other item and the interval instead. An existing note
  round-trips untouched — `parseKeepApartNote` keeps whatever text it cannot read
  as an interval — but cannot be changed or cleared by a user. This is also why
  the interval-in-the-note encoding is safe today: nobody can edit around it.

**Formulation is a derived chip row** (`lib/intake-formulations.ts`): the
ingredient's own form plus the curated pediatric products, defaulted by the
profile's age and outranked by a stored `product` so an edit reads back what was
saved. A switch re-derives the product, the redose preset and the pediatric
context line. It does NOT write the volume into the dose amount: the amount
stays milligrams and `formatMedicationDoseProduct` scales the concentration at
every display boundary.

The reason is a safety one and is worth stating exactly, because the near-miss
is harmless. `parseAmountMg` (#1854) is anchored at a leading number + mass
unit, so an **mg-leading** amount with the volume appended — `240 mg / 7.5 mL` —
reads fine. It is the LITERAL "volume-first" shape that does not: `7.5 mL
(240 mg)` and `7.5 mL` both parse to null, and `prnDayExposure` treats an
unreadable amount as a reason to abandon the milligram basis. `PrnExposureBasis`
flips from `"mg"` to `"count"`, so a confirmed mg/day ceiling silently stops
being a mg/day ceiling — on a child's liquid medicine, the one case where it
matters most, with nothing surfacing the downgrade. Storing both would also put
one datum in two columns and render the concentration twice.

**What did not change.** Same actions, no schema change. `SharedSupplyPicker`
remains the authority for linking and unlinking an EXISTING item, with its
separate-submit, one-way count-migration design untouched; the front door only
promotes the #1705 create-mode branch. #843's row parity is the merge's safety
net, extended in `lib/__action_tests__/intake-row-parity.actions.test.ts` against
a hand-transcribed copy of what the old full form posted.

**Where #846's guarantee went.** The split existed because one shared body
taught the user wrong — supplement brands and catalog dosages on a medication.
Its text-scanning guard died with the file boundary; the guarantee is now a
property of the DERIVED KIND, in `lib/intake-kind-affordances.ts`, with one call
site each for the two suggestion lists. That is stronger than the scan, which
passed for any file that avoided the words.

The facts-with-editors pattern is deliberately LOCAL to this form. #3218
extracts it once a second consumer ships — extract at the second use, not
speculatively.

## Effective-dated dose schedules (#1973)

**Each day is judged against the schedule in force on that day.** Before this, the
invariant "editing a dose must not rewrite adherence history" was implemented by a
CLAMP: `doseAdherenceSince` took the adherence lower bound from
`intake_item_doses.updated_at`, so any re-time voided every day before the edit. The
rule was honoured by throwing the history away. Erasing the past and re-judging it are
the same mistake pointed in opposite directions — a present edit deciding what was true
before it — so the clamp is gone and the history is recorded instead.

**Storage: `intake_dose_schedule_versions`** (migration 151), a child of
`intake_item_doses` carrying only the DUENESS-RELEVANT fields — `time_of_day`,
`weekdays`, `start_date`, `end_date` — plus the profile-local `effective_from` day they
took effect. Versions are HALF-OPEN (no `effective_to`; the next version closes the
previous), so a change is one append and "no gaps, no overlaps" is structural.
`UNIQUE (dose_id, effective_from)` collapses several edits on one day to that day's
final state, which is the right grain because dueness is evaluated per day.

It is a CHILD TABLE rather than effective-from/to columns on a versioned dose row
because a dose id is a stable external identity: `intake_item_logs.dose_id`,
`intake_administrations.dose_id`, live Telegram reminder keyboards and the
dose-id-keyed adherence dedupe keys all point at it. Re-minting that id on every
schedule edit would scatter a dose's logs across version rows and re-fire dismissed
findings under new keys.

Amount, food timing and sort are deliberately NOT versioned — they cannot make a day
due or not due, so **a cosmetic edit moves no adherence boundary at all**. What was
actually swallowed is already snapshotted onto the log at confirm time, which is where
that history belongs.

**Reads.** `doseScheduleAsOf` (`lib/intake-cadence.ts`) resolves the version in force on
a day, and `doseOnDay` calls it — so every surface that iterates dose rows inherits
effective-dating for free, exactly as it inherited the calendar. Two total fallbacks:
a dose with NO recorded history reads as "this row, always" (the pre-#1973 behaviour,
which is what every fixture, seed and importer row keeps), and a day before the first
version reads the EARLIEST version. That second one is deliberate — "did the dose
exist?" is a different question with a better answer already, `doseWindowSince`, which
is timezone-aware and widened by logged history because a log is proof the dose existed
on its date (#1442). The schedule resolver must never override it.

**Attaching the history costs one join per profile per request/tick** (#2066).
`withScheduleVersions` runs on every current-schedule read, and both the hourly tick and
a single page render fan `getIntakeDoses` out across several consumers, so that read
is memoized per profile with a short TTL (the `tzMemo` shape in `lib/db.ts`, for the same
three-processes-one-file reason). A dose edit and an undo restore drop the entry
in-process through `invalidateDoseScheduleVersions`; `getDoseScheduleVersions` itself is
UNMEMOIZED because the write path's backfill decision must never read a cache. There is
no lean "current schedule only" reader and there must not be one: the tick's own gather
scores each dose's adherence strip over past days, so stripping `.versions` from it would
re-introduce the retroactive re-judgment this whole feature prevents.

**The bound that remains.** `buildAdherencePatternFindings` clamps by EXISTENCE only,
the same bound the strip it summarizes uses (#221). It no longer filters at
`updated_at`, so a re-timed dose keeps its pre-edit window and its pattern survives the
edit.

**What #430 actually protected, kept.** The old clamp existed to stop the engine
re-accusing someone who had followed its own "move it earlier" advice. Erasing the
history was disproportionate; withholding the ADVICE is not. `doseSlotChangedSince`
suppresses the move suggestion when the dose's time BUCKET moved inside the window
(an 08:00 → 07:30 nudge inside Morning is not a slot change), and the days stay.

**Legacy re-times.** A dose re-timed BEFORE this shipped has no pre-edit version and its
old slot is unrecoverable — migration 151 seeds from the current row. Judging those days
by today's rule would be the exact retroactive re-accusation #430 guarded against, so
`unrecordedScheduleChangeOn` keeps the conservative clamp for precisely those doses: an
`updated_at` newer than the newest recorded version. It self-heals — the write path
records a dose's PRE-EDIT schedule before appending the new one, so the first schedule
edit after this ships gives the dose a real history and the fallback goes quiet forever.

**Writes.** `saveSupplement` appends a version only when `doseScheduleDiffers` sees a
dueness-relevant change, and new doses are seeded with a version at birth so their first
edit has something to close. The version table is APPEND-ONLY beyond the same-day
upsert: an earlier version is never rewritten, which is what makes a past day judgeable.
The schema-derived profile-delete sweep clears it automatically
(`lib/profile-delete.ts`, #2126 — the sweep runs with foreign keys OFF, so the
CASCADE would not fire), undo-delete captures it as a grandchild entity, and it
exports as the browse-only **Dose schedule history** dataset (#2129 — history
undo preserves must not be history export drops).

**Sleep attribution.** `bedtimeDoseDisposition` (#1972) keeps its fact/judgment split
untouched — a logged night renders on the log alone — but its judgment inputs are now
effective-dated: `isBedtimeDose` asks `doseBucketOn(dose, sleepDate)`. That closes the
residual #1972 named and could not fix alone, since nothing recorded a past slot: a dose
re-timed INTO the bedtime slot no longer claims earlier logs retroactively, and one
re-timed OUT of it keeps the nights it really was a bedtime dose.

- **Denominators count on-days only.** A weekly med at 1/1 is 100%, not 1/7; an
  off-day scores `"na"`. The demotion detector and the digest delta classifier
  inherit this for free, since both already treat a not-due day as transparent —
  so a sparse cadence cannot read as abandonment.
- **Refill divides by cadence density** (`cadenceDensity`), and only on the
  SCHEDULE-based rate: 12 tablets of a weekly med are ≈12 weeks, not ≈12 days.
  The history-based rate already observes the real cadence in the taken log.
- **`markDoseTaken` on an off-day still LOGS**, returning `logged-off-day`. You
  record reality (the same surfacing/ledger split a held item follows), but every
  handler names the schedule — "Logged ✅ — note: scheduled for Mondays" —
  because a bare check is how a weekly drug gets taken twice in one week.

Deliberately out of v1: rolling intervals ("72h after the LAST application" —
dueness as a function of log history is a feedback loop) and monthly-by-date.
Both slot into `cadence_kind` later with no schema churn.

**Medications follow-ups (#851).** A cluster of refinements to the shipped
Medications page + split forms. **Rx / OTC (`rx` column, migration 045):** a
medication is a prescription (`rx=1`) or over-the-counter (`rx=0`), replacing
the former hardcoded "Rx" badge — the badge now reads "Rx"/"OTC"
(`components/RxOtcBadge.tsx`, one component across row/card/detail). The flag is
**derived on backfill** (a recorded `prescriber` or `rx_number` ⇒ Rx, else OTC —
a one-shot in the migration, guarded to fire only on the fresh column add so a
later `migrate()` replay can't re-flip an edited row) and kept in sync by the
form; a supplement is always `rx=0`. The prescriber/pharmacy/Rx-number/provider
fields render **only for a prescription** (a "This is a prescription" disclosure
flips an OTC med), so an OTC ibuprofen isn't asked for a prescriber it doesn't
have. **PRN ⇒ amount-only dose (the dose-model pairing):** the PRN-interval path
and the scheduled time-slot/split-dose path are **mutually exclusive** — an
`as_needed` med carries exactly ONE amount-only dose row (no `time_of_day` slot,
no split; the redose interval owns "when"), a scheduled med keeps the slot/split
editor and no interval/max. The invariant is enforced at BOTH surfaces: the form
collapses to a single amount-only editor (`DoseRowsEditor singleAmountOnly`) and
the save action runs `collapseOnDemandDoses` (pure, `lib/intake-schedule.ts`) so
a legacy hybrid row (a PRN med with slots) collapses to its first dose's amount
on the next save — keeping that dose's id (and its administration history).
Migration-free: existing hybrid rows still render; new saves are clean.
**Age-aware guidance & prefill:** the food-drug matcher
(`matchFoodInteractions`) takes the profile's age at every call site (row
`FoodGuidance`, form notice `IntakeInteractionNotices`, dose-reminder tail
`renderWindowMessage`), and rules can carry a `minLifeStage`/`minAge` gate — the
alcohol rules gate to `adult` (`lib/life-stage.ts`
`meetsMinLifeStage`/`meetsMinAge`, unknown-age → shown, hide only on a positive
under-age match), so a child's medication card never carries "limit alcohol".
The redose interval/max prefill is age-aware too (`redoseLabelDefaults`): the
pediatric label figures for a child when the label carries them (acetaminophen
kid max 5/day vs adult 6; the pediatric blocks in
`lib/datasets/data/prn-defaults.json` gained
`minIntervalHours`/`maxDailyCount`), and a deliberate REFUSAL (no prefill) for a
child whose ingredient has no pediatric label figure — never guess below the
label's floor (#798 posture). **Administration undo (the safety-relevant
miss):** a mis-tapped PRN Log otherwise permanently decrements supply, ADVANCES
the redose window (the next real dose shows "wait 6h" off a dose never given — a
safety inversion), and counts toward the daily max. Each administration chip on
the card offers remove-with-undo;
`deleteAdministrationLog`/`restoreAdministrationLog`
(`lib/queries/intake/adherence.ts`, kind `'administration'` in `deleted_rows`,
routed through the shared `useUndoableDelete`/`undoDelete` toast) invert EVERY
side effect — supply directly (`incrementSupply` on delete, `decrementSupply` on
restore), and the window/count automatically because both are DERIVED from the
ledger rows (deleting the row recomputes them; the id-keyed
`notify_last_redose_*` marker is a harmless stale ref after a delete since ids
never recycle). **Other:** the combobox collapses to one option per med
(`medicationCatalogOptions` — `Generic (Brand, Brand)`, ≤2 brands + "…", filter
over the label, a typed brand token prefills `brand` via
`resolveMedicationPick`); reading a label BACK to its generic
(`catalogLabelGeneric`) is a lookup in the catalog that produced it, never a text
strip of the trailing parenthetical — the catalog holds generics whose own name
carries one (`Cholecalciferol (Vitamin D3)`) and only it can tell that apart from
a brand suffix (#1817); a strip is tried only when the whole string is unknown,
and only its catalog-confirmed result is accepted, so an unrecognized name comes
back WHOLE rather than truncated on a guess; "Generic" leads the brand options
(`medicationBrandOptions`); the picker's ORDER is per-profile (#1677 — see
**Picker order** below); a catalog pick auto-confirms an UNAMBIGUOUS RxNorm
top match (`dominantRxNormCandidate`, silent offline degrade, ambiguous →
manual); refill tracking is a collapsed disclosure unless already tracked; the
pediatric weight-band suggestion moved next to the Doses ("how much") section;
the Today panel uses ONE row primitive
(`components/medications/TodayMedRow.tsx`) for both scheduled check-off and PRN
administration rows (kind expressed by the control, not the container); and the
detail page carries scheduled and as-needed entries in a dated "Dose history"
roll-up (`getIntakeDoseHistory`), with an inline correction form for
recording and editing a past dose during the medication course; PRN entries may
predate and move back the recorded start date.

### Historical dose correction (#1933)

Backfilling, amending, and removing a recorded administration is **adherence
machinery**, so it is not split by kind. Until #1933 it was: the write cores
carried `s.kind = 'medication'` (backfill, delete) and `s.obligation = 'may'`
(amend), so supplements had none of it and a scheduled medication log could not
be corrected at all. `kind` decides clinical identity, not capability (#1664),
and the refusal LIED — a supplement dose came back `stale-dose`, "that dose
doesn't exist", from a core that had simply refused its kind.

The ungated cores live in `lib/queries/intake/adherence.ts`: `logHistoricalDose`,
`updateHistoricalDose`, `deleteAdministrationLog`, `restoreAdministrationLog`.
`updateHistoricalDose` is the ONE amend core (#2228): the illness-episode
timeline's dose edit routes through it too (its looser twin
`updateAdministrationLog` is deleted), it writes the stated event instant
`occurred_at` — never `recorded_at`, which is a record instant by the #2229 ruling
and read-only history for amendments — and it takes the row's `date` explicitly:
a present instant must agree with it (refusal, never silent re-dating) and a
null instant means no intake time was stated, leaving `occurred_at` NULL. The
one refusal→message mapping is `lib/historical-dose-error.ts`. The reads that
serve both kinds are named for both:
`getIntakeLogsForDate`, `getIntakeLogsInRange`, `getIntakeDoseHistory`, and the
batched `getIntakeDoseHistoryForItems`.

One panel renders it on both surfaces — `components/intake/DoseHistoryPanel.tsx`,
inline in the medication card and behind the supplement row's ⋯ "Dose history"
disclosure — over the Server Actions in
`app/(app)/nutrition/intake-actions.ts` (the kind-agnostic intake action
module), each rendering its core's typed outcome. Since #2417 that panel's ROWS
are the shared `components/EntryHistoryTable.tsx` (the ⋯ menu, the in-place edit
row, the confirm-then-undo delete), settling the debt that component's own header
had recorded: dose history was the one clone of that shape it never absorbed.

### The cross-item dose ledger (#2417)

"What did I actually take last week, across items" used to cost one navigation per
item, because dose history existed ONLY as a per-item disclosure two menus deep.
It is the same question at a wider scope, so it is the same reader and the same
renderer:

- `getIntakeDoseHistoryAll(profileId, since, { kind?, itemId?, untilDate? })`
  (`lib/queries/intake/adherence.ts`) is the third member of the dose-history read
  family — same taken-only semantics, same ordering, same profile scoping through
  the parent item, plus the item's name and kind. The JOIN is on the item's
  PROFILE only, never on `active`: **history outlives retirement**, and a dose
  taken from a bottle since paused or retired still happened. Narrowed to one item
  it returns exactly what `getIntakeDoseHistory` returns for that item over the
  same window — asserted row-for-row in
  `lib/__db_tests__/supplement-dose-history.test.ts`, which is what makes the
  ledger and the panel two views of one record rather than two answers.
- `components/intake/DoseLedgerMount.tsx` (server) mounts the shared
  event-ledger frame (`docs/internals/event-ledger.md`, #3484 part 2) and brings
  the dose-specific halves with it: `DoseLedgerRows.tsx` renders the rows on
  `EntryHistoryTable` with the SAME ⋯ Edit / Delete-with-undo over the same
  unchanged cores (columns: date · time · item · amount · product, newest
  first), and `DoseBackfillLauncher.tsx` fills the frame's backfill slot. The
  frame contributes the box — range control, chips, item filter, note, empty
  state, pager — and knows nothing about doses.
- Two routes, one component: `/nutrition/dose-history` and
  `/medications/dose-history`, each opening **pre-filtered to its own surface's
  kind** — the same kind→surface seam `intakeHref` encodes one level up, spelled
  by `doseLedgerHref` (`lib/hrefs.ts`). Both surfaces carry the one-click door
  (`components/intake/DoseLedgerLink.tsx`).
- Filters ride the URL, so a filtered ledger is a deep link and every filter
  narrows the QUERY: kind (the `all` state widens), item (every item the profile
  owns, active or not), and the shared `DateRange` vocabulary with
  `DOSE_HISTORY_DAYS` as the default window and `?range=all` as the explicit
  all-time sentinel. The pure half is `lib/dose-ledger.ts`.
- **A range is a filter; the PAGE is the bound (#2445).** "All time" is a
  legitimate answer here — history outlives retirement — so it cannot be what
  limits the read, and a `must` medication logged twice daily for years is
  thousands of rows. The surface therefore reads
  `getIntakeDoseLedgerPage(profileId, since, filters, page, HISTORY_PAGE_SIZE)`,
  a real `LIMIT`/`OFFSET` over the same statement plus the `COUNT(*)` the pager
  needs, with `?page=` riding the URL and every other control dropping it (a
  narrowed ledger re-pages from its first row). `HISTORY_PAGE_SIZE` and the page
  arithmetic are `lib/pagination.ts`, shared with the other record-history
  tables. `getIntakeDoseHistoryAll` stays for callers that genuinely want the
  whole window in one array, and as the row-for-row cross-check against the
  per-item panel — but nothing that RENDERS the ledger uses it.
- **"Log past dose" is a top-level entry** on the ledger — the same
  `HistoricalDoseForm` with an item picker in front, which opens on the item the
  ledger is filtered to. The per-item panel keeps its own entry: an item-scoped
  question stays answerable on the item.
- Cross-linked with the Trends → Nutrition **Dose history** chart (#2415) both
  ways: the ledger links to the chart, and a tapped day in that chart's day panel
  links back to the ledger filtered to that day (`dayLink` on the `dose` entry of
  `DAY_HISTORY_DOMAINS`).

What "everything editable" carries:

- **The course window is a data question, not a kind question.** It binds an item
  that HAS `medication_courses` rows; a supplement has none, so there is no
  course for its history to fall outside of (`itemHasCourses`).
- **Supply is counter-like.** A backfill's optional decrement, the delete's
  re-credit, and the restore's re-decrement all run through the shared
  `decrementSupply`/`incrementSupply`, so a pooled item (#1374) moves the
  household bottle. Amending a time or an amount moves nothing: the counter is in
  UNITS (`qty_per_dose`) and `amount` is a snapshotted label, so the diff is zero
  and applying one would be a second, invented movement.
- **Retired doses and paused items stay editable.** `d.retired = 0` is right for
  CREATING a backfill (it puts a dose back on the schedule) and wrong for editing
  an existing row: the schedule was retired, the history is still real.
- **A log edit never writes the schedule.** `intake_item_doses` is read-only on
  every one of these paths.
- **No re-arm.** Any write that un-marks a dose for a day — a delete, or an edit
  that moves the row to another date — stamps that day's escalation marker
  (`escalationMarkerKey`, #328), so a retroactive correction can never resurrect
  a missed-dose push. The attention doctrine's contact-consent rule is
  asymmetric; this is the direction it forbids. Suppression is per-DATE, so a
  correction to an older day cannot silence a genuine miss today, and the restore
  deliberately does not clear the marker.
- **Audited.** Tapping today's check-off is ordinary use. Retroactively rewriting
  what the record says was given is clinically significant — especially where a
  caregiver amends a dose somebody else gave — so the action boundary records
  `dose-log.backfill` / `dose-log.amend` / `dose-log.delete` (identifiers and the
  affected date only, never the amount or the name).

**Pre-workout send timing (#1154 Fix A).** `pre_workout` is a day condition; its
SEND slot is workout-relative when the dose's bucket is `anytime` and a cadence
is inferable: the PreWorkout pseudo-slot fires one hour before
`inferWorkoutSchedule().hour` (`doseSendSlot`/`preWorkoutSlotHour`). An explicit
bucket is honored; no cadence keeps the fold-to-Morning fallback. A dose is in
the pseudo-slot XOR its bucket window. Escalation chases the pseudo-slot like a
window.

**The obligation model (#1505).** One user-owned field, `obligation`, replaced
BOTH `priority` (mandatory/high/low) and `as_needed`. Migration 124 rebuilds
`intake_items`: `as_needed = 1 → may` (first, so a formerly as-needed row lands on may whatever
tag it carried), then `mandatory → must`, `low → may`, everything else `should`.

| Obligation | Meaning                       | Push                            | Adherence                                            |
| ---------- | ----------------------------- | ------------------------------- | ---------------------------------------------------- |
| `must`     | a miss is an incident         | remind + missed-dose escalation | counted, escalated                                   |
| `should`   | a miss is a tracked shortfall | remind, never escalate          | counted                                              |
| `may`      | there is no expectation       | never pushed                    | **no dueness, no misses, no fraction** — ledger only |

Three predicates in `lib/intake-schedule.ts` are the whole of the semantics —
`isPushedIntake`, `accruesMisses`, `escalatesOnMiss` — plus `isOnDemand`, the generic
name for `may` across both kinds. PRN remains a medication-specific dose-limit and
redosing policy (#798/#1027); an optional supplement is simply on demand. They are
deliberately separate
functions: `should` reminds but never escalates, which the old two-value model
could not express.

**`kind` stopped deciding pushability.** It keeps clinical identity — which safety
engine (interactions #144 / PGx #710 vs supplement ULs #148), which surface
(`/medications` vs the supplements tab), passport inclusion, prescription/refill
semantics — and obligation decides push. The guardrail that makes that safe:
**medications default to `must`**, and moving one below must requires an explicit
consequence-stating confirm at the form boundary ("no reminders, no escalation, no
missed-dose safety net"), asked on the transition only. Demotion suggestions never
target medications.

**A slot on a `may` item survives as an ACCESS HINT.** `time_of_day` stops meaning
"due then" and starts meaning "offer it here": `slotHintBucket` /
`slotHintCoversNow` are that reading, and `isOfferedOn` is dueness's twin for the
offer surfaces (both share `conditionAppliesOn`, so offers and dues can't drift on
the day rule). Magnesium is may + a bedtime hint; aspirin is may with no hint and
is always available.

**Surfaces, derived from obligation.**

- _System-initiated sends_: must → remind + escalate; should → remind; may → never.
  An all-may slot sends nothing (pinned). Refill nudges follow the same rule, and a
  pooled bottle nudges only while any must/should member remains (`poolPushes`).
- _Rendered aggregates — collapsed, never removed_: `collectUpcoming`'s `doseItems`
  is must+should only (isDueOn short-circuits `may`), and `offeredItems` gathers the
  may items on offer today into Upcoming's collapsed **available** disclosure. The
  dashboard placement and the #1504 count read the due list; availability is deliberately outside
  the page total. Demotion is therefore a visible MOVE, not a disappearance.
- _User-initiated LOGGING — dueness gates nudging, never logging_ (#2419). Every
  ACTIVE, unpaused item renders its one-tap log control on
  the web, whatever its dueness says: `EditableSupplementRow` gates
  `DoseStatusControl` on the item's state and the row's DAY (a past day stays
  read-only, showing its recorded outcome), not on `due`, so a `may` item, an
  off-cadence row and a situation-inactive one are all one tap away from the
  collapsed "More supplements" section. A situationally HELD row (#1296) is active
  too, so it keeps the control: a hold suppresses dueness, and if the dose was taken
  anyway that is precisely the fact a hold wants on the record. `offeredItems`
  carries the item's FIRST
  ACTIVE dose so Upcoming's "Available to log" rows render the same
  `RowAction` "Mark taken" chip the due rows use. Still ONE row per item — collapse
  is presentation, not data loss — and a multi-dose item logs its first active dose's
  amount. The logged day is TODAY: a tap says "I took this now", never that the item
  was scheduled. Before this, both collapsed surfaces were look-but-don't-log, and
  taking a situation-bound item meant flipping its situation ACTIVE first, purely to
  make a button exist — corrupting one's own data to use the app. Three things the
  tap does NOT do, each pinned by a test: it creates no expectation (adherence is
  computed from dueness, so a taken row on a non-due day scores `na` and no miss,
  streak or rate moves), it is not a lifecycle write (no situation row and no dated
  transition changes), and it pushes nothing new anywhere. The write is the shared
  `setDoseStatusCore` / `markDoseTaken` core, whose refusals are retired-dose and
  paused-item — never dueness — so the optimistic ledger, the offline queue and the
  honest refusal wording all come along unchanged.
- _User-initiated access — always reachable_: the Supplements page and quick-log in
  app; on Telegram the **guaranteed** path is the daily digest's
  "➕ Doses (N)" tail (its first inline button), which expands IN PLACE
  into one-tap log buttons for the may items whose hint covers **now** — evaluated
  at TAP time,
  never at message-build time, because a morning digest may be tapped at bedtime.
  The tick relabels the collapsed tail at each slot boundary and strips it at day
  rollover; both are keyboard edits, which do not notify. `buildDigest` may return
  a **tail-only** message rather than null while may items exist, so an all-may
  regimen keeps its access path. A slot reminder that fires anyway carries the same
  control as a ride-along, labelled **"Log other (N)"** there — it already shows
  "✅ All (N)" over the doses that are due, and two bare dose counts on one keyboard
  would be two numbers that cannot be added up. Web Push / Home Assistant get a `+N available` text tail,
  since neither can expand a keyboard.

**Button labels take a curated short name.** An inline keyboard button has a hard
width budget the Telegram client enforces by cutting labels mid-word, so the
one-tap surfaces label items through `lib/intake-short-name.ts` — a hand-curated
map from intake item names to short display forms ("Vitamin D3 + K2" → "D3+K2",
"Coenzyme Q10" → "CoQ10"), matched case-/whitespace-/separator-insensitively.
Curated, never derived: an unknown name passes through WHOLE rather than being
truncated on a guess (the #1817 lookup-not-strip posture). A MEDICATION is
never shortened at all — `intakeItemShortLabel` gates on `kind` explicitly,
because the map's supplement vocabulary contains names that are also drugs
(ergocalciferol, magnesium citrate) and a shortened drug name is a misread
risk; the medications-only `/dose` list applies no shortening for the same
reason. Applied at the COMPACT CONTROL label boundary only (dose-reminder take
buttons, post-workout finish, the digest offer tail, the `/dose` list,
household-round confirms, and the in-app quick-log dose chip); body lines, toasts
and in-app row content keep the full name — the full name is the record, the short
name is a control label. When the map misses,
`intakeItemShortLabel` falls back to a SUPPLEMENT's own `product` when it is
genuinely shorter than the name — the "name carries the composition, product
carries the product identity" convention (name "Astaxanthin/Lutein/Zeaxanthin",
product "Eye Health+"); a medication's `product` is a formulation label already
rendered beside the dose and never substitutes. Two rules for
entries, pinned by `lib/__tests__/intake-short-name.test.ts`: a short form must
be recognizable on its own (no bare "C" for Vitamin C), and two distinct
substances must never collapse onto one short name (the K2 forms keep
MK-4/MK-7), while aliases of one substance (Ubiquinone / Coenzyme Q10)
deliberately share one.

**Safety stays obligation-BLIND, pinned.** Missed-dose escalation reads the
deliberately unfiltered gather (the send floor is applied at assembly, never at the
gather), and the interaction / PGx / UL warnings fire identically for a `may`
member. Adherence fractions re-scope to must+should for free — a `may` item has no
occurrences, so it cannot drag an honest number down.

**One stored obligation.** Migration `20260814-remove-legacy-schema-shells` removed
the retired `priority` / `as_needed` columns and their replay-only trigger after the
test harness moved to the production ledger-gated startup path. Current storage has
only `obligation`; historical migrations remain immutable and run only while their
historical schema is current.

**Adherence-based demotion SUGGESTIONS (#1505 part 2).** A `must`/`should`
SUPPLEMENT taken on ≤25% of its scheduled days over 30 days (≥10 occurrences)
becomes a demotion candidate — pure detection in `lib/supplement-demotion.ts` over
the ONE shared item-level gather `getIntakeHistory` (`lib/intake-history.ts`), the
same evidence the digest deltas read. It surfaces as a calm COACHING-tier finding
under the registered `demote-obligation:` prefix on the Supplements page, and as a
third button (**Take / Skip / ⤓ May**) on the item's own slot reminder — riding a
send that exists for its own reasons, never generating one.

The reminder button is governed **solely by detection state**: a page dismissal
hides the card only, because for a tap-only user that button is the only escape
hatch that ever reaches them. Accepting is the only write — `demoteIntakeObligation`
(`lib/intake-obligation-write.ts`) is a compare-and-swap returning a typed outcome
(`demoted` / `already-may` / `inactive` / `not-found`) that both surfaces render
rather than assuming success. Recovery clears the candidate; demotion is
downward-only, permanently (no promotion suggestions).

**The unconfirmed imported MEDICATION escape hatch (#2574).** The demotion detector
above exempts medications entirely, and correctly: poor med adherence is a missed-dose
escalation concern, never an obligation question. The consequence was that a medication
genuinely STOPPED became indistinguishable from one badly adhered to — a course
prescribed during an acute illness, imported from a CCD that never marked it
discontinued, reminds at `must` every morning forever.

The signal that separates them is not adherence, it is **provenance plus silence**:

> `kind = medication` AND `source = 'extracted'` AND **zero lifetime logs** AND ≥10
> scheduled occurrences in the trailing 30 days.

Pure detection in `lib/medication-unconfirmed.ts` over the SAME `getIntakeHistory`
gather, plus one lifetime read (`getEverLoggedItemIds`) — the strip is windowed by
construction and the claim is that nothing has _ever_ happened. It produces no
`Finding`: no dedupe key, no suppression bus, no registry entry, no send. It sets a
per-dose flag and puts a **🏁 Stop** button beside Take and Skip on the reminder that
was already going out.

- **Disjoint from `demotable` by construction** — that detector refuses medications and
  this one requires one — so a row gains at most one extra button, asserted over the
  cross product rather than assumed.
- **One tap performs the STOP**, through `stopMedicationCourses`, the same core the web
  Stop dialog calls. No second write path, no demotion to `may` (which would assert
  "available, take when you want" about a course that ended), and no deep link (which
  is the two-step journey the person could already make). The web action's eager
  refill-marker clear is NOT copied: it lives in the action rather than the core and is
  an optimisation for a same-session Stop→Restart, while `planRefillNudges`' #325
  self-healing sweep is the authoritative drop on the next tick.
- **The tap RE-DERIVES the offer before it writes.** A button that sat in a chat while
  a dose was taken, skipped, or the med was stopped from the web answers `withdrawn`
  and changes nothing. That is what makes "never on a medication with any engagement
  history" true of the TAP and not merely of the render.
- **Typed outcomes are rendered**, never an unconditional success
  (`stopped` / `already-stopped` / `synced` / `not-found` / `withdrawn`).
- **`stop_reason` is `other`** — the button collects none — and the reply says where to
  name a real one. A callback answer is a plain-text toast, so the pointer is words
  rather than a link; the reminder's own body never mentions the button, which is the
  #1718 rule for Web Push and Home Assistant.
- **Restart is the undo**, opening a new course dated today rather than reopening the
  old one, so a mis-tap costs one tap and rewrites no history.

A weekly medication never reaches the occurrence floor and never gets the button. That
is the conservative direction and the only one a safety-adjacent offer may err in.

**Digests report DELTAS, not a fraction (#1505 part 3).** `lib/intake-deltas.ts`
classifies the must+should ledger into **notably missed** (a taken-streak of ≥3
occurrences just broken) and **resumed** (taken again after a miss run of ≥2), over
a 14-day window nested strictly inside the demotion window so the two engines can't
fire off the same evidence (test-pinned). `intakeDeltaLine` is the ONE formatter and
`getIntakeDeltaLine` the ONE server entry point; the Telegram morning digest, the
weekly recap (and so the dashboard recap atoms) and the Household card all render
that single result. Quiet windows produce no line; the fraction — now over must+should
only — demotes to secondary detail. A caller reporting on a MULTI-DAY window (the
weekly recap) passes that window, and a single-occurrence miss then names its day
("Missed: Coenzyme Q10 on Wednesday"; a `Mon, Aug 4`-style date when the miss
precedes the window) — resolved inside the formatter as a function of the window,
never a per-caller flag (#3033). The day-scale callers pass nothing and keep the
run-length copy.

See [the attention doctrine](findings.md#the-attention-doctrine) for the general
rules this change is the first implementation of.

**Derived situations — the pattern (#1292 Poor sleep, #1298 Period).** A
_situation_ a `situational` item keys on (`lib/situations.ts`) can be
**DERIVED** from the profile's own data rather than a manual chip — the #558
discipline (context is COMPUTED, surfacing-paths-only, no user toggle, no
machine-written `situations` row) applied to two contexts. The pure rules +
formatters live in `lib/derived-situations.ts`; the DB gather is
`lib/queries/derived-situations.ts`, whose
`getEffectiveActiveSituations(profileId, date)` is the ONE seam every dueness
surface (Supplements bar, Medications, check-in count, Upcoming, notify tick,
digest) unions in — declared ∪ derived — so an item keyed to a derived situation
goes due exactly while that context holds. Two tenants today:

- **Poor sleep (#1292)** = declared (the Poor sleep situation toggled —
  self-report / no-wearable) **OR** derived-measured (last night vs baseline
  trips the SAME `measureRoughNight` threshold the coaching engine's rest-sleep
  trigger uses — extracted so coaching and dueness can never disagree, and a
  _declared_ rough night now also tilts `restRecommendation` with basis-aware
  copy, `poorSleepDeclared` on `CoachingInput`). **On-with-override:** the
  visible state line carries a one-tap **"Not today"** that suppresses ONLY the
  DERIVED contribution for that date (a date-scoped `poor-sleep-override:<date>`
  row on the shared bus, prefix registered in `lib/rule-finding-prefixes.ts`; a
  declared toggle is cleared by its chip, never the override). The dueness
  override and the coaching card's #39 snooze stay INDEPENDENT (#449).
  Missing/stale sleep or no baseline ⇒ derived OFF (never a guess).
  `roughNightVerdict` — the USER WINS over the data (a declared night reports
  basis `declared`).
- **Period (#1298)** = a LOGGED menses day (`periodOnDate` covers today —
  factual, non-predictive, menses only; phase-level keying is deliberately
  deferred) **OR** a declared fallback toggle. Gated on the SAME `cycle`
  relevance bit the nav uses (`withPeriodOption`) — a profile that doesn't track
  cycles never sees the built-in Period situation. **No override needed** — the
  period log IS the control (editing/ending the log is the override). Coaching
  stays out of the Period CATEGORY (phase/menses-based training advice is
  scientifically contested — the no-fake-science stance); the day's reported
  symptom burden is the #1300 lever, not Period membership.

- **Weather (#1726)** — five built-ins (`Heatwave`, `Cold snap`,
  `Pressure swing`, `High pollen`, `Poor air quality`), derived from the cached
  daily weather series for the profile's home location (`weather_days`,
  migration 129; pure predicates in `lib/weather-situations.ts`, gather in
  `lib/queries/weather-situations.ts`). Unlike the other two there is **no
  declared/derived split**: weather has no self-report fallback — either the
  cached series says the day qualified or the app claims nothing. Every predicate
  is HYSTERETIC (enter high, exit lower) and the duration ones need consecutive
  qualifying days, so a borderline series can't flap the context on and off; a
  GAP in the series breaks every run (no data ⇒ no situation). The series handed
  to the predicates ends TODAY, so the forecast tail the cache also holds can
  never activate a situation ahead of time. **Relevance-gated** like Period, one
  gate wider (`withWeatherSituationOptions`): a home location, plus either an
  item already keyed to a weather situation or a recently logged symptom these
  situations could explain. The five join the item form's PICKER when relevant —
  never the toggle chip row, because a derived situation has nothing to toggle.
  **The impact exception:** `situation_events` stays declared-only, but weather
  situations still yield #1297 impact cards, because the rule's reason (a per-day
  verdict leaves no reconstructable span) doesn't apply — a heatwave IS a run of
  days in a cached series, recomputed identically every time, so
  `weatherSituationWindows` derives its windows from the predicate and still
  writes nothing.

The visible state lines (`getDerivedSituationLines` →
`poorSleepStateLine`/`periodStateLine`/`weatherSituationStateLine`, basis-aware)
render on the Supplements
bar (distinct "Auto" tag, non-toggleable), the #1221 check-in Context
disclosure, and the morning digest — ONE formatter so a Telegram-first user
isn't surprised by the extra due items (#662/#221). The item form shows a
discovery hint when a `situational` item is keyed to Poor sleep / Period ("goes
live automatically on rough nights / logged period days"). Deliberately out of
scope: derived chart annotations (`situation_events` stays declared-only — the
weather impact cards read their windows from the cache, not from the log) and
any Travel derivation (no privacy-acceptable signal — Travel stays fully
manual).

**Pause-during-situation — the inverse situational hold (#1296/#1299).**
`intake_items.situation_id` (migration 029) turns an item ON while a situation
is active; **`pause_situation_id`** (migration 108, its mirror, same single-link
FK shape) HOLDS an item while a situation is active — the inverse the real cases
need (Pre-surgery stops fish oil / vitamin E / blood-thinning supplements; a
fasting day skips with-food doses; "hold this while on antibiotics"). It is
INDEPENDENT of `condition`: a plain `daily` medication can be held during
Pre-surgery, so the form's "Pause during…" picker is always available (beside
"Only during…", over the same #1177 `situation-options` vocabulary), and
`getIntakeItems`/`getMedication` COALESCE the linked row's name into
`pause_situation` (a second `situations` join). **Held BEATS due** — one pure
decision, `heldBySituation` in `lib/intake-schedule.ts`, consulted at the
TOP of `isDueOn` (before PRN/condition), so a held item is suppressed on EVERY
surfacing path the same engine already feeds (Upcoming, dose strips, reminders,
digest, escalation) without a second lookup: the active-situations set `isDueOn`
already reads carries the pause situation's state, and an item carrying BOTH
links (on-during A, paused-during B, both active) is held. **Composes with the
derived-situations union (#1360):** the surfaces feed `isDueOn` (and the Held
split / digest held-count) the `getEffectiveActiveSituations` set (declared ∪
derived), so a pause reads the SAME union the on-condition does — a declared
surgery hold and a derived poor-sleep flow through together, and a pause link
naming a derived context ("Poor sleep") holds exactly while that context is
active (the link still targets a `situations` ROW — the name-keyed
`heldBySituation` matches the derived NAME the union adds). Surfacing-only
(#558): `markDoseTaken` still accepts a held item — the hold gates SURFACING,
never the ledger. **Visible, never silently absent:** held items render in their
own "Held — <situation> active" section (Supplements tab) / row badge
(Medications, `heldBy`), and the morning digest counts them ("N items held by
<situation>", `heldSummaryLine`), so a forgotten-active pause situation is
discoverable. **Safety tier:** a held day produces no due dose, so **missed-dose
escalation never fires for a held dose** (nothing to miss) — and it resumes
automatically the moment the situation deactivates (the escalation net reads the
same `isDueOn`), so a pause is NOT a #449 bus dismissal (which would be
safety-ungated) but a deliberate, reversible hold; linking a pause on a
MEDICATION or a `mandatory` item warrants a confirm at link time
(`pauseLinkNeedsConfirm`). **Adherence honesty:** held days score `"na"` (out of
denominator) in `supplementAdherenceStrip` automatically — `isDueOn` returns
false for the held day against that day's situation history (#654) — so a week
of pre-surgery holds doesn't crater the percentage; refill projections,
history-based, see no consumption on held days. **The producer (#1299):** two
built-in situations, **"Pre-surgery"** (pause-shaped) and **"Post-op"**
(on-shaped), suggested — NEVER derived-auto — by a curated surgical-keyword
bridge (`lib/surgery-bridge.ts`: `SURGERY_KEYWORDS` +
`-ectomy/-otomy/-ostomy/-plasty/-oscopy` suffix forms, minus a negative
"consultation/follow-up" veto) matched against a profile's still-scheduled
appointment titles. Inside the lead window (default 7 days before the date) the
chip offers "Surgery scheduled <date> — activate Pre-surgery? N items will be
held" (the held-count reads the ACTUAL #1296 links); after the date passes it
offers "clear Pre-surgery (N items resume)? / Activate Post-op?" — one confirm
each, nothing auto-clears (a postponed surgery must not silently resume held
blood-thinners). Suggestions are DERIVED from current appointments so a
deleted/rescheduled visit re-dates or drops the chip, and dismissed
per-procedure on the shared bus (`surgery-bridge:<phase>:<visitId>`, registered
in `lib/suppression-display.ts` — a suggestion, not a rule-finding builder, so
it resolves against the display registry, not `RULE_FINDING_PREFIXES`).

**Shared supply pools — the household medicine cabinet (#1374, migration 112).**
The intake model assumed every bottle belongs to one person: supply is per-item
(`intake_items.quantity_on_hand`), so a family's shared ibuprofen was either
tracked on ONE profile (nobody else's doses decremented it) or duplicated per
profile (phantom double supply, N low-stock alerts for one bottle).
**`shared_supplies`** is the fix — a household-shared entity deliberately NOT
profile-owned (the `providers` precedent: a family sees one "Quest Diagnostics";
a family owns one bottle), carrying name/strength/form, `quantity_on_hand`, a
per-pool `low_supply_days` threshold and notes; it joins the profile-scoping
test's global-tables exemption with a justification.
**`intake_items.supply_id`** is the nullable `REFERENCES` link — an item links
to at most one pool, and an UNLINKED item keeps today's private per-item supply,
so nothing changes for anyone until a bottle is explicitly shared. There is
deliberately **no `qty_per_dose` on the pool**: how many units ONE dose consumes
is a property of the TAKER (an adult takes 2 tablets where a child takes 1), so
each linked item keeps its own and draws that many units.

**Accounting rides the ONE existing write core.**
`decrementSupply`/`incrementSupply` (`lib/queries/intake/refill.ts`) are the
single place either adjustment is written; they now resolve the item's
`supply_id` (profile-scoped) and land on the POOL when it is set. Every dose-log
path therefore becomes pool-aware with **no second decrement path**: the page
tri-state (`setDoseStatusCore`), `markDoseTaken` (dashboard atom, Upcoming, the
household cockpit's cross-profile confirm, Telegram taps), `logAdministration`
(PRN quick-log, `/dose`), the historical-dose backfill, the offline replay, and
the administration undo/restore inverse. `refillSupply` (the one-tap "Refilled")
tops up the pool, while `last_fill_size` stays on the ITEM ("I buy the 90-count
bottle" is a fact about how one person restocks).

**One core owns every `intake_item_logs` transition (#2039).** The three scheduled
paths above are ONE function in `lib/queries/intake/adherence.ts` differing by a
single flag: the one-way resolvers (`markDoseTaken` / `markDoseSkipped` — Telegram,
offline replay, dashboard, household) short-circuit on ANY existing row and report
its ACTUAL status, while the explicit web set (`setDoseStatusCore`) may flip or
clear because the user is looking at the control. Until #2039 the tri-state was a
second core living in `app/(app)/nutrition/intake-actions.ts`, and it had
drifted: it never refused a PAUSED item, so the one contract `markDoseTaken` exists
to state held on the Telegram path and not on the web one. The Server Action is now
a thin authorization + validation boundary that renders the core's typed outcome
instead of confirming unconditionally, `intake_item_logs` is a registered gated
table so the scan fails the next parallel core, and the supply crossing reads the
ledger row's own `supply_adjusted` — clearing a deliberately unadjusted historical
row hands back nothing.

Both counters are registered gated tables (`STATEFUL_WRITE_TABLES`, #1893):
outside `refill.ts` and `supply-pool.ts` no module may write `quantity_on_hand`
on `intake_items` or `shared_supplies`, so a fourth write path can't reappear
and clobber a concurrent taker's decrement. The item FORM's absolute write is a
reviewed allowlist entry — it is the #467 compare-and-set over the
`quantity_on_hand_loaded` snapshot, not a blind clobber. The gate is
column-narrowed, so name/dose/cadence edits stay ordinary last-write-wins form
writes. See [stateful affordances](./stateful-affordances.md).

A refill is **additive**, so the one-tap affordance is deliberately not gated:
two bottles is a legitimate restock and blocking the second tap would refuse a
real write. Instead it carries the #798 informational treatment — for
`REFILL_RECENCY_WINDOW_MS` after a successful tap it shows
"Refilled just now (+90)" beside a button that stays fully enabled
(`refillRecencyLine`, `lib/refill-recency.ts`). `refillMedication` returns the
core's own `fillSize`/`newQuantity` so the one-tap path — where the size came
from `last_fill_size`, not the form — can name what it actually added.

**Linking clears the item's private count** — keeping a second count IS the
phantom-double-supply bug —
which also means a pooled item drops out of the per-item refill candidate set
(`quantity_on_hand != null`) by construction, so one bottle can never surface
twice.

**Pooled projection + the #467 CAS at pool level.** `daysOfSupplyForPool` (pure,
`lib/refill.ts`) feeds the SAME `daysOfSupplyLeft` engine the per-item path
uses, with `pooledUnitsPerDay` summing each linked item's own
`dosesPerDay × qtyPerDose`. Rates stay **per-profile-composed** — the #38 basis
decision (actual taken-log vs scheduled estimate) is evaluated in each member's
own context via `getRefillRates(profileId)`, never in another member's, and only
then summed. The compare-and-set moved to the pool: `updateSharedSupply`
re-reads `quantity_on_hand` under the IMMEDIATE write lock and routes the
submitted/loaded pair through `resolveOnHandWrite`, which matters MORE than
before because the concurrent-writer set is now every linked member's confirms
plus the poll sidecar.

**One bottle, one alert.** `runPoolRefills` (`lib/notifications/supply-pool.ts`)
runs **once per tick, globally** — deliberately NOT inside the per-profile loop,
which is what would produce N notifications. Its episode marker
`notify_last_pool_refill_<poolId>` lives in the GLOBAL settings tier (a pool has
no owning profile) with the same once-per-episode + self-healing-clear (#325)
semantics as `planRefillNudges`, which it reuses directly. Delivery rides the
login-scoped fan-out (#1072): `planPoolDispatchProfiles` (pure) walks the linked
profiles and keeps only those reaching a managing login no earlier dispatch
reached, so the ordinary household (one caregiver over both kids) gets exactly
ONE message while a split-caregiver household still reaches both people once
each. Timing is held to the WAKING WINDOW of the pool's earliest linked profile
(#378). In-app, the finding is keyed `pool-refill:<poolId>` on every linked
member's Upcoming — registered in `lib/suppression-display.ts` beside `refill:`
and NOT in `RULE_FINDING_REGISTRY`, for the same reason `refill:` isn't (an
Upcoming GENERATOR key, not a rule-findings builder output; the surgery-bridge
precedent). **Dismissal semantics:** per-viewer in-app (the bus table is
profile-scoped, so each member clears their own row), pool-wide on the push (ANY
linked member's active suppression freezes the episode — "I ordered it" is a
fact about the bottle, not the viewer).

**Permissions + row-ops.** Pool edits (quantity/threshold/rename/delete) gate on
MEMBERSHIP: write access to **≥1** linked profile (`requirePoolWriteAccess`,
reachability-checked FIRST since `accessForProfile` returns "write" for a
profile a member was never granted); an orphaned pool falls back to the ordinary
active-profile gate. Link/unlink follows the ITEM's own profile. Deleting a pool
carries its side-state: links are nulled (the FK carries no ON DELETE action by
design), the remaining count returns per `resolvePoolUnlinkRestore` (a **sole**
linked item takes it back — unambiguous, invents nothing; **two or more** return
to untracked rather than copying one bottle N times), and the pool's episode
marker plus every linked member's `pool-refill:` suppression row are swept. A
pool whose last item unlinks or is deleted is **orphaned, never destroyed** —
surfaced in the cabinet as "no longer linked" with a delete offer. The undo
ledger reconciles `supply_id` as an external ref (`onMissing: "null"`, global),
so an item captured while pooled restores untracked instead of aborting on a
dead FK (#375/#598 class).

**Reached from its consumers, not the nav (#1522).** The cabinet is a registry of
physical objects, the same shape as `/equipment` — and `/equipment` has never had a
nav entry. Its old Medical-group row was worse than an ordinary one: it was
`requiresMultiProfile`, so it materialized unannounced when a second profile was
added, wearing the same `IconPill` as the "Medications" row above it. The row was
removed; the ROUTE is unchanged. Its doors are `components/intake/SharedSuppliesLink`
(the Medications header, the Nutrition → Supplements tab, and the Household header,
labelled by the pure `sharedSuppliesLinkLabel`), the shared-bottle chip on a linked
item, and the "See all shared bottles" exit in `SharedSupplyPicker`. `/supplies`
highlights **Medications** and `/equipment` highlights **Training** through
`NAV_PARENT_ROUTES` (`lib/nav.ts`), which `isRouteActive` consults before the plain
prefix rule — a registry route lights its parent and nothing else.

**One cabinet rule.** `isPoolVisibleTo` (pure, `lib/refill.ts`) decides what a caller
sees: any pool an accessible profile draws from, plus member-less orphans (they name
nobody, and somebody has to be able to clear them). The page lists
`listVisiblePoolViews(scope.ids)` and every door counts `countVisiblePools(scope.ids)`
through the SAME predicate, so a door can never promise a bottle the page won't show.
The count skips the pooled-projection build the list needs, and since #2116 it reads
membership for the whole cabinet in ONE query instead of one `poolMembers` call per
bottle — the rule stays in `isPoolVisibleTo`, evaluated in JS over that one read, so
there is still exactly one definition of "in the cabinet". `poolIdsForProfiles` (the
pools an accessible SET draws from) is set-based for the same reason, which is why
`lib/queries/intake/supply-pool.ts` is a registered `CROSS_PROFILE_SQL_MODULES` module.

**The product-fact exchange (#1705).** A bottle carries `name`/`strength`/`form`;
an item carries `name`, `product`/`brand` and its dose amounts — **there is no
`strength` or `form` column on `intake_items`**, which is what makes "the pool is
authoritative for the product" implementable by DERIVATION rather than by copying.
The split: the bottle owns WHAT THE PRODUCT IS (name, strength, form, the on-hand
count, the low-supply threshold); the item owns HOW THIS PERSON USES IT (dose
amount and schedule, obligation, situation gating, notes, its own display name).
One pure module, `lib/supply-product.ts`, owns both directions plus the single
`productLabel`/`bottleLabel` every surface (picker option, shared-bottle chip,
cabinet heading) reads.

- **Item → bottle.** `createPoolAction` seeds `name` and `strength` from the item
  alongside the existing one-way count migration. The item's strength is its FIRST
  active dose amount (`itemStrength`) — dose `amount` is where a strength is
  actually typed. A posted field always wins, matching the count rule; `form` has
  no item-side source and is left for the user.
- **Bottle → item.** `listSharedSupplyOptions` carries `form` and resolves through
  `listLinkableSupplies(ids)` — the SAME `isPoolVisibleTo` rule the cabinet lists
  by, so a picker can never offer a bottle the cabinet hides. Two entry points: the
  item forms' create-mode bottle selector (in the shared `SharedSupplyPicker`,
  posting `supply_id` on the item's own save so `addIntakeItem` links it and forces
  the private count NULL), and the cabinet's **"Add for another person"** — a
  profile selector whose submit switches the active profile and lands on
  `addItemFromPoolHref(kind, poolId)` (`?supply=`), so the item is created under the
  TARGET profile's own write gate. The bottle's kind-surface comes from
  `poolSurfaceKind` (any medication member ⇒ the medications surface).
- **Derivation, not duplication.** A linked item stores no copy of the bottle's
  product facts; `PoolChipData` carries `strength`/`form` and the chip renders them,
  so editing the bottle updates every member's display with **no write to any item
  row** — and there is no mismatch state to reconcile on unlink.

**Cross-grant visibility (stated choice).** The cabinet resolves access once at
the boundary via `requireScope()` and lists the pools the caller's accessible
profiles draw from, plus member-less orphans. A member granted only ONE linked
profile sees that member by name and the rest as a COUNT ("+2 other household
members"); the pooled days-left is shown in full, because it is a property of
the bottle and hiding it would make the number the feature exists to produce
unreadable, while WHO ELSE takes it stays behind the grant.

**Household dose round over Telegram (#1459).** The dose-confirmation loop
gained a MOMENT-side surface to go with its destination: a caregiver can
subscribe their own profile to a **household dose round** — at their schedule
slots, one Telegram message carrying the due-unconfirmed doses of the household
members they explicitly ticked, each with an inline confirm. It changes NOTHING
about this domain's rules and adds no second dueness engine: the round's
per-member gather is the SAME `collectWindowDoses` + `isPushedIntake` floor that
builds that member's own reminder (#221), evaluated in that member's own
timezone/day, so an on-demand item is absent (never scheduled-due), a taken or
deliberately skipped dose (#232) is not "due", and a held item stays held. The
confirm writes through `markDoseTaken` ONLY — adherence history stays truthful,
the amount snapshot and retired/paused refusals are unchanged, and the handler
answers from the typed `DoseTakenOutcome` rather than confirming reflexively.
Access is the receiving profile's own login's WRITE grant on the member,
re-validated at send and at tap. Full design + the safety semantics (never
bus-gated, escalation deliberately NOT aggregated) live in
[`notifications.md`](notifications.md).

**Picker order (#1677).** `Combobox` shows 8 rows and an empty query keeps
source order, so a flat catalog's first eight entries ARE the picker.
Alphabetical over 242 medications opened on Adalimumab/Alendronate; the
supplement catalog's category grouping made all eight rows vitamins whatever the
profile takes. Ordering is now a per-PROFILE computation in three tiers: what
this profile records (a CURRENT medication / ACTIVE supplement outranks a past
one), then a curated common head, then the flat tail. Membership never changes
and free-text semantics are untouched — everything stays reachable by search.

The pure rankers are `lib/medication-rank.ts` and `lib/supplement-rank.ts` over
the shared `rankByFrequency`; both follow the `rank-core`/#1490 discipline of
stable facts and BUCKETED presence (weights combine with MAX, so duplicate
ledger rows never inflate a rank and there is no raw-recency jitter).
`lib/queries/intake-options.ts` resolves each profile's ledger once and
`components/IntakeOptionsContext.tsx` supplies the result to the form, the same
shape `ProviderOptionsContext`/`SituationOptionsContext` already use. Since
#3216 there is one form and therefore one call site, so the picker's head cannot
disagree with itself (#221). The BRAND field keeps its post-name-pick narrowing to the
chosen drug's own brands; only its PRE-pick state changed, to lead with the
brands this profile has recorded.

**Eight rows, with a floor per group (#3410).** "The first eight" is right for ONE
vocabulary and silently wrong for two: a picker fed two ranked lists concatenated
spent all eight on the higher-ranked one, and the other never appeared — no header,
no "more", and a list that looked complete because it was short. When the caller
passes `groupFor`, `lib/relevance-view.ts` gives every group ONE row first, in the
caller's group order, then fills the rest of the eight in the caller's own ranked
order. Representation is the defect, so it is guaranteed; the ranking is the
product, so nothing beyond that one row overrides it. Sharing the eight out EVENLY
was tried and rejected: every grouped picker that ships orders its groups by
priority, and an even split handed half of "Due or flagged" to the ~200-name
alphabetical tail (8/0/0 → 4/0/4 for a profile with eight flagged analytes; the
floor rule gives 7/0/1). The total is still eight, a single-group picker is
unchanged by construction, and a picker with more groups than rows says which ones
it could not fit (a development-only `console.warn`). WITHOUT `groupFor` a
concatenated list has no seam in it and nothing can detect the loss — so a picker
that merges vocabularies must pass one.

**The stack field is one of these vocabularies (#3100).** `IntakeCatalogOptions`
carries `stacks` — this profile's distinct, trimmed, non-empty `stack` values,
active items' stacks first then most recent — and the intake form's "Stack
(optional)" field is an `IntakeItemCombobox` over it, free text still on.
Everything that groups by stack groups by EXACT STRING (`doseSortKey`, the
supplement row's chip), so retyping was the only way into an existing stack and one
capital letter minted a second cluster. Distinctness is exact on purpose: a profile
already carrying both "AM stack" and "AM Stack" has two real clusters, and folding
them here would leave one unreachable by name. There is no curated tier — a stack is
whatever this profile called one — so the context fallback is `[]`.

The sibling rankers live beside them: `lib/provider-rank.ts` (recency-decayed
provider use across every provider-bearing domain, plus the specialty head, fed
by `lib/queries/provider-options.ts`) and `lib/immunization-rank.ts` (age/life-
stage buckets read off the SAME `assessSchedule` status engine the schedule grid
draws, fed by `lib/queries/immunization-options.ts`) — so an adult's vaccine
picker no longer opens on an infant's first year.

**A ranked source only survives the EMPTY query unless it declares usage
(#2384).** The model above — "an empty query keeps source order, so the source
array's first 8 entries are the picker" — is true only for the empty query.
`fuzzyFilter` sorts on `b.s - a.s || a.i - b.i`, so the caller's order is kept
only as an exact-score TIEBREAK, and the score carries a fractional length term
that makes exact ties essentially never occur. One keystroke therefore replaced
every ranker above with string geometry: a never-logged "Squash" outranked five
logged squats on `sqa`, purely because its `s` sits at index 0.

The fix keeps the split the rankers already have. The CALLER answers "does this
profile actually use this?" — it is the domain question, and these rankers
already resolve it — and passes the answer as `usedOptions`, a `ReadonlySet` of
lowercased option names. `lib/fuzzy.ts` owns what that is worth: one app-wide
`USAGE_BONUS` (1.5), bounded so it overturns the +1 first-character bonus and
the length tiebreak but never a word boundary (+2) or a contiguity run (+3), and
BINARY rather than graded, per the same #1490 discipline these rankers follow.
It de-ranks, never hides. Omitting `usedOptions` is byte-for-byte the old
behavior, which is the right default: a picker earns the bonus by declaring real
evidence, never by merely having an order — a position-derived bonus over an
alphabetical list would just favour names beginning with "A".

The activity picker is the first consumer (`ActivitySuggestions.logged`, built
from the three usage tallies `getActivitySuggestions` already gathers).
Medications, supplements, providers, specialties and immunizations should pass
`usedOptions` as each ranked source lands, or their rank will keep evaporating
on the first keystroke.

## Biomarker → supplement: the curated engine, and the AI route as fallback (#2378)

Biomarker → **food** has been deterministic since #577: `lib/food-suggest.ts`
reads a curated, human-reviewable map, is a pure engine with its DB gather split
out, and screens every suggestion before it renders. Biomarker → **supplement**
had no such engine — `lib/supplement-suggest.ts` was the only route, and it
imports the model SDK. The two halves of one question were held to different
standards, and **the half that recommends a substance a user swallows was the
less deterministic one.** This closes that gap.

**The map** — `lib/datasets/data/biomarker-supplement-map.json`, generated by
`scripts/gen-biomarker-supplement-map.ts` (`npm run gen:biomarker-supplement-map`)
like every other curated dataset, on the #860 dataset framework, pinned as a
fixed point by `lib/__tests__/biomarker-supplement-map-dataset.test.ts`.

**The engine is the easy half; the map is not.** "An orange contains vitamin C"
is uncontested; "this biomarker warrants this supplement" carries dose, form,
bioavailability, an interaction surface, and efficacy that is frequently
contested. So the curation standard is deliberately higher than the food map's,
and it lives at the top of the generator:

- an entry may only claim what is **uncontested at the level of the MARKER** —
  that taking the substance moves the very quantity the biomarker measures, in
  the direction the entry declares. For every repletion entry that is a LOW
  reading answered by repleting it; the one add-on-high entry (`lipids`, #2754)
  answers a HIGH LDL/ApoB with the soluble fiber whose LDL-lowering effect is
  FDA-authorized-health-claim territory. Never that it improves an outcome.
- every entry carries `evidence` (a one-line reason a reviewer can check) and
  `source` (a public citation). No one-liner, no entry.
- **no entry states a dose**, anywhere in its text. The dataset test fails one
  that tries.
- **the trigger must be a status marker, not merely an analyte.** The `iron` entry
  fires on `Ferritin` alone: serum iron swings through the day, falls in
  inflammation and rises after one iron-containing meal, so triggering the one
  substance here with a real overdose risk off that reading is the combination not
  to ship.
- the map starts **small and ships mostly empty on purpose**. An uncovered
  family falls through to the AI route and loses nothing, so **coverage is a
  measurable thing that grows** rather than a gate on the feature landing. Do not
  pad it to look complete.

**The screens are reused, never reimplemented.** The engine
(`lib/supplement-suggest-curated.ts`) runs each candidate through
`screenSuggestionSafety` — the same allergen (direct + cross-reactive),
medication-interaction and condition→nutrient belt that post-validates the AI
route's output — over the same ingestible-conservative gather
(`getIngestibleSafetyContext`, resolved allergies included per #691). Map-declared
condition/situation tags go through `conditionOrSituationMatches`, the matcher the
food engine uses. Medication timing notes come from `stackFoodDrugHits`, the food
engine's own inverse index. Magnesium × CKD is deliberately NOT declared in this
map: `CONDITION_NUTRIENT_RULES` already carries it, and a second copy is the drift
the shared rule exists to prevent. Where the shared machinery genuinely lacked a
rule the map needed, the rule was added to the SHARED dataset rather than
special-cased here: `fish-oil-anticoagulant` (supplemental EPA/DHA × warfarin / DOACs
/ clopidogrel, from the omega-3 product labelling) is a food–drug entry both
engines and the medication surfaces read, so the bleeding-time caution reaches the
profiles it concerns instead of sitting in prose every reader sees. A struck primary falls back to the entry's
curated alternative (itself screened); if nothing safe remains the whole
suggestion is **withheld** — absence is never an all-clear.

**The AI route stays, demoted.** `lib/supplement-suggest.ts` answers what the map
does not cover; its prompt is told which families already have a curated answer so
it doesn't restate them. The two are **visibly distinguished** wherever they
render — a **Curated** badge with an evidence line and a source, versus a
**Generated** badge with the model's rationale — because a curated recommendation
and a generated one are different claims. That distinction is also what makes the
map's coverage measurable.

**One question, one computation.** `getCuratedSupplementSuggestions`
(`lib/queries/nutrition.ts`, beside `getFoodSuggestions`) is the single gather; the
supplements tab and the biomarker detail page both format it through
`components/CuratedSupplementSuggestions.tsx`. A covered family yields identical
output on every run with no model call — pinned in both the pure and the DB tier,
because that determinism is the entire point.

## Dose amounts that can't be read (#3153, #3320)

A dose row stores **only the text that was typed** — `intake_item_doses.amount
TEXT`, migration 011, and nothing since adds a numeric column beside it. Every
number is derived at read time by `readDoseQuantity` (`lib/dri.ts`), which reads
the first number+unit whole and hands the number to `readGroupedNumber`.

**The rule refuses rather than resolves.** `"1,000 mg"` is a thousands group and
reads 1000. `"2,5 g"` is 2.5 g or 25 g, `"10.000 IU"` is ten or ten thousand, and
nothing in the row says which — so those read as `unreadable` and no total counts
them. Before #3153 the scan was anchored at `\d+(?:\.\d+)?`, which cannot span a
comma: on `"1,000 mg"` it matched the `"000"` and returned a confident **zero**,
so a niacin dose 28x over the upper limit contributed nothing to the total it was
over. The write boundary (`intake-actions.ts`) now refuses an unreadable amount
instead of storing a guess.

**Legacy rows needed no repair, which is the part worth remembering.** Because
the reading was never persisted, #3153's fix corrected every recoverable row the
moment it merged — `"1,000 mg"` reads 1000 today with no migration and no
backfill. That is the inverse of the ingredient half, where
`readIngredientAmount` writes a derived amount **beside** `amount_text` and a bad
reading really is on disk. For doses there was nothing to correct, only something
to make visible.

**What was left was silence.** An unreadable amount is honest — better than a
fabricated number — but nothing said the upper-limit total and the RDA share were
skipping the dose. The `dose-amount-unreadable` data-quality gap
(`lib/data-quality.ts`) names the count and links the item so the person can
retype it; it covers live doses on active items, because a retired dose reaches no
total. **No remedy may guess a locale for an ambiguous string**, legacy data
included: a silent wrong number in a health record is worse than the absence it
replaces.

Two things about that scope a later reader should not have to derive. **Excluding
retired doses is a deferral, not a discard** — `unretireDose` restores the row
with its `amount` untouched, so the gap fires the moment the dose is schedulable
again, which is the moment a total would reach for its number. And **the count is
a ceiling on the safety-relevant rows, not a tally of them**: only every-day
schedules feed the daily UL/RDA totals (#635), so a situational item's unreadable
amount is counted while feeding no upper-limit total. The wider scope is
deliberate — the amount is unusable for every consumer, not just the UL — but the
number is not "doses missing from a safety total"; it is at most that many.

**Measuring the population.** `npm run census:dose-amounts [path]` partitions
every stored dose amount into six buckets (untouched, no quantity, repaired-from-
zero, repaired-from-wrong, unreadable-with-a-restated-amount,
unreadable-with-nothing-to-recover), split live/retired. It is read-only, opens
the file directly so counting can never migrate what it measures, and prints
amount strings and counts only. The classification is `lib/dose-amount-census.ts`
and it **imports** the shipped rule — a SQL or regex restatement would be a second
version of the rule #3153 unified, and a census that disagrees with the engine it
describes is worse than none. The one re-implementation there is the _pre-fix_
pattern, kept to answer "what did this row read as yesterday": the artifact being
measured, not a rule.

**The census measures the stored string, and there was a third reader upstream of
it (#3444).** `lib/prescription-parse.ts` — the medication import — spelled its
own `\d+(?:\.\d+)?` and so carried the identical defect on the identical shapes,
one step earlier and in the direction that hides. On `Bisoprolol 2,5 mg` the scan
stopped at the comma, restarted after it, and stored **`5 mg`** as the dose;
`Digoxin 0,125 mg` stored `125 mg`; `Metformin 1,000 mg` stored `000 mg`, a
confident zero. Every reader downstream then agreed, this census included — `5 mg`
reads the same before and after #3153, so it is `always-correct`, correctly, and
the population looked clean over rows whose number no document ever stated. The
number pattern is now imported (`WRITTEN_NUMBER`, `lib/dri.ts`) rather than
respelled, so a comma-decimal strength survives verbatim into the dose column and
is refused there like any other unresolvable separator, where the
`dose-amount-unreadable` gap names it.
`lib/__tests__/dose-number-readers.test.ts` sweeps every reader of a number
against a dose unit and pins what each one is allowed to answer.

Two consequences to carry. The "one rule shared by both halves of a label" claim
was **counting halves when there was a third**, which is why the heading in
`lib/dri.ts` no longer counts. And a census over stored text **cannot see a value
fabricated before the text was stored** — rows imported before this fix keep their
rewritten amount, findable only by comparing a dose against the item name it was
parsed from, and repairable only by the person holding the label.

**A leading zero settles the separator, on both sides (#3444).** `readGroupedNumber`
refused `0.125` from the start — no label writes a thousands group beginning with a
zero — but its comma branch accepted `0,125` as one and returned `125`. So the rule
that exists to refuse rather than guess was itself stating a thousandfold overdose
for the commonest digoxin strength, on the manual dose-entry path as well as the
import. The leading group is now `[1-9]`, and the two branches agree.

**A separator that is not a comma, and the one that stays refused (#3451).** The
same restart was reachable through seven other characters. `"1 000 mg"` — and the
same with a no-break space, a narrow no-break space, a thin space, a figure space,
a Swiss apostrophe (`1’000`, and the `1'000` people type for it) or U+066C — read
as a confident **zero**, on the very niacin shape `lib/dri.ts` cites as its reason
for taking a number whole. It defeated every net: the name was torn in half too
(`Metformin 1 000 mg` filed the item as `Metformin 1` with a dose of `000 mg`), the
census called the row `always-correct`, and no data-quality gap mentioned it.

The fix is **deliberately not uniform across the seven**, and the split is a safety
claim in both directions:

- The six that exist _because_ they are thousands separators are **read**. They
  normalize to a comma and go through the comma rule unchanged, so `1’000` is 1000
  for the same reason `1,000` is, and `0’125` is refused for the same reason
  `0,125` is.
- The plain ASCII space **U+0020 is refused**. On a label `"1 500 mg"` is as
  plausibly _one 500 mg tablet_ — count then strength, a shape this codebase
  already parses (`doseUnitCount`, and `COUNT` in `lib/prescription-parse.ts`) — as
  it is fifteen hundred milligrams. Measured before the fix,
  `readDoseQuantity("2 500 mg tablets")` answered 500 mg; reading the space as a
  group would have made it 2500, swapping a confident zero for a confident
  fivefold overdose. U+0027 is the one member of the read set admitted on evidence of
  use rather than on the character's definition — an apostrophe is a quote mark, not a
  separator, but a Swiss label typed on an ASCII keyboard writes `1'000` and that input
  produced a confident zero. The number is taken whole so the scan cannot restart inside
  it, and then declined — the row becomes a visible `dose-amount-unreadable` gap,
  the same answer `"2,5 mg"` gets.

**A name may end in a digit,** which is why the space branch refuses to start after a
letter, digit, underscore, hyphen or en dash: `B12 500 mcg`, `CoQ10 200 mg`,
`Vitamin D3 5000 IU` and `Omega-3 1000 mg` all read exactly as they did before. That
guard is the whole reason the branch can afford to demand nothing about the group's
size. `lib/__tests__/prescription-parse.test.ts` already pinned `"B12 500 mcg"` with
the words _"must not become 12"_ — somebody had met this hazard and written it down
before the issue existed, which is the strongest argument in the tree for the split.

**It refuses every digit-space-digit run, not only a well-formed group,** and the
first cut got that wrong. Matching the thousands-group _shape_ (`\d{1,3}(?: \d{3})+`)
refused `"1 000 mg"` and left `"1 00 mg"` and `"1 0000 mg"` reading a confident **zero**
— a group too short and a group too long, both of which are what a mistyped label looks
like. That refused the correctly-typed separator and fabricated from the mistyped one,
which is the wrong way round. The lever is the refusal, not the shape: dropping the size
requirement and leaning on the lookbehind closes both. Measured over 58,769 string
literals from the tracked tree plus 50 label shapes, dropping it changes **four** strings
beyond the two it fixes, all one family — a name ending in a standalone digit held by a
_space_ (`Omega 3 1000 mg`), which is structurally identical to a mistyped group and
cannot be separated from one by any local rule. That differ could not see the whole
family — see below: it compares reader answers on single literals, and this shape needs a
name and a strength adjacent.

**The en dash is in that class for a reason no sweep of this repo could show.** U+2013 is
not a spelling anybody chooses — it is what a word processor's autocorrect, a PDF exporter
or an OCR pass _produces_ from a typed `-`. Every file here is hand-authored TypeScript,
so a corpus over the tree reports zero occurrences forever, while `persistDocumentImport`
— the path carrying real discharge summaries and pharmacy printouts into
`intake_item_doses.amount` — is exactly where the substitution arrives. Same evidence
class as U+0027: admitted on how the input reaches us, not on what the character is for.

**The slash is deliberately not in that class, and it looks wrong until you measure it.**
`LABEL_UNIT_COUNT_RE` is spelled `(?<![\d.,/])` — without the `/` the `2` of `1/2 tablet`
reads as two tablets — so the file already knows a slash binds a digit, and the obvious
conclusion is that this guard forgot. It is the opposite, because **the two guards sit on
branches that do opposite things**: `LABEL_UNIT_COUNT_RE`'s lookbehind blocks a _read_, so
adding `/` removes a fabrication; this one guards a _refusal_, so adding `/` blocks the
refusal and lets the ordinary scan restart after the space, _creating_ one. Measured both
ways: with `/` in this class, `"1/2 000 mg"` and `"5/325 000 mg"` become a confident 0 mg,
against one arguable gain (`"1/2 500 mg tablet"` reading 500). Two fabrications for one
read is the wrong trade here. Pinned in both directions.

**Not every separator is one character, and an early cut of this fix keyed on exactly
one.** `"1  000 mg"` with a **double** space, a tab, a mixed run, and the zero-width
family (`U+00AD`, `U+200B`, `U+2060`, `U+FEFF`) all still read a confident zero after the
first fix landed, while the correctly-typed single space was refused. The refusal now
keys on a **run**: more than one separator character of any kind, or a single character
that is not in the read set. The zero-width ones are why that is an explicit list rather
than `\s` — a soft hyphen between two digit runs _renders as nothing_, so the person sees
`1000` and the string holds `1<U+00AD>000`. Reading it and refusing it are both
defensible; returning a confident zero is not.

**A read-set character is a thousands separator only _between two digit runs_.** Putting
that same set into the scan's start lookbehind and its optional leading separator applied
the claim in two positions where it is not true — and NBSP, narrow NBSP, thin space and
figure space are overwhelmingly ordinary **word spaces**, which is what Word, HTML and PDF
extraction put between a name and a number. The cost was silent: `Niacin<NBSP>1000 mg`
yielded no strength at all, so the item was filed under the whole string and the sig's
`1 tablet` landed in the amount column — which reads `none`, not `unreadable`, and
`getUnreadableDoseAmounts` filters `none` out. A real 1000 mg niacin dose, absent from
every total, with nothing prompting anyone to look. Those two positions carry `[.,]` and
nothing more, exactly as they did before this change.

**What the widening costs, as a family rather than a string:** any name whose last token
before the strength is a bare digit run held by a **space** — `Omega 3 1000 mg`,
`Vitamin B 12 500 mcg`, `PreserVision AREDS 2 500 mg`, `Coenzyme Q 10 100 mg`,
`Sinemet 25 100 mg`. **`PreserVision AREDS 2` is a shipped catalog entry**
(`lib/supplement-catalog.ts`), so the family is reachable rather than hypothetical — the
bare name is untouched, but a strength appended to it in one string refuses and the
grouping name drops the `2`. There is no narrowing available. The obvious one (also refuse after
letter-then-space) rescues it and simultaneously un-refuses `Vitamin C 1 000 mg`, handing
back a confident zero on one of the commonest label shapes there is; that assertion is
pinned in `lib/__tests__/dri.test.ts`. **The remedy, if complaints appear, is to normalise
the name — not the reader.** `Omega-3` already reads and is what this tree spells twenty
times over; widening the reader to accept the spaced form is the same edit as reading
`1 0000 mg` as a number. The dose becomes a visible unreadable gap and the name renders as
`Omega` — visibly odd and correctable, which is exactly what a confident zero is not.

**Two residuals, named rather than implied — and the list is a test, not a sentence.**
A character in neither class still lets the scan restart: `"1_000 mg"` reads 0 (an
underscore is a programming digit separator, no label spelling) and `"1-000 mg"` reads 0
(a hyphen between digits means a **range** here, which `COUNT` and `DOSE_RANGE` parse on
purpose — same trade as the slash). Reading a range is a separate defect from reading a
separator and is not fixed here: `"100-200 mg"` still reads 200, as on main. Both are
asserted in `lib/__tests__/dri.test.ts` so the day either changes the change is
deliberate — and the list is written this way because an adversarial pass found that
"one residual" was nineteen while the branch keyed on a single literal space.

**A corpus over string literals cannot see a two-part shape,** which is worth recording
because an earlier round concluded from exactly such a corpus that the spaced-name
spelling appeared nowhere in the tree. The measurement was sound; the conclusion was not.
The defect needs a **name and a strength adjacent**, and those never co-occur in one
literal by construction — the catalog stores names, the seeds store amounts.

The heading in `lib/dri.ts` is wide again as a result, and now says **separator**
rather than naming characters. `readIngredientAmount` stopped spelling its own
number pattern in the same change: the shape comes from `WRITTEN_NUMBER` and the
meaning from `readGroupedNumber`, so the only thing local to the ingredient half is
its anchoring. `lib/__tests__/dose-number-readers.test.ts` asks both halves the
same string and insists on the same answer, for all eight spellings.
