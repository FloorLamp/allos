# Findings reach — the two-tier policy

Status: **shipped** · extracted verbatim from AGENTS.md (#597; the policy was
decided in #449)

How far a rule-engine finding travels — page, dashboard hero, notification — is
a deliberate two-tier decision, not a per-feature accident. This page holds the
full policy and how a new engine joins a tier; the one-line rule stays in
AGENTS.md's conventions.

> **The reach policy is one half of a larger doctrine.** [The attention
> doctrine](#the-attention-doctrine) at the end of this file generalizes it: the
> surface taxonomy (who initiates), the contact-consent rule, which domains can
> carry an obligation at all, the right-sizing family, and how tiers and
> obligations correspond without being the same thing. Read that when adding a
> new engine, a new push surface, or a new "the system noticed X" suggestion.

---

**Findings reach is a two-tier policy — decide it on purpose (#449).** The #45
rule engines split into two reach tiers. The **care tier** (preventive findings,
drug-interaction/dietary-limit items, and the illness-care duration/trajectory
findings — #805) is _push_: it reaches Upcoming, the dashboard **Needs
attention** hero, AND the Telegram nudge (one assessor). The **coaching tier** —
the four observational builders
(`buildTrainingObservationFindings`/`buildBodyHygieneFindings`/`buildGoalPacingFindings`/`buildAdherencePatternFindings`,
aggregated by `collectCoachingFindings`) — is _calm/observational_: it reaches
its own tab AND the hideable dashboard **Coaching observations** rollup, but
**never a notification and never the non-hideable hero** (reach without noise).
A new observational engine joins the coaching tier by adding its builder to
`collectCoachingFindings` and its dedupeKey prefix to the registry; it does NOT
get a push channel unless it's genuinely _care_. Every surface renders the SAME
`Finding` (one computation) with the SAME dedupeKey, so a dismiss on any surface
silences it on all of them through the shared bus.

**A tier is a ceiling, not a floor — an attention state still has to be EARNED
(#1433).** Membership in the care tier says how far a finding _may_ reach; it
never says a finding must reach that far. The preventive engine is care-tier and
still splits on **evidence**: `lib/preventive-status.ts` distinguishes
_recorded-lapsed_ (a dated satisfaction whose interval genuinely elapsed → the
existing `due`/`overdue`, full care reach) from _never-recorded_ (the new `setup`
status, derived from nothing but an age and a nominal interval). `setup` is kept
out of `PreventiveSummary.actionable`, which is what the Telegram nudge and the
token reconciler are composed from, so it cannot page anyone; the morning digest
drops it explicitly. Its `UpcomingItem` carries `signalGroup: "setup"`, which
gives it its own trailing group on Upcoming and excludes it from
`cardBandForItem`, the hero count, the app badge, and the "+N scheduled later"
link — the hero renders it as ONE collapsed `attentionSetupItems` line instead.
The dedupeKey, rule key, deep link and inline actions are all unchanged, so this
is a re-framing and not a second finding (an existing dismissal survives it).

The general rule this instantiates: **the system may reduce contact
unilaterally**, so narrowing a care finding's reach when the evidence does not
support it needs no user decision — but the reverse (promoting a calm state into
an attention slot) always does. A cold-start state must never newly page anyone.

**One dashboard home per finding family (#1533).** The rollup's charter is reach
for findings that would otherwise render only on their own tab, so a family that
has earned its OWN dashboard widget is excluded from it: `FINDING_DASHBOARD_HOME`
in `lib/dashboard-widgets.ts` maps a dedupeKey prefix to that widget id, and the
page splits `activeCoaching` into the homed slice and the rollup's catch-all. The
two sets are disjoint, their union is the whole set, the rollup's count and
"Show N more" overflow are computed over what it renders, and hiding the home
widget puts its family straight back into the rollup. A new family with its own
widget adds one registry line — it does not add another one-off filter.

**The same contract governs the Upcoming page's display aggregation (#1504).**
The planning page folds a band's scheduled `dose` rows into one disclosure, and
its `interaction` + `pgx` rows into a second, with the count (and, for Today, the
day's taken fraction) stated in BOTH states, no dismiss, and no persisted state —
an aggregate is collapsed on every visit. `lib/upcoming-aggregate.ts` owns the
decision (`planBandRender`); the page is a formatter over it.

Three properties are load-bearing:

- **Rendering aggregates; identity does not (#1496).** The disclosure hands the
  SAME `UpcomingItem` objects to the SAME row renderer, so every folded row keeps
  its `dedupeKey`, its per-item snooze/dismiss, and its `WriteTarget` — a dose
  confirmed on another member's row still writes to that member.
- **The safety exemption is read from the item's own policy**, exactly as the
  hero's is: an item whose `itemSuppressionPolicy` is `"safety-ungated"` (a
  missed-dose escalation, the crisis finding) is never folded, and neither is a
  `prn-max` row — a count that has already been exceeded must not be summarised by
  another count. Both render individually and lead their band.
- **The rollup's scope is closed**: `interaction` + `pgx` only. `allergy-med`
  keeps its rank above them (#1029) and stays an individual row, as do the
  singular care findings. `lib/__tests__/upcoming-aggregate.test.ts` reflects over
  the whole `UpcomingDomain` union so a new domain must choose a side.

The fold is band-scoped (an overdue dose is never summarised together with a
not-yet-due one), and it does not touch the engines, the bands,
`compareWithinBand`, `collectUpcoming`, or the suppression bus — the digest, the
dashboard hero and the calendar feed read the same model unchanged.

**The hero's contract is ALWAYS-PRESENT, not always-full (#1413).** The care
tier's `non-hideable hero` guarantee was refined on exactly one axis: the hero
may **collapse** to a compact pinned line, because on a phone the full card cost
a screenful even on a day whose items you had already read. What collapse may
never touch is the signal itself — the heading, the alert glyph, the **count**,
and the highest-severity band all render in BOTH states, there is still no
dismiss control, and the toggle is always two-way, so no interaction reaches a
state with no attention affordance on the page. The preference is stored per
**login** (`attention_hero_collapsed` in `login_settings`) because it is a
viewing-density choice about the reader's own screen, not a fact about the
person being displayed.

The **safety carve-out outranks the preference entirely**:
`attentionSafetyLocked` (`lib/attention.ts`) refuses to collapse a hero carrying
an item whose lifecycle policy is `"safety-ungated"` (dose reminders,
missed-dose escalation, the #716 crisis finding), and such a hero renders with
NO collapse control at all. The tier is read from the item's OWN declared policy
through the shared `itemSuppressionPolicy` dispatcher
(`lib/upcoming-suppress.ts`) — deliberately NOT a second "serious-looking
domains" allowlist, so a future safety signal inherits the no-compaction
guarantee by declaring its policy rather than by someone remembering to update a
list here. This mirrors `isHiddenUnderPolicy`'s posture (#942): the safety
branch is checked FIRST and unconditionally, before any stored preference is
consulted, so neither can be weakened by editing what is stored. Pinned by
`lib/__tests__/attention-hero-collapse.test.ts` and
`e2e/dashboard-now.mobile.spec.ts`.

---

## The finding-producing builder registry (#860 Track A, extending #448)

`lib/rule-finding-prefixes.ts` is the ONE registry that binds three facts per
finding namespace — **prefix + tier + reason source** — so the tier decision
above can't be made by accident and can't drift from the code. Each
`RULE_FINDING_REGISTRY` entry is `{ prefix, tier, builder, reasons }`:

- **prefix** — the dedupeKey namespace the builder keys under (the #448
  guardability property: a page's prefix-guarded dismiss action must be able to
  match it). `RULE_FINDING_PREFIXES` and `dedupeKeyHasKnownPrefix()` are derived
  from the registry, unchanged for existing consumers (the dismiss actions in
  `app/(app)/actions.ts`).
- **tier** — `"care"` or `"coaching"` (#449). `tierForDedupeKey(key)` resolves
  it. The **coaching** members are exactly the builders
  `collectCoachingFindings` aggregates; the **care** members are the push
  builders (`buildIllnessCareFindings`, `tempRedFlagItems`,
  `conditionReviewItems`, `followUpItems`) that reach Upcoming/hero and are
  deliberately NOT in `collectCoachingFindings`.
- **reason source** — the closed set of #656 `ReasonCode`s a finding under this
  prefix may carry (empty for the common no-reason builder;
  `["followup-source"]` for the follow-up loop). `ReasonCode` is backed by the
  enumerable `REASON_CODES` array in `lib/reasons.ts`, so
  `declaredReasonCodesFor(key)` is checkable and a builder can't attach an
  undeclared code.

**The teeth** (the source-scan / #448 precedent — registry is data, enforcement
is a reflection test):

- **Un-registered emission fails CI.** The #448 reflection guard
  (`rule-findings-builders.test.ts`) asserts every builder-emitted dedupeKey
  `dedupeKeyHasKnownPrefix`.
- **A tier the code doesn't match fails CI.** Every key
  `collectCoachingFindings` emits must `tierForDedupeKey === "coaching"`; every
  care builder's key (asserted in each builder's own fixture DB test —
  `followup-findings` / `condition-suggestion-findings` /
  `illness-care-findings` / `temp-red-flag-findings`) must resolve `"care"`. So
  a coaching builder registered `care` (or vice versa), or an omitted
  registration, fails CI.
- **An undeclared reason source fails CI.** A finding whose `reasons[].code`
  isn't declared for its prefix fails the reflection guard.
- Pure structural invariants (unique, non-overlapping prefixes; both tiers
  populated; valid reason codes) are pinned in
  `lib/__tests__/rule-finding-registry.test.ts`.

**Adding a new finding engine:** add one `RULE_FINDING_REGISTRY` entry (prefix +
tier + declared reason codes) and its own fixture DB test (the #448 rule), which
asserts its tier via `tierForDedupeKey`. You cannot ship a finding without
declaring how far it reaches.

**Dedupe keys follow their series' identity, not display names.** Two
consequences worth knowing when touching identity code:

- Training plateau/stale keys are built from the shared identity builders
  (`plateauSignalKey` on `movementLoadKey` — variant-collapsed movement + the
  equipment load lane; `staleExerciseSignalKey` on `exerciseHistoryKey`), never
  from a raw display name (#1399/#1610). The old raw-name keys were re-keyed the
  #482 way: a dismissal stored before the change goes inert and its finding
  resurfaces once.
- The biomarker family key is no longer a finite SQL preimage: SQL calls the one
  pure `biomarkerFamily()` through the `biomarker_family()` user function
  (#1401), so a family's freeform `match` regex is load-bearing on the
  dedup/is_latest partitions and must be held to the same exclusion discipline
  as its `members` list. The retest cadence resolves through the analyte's
  retest identity, so every family member inherits the family's curated
  interval, tightest wins (#1394/#1395).

---

## Illness-care findings (care tier, #805)

The illness-care engine (`lib/illness-care.ts`, builder
`lib/illness-care-findings.ts`) is a **care-tier** member: a logged symptom in
the profile's current open illness episode (the #801 `assembleIllnessEpisode`
assembly — no second gather) that has crossed a **cited duration or trajectory
line** becomes a push finding. Its dedupeKey prefix (`illness-care:`) is
registered in `RULE_FINDING_PREFIXES` (so the #448 reflection guard proves the
keys are guardable) even though it is a push builder, not a coaching one — it is
NOT part of `collectCoachingFindings`. It reaches Upcoming + the hero as an
`illness-care`-domain `UpcomingItem` banded `today` (via `illnessCareItems` in
the Upcoming generator fan-out) and the Telegram nudge via `runIllnessCare`
(`lib/notifications/illness-care.ts`), all keyed by the SAME dedupeKey through
the shared bus.

**Thresholds are a curated, per-entry-cited dataset**
(`lib/datasets/data/illness-thresholds.json`, the #798 prn-defaults pattern),
keyed by the #799 symptom slugs. Every finding states the logged **fact** + the
cited **line** + the **source** + an "informational, not medical advice" tail —
never "you should", never a diagnosis. No dataset entry for a symptom ⇒ no
finding for it, ever; age bands are the SOURCE's own (infant fever renders the
"contact a clinician" refusal, never a number we computed), applied only when
age is known.

**Hard non-goal — no symptom-combination triage.** The engine judges ONE symptom
against ONE citable duration/trajectory line at a time. Red-flag COMBINATIONS
("fever + rash + stiff neck ⇒ ER") are out of scope **entirely** — not even as
"informational" — because that is diagnosis, and one missed emergency or one
false alarm both end badly. No auto-created conditions, no auto-contacting
anyone, no severity-only alarms without a citable duration source. The illness
hero accordion / Household "sick day" chip's **worsening ↑** marker
(`episodeIsWorsening`) is a pure visibility arrow over the same assembly — a
trend indicator with no medical claim, distinct from these cited findings.

---

## Condition-suggestion review (care tier, #685)

The condition-suggestion engine (pure detector `lib/condition-suggestions.ts`,
builder `lib/condition-suggestion-findings.ts`) is a **care-tier** member: a
CURRENT qualitative lab result the shared classifier (#549) resolves to a
`polarity:"bad"` infection-**positive** (positive HBsAg / anti-HBc / HCV / HIV /
RPR / chlamydia / gonorrhea) — or, per #687's cross-ref, a **high-risk**
prenatal/genetic screen — becomes a **suggest-only** review item to add the
matching problem-list **Condition**. A positive infection marker seen only as a
flag chip was the safety gap #685 names; routing it to the conditions surface
(which the recommendation engines read) closes it.

**Suggest-only (#560), never a silent insert.** The item carries an inline
**"Add to conditions"** confirm the user clicks; `confirmConditionSuggestion` →
the idempotent, external_id-keyed `addSuggestedConditionCore` is the ONLY path
that writes a Condition — ingest never does. Once added, the concept collapses
onto the new condition and the suggestion self-clears.

**Concept dedup reuses the existing identity (#482).** A suggestion is dropped
when its concept's `conditionCollapseKey` (`lib/icd10.ts`) already collapses
onto a stored condition — the SAME identity the conditions page dedups by, not a
second grouping. The marker→concept map is the one new table, with an
**exclusion discipline**: a generic culture whose organism is unknown suggests
nothing. **NEGATIVE results are deliberately NOT conditions** — a non-reactive
HIV/HCV is a screening event (the preventive-cadence follow-up, #686), never a
problem-list row.

**Tier reach (#449).** It reaches Upcoming + the non-hideable **Needs
attention** hero as a `condition-review`-domain `UpcomingItem` banded `today`
(via `conditionReviewItems` in the Upcoming generator fan-out), suppressible
through the shared bus by its `condition-review:<conditionCollapseKey>`
dedupeKey (registered in `RULE_FINDING_PREFIXES`, so the #448 reflection guard
proves it's guardable). It is NOT part of `collectCoachingFindings`. A **new
push channel (Telegram) was deliberately scoped OUT** — `condition-review` is
omitted from the digest's `DOMAIN_SEQ`, so the review/Upcoming/hero surface is
the shipped step; a push is a larger decision left to a follow-up.

---

## Food log × food–drug rules (two tiers, #2021)

The food catalog logged `alcohol` and `leafy_greens` as first-class groups while
`matchFoodInteractions` took an ITEM and never touched `food_log`, so the
medication row printed _"Avoid all alcohol during treatment and for 3 days
after"_ and then watched the user log an alcohol serving in silence. The join is
`lib/food-drug-ledger.ts` (pure) behind `lib/food-drug-ledger-findings.ts` (the
gather).

**Entries declare their mapping, or their exclusion.** Every entry in
`scripts/food-drug-interactions.source.json` carries a `catalog` block —
`groups`, a `rule` (`event` / `variance` / `none`), an optional per-entry
`tailDays` and `coverageNote`, and a written `reason` whenever the rule is
`none`. The generator REFUSES an entry that decides neither way, so a new
interaction cannot ship without someone deciding whether a day-granular log can
honestly speak to it, and the builder physically cannot fire on an unmapped one.
Four entries participate today: the three alcohol rules as `event`s
(metronidazole carrying the label's own `tailDays: 3`) and vitamin-K × warfarin
as a `variance`. The rest are excluded with reasons — grapefruit collapses into
the broad `fruit` group and would fire on every apple; tyramine is only loosely
reachable through `fermented` + `processed_meat` + `alcohol`, where a yogurt and
an aged cheese are the same tap; potassium and salt substitutes are not a group
at all; the dairy rules are separation WINDOWS that need the eating time #2019
adds. #661's static habit screen (`FOOD_GROUP_INTERACTION_KEYS`) is DERIVED from
the same declarations rather than kept as a second map.

**The event finding is CARE tier with no push channel.** A mapped group logged
inside the item's course window (plus the entry's stated tail) becomes a
`food-drug-event`-domain `UpcomingItem` banded `today`, so it reaches Upcoming +
the non-hideable hero, keyed `food-drug-event:<itemId>:<ruleId>:<date>` — a day
at a time, so a dismissal covers that day rather than the topic forever. It is
omitted from the digest's `DOMAIN_SEQ` and has no notify orchestrator, which is
the tier acting as a CEILING and not a floor (#1433): the contact-consent rule
wants a user-owned declaration behind any INCREASE in contact, the food log is
an observation domain (nobody promised anything by logging a drink), and a
message that arrived because you did would be surveillance-shaped — the opposite
of the posture that makes people log honestly in the first place.

**The variance finding is COACHING tier.** A week-over-week swing (both an
absolute floor and a doubling/halving must clear, with an adoption guard so a new
logger is not a swing) against advice of the "keep it steady" shape becomes a
calm, hideable note keyed `food-drug-variance:<itemId>:<ruleId>`. It joins
`collectCoachingFindings` and reaches no notification and no hero.

Both quote the entry's OWN advice sentence, its citation and the informational
tail, and state what the log actually contains — never a verdict about the
person (#992/#716).

---

## The finding follow-up loop (care tier, #700 · #860 Track A / #707 Substrate 1)

Status: **shipped** (imaging adapter; IOP/dental/skin/labs adapters plug in as
their record types land — the seam is documented below)

The highest-harm failure across the medical domains is not a missing record —
it's a flagged **finding whose follow-up never happens** (an incidental "6 mm
pulmonary nodule, recommend follow-up CT in 12 months"). The loop that closes it
is generic and lives over the EXISTING `care_plan_items` lifecycle (#658,
migration 050 adds the link columns), not a new table:

**finding (a domain record) → follow-up (a linked `care_plan_items` row) →
resolution (an outcome recorded against a later record).**

- **The chain node** is a `care_plan_items` row that carries `source_kind` + a
  concrete source FK (`source_imaging_study_id` today), a
  `recommended_interval_days`, and — once closed — a `resolution`
  (`resolved`/`stable`/`changed`) + `resolved_by_imaging_study_id`. All
  nullable: a generic care-plan item sets none of them.
- **The builder** (`lib/followup-findings.ts`, `followUpItems`) is a #448
  care-tier builder: it gathers linked, open follow-ups + their imaging studies
  and emits one `followup`-domain `UpcomingItem` per follow-up in its current
  state. Its `FOLLOWUP_PREFIX` (`followup:<carePlanItemId>`) is registered in
  `RULE_FINDING_PREFIXES`.
- **Legibility (#656)** — the item carries a `followup-source` `Reason` ("for
  the 6 mm RLL nodule (2026-03)"), so a bare "follow up in 12 months" reads as
  "Follow-up CT — for the 6 mm RLL nodule". The reason union IS the registry;
  the code was added there deliberately.
- **Resolution is confirm-first (#560)** — when a later matching record lands
  the item switches to a resolvable OFFER carrying `followUpResolve` (the shared
  `FollowUpResolveControls`). The app never auto-resolves; the user records the
  outcome against the later study (`resolveFollowUpCore`). That yields the
  serial view of one finding across time.

**Tier reach (#449, amended by owner ruling 2026-08-01 — #1866).** Care tier: it
reaches Upcoming + the non-hideable **Needs attention** hero (an overdue one
bands `overdue` → the hero's "Past due"), and — since #1866 — the **overdue
state pushes**. v1 scoped the channel out; the owner ruled it in-doctrine with
**zero new settings**: the contact-consent rule requires a user-owned
declaration behind any contact increase, and the follow-up has one — the user
(or their accepted extraction) recorded it as a tracked care item with a due
date. That is the same structure that lets a `must` medication remind without a
"remind me about medications" toggle. The escalation
(`runFollowUpNudges`, `lib/notifications/followup.ts`) is deliberately
conservative — one send when the follow-up crosses overdue, one repeat
`FOLLOWUP_REPEAT_DAYS` later framed as final, then nothing further, with the
finding holding the calm surfaces forever — and its ONLY permanent off-switch is
the **per-item terminator** (`settleFollowUpCore`: "done on \<date\>" /
"discussed, not doing it" with an optional reason, migration 141's `settled_*`
columns), rendered inline where the follow-up renders. It is NOT silenced by an
Upcoming dismissal: the send gate is `isHiddenUnderPolicy` under the item's own
`snooze-only` policy, keyed by the identical `followup:<id>` dedupeKey — a
dismiss is resisted exactly as on the page, a live snooze defers with the
cadence marker frozen. `followup` remains omitted from the digest's
`DOMAIN_SEQ` (the escalation is its own message, not a digest line), and
`condition-review` stays out of push entirely — that is a separate, smaller
decision. Full delivery mechanics:
[notifications](notifications.md#overdue-safety-follow-up-escalation-1866).

### Care-tier persistence contract (#700 ask 5)

An OVERDUE safety follow-up must not fall to the "dismiss once, silence
everywhere" convenience path the way a medication-dose escalation must not
(#171/#227). The contract, decided by state (pure, `lib/followup.ts`
`isFollowUpHidden` / the shared `isItemHiddenBySuppression`), routes through the
ONE `isHiddenUnderPolicy` decision in `lib/lifecycle.ts` (#942) — the same gate
the bus-gated nudges and the dose-escalation carve-out use:

| Signal / follow-up state          | Suppression policy   | Honors SNOOZE (time-boxed) | Honors DISMISS (indefinite) |
| --------------------------------- | -------------------- | -------------------------- | --------------------------- |
| upcoming (due today / future)     | `normal`             | yes                        | yes                         |
| resolvable (later record on file) | `normal`             | yes                        | yes                         |
| **overdue** (past planned date)   | **`snooze-only`**    | **yes**                    | **NO — resisted**           |
| **dose reminder / escalation**    | **`safety-ungated`** | **NO — ignored**           | **NO — ignored**            |

The `safety-ungated` row is the #449 carve-out named as a first-class policy
(#942): missed-dose escalation is the first lifecycle tenant, declaring it in
`ESCALATION_SUPPRESSION_POLICY`. The bus is ignored ENTIRELY — no dismiss and no
snooze can hide it — so a page dismissal can never silence a possibly-critical
medication signal.

An overdue follow-up carries `carePersistent: true`: the shared suppression
filter IGNORES a `dismissed_at` row for it (a page dismiss can never permanently
silence a possibly-missed nodule follow-up), but a live `snooze_until` still
defers it (a deliberate "remind me next week"), and it reappears when the snooze
expires. The surfaces render a **snooze-only** menu (no Dismiss) for it. This is
scoped EXPLICITLY: only the _overdue_ state resists dismiss; an upcoming or
resolvable follow-up is fully suppressible like any finding. The pure pin is
`lib/__tests__/followup.test.ts` (overdue + a dismiss → NOT hidden; + a live
snooze → hidden), and the end-to-end pin is
`lib/__db_tests__/followup-findings.test.ts` (a dismiss on `collectUpcoming`
leaves the overdue follow-up live).

The definitive CLOSE is never a suppression at all: the #1866 **terminator**
(`settleFollowUpCore` — "done on \<date\>" or a declined "discussed, not doing
it" with an optional reason) writes terminal state onto the chain node itself
(`settled_disposition`/`settled_on`/`settled_reason`, migration 141, status
stamped `completed`/`not-done`), so the finding — and its push escalation —
ends because the underlying fact is answered, not because a dismissal hid it. A
settled node is structurally excluded from the builder and from every "open
follow-up exists" idempotency check; deliberately re-tracking the same source
later starts a NEW chain node, which is a new consent.

**The drug-allergy contraindication finding is the second `carePersistent`
tenant (#1092).** The allergy ↔ medication cross-check
(`allergy-med:<allergyId>-<itemId>`, the #1029 engine `crossCheckDrugAllergies`
gathered by `getDrugAllergyWarnings`) is a **safety** care-tier finding: an
active medication meeting a documented, non-resolved allergy. Because a live
contraindication must not be silenced by a convenience dismiss (the same
reasoning as an overdue nodule follow-up and the dose-escalation carve-out), the
`drugAllergyItems` generator sets `carePersistent: true`, so it resolves to
`snooze-only` — a page `dismissed_at` is RESISTED (it re-surfaces on the hero /
Upcoming / Telegram digest) while a live `snooze_until` still defers it, and the
care surfaces render a snooze-only menu. The **both-stand** gating is inherent
in the builder rather than in the suppression policy: the finding disappears the
instant the med goes inactive or the allergy resolves (`getDrugAllergyWarnings`
emits nothing), so there is nothing left to re-surface. This supersedes #1029's
original fully-dismissible framing ("a clinician-reviewed,
deliberately-continued med is common") — that deliberate-continuation case is
served by a time-boxed snooze, not a permanent silence. The calm per-page intake
strip keeps its plain acknowledge-Dismiss (it is not a push surface); the
persistence net lives on the care/push surfaces. Pins:
`lib/__db_tests__/drug-allergy-crosscheck.test.ts` (a dismiss on
`collectUpcoming` leaves it live; a snooze hides it; it dies with either row)
and `e2e/drug-allergy.spec.ts` (snooze-only hero menu; a bus dismissal is
resisted).

**Snoozed & dismissed is the complete window over the bus (#1151).** Upcoming's
"Snoozed & dismissed" section lists EVERY active suppression: care items keep
their rich reconstruction, everything else (coaching findings, suggestions,
warnings) resolves through the ONE prefix-keyed resolver
`lib/suppression-display.ts` (coverage-guarded — a new finding namespace must
add its label with its prefix), and an orphaned key renders as a generic
clearable row (#203). The inline per-surface dismissed lists stay (in-context
restore); both read/write the one store, so they can never drift. Appearing in
this housekeeping section does not escalate a calm-tier item (#449).

### Domain-agnostic core, domain adapters (#700 ask 6)

The chain/state-machine/persistence/resolution-precedence live ONCE in
`lib/followup.ts` (auth-blind, pure). Each finding-producing domain supplies a
`FollowUpAdapter<Source, Candidate>` — three domain questions, nothing else:

```ts
interface FollowUpAdapter<Source, Candidate> {
  kind: string; // stored in care_plan_items.source_kind
  describeSource(source): string; // "6 mm RLL nodule (2026-03)" — the reason "why"
  followUpTitle(source): string; // "Follow-up CT"
  findResolvingRecord(source, followUp, candidates): Candidate | null; // confirm-first OFFER
  describeResolvingRecord(candidate): string; // "CT chest · 2026-03"
}
```

**Imaging** is the first adapter (`lib/followup-imaging.ts`): its resolution
rule is a LATER study of the same modality + overlapping body region (never
cross-modality). A new domain plugs in by (1) appending its own source FK column
to `care_plan_items` (an append-only migration + the same NULL-first row-ops at
every source-record delete/reassign seam — see
`unlinkFollowUpsForImagingStudy` + the import-footprint null-sweeps), (2)
shipping its adapter, and (3) extending the builder's gather. **#698** (IOP
awaiting a glaucoma workup), **#705** (dental "re-eval in 3 months"), **#715**
(skin "recheck in 3 months"), and flagged labs each map onto this exact shape.

---

## Reproductive-health findings stay coaching, always (#1682, #1680)

Two namespaces come out of the cycle/TTC domain, and both are **coaching tier by
hard product contract** — never a notification, never the non-hideable hero:

| Prefix            | Builder                      | Keyed on                              |
| ----------------- | ---------------------------- | ------------------------------------- |
| `cycle-bleeding:` | `buildCycleBleedingFindings` | the period's start day                |
| `ttc-workup:`     | `buildTtcWorkupFindings`     | the DECLARED trying-to-conceive start |

The tier is not a judgement call to revisit per finding. Cycle and TTC are
**observation domains** (§3): nothing in them is a commitment, so nothing in them
can be missed, so nothing in them can be due. A fertility timeline or a body-state
observation arriving as a push would be the single worst delivery this app could
choose for it.

Two further constraints specific to `ttc-workup:`:

- It is gated on the **declared** start (`profile_settings.ttc_start_date`) and on
  `!isMinor(age)`. Recording an LH test or a waking temperature is an observation,
  not a declaration of intent — the system never infers that someone is trying to
  conceive, and the declared-only doctrine means nothing but a user action writes
  that key.
- Keying on the declared start makes a dismissal cover **that attempt**: a later,
  separately declared attempt surfaces its own prompt once (#436), and a dismissal
  is never a topic-wide mute.

The copy is held flat by test, not just by review
(`lib/__tests__/ttc.test.ts`): no encouragement, no odds, no milestone, no failure
language. The #716/#992 sensitivity precedent applies directly.

## Conditions compose with the stack, they don't add a nag (#1727)

Status: **shipped** (photosensitizers × UV, heat-risk meds × heatwave)

A curated safety engine whose trigger is the WEATHER rather than another pill
raises the reach question sharply: the fact is care-tier (an environmental
exposure interacting with an active medication), but the conditions recur, so a
naive implementation would speak most days of a summer. The rules this settled
on, stated once here because the next environmental engine will need them:

- **Enrichment before emission.** When a line about the same event is ALREADY
  firing, the med fact joins it as one clause rather than becoming a second
  finding. A photosensitizer on a day the UV-overexposure heads-up fires enriches
  that line and keys under the SAME dedupeKey, so one dismissal still covers the
  day. Two findings about one afternoon is the failure mode; one richer sentence
  is the fix.
- **A standalone line only where the existing one is silent.** The new
  finding exists precisely for the gap the enrichment can't cover — a strong-sun
  day with nothing logged outdoors yet, so there is no dose to warn about and the
  advice is still actionable. It stands down the moment the overexposure line
  takes over. The heatwave note is the same shape and requires BOTH facts, so a
  merely warm day is silent however many diuretics are in the stack.
- **No new send, ever.** Both notes ride Upcoming, the hero, and the digest that
  already fires. The composition adds no channel, which is the contact-consent
  rule of the attention doctrine: the system may enrich what it was already
  saying, never start saying more.
- **Date-scoped dedupe keys.** The condition is a property of the DAY, not a
  standing fact about the medication, so the key carries the date: a dismissal
  silences today and a genuinely new qualifying day surfaces fresh. (Contrast
  the ototoxic note, whose key is standing because the drug class is.)
- **Obligation-blind (#1505, pinned) and kind-blind.** A `may` photosensitizer
  triggers exactly like a `must` one — obligation governs whether the app
  CONTACTS you about taking something, never whether a drug reacts to sunlight.
  And the stack screened is supplements AND medications: St John's Wort is a
  supplement and a documented photosensitizer.
- **Safety gates itself; it doesn't inherit a calm surface's gate.** The
  weather-SITUATION machinery (#1726) is relevance-gated so five context rows
  don't appear in the life of someone with no reason to care. The safety
  composition deliberately does NOT read through that gate: taking the medication
  IS the reason to care, and a care-tier note must not be silenced by the
  unrelated fact that the user never keyed a supplement to pollen.

---

## Empty safety results are never affirmative all-clears (#1032)

Status: **shipped** (intake safety notices + quiet footer disclosure; the
principle applies to every safety surface)

The safety-logic datasets are, by explicit design, **curated high-value
subsets** (51 interaction rules, 34 PGx entries, 6 ototoxic classes, the
drug-allergy classes, 2 contrast entries, 15 weather-sensitivity classes, …). The principle, stated once here
alongside the #449 tiers: **a safety surface must never let _absence of a
finding_ read as an _affirmative all-clear_; when coverage is partial, say so.**
A profile whose entire stack is off-dataset must not render identically to one
that was genuinely screened against matching rules and came up clean — the empty
one is the more dangerous state.

Concretely (the intake surfaces, the first tenants): when no findings exist, the
page ends with a muted, collapsed **scope disclosure** instead of rendering an
active-warning card or returning silent `null` — "Screened against a curated set
of common drug and supplement interactions — N of M active items match it. No
flags found — a curated check, not an exhaustive one." (`coverageScopeLine` over
`stackScreeningCoverage`, `lib/safety-coverage.ts`; "matched" resolves through
the ONE shared `matchConceptKeys` matcher so the fraction can't disagree with
the detector). The expanded disclosure includes the count of name-only items
with no confirmed RxCUI; that context is deliberately not repeated as a chip on
every medication row. This is a **legibility** fix, not a new warning class: no
red, no interstitial, never prescriptive, and it never asks to grow the datasets
(that's the #1033 depth roadmap). A NEW safety surface with an empty state
(preventive, contrast, dental, a future matcher) adopts the same stance:
distinguish "clear" from "not covered" wherever an empty result renders.

---

## Display units on finding surfaces — the policy (#1019)

A finding/item string that contains a **measurement** (a temperature, a weight,
a distance) renders under one fixed policy — decided once here so no builder
re-litigates it:

1. **Web: the viewer's login pref, always.** Any measurement-carrying string
   either takes the unit at format time (the
   `tempRedFlagTitle`/`tempRedFlagDetail` display parameter,
   `enduranceEventItems`' distance unit) or carries the raw canonical value on
   its envelope for render-time formatting — never a baked-in unit. The web
   boundaries (the Upcoming page, the dashboard hero) resolve
   `getUnitPrefs(login.id)` and thread it into
   `collectAttentionModel`/`collectUpcoming` (`UpcomingDisplayUnits`).
2. **Telegram/notifications: canonical units (kg/km/°F), documented — EXCEPT
   safety-critical temperature, which renders dual-unit** (`fmtTempDual`, "38.5
   °C / 101.3 °F"). Unit prefs are per-**login**; notifications are
   per-**profile** — there is no pref to consult. The digest/recap weight and
   distance lines deliberately stay canonical (dual-unit everywhere would be
   noise); the temperature red-flag nudge is the one safety message where a
   mixed-preference household must read the number correctly either way, so it
   errs toward redundancy.
3. **Identity is display-independent.** `dedupeKey`s and item `key`s never
   depend on the display unit (pinned in `lib/__tests__/temp-red-flag.test.ts`),
   so a dismiss on a °C surface silences the °F and Telegram twins through the
   shared bus.
4. **Cited source text never converts.** A threshold quoted from a curated
   dataset (`entry.line`/`entry.label` in
   `lib/datasets/temperature-red-flags.ts`) is the source's own words and passes
   through verbatim; only app-authored fact clauses convert.

## The reason model — structured "why", carried as data (#656, Track A of #860)

Status: **shipped** (findings/upcoming/notification spine; import-review
`ActivityDupPair.reason` + `SuggestionDraft.rationale` deliberately out of scope
— documented follow-ups)

Many engines decide _due / overdue / prioritized_, and the deciding engine often
produces a good, cited reason — but before #656 those reasons were flattened by
string concatenation into `UpcomingItem.detail` at generation, so a compact
surface (the Telegram digest) could only re-derive per-domain counts and the
"why sooner" never reached the push, and flagged biomarkers carried no reason at
all. `Reason` (`lib/reasons.ts`) is the **first-class, structured** form carried
ALONGSIDE — never replacing — the display `detail`:

```ts
interface Reason {
  code: ReasonCode;
  text: string;
  source?: string | null;
}
type ReasonCode =
  | "risk-elevated"
  | "biomarker-flagged"
  | "situation-active"
  | "followup-source" // a tracked follow-up's source finding (#700)
  | "coaching-held"; // coaching paused by context — an open illness episode (#837)
```

This is **"one question, one computation" at the explanation layer**: the reason
is computed ONCE by the deciding engine and carried as `UpcomingItem.reasons` /
`Finding.reasons` (copied across the bus by `upcomingToFinding`); each surface
is a formatter over it, never a second derivation. The **closed `ReasonCode`
union** keeps the code set honest (a source-scan would be overkill — a union +
the shared-fixture pin suffices, the issue's own call); **`source`** carries
provenance where the reason is citation-backed (the risk rules' ACC/AHA-style
informational citation, threaded through `risk-stratification.ts`'s new
`SourcedReason`).

**Where reasons attach (generators stop flattening).** The Upcoming generators
(`lib/queries/upcoming/generators.ts`) attach `reasons` — the SAME lines the
`detail` string still flattens (display unchanged) — on: the biomarker retest
item (cited `risk-elevated` from `retestModulationFor().sourced` + a
`biomarker-flagged` reason), immunization (`immunizationPriorityFor().sourced`),
preventive visit/screening (text-only `risk-elevated` — the assessor's
pre-merged strings aren't sourced through it yet, a follow-up), and the
**situational dose** (`situation-active` — "Due because Illness is active",
lifted from the medicine-page bare tag so the same explanation can reach the
digest/reminder). The **flagged-biomarker** item (`lib/attention.ts`
`buildFlaggedItem`, gathered by `collectAttentionModel`) gains a
**why-for-this-profile line**: the risk-layer reasons for the flagged analyte —
computed via the SAME `retestModulationFor` over the SAME factors the retest
generator uses — are attached and appended to its detail
(`biomarker-flag-copy.ts`), so a flagged LDL for a family-cardiac-history
profile explains its elevation, not just orders it.

**The digest surfaces the top reason (#656 item 2).** `buildUpcomingDigest`
(`lib/notifications/upcoming-digest.ts`) adds `highlights` — the
highest-priority reasoned items' `primaryReason()` — rendered after the per-band
counts, so the push says WHY the important item matters. `primaryReason()` (the
first carried reason; generators order the cited risk line first) is the ONE
lead-reason computation the digest and the page share.

**The pin (one computation, three surfaces).**
`lib/__db_tests__/reason-model.test.ts` seeds one fixture
(family-cardiac-history + a stale flagged LDL) and asserts the SAME
`risk-elevated` reason string appears on the Upcoming item, the attention-model
item, and the digest highlight — plus the flagged why-line and the
situational-dose reason. Reasons are **explanation only**: they never change a
finding's tier or reach (#449 unchanged).

**`coaching-held` — the "why it's quiet" reason (#837).** Situation-aware
coaching (below) pauses the routine-gap / pace nags during an open
flagged-illness episode. That's not "nothing to say" — it's a deliberate context
hold, so the dashboard coaching card renders a calm HELD note
(`illnessHeldNote()`, `lib/coaching/engine.ts`) carrying a `coaching-held`
reason ("Held — illness episode open"), threaded onto the coaching `Finding` by
`recommendationToFinding` (`Recommendation.reasons` → `Finding.reasons`). It's a
fact about the app's own tracked situation, so it carries no `source`.

## Situation-aware coaching — hold nags during illness, ease back on close (#837)

Status: **shipped**

During an OPEN flagged-illness episode (the `illness_episodes` row covering
today, #856 — the SAME derivation the illness hero/timeline use, never a second
engine), the coaching engine HOLDS the go-train / routine-gap / cardio-gap /
behind-pace nags: `illnessCoachingMode(input.illness, today)`
(`lib/coaching/engine.ts`) returns `held`, `recommendCoaching` skips the
training-side recommendations and emits only the rest recommendation (untouched
— recovery/safety always fire) plus the calm held note. Because BOTH the
dashboard coaching card and the Telegram workout slot read this ONE decision off
the shared `gatherCoachingInput` (`recommendWorkout` returns null in
`held`/`ease-back`, so the workout-reminder slot goes quiet), they can't drift
(#221). **This alters what FIRES, never what's ADVISED** — the recommendations
themselves are unchanged; suppressing a nag during the app's own tracked illness
state is context, not medical judgment (#666's mechanism line).

On episode close, a short **ease-back ramp** (`EASE_BACK_RAMP_DAYS = 3`, from
the episode's exclusive end / first-well day) replaces the immediately-resumed
gap nags with a one-shot, coaching-tier ease-back re-entry recommendation ("a
light session or easy Zone 2 is a good re-entry"), then normal coaching resumes.
The read surfaces show the ease-back rec through the ramp; the notify tick sends
it **once per episode** (`runEaseBack`, `lib/notifications/ease-back.ts`, marker
`notify_ease_back_<episodeId>` — an id-keyed one-shot, #203-safe). The ease-back
push is a deliberate **one-time transition notice**, NOT part of the calm
`collectCoachingFindings` stream the #449 "coaching tier never notifies" rule
governs — it's a single close-of-episode courtesy, in the same family as the
weekly-recap/milestone one-shots. The weekly recap stays honest too:
`illnessDaysInWindow` feeds a "sick N days" recovery line so a sick week reads
as a sick week, not a failed one. Pins: `lib/__tests__/coaching-illness.test.ts`
(pure hold/ramp), `lib/__db_tests__/coaching-illness.test.ts` (gather → card AND
workout slot agree end-to-end).

**Reported-burden rest tilt (#1300).** Today's SELF-REPORTED load — logged
`symptom_logs` severities + the check-in Energy tap (mood store) — tilts
coaching toward an easier session, in the SAME rest-recommendation family as the
\#1292 declared poor-sleep tilt (it is another `RestReason`, not a new engine,
and NOT a #45 findings builder — it needs no `RULE_FINDING_PREFIXES` entry). The
ONE pure computation is `computeReportedBurden` (`lib/reported-burden.ts`,
gathered by `getReportedBurden` in `lib/queries/reported-burden.ts` and threaded
on `CoachingInput.reportedBurden`): a conservative threshold (a single SEVERE
symptom, OR moderate burden across several, OR low energy — clean-signal, never
a number, never calendar-based) yields a basis-aware `rest-symptom` reason
naming the actual report ("You logged severe cramps today — consider an easier
session"; "Energy's low today — an easy session may serve better"). **Tier:** it
rides the rest recommendation, so it reaches the dashboard coaching card, the
Training overview, and the Telegram workout nudge exactly as the existing rest
tilts do — self-report is sufficient basis (#1292's user-wins symmetry; no
sensor gets a veto). **Precedence (all in the pure engine):** the illness HOLD
(#837) OUTRANKS it — an open flagged episode already holds routine nudges, so
`restReasons` gates the `rest-symptom` reason OUT under `held` (no
double-speak); it composes with injury temper unchanged; and because it is just
another rest reason, it COLLAPSES with the poor-sleep tilt into ONE rest rec
(primary + `Also:`), never two. Period context (#1298) is FRAMING only — it
never fires the tilt, but when it's on and a symptom fired it the copy may
mention it. Pins: `lib/__tests__/reported-burden.test.ts` (threshold matrix +
copy), `lib/__tests__/coaching-reported-burden.test.ts` (firing + precedence +
collapse), `lib/__db_tests__/reported-burden.test.ts` (gather → card
end-to-end), `e2e/checkin-card.spec.ts` (well-day entry → tilt).

---

## Documented exemption — intake suggestions are proposals, not findings (#662)

Status: **shipped** (exemption; the divergence is deliberate, not a gap to
close)

AI supplement/medication suggestions (`intake_item_suggestions` — the
`rationale`/`trigger`/`model` provenance columns; produced by
`generateAndStoreSuggestions` in `lib/supplement-suggest.ts`, surfaced on
Nutrition → Supplements with per-row **Accept**/**Dismiss** —
`acceptSuggestion`/`dismissSuggestion` in
`app/(app)/nutrition/supplement-actions.ts`) are a **parallel mechanism**: they
never become `Finding`s and their dismissal does NOT flow through the shared
`upcoming_dismissals` bus. That is the RIGHT call — this is the exemption, so
the next engine doesn't route a proposal through the findings envelope by
copying the "every surface renders the SAME Finding through the shared bus" rule
where it doesn't apply.

**Why a suggestion is not a finding.** A `Finding` (#449) is an **observation**
about existing state — a flagged marker, a preventive gap, a routine lapse —
that the user reads and, at most, dismisses; dismissing it says "I've seen this,
stop showing it," and the shared bus makes that one dismissal silence every
surface (page, hero, Telegram) because they're all views of the ONE observation.
A suggestion is the opposite shape on three axes:

- **It has a materialization step, not just a read.** `acceptSuggestion` INSERTs
  a brand-new `intake_items` row with parsed doses (`insertDoses`) and flips the
  suggestion to `status='accepted'`. "Accept" creates a first-class tracked
  entity; a finding has no analog to that — there is nothing for a finding's
  dismissal bus to model. Routing a proposal through the findings envelope would
  give it a dismiss-everywhere semantic while stranding its
  accept-and-materialize semantic outside the model.
- **Its terminal state lives on its own row, id-keyed — there is nothing to
  re-key (#203).** Dismissal is
  `UPDATE intake_item_suggestions SET status='dismissed' WHERE id=?` — an
  integer-id-keyed row transition (`pending → accepted | dismissed`), never a
  name/code-keyed `dedupeKey` in `upcoming_dismissals`. So it needs no
  name-keyed re-key on rename/merge and can't drift the way a string-keyed
  suppression can. The bus buys it nothing.
- **It's user-initiated and one-shot, not a standing signal.** A finding
  recomputes every load from live state and keeps reappearing until the
  underlying fact changes; a suggestion is generated on the user's explicit
  **Generate** tap and then sits in one of three states forever. It's a
  generative proposal with provenance, closer to the suggest-only
  **materialization** pattern (#560 — "confirm-first, never a silent insert",
  the same shape as the condition-suggestion accept) than to an observational
  finding.

**Tier fit (#449).** It belongs to neither reach tier: not **care** (no push —
it is never a nudge; the user opts into generation), not **coaching** (the
coaching tier is _observations_ aggregated by `collectCoachingFindings`; a
suggestion is a proposal, not an observation, and materializes rather than
merely informs). The suggest/accept/dismiss surface on the Supplements tab is
the whole of its reach, by design.

**What WOULD change this.** If a suggestion ever needed to (a) reach a second
surface that also had to honor one dismissal, or (b) suppress a corresponding
observational finding when dismissed, it would then owe a shared `dedupeKey` and
a bus entry — but that would be a real observation riding alongside the
proposal, registered in `RULE_FINDING_PREFIXES` like any finding. Until then,
the parallel mechanism is correct and this exemption is why.

---

# The attention doctrine

Status: **shipped** · first implemented by #1505 (intake obligation); extended by
#1718 (channel honesty), #1670 (frequency-target right-sizing across practices,
training frequency goals and food groups) and #1668 (mood check-in auto-pause) as
they land.

The two-tier reach policy above answers "how far does a SIGNAL travel". That
turned out to be one question inside a larger one the codebase kept answering
per-feature: **when may the system take a person's attention, and what may it do
with their own declarations?** #1505 forced the general answer out into the open,
so it lives here rather than being re-derived in each domain.

## 1. The surface taxonomy — who initiates

Every surface in the app falls into exactly one of three classes. The class is
decided by **who initiates the contact**, not by which channel it uses — Telegram
appears in all three, and that is the point.

| Class                         | Who initiates               | Examples                                                                                                  | Rule                                                                                                                 |
| ----------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **1. System-initiated sends** | the system, unprompted      | dose reminders, missed-dose escalation, refill nudges, the morning digest, the weekly recap               | Costs the user's attention. Needs a standing reason and an obligation behind it.                                     |
| **2. Rendered aggregates**    | the user, by opening a page | Upcoming, the dashboard hero, the #1504 count, the Household card                                         | Costs nothing until looked at, but competes for scarce space — so it ranks and folds rather than listing everything. |
| **3. User-initiated access**  | the user, by asking         | the Supplements page, quick-log overlays, the digest's "Log other…" tail, a reminder's More… row, `/dose` | Costs nothing. Must be COMPLETE — anything the user owns has to be reachable here, or it is effectively deleted.     |

Two consequences that are easy to get wrong:

- **Removing something from class 1 does not mean removing it from class 3.**
  #1505's `may` items are never pushed and always reachable. A model that only
  had "push it" and "drop it" is what produced the incoherent middle state the
  issue was re-specced to remove.
- **Class 2 collapses, it does not filter.** A `may` item still appears on
  Upcoming — inside a disclosure, labelled _available_, not _due_. Demotion is
  then a visible MOVE rather than a disappearance, which is what makes the
  affordance trustworthy enough to use.

## 2. The contact-consent rule

> The system may **reduce** contact unilaterally. It may never **increase**
> contact, or rewrite user-owned state, without the user's consent.

The asymmetry is deliberate: being contacted less is recoverable and costs
nothing to try, while being contacted more spends something the user cannot get
back, and a silent state rewrite destroys the ground truth every other surface
reads. Three corollaries carry the weight in practice:

**Ride-the-nag.** A suggestion may only DECORATE a send that already exists for
its own reasons. #1505's demotion suggestion appears as a third button on the
dose reminder the item was already generating — never as its own message.
Corollary of the corollary: a suggestion about an item that has stopped
generating sends has no delivery path, and that is correct, not a gap.

**Ride-the-nag applied to a structural signal (#1685, owner-decided 2026-07-30).**
A broken integration is the same shape one level up. It is not a rule-engine
finding — it carries no `Finding`, no builder, and no bus suppression (structural
signals are non-suppressible: you reconnect them, you don't snooze them), so it
is deliberately NOT in `RULE_FINDING_REGISTRY`, for exactly the reason `refill:`
and `pool-refill:` aren't — the registry's reflection guards read builder output,
and a namespace no builder emits would fail them. Its reach question is still the
same one: how far may it travel?

The answer is **the daily digest and nothing else**. It reaches Upcoming, the
dashboard hero and Data → Review as it always did, and it is now counted and
NAMED in the morning digest — the one message that was already going to send.
There is no dedicated notification and no escalation.

Why it earns a push channel at all, when `condition-review` and `med-monitor`
are deliberately kept off it (and `followup` earned its own dedicated send only
by the explicit #1866 owner ruling): this is the one signal whose entire
purpose is to work while the user is NOT looking. An integration exists so data
flows without opening the app, which makes a dead one precisely the state its
owner is least likely to notice, and a revoked grant is unrecoverable without
their re-consent, so waiting never fixes it. A signal that only reaches surfaces
you must open to see inverts the feature it is reporting on. That is a reach
argument, not a severity one — which is why it stops at decorating an existing
send rather than earning its own.

**Ride-the-nag applied to a portal SYNC REQUEST (#1757).** The same argument, one
step further along: a portal run cannot happen without a person at a specific
machine, so the signal's whole job is to reach that person. It is a real row
(`portal_sync_requests`) with a real dedupe key, and unlike a broken integration
it IS registered in `RULE_FINDING_REGISTRY` — under the `portal-sync:` prefix,
`coaching` tier — because it rides the ordinary suppression bus and its dismiss
must be guardable and nameable in "Snoozed & dismissed". (It is registered
without being a rule-findings builder; the Upcoming generator emits it, so the
`collectCoachingFindings` reflection guards never see it, exactly as the
suppression-only poor-sleep override entry is registered.)

Its reach is the strictest shape this doctrine allows:

- an **Upcoming item**, dismissible;
- **one digest line**, named rather than merely counted, on the message that was
  already going to send;
- and **nothing else — no dedicated send, ever.** It is also excluded from the
  non-hideable "Needs attention" hero by `cardBandForItem`'s named domain set,
  which is the difference between this and the broken-sync signal beside it: a
  dead connection is a fault you must repair, while "somebody should run the
  portal tool this week" is an ask, and an ask that cannot be dismissed is a nag.

The reach argument is #1685's verbatim — an attended sync exists so records
arrive without you thinking about it, so the state of "nobody has run it in five
weeks" is precisely what its owner will not notice — and the severity answer is
the opposite: portal hygiene is never a safety signal, and a request that nobody
acts on **expires** rather than escalating.

**A keyboard edit is not a send; an edit that would notify is.** Telegram's
`editMessageReplyMarkup` changes a message the user already received and does not
ring their phone. That is what lets #1505's offer tail stay accurate across slot
boundaries — the tick relabels the collapsed button at each boundary, costing
zero interruptions. The test of whether a mechanism is a "send" is whether it
consumes attention, not whether it makes an API call.

**Confirm to KEEP, never confirm to stop.** When a flow reduces contact, do it
and say so; when a flow reduces the user's SAFETY NET, state the consequences and
ask. #1505's medication guardrail is the second shape: a medication defaults to
`must`, and moving it below must asks "no reminders, no escalation, no
missed-dose safety net — continue?". It is asked on the transition only, never
re-asked on unrelated edits, and it names what is lost rather than saying "are
you sure?".

## 3. Commitment domains vs observation domains

An **obligation** only exists where the user has committed to future behavior.
Domains that merely RECORD what happened have nothing to demote, and trying to
give them a priority band is how a model acquires a meaningless field.

| Domain                                          | Commitment? | Its `may`-equivalent state                          |
| ----------------------------------------------- | ----------- | --------------------------------------------------- |
| Intake (supplements, medications)               | yes         | `obligation = 'may'` — tracked, offered, never due  |
| Wellness practices                              | yes         | logs-only: the practice exists, no pace target      |
| Goals                                           | yes         | filed away: kept, not paced                         |
| Food groups                                     | yes         | excluded: off the suggestion engine, still loggable |
| Body metrics, labs, sleep, symptoms, activities | **no**      | n/a — an observation cannot be missed               |

The right question when adding a domain is therefore not "what priority band does
this get" but "**did the user promise anything?**" A no makes obligation
inapplicable, and the domain's quiet state is simply "we still record it".

## 3b. Runs are not a reportable shape (#1935/#1936/#1937/#1939)

An owner ruling that belongs beside the obligation table, because it settles what
the system may COUNT rather than what it may send. A figure that measures an
unbroken RUN — consecutive days active, consecutive days with every due dose
taken — is not reported to the user, on any surface, in any domain.

The objection is not that runs are unmotivating. It is that a run has a **cliff
where a rate degrades gracefully**, and the cliff lands on exactly the behaviours
this app exists to accommodate: a deload week, a rest-day recommendation, an
illness episode that pauses schedules, a travel week, a deliberate skip (#232).
The app cannot recommend rest on one side of a screen and print "you broke your
run" on the other. A run also measures continuity of APP-LOGGED behaviour rather
than health, which fails the same test the coverage rule applies elsewhere.

What was retired, and it was very nearly the whole family at once: the
weekly-recap streak line (#1935), the per-supplement 🔥 chip and its Telegram
note (#1936), the Training/Journal activity streak on four surfaces (#1937), and
the `streak:` / `adherence:` milestones — mint AND existing rows, via migration
148 (#1939). #1966 then took the one sibling that sweep missed: the Trends
Practices lens's "N-week streak", which the first pass read past because it
counted WEEKS rather than days. The unit is not the test; the cliff is.

What survives, and why the line falls there:

- **Rates and totals.** Adherence %, active days, workouts logged, and the
  Practices lens's "floor met in N of M completed weeks" over its per-week
  cadence ledger. A missed day or week NUDGES these; it cannot zero them.
- **Milestones that cannot be broken.** `workouts:` (gaps do not undo a total)
  and `goal:` (a user-declared intent met). Push stays on for both: they fire a
  handful of times a year, and a rare positive send does not compete with the
  safety tier.
- **Runs the system reads but never shows as an achievement.** The coaching
  overtraining detector counts consecutive hard-session days to say "a rest or
  light day will help you recover" — the app telling you to STOP. Same math,
  opposite direction; `lib/__tests__/streak-scope.test.ts` pins it as the only
  surviving caller of `lib/streak`. The intake-delta engine likewise reads a
  broken taken-run as EVIDENCE that something changed, and reports the change,
  not the run.
- **Counts that ARE the thing being tracked, not a proxy for using the app.**
  Substance-use abstinence days, ruled kept in #1966: superficially run-shaped,
  but it is a clinical figure, and removing it would lose real information
  rather than remove a scoreboard.
- **Counters that back the system OFF.** The mood check-in's ignored-day pause
  counter, also ruled kept in #1966. It is not a reward in any direction: it
  exists so the app asks LESS, which the contact-consent rule permits
  unilaterally. Nothing to retire.

The test for a new case is the direction of the cliff: a run the system uses to
reduce what it asks of you is fine; a run the user can lose is not. "Run-shaped"
was never the test on its own — #1966 is the case that makes this explicit, since
abstinence days and the pause counter are both run-shaped and both fail the
actual test, in opposite directions.

## 4. The right-sizing family

Several issues converge on one pattern: the system NOTICES that a commitment has
drifted from reality and offers to shrink it. Members share four properties, and
a new member should adopt all four rather than re-deciding them:

1. **Revealed-preference detection.** The evidence is what the user actually did
   — an adherence ledger, a completion history — never a self-report or a guess.
2. **Suggest, never write.** Detection produces a candidate; the user's tap is
   the change. Auto-apply is permanently out of scope (#1505), because a silent
   write to a declared field destroys the only ground truth the system has.
3. **Recovery clears it.** Detection is a pure function of a trailing window, so
   resumed behavior makes the suggestion disappear on its own. No stale
   suggestion, no dismissal bookkeeping to keep it away.
4. **Downward only.** Suggesting LESS commitment is offering relief; suggesting
   MORE is manufacturing obligation, which is a different risk class the system
   does not take on. Promotion stays manual.

**Window-coherence convention.** A right-sizing engine and any reporting engine
over the same ledger must use windows that NEST strictly, so the two can never
fire off the same evidence and contradict each other. #1505 pins
`INTAKE_DELTA_DAYS` (14, "what changed this fortnight") strictly inside
`DEMOTION_WINDOW_DAYS` (30, "has this been abandoned this month") with a unit
test. #1670 pins the same shape on its own pair: the weekly pace window every
frequency-target surface reads (`FREQUENCY_PACE_WINDOW_DAYS`, 7 — "you're behind
this week") sits strictly inside `RIGHTSIZE_WINDOW_DAYS` (28 — "you have been
under this floor for a month"), asserted in
`lib/__tests__/target-rightsize.test.ts`. The two right-sizing windows are also
kept within a week of each other, so "abandoned" means roughly the same span of
life whichever domain says it.

### 4a. The members, and the may-state each one lands in

Every member's accept must land in a state the domain ALREADY has. Inventing a
new "reduced" state per domain is how this family would fragment; the point of
the table is that each row's right-hand column existed before the suggestion did.

| Member                          | Detected from                             | Suggests                         | Lands in                                                   |
| ------------------------------- | ----------------------------------------- | -------------------------------- | ---------------------------------------------------------- |
| Intake obligation (#1505)       | the item's adherence strip over 30 days   | move to `may`                    | `obligation = 'may'` — tracked, offered, never due         |
| Wellness practice (#1670)       | `practice_logs` days per completed week   | lower the floor · stop tracking  | logs-only practice (#1621) — sessions kept, no weekly goal |
| Training frequency goal (#1670) | distinct training days per completed week | lower the target · stop tracking | untracked routine — every logged session stays             |
| Food group (#1670)              | logged servings per completed week        | lower the target · stop tracking | untracked habit — the food log is untouched                |

Two boundaries the table is deliberately silent about, because they are
non-members rather than gaps:

- **Substance-use ceilings are not in this family and never will be.** A
  `substance` frequency target's `per_week` is a weekly CAP, so "chronically
  under it" is that scope's SUCCESS state and a right-sizing suggestion there
  would nudge toward more consumption. It is excluded at
  `rightSizeDomainFor` — the same boundary `getFrequencyTargetProgress` already
  draws — not at a call site someone could forget.
- **Dietary EXCLUSION is not a right-sizing accept.** Declaring "I don't eat
  dairy" is a statement about a diet, not about a missed target, so it stays a
  Settings → Nutrition declaration. Right-sizing a food habit stops the weekly
  ask and leaves the group loggable, which is the domain's actual
  no-expectation state.

**The three #1670 domains share ONE detector, not three.** All of them declare
their floor as a `frequency_targets` row, so `lib/target-rightsize.ts` is one
pure engine with per-domain FORMATTING (the unit word, the stop label, the
surface), one registered dedupeKey prefix (`right-size:`, coaching tier), and one
set of accepts in `app/(app)/rightsize-actions.ts`. The tier, the suppression bus
and the guardability property are properties of the SIGNAL, which is identical
across them.

Two implementation conventions worth reusing in a fourth domain:

- **The suggested floor is the BEST week in the window, never a median.** Every
  week in the window is at or below it, so accepting SELF-CLEARS the chronic
  condition. A median would leave half the window still under the new floor and
  re-fire immediately at a lower number — a ratchet, which is the nag the family
  exists to end.
- **The accept re-derives the candidate; the surface never posts the number.**
  Both the in-app buttons and the Telegram ride-along carry the dedupeKey (or the
  target id) alone, so the only floor that can ever be written is the one the
  detector is currently suggesting, and a card left open while the cadence
  recovered refuses with a typed outcome.

**Reach, stated once for the whole family:** coaching tier, calm and hideable,
with no send of its own — ever. #1670's only push presence is one extra button on
the pace nudge that was already firing for the target's own reasons
(`lib/notifications/practices.ts`), which is ride-the-nag in its strictest form.
That button is governed by DETECTION STATE ALONE and is deliberately not
bus-gated: an in-app dismiss means "keep asking me about this practice", which is
a statement about the card, not about whether a message already being sent may
offer relief. A target that has stopped generating its nudge therefore has no
delivery path, and that is correct rather than a gap.

## 5. Care/coaching ↔ obligation: a correspondence, not a rename

The findings tiers and the obligation levels are adjacent, and it is tempting to
collapse them. They stay separate, because they describe different things:

- A **tier** describes a SIGNAL's reach — how far this particular observation may
  travel.
- An **obligation** describes a COMMITMENT's weight — what the user owes this
  item.

One item can carry signals of both tiers at once: a `may` supplement still
produces care-tier interaction warnings (the safety engines are obligation-blind,
pinned by test), while the demotion suggestion ABOUT it is coaching tier. The
useful mapping, stated so the two vocabularies cannot drift apart silently:

| Obligation | Its routine dueness signal reaches                            | Note                                                         |
| ---------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| `must`     | care tier — Upcoming, hero, reminder, escalation              | escalation additionally needs the per-item `critical` opt-in |
| `should`   | care tier minus escalation — Upcoming, hero, reminder         | a miss is a tracked shortfall, never chased twice            |
| `may`      | no push; the Upcoming disclosure + user-initiated access only | ≈ a coaching-tier signal in reach                            |

The correspondence is about ROUTINE DUENESS only. A safety finding's tier is
decided by the finding, never by the obligation of the item it names — that
boundary is the one thing in this document that has no exceptions.

### 5a. The conservative-direction rule

Obligation-blindness answers whether a safety finding may FIRE. A second question
sits behind it: when a safety-adjacent finding is computed from an aggregate, may
obligation change the NUMBER? Sometimes yes — but only ever in the cautious
direction, and the cautious direction is not the same for every aggregate.

State the aggregate's polarity first, then apply the rule:

| The number is a…                        | Obligation may never… | So a `may` item is…                               |
| --------------------------------------- | --------------------- | ------------------------------------------------- |
| **risk** total (bigger = worse)         | shrink it             | counted at full weight, and LABELLED as such      |
| **reassurance** share (bigger = better) | inflate it            | excluded from the figure, and DISCLOSED beside it |

Both anchors live in `lib/dri.ts` over one shared summation:

- The **upper-limit (UL)** warning is a risk total. A `may` item contributes its
  full daily amount and `ulWarningDetail` appends "including as-needed items".
- The **RDA adequacy** note is a reassurance share. It is computed from committed
  (`must` + `should`) intake only, and `rdaAdequacyDetail` names the on-demand
  remainder as an aside that is explicitly outside the share.

Two consequences worth stating because both were once violated:

1. **The upstream gate stays obligation-blind.** `contributesToDailyLimit` filters
   on SCHEDULE alone. Obligation is applied per question, downstream, where the
   direction of caution is known — a single upstream filter would silently force
   one direction on both questions.
2. **Neither direction is allowed to make a nutrient disappear.** Excluding an
   amount from a share is not the same as dropping the row: a nutrient the user
   supplements is still reported, because going quiet about it is the outcome the
   demoting user least expects and least wants.

The trap this rule exists to catch is a lossy vocabulary translation. Pre-#1505
`as_needed` asserted a FACT about the schedule ("no standing daily intake"), so
excluding it from a daily total was sound. `may` asserts only a WISH about pushing
("don't nudge me"), and a daily item demoted to `may` is usually still taken every
day. Carrying the old exclusion across the collapse therefore lost real
milligrams — and with them a UL warning the user needed precisely because nothing
was nudging them any more. When a field's meaning widens, re-derive every
predicate that read it; do not translate it literally.

## 6. A message never references an affordance its channel strips

Added by #1718. The obligation model decides WHETHER to contact someone; this rule
decides whether the message that arrives is honest about what the person can do
with it.

Web Push carries only title, body and a single click-through URL — it drops
`actions` entirely — and the Home Assistant webhook forwards content for an
automation to present. So a builder whose copy says "tap the button below" is
telling a push user to tap something that does not exist. Every actionable message
must therefore take one of two roads:

- **Be excluded from actionless channels.** Right when the buttons ARE the content:
  the food nudge ("Tap what you've eaten to log a serving" — #692) and the mood
  check-in ("One tap logs your day" — #1718) have nothing left once the buttons go,
  so `PUSH_UNDELIVERABLE_KINDS` treats them as a no-op success rather than
  delivering an empty instruction.
- **Carry a `url` action and channel-neutral copy.** Right when the message has real
  content and the buttons are a shortcut: the practice check-in and the household
  round state what is behind/due and offer "Open …", which works everywhere. A
  url-bearing action doubles as the push notification's click-through target
  (`pushClickThroughUrl`), so the tap opens the exact page rather than the app root.

Two corollaries, both #1718:

- **A kind that dispatch can emit must be routable.** A message carrying
  `kind: "other"` cannot be muted or routed per channel and is indistinguishable to
  an HA automation, so it silently opts out of the matrix the settings page
  advertises. Every dispatched kind has a registry row or an explicit
  `NON_CONFIGURABLE_KINDS` reason (`lib/notifications/kinds.ts`), and
  `notification-kinds.test.ts` pins the partition.
- **The send-test is never gated.** Its whole job is proving the wiring works, so it
  carries `kind: "test"` on every channel — a user who muted a kind must not read
  their own mute as a broken subscription.

## 7. Confirm-to-KEEP is the consent shape for contact REDUCTION

Added by #1668. §2's contact-consent rule governs STARTING contact and CHANGING
user-owned state. Stopping contact is the other direction, and the usual
suggest-and-confirm shape inverts badly there.

A "tap to pause these?" question is self-defeating: if ignoring it keeps the
reminders coming, the disengaged user is nagged forever — the exact harm the
sensitivity contract forbids; if ignoring it pauses anyway, the confirmation was
theater. So a reduction the system is entitled to make unilaterally is
**announced, not asked**, and the affordance offered is the opposite one: keep
going.

**Worked example — the mood check-in auto-pause (#992/#1668).** The reminder
holds itself once `MOOD_CHECKIN_AUTOPAUSE_DAYS` sends go unanswered. The
mechanism was already right (it writes no user-owned state: `enabled` stays
true and the hold is derived), but the silence read as "notifications broke".
The fix adds no sends: the check-in that would exhaust the streak — one that was
going out anyway — carries one extra line and a **[Keep daily check-ins]**
button. Tapping resets the streak; ignoring lets the pause proceed exactly as
before, now as informed silence. The paused state is then visible and resumable
in-app, still as presentation of derived state rather than a new stored flag, so
`shouldSendMoodCheckin` remains the single decision and one streak-reset write
serves all three entry points (a logged mood, the button, the Resume action).

The tone constraint is part of the pattern: an announcement of reduced contact
must carry no guilt and no streak language, or it becomes the pressure it exists
to remove.

## 8. A preference filter never overrides a safety floor

Added by #1714. §2 permits the system to REDUCE contact unilaterally and §7 gives
reduction its consent shape. This rule bounds what the USER's own reduction can
reach.

A per-category preference — the morning digest's ⚙️ Tune demotion is the first —
is a statement about ROUTINE lines: "stop telling me about this by default". It is
never a statement about the safety-adjacent class, and the code must make that
structural rather than a matter of ordering. Two properties carry it:

1. **The floor predicate implies the notable predicate.** In
   `applyRecentChangeDemotion`, `flagged` implies notable, so a flagged lab or an
   out-of-range vital survives every preference no matter which category it belongs
   to. There is no filter ordering that can hide one, because there is no filter
   that accepts one.
2. **A category whose every line is floor class is still tunable, and the floor is
   what answers.** #1714 originally withheld `labs` on the argument that a toggle
   which provably changes nothing is a lie about what the user is deciding; the
   owner retired that intersection in #1797. The set is now derived from the
   collector's registry plus the digest's own sections, with nothing subtracted, so
   a new category cannot silently become untunable — and `labs` states the boundary
   in its own copy ("A flagged result always appears — turning this down never hides
   one") instead of hiding it behind a missing control. Property 1 is what makes
   that safe: the toggle stores, the digest reads it, and the flagged result arrives
   regardless.

The corollary on the message side: the guaranteed-access core (#1505's
minimal-digest rule, the offer tail, the Today obligations) is the MESSAGE's job,
not a category, and therefore not demotable. Demoting everything makes the message
short; it can never make it vanish.

The predicate a demotion checks is always the classification the surface ALREADY
computes (`sleepVerdict` for a night, the mood shift against the subject's own
average, a severe symptom-day). A preference filter that minted its OWN threshold
would be a second definition of "notable" — the #221 drift these rules exist to
prevent, and a place where a user's display choice could quietly change what counts
as clinically interesting.

## Where each rule is enforced

| Rule                                                    | Enforced by                                                                                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Obligation decides push; kind decides clinical identity | `isPushedIntake` / `accruesMisses` / `escalatesOnMiss` (`lib/supplement-schedule.ts`)                                                                                                                   |
| Safety engines are obligation-blind                     | `lib/__db_tests__/intake-obligation-lifecycle.test.ts`                                                                                                                                                  |
| Conservative direction per aggregate (5a)               | `lib/__tests__/dri.test.ts` + `lib/__tests__/supplement-schedule.test.ts`; `e2e/dietary-limits.spec.ts` (full weight) and `e2e/rda-adequacy.spec.ts` (excluded + disclosed) pin the opposite directions |
| Suggest-never-write                                     | `demoteIntakeObligation` is the only obligation-lowering write, and it is called only from a user action                                                                                                |
| Reconciliation only ever REDUCES a message's claims     | `lib/notifications/reconcile-core.ts` emits close/strip only; predicates read the ledger and never the suppression bus (`lib/__db_tests__/message-reconcile.test.ts`)                                   |
| Preference filters never override safety floors (8)     | `flagged` ⇒ notable in `applyRecentChangeDemotion`, so a tuned-down `labs` still delivers its flagged result; `lib/__tests__/digest-tune.test.ts` + `lib/__db_tests__/digest-tune.test.ts`              |
| Recovery clears a suggestion                            | pure detection over a trailing window (`lib/supplement-demotion.ts`)                                                                                                                                    |
| Window nesting                                          | `lib/__tests__/intake-demotion.test.ts`                                                                                                                                                                 |
| Reach tier per finding namespace                        | `RULE_FINDING_REGISTRY` + its reflection guards                                                                                                                                                         |
