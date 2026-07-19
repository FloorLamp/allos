# Findings reach — the two-tier policy

Status: **shipped** · extracted verbatim from AGENTS.md (#597; the policy was decided in #449)

How far a rule-engine finding travels — page, dashboard hero, notification — is a deliberate two-tier decision, not a per-feature accident. This page holds the full policy and how a new engine joins a tier; the one-line rule stays in AGENTS.md's conventions.

---

**Findings reach is a two-tier policy — decide it on purpose (#449).** The #45 rule engines split into two reach tiers. The **care tier** (preventive findings, drug-interaction/dietary-limit items, and the illness-care duration/trajectory findings — #805) is _push_: it reaches Upcoming, the dashboard **Needs attention** hero, AND the Telegram nudge (one assessor). The **coaching tier** — the four observational builders (`buildTrainingObservationFindings`/`buildBodyHygieneFindings`/`buildGoalPacingFindings`/`buildAdherencePatternFindings`, aggregated by `collectCoachingFindings`) — is _calm/observational_: it reaches its own tab AND the hideable dashboard **Coaching observations** rollup, but **never a notification and never the non-hideable hero** (reach without noise). A new observational engine joins the coaching tier by adding its builder to `collectCoachingFindings` and its dedupeKey prefix to the registry; it does NOT get a push channel unless it's genuinely _care_. Every surface renders the SAME `Finding` (one computation) with the SAME dedupeKey, so a dismiss on any surface silences it on all of them through the shared bus.

---

## The finding-producing builder registry (#860 Track A, extending #448)

`lib/rule-finding-prefixes.ts` is the ONE registry that binds three facts per finding namespace — **prefix + tier + reason source** — so the tier decision above can't be made by accident and can't drift from the code. Each `RULE_FINDING_REGISTRY` entry is `{ prefix, tier, builder, reasons }`:

- **prefix** — the dedupeKey namespace the builder keys under (the #448 guardability property: a page's prefix-guarded dismiss action must be able to match it). `RULE_FINDING_PREFIXES` and `dedupeKeyHasKnownPrefix()` are derived from the registry, unchanged for existing consumers (the dismiss actions in `app/(app)/actions.ts`).
- **tier** — `"care"` or `"coaching"` (#449). `tierForDedupeKey(key)` resolves it. The **coaching** members are exactly the builders `collectCoachingFindings` aggregates; the **care** members are the push builders (`buildIllnessCareFindings`, `tempRedFlagItems`, `conditionReviewItems`, `followUpItems`) that reach Upcoming/hero and are deliberately NOT in `collectCoachingFindings`.
- **reason source** — the closed set of #656 `ReasonCode`s a finding under this prefix may carry (empty for the common no-reason builder; `["followup-source"]` for the follow-up loop). `ReasonCode` is backed by the enumerable `REASON_CODES` array in `lib/reasons.ts`, so `declaredReasonCodesFor(key)` is checkable and a builder can't attach an undeclared code.

**The teeth** (the source-scan / #448 precedent — registry is data, enforcement is a reflection test):

- **Un-registered emission fails CI.** The #448 reflection guard (`rule-findings-builders.test.ts`) asserts every builder-emitted dedupeKey `dedupeKeyHasKnownPrefix`.
- **A tier the code doesn't match fails CI.** Every key `collectCoachingFindings` emits must `tierForDedupeKey === "coaching"`; every care builder's key (asserted in each builder's own fixture DB test — `followup-findings` / `condition-suggestion-findings` / `illness-care-findings` / `temp-red-flag-findings`) must resolve `"care"`. So a coaching builder registered `care` (or vice versa), or an omitted registration, fails CI.
- **An undeclared reason source fails CI.** A finding whose `reasons[].code` isn't declared for its prefix fails the reflection guard.
- Pure structural invariants (unique, non-overlapping prefixes; both tiers populated; valid reason codes) are pinned in `lib/__tests__/rule-finding-registry.test.ts`.

**Adding a new finding engine:** add one `RULE_FINDING_REGISTRY` entry (prefix + tier + declared reason codes) and its own fixture DB test (the #448 rule), which asserts its tier via `tierForDedupeKey`. You cannot ship a finding without declaring how far it reaches.

---

## Illness-care findings (care tier, #805)

The illness-care engine (`lib/illness-care.ts`, builder `lib/illness-care-findings.ts`) is a **care-tier** member: a logged symptom in the profile's current open illness episode (the #801 `assembleIllnessEpisode` assembly — no second gather) that has crossed a **cited duration or trajectory line** becomes a push finding. Its dedupeKey prefix (`illness-care:`) is registered in `RULE_FINDING_PREFIXES` (so the #448 reflection guard proves the keys are guardable) even though it is a push builder, not a coaching one — it is NOT part of `collectCoachingFindings`. It reaches Upcoming + the hero as an `illness-care`-domain `UpcomingItem` banded `today` (via `illnessCareItems` in the Upcoming generator fan-out) and the Telegram nudge via `runIllnessCare` (`lib/notifications/illness-care.ts`), all keyed by the SAME dedupeKey through the shared bus.

**Thresholds are a curated, per-entry-cited dataset** (`lib/datasets/data/illness-thresholds.json`, the #798 prn-defaults pattern), keyed by the #799 symptom slugs. Every finding states the logged **fact** + the cited **line** + the **source** + an "informational, not medical advice" tail — never "you should", never a diagnosis. No dataset entry for a symptom ⇒ no finding for it, ever; age bands are the SOURCE's own (infant fever renders the "contact a clinician" refusal, never a number we computed), applied only when age is known.

**Hard non-goal — no symptom-combination triage.** The engine judges ONE symptom against ONE citable duration/trajectory line at a time. Red-flag COMBINATIONS ("fever + rash + stiff neck ⇒ ER") are out of scope **entirely** — not even as "informational" — because that is diagnosis, and one missed emergency or one false alarm both end badly. No auto-created conditions, no auto-contacting anyone, no severity-only alarms without a citable duration source. The illness hero accordion / Household "sick day" chip's **worsening ↑** marker (`episodeIsWorsening`) is a pure visibility arrow over the same assembly — a trend indicator with no medical claim, distinct from these cited findings.

---

## Condition-suggestion review (care tier, #685)

The condition-suggestion engine (pure detector `lib/condition-suggestions.ts`, builder `lib/condition-suggestion-findings.ts`) is a **care-tier** member: a CURRENT qualitative lab result the shared classifier (#549) resolves to a `polarity:"bad"` infection-**positive** (positive HBsAg / anti-HBc / HCV / HIV / RPR / chlamydia / gonorrhea) — or, per #687's cross-ref, a **high-risk** prenatal/genetic screen — becomes a **suggest-only** review item to add the matching problem-list **Condition**. A positive infection marker seen only as a flag chip was the safety gap #685 names; routing it to the conditions surface (which the recommendation engines read) closes it.

**Suggest-only (#560), never a silent insert.** The item carries an inline **"Add to conditions"** confirm the user clicks; `confirmConditionSuggestion` → the idempotent, external_id-keyed `addSuggestedConditionCore` is the ONLY path that writes a Condition — ingest never does. Once added, the concept collapses onto the new condition and the suggestion self-clears.

**Concept dedup reuses the existing identity (#482).** A suggestion is dropped when its concept's `conditionCollapseKey` (`lib/icd10.ts`) already collapses onto a stored condition — the SAME identity the conditions page dedups by, not a second grouping. The marker→concept map is the one new table, with an **exclusion discipline**: a generic culture whose organism is unknown suggests nothing. **NEGATIVE results are deliberately NOT conditions** — a non-reactive HIV/HCV is a screening event (the preventive-cadence follow-up, #686), never a problem-list row.

**Tier reach (#449).** It reaches Upcoming + the non-hideable **Needs attention** hero as a `condition-review`-domain `UpcomingItem` banded `today` (via `conditionReviewItems` in the Upcoming generator fan-out), suppressible through the shared bus by its `condition-review:<conditionCollapseKey>` dedupeKey (registered in `RULE_FINDING_PREFIXES`, so the #448 reflection guard proves it's guardable). It is NOT part of `collectCoachingFindings`. A **new push channel (Telegram) was deliberately scoped OUT** — `condition-review` is omitted from the digest's `DOMAIN_SEQ`, so the review/Upcoming/hero surface is the shipped step; a push is a larger decision left to a follow-up.

---

## The finding follow-up loop (care tier, #700 · #860 Track A / #707 Substrate 1)

Status: **shipped** (imaging adapter; IOP/dental/skin/labs adapters plug in as their record types land — the seam is documented below)

The highest-harm failure across the medical domains is not a missing record — it's a flagged **finding whose follow-up never happens** (an incidental "6 mm pulmonary nodule, recommend follow-up CT in 12 months"). The loop that closes it is generic and lives over the EXISTING `care_plan_items` lifecycle (#658, migration 050 adds the link columns), not a new table:

**finding (a domain record) → follow-up (a linked `care_plan_items` row) → resolution (an outcome recorded against a later record).**

- **The chain node** is a `care_plan_items` row that carries `source_kind` + a concrete source FK (`source_imaging_study_id` today), a `recommended_interval_days`, and — once closed — a `resolution` (`resolved`/`stable`/`changed`) + `resolved_by_imaging_study_id`. All nullable: a generic care-plan item sets none of them.
- **The builder** (`lib/followup-findings.ts`, `followUpItems`) is a #448 care-tier builder: it gathers linked, open follow-ups + their imaging studies and emits one `followup`-domain `UpcomingItem` per follow-up in its current state. Its `FOLLOWUP_PREFIX` (`followup:<carePlanItemId>`) is registered in `RULE_FINDING_PREFIXES`.
- **Legibility (#656)** — the item carries a `followup-source` `Reason` ("for the 6 mm RLL nodule (2026-03)"), so a bare "follow up in 12 months" reads as "Follow-up CT — for the 6 mm RLL nodule". The reason union IS the registry; the code was added there deliberately.
- **Resolution is confirm-first (#560)** — when a later matching record lands the item switches to a resolvable OFFER carrying `followUpResolve` (the shared `FollowUpResolveControls`). The app never auto-resolves; the user records the outcome against the later study (`resolveFollowUpCore`). That yields the serial view of one finding across time.

**Tier reach (#449).** Care tier: it reaches Upcoming + the non-hideable **Needs attention** hero (an overdue one bands `overdue` → the hero's "Past due"). Like condition-review (#685), a **new Telegram push channel is deliberately scoped OUT for v1** — `followup` is omitted from the digest's `DOMAIN_SEQ` — so the escalation is the hero + Upcoming + care-persistence step; a push is a follow-up decision.

### Care-tier persistence contract (#700 ask 5)

An OVERDUE safety follow-up must not fall to the "dismiss once, silence everywhere" convenience path the way a medication-dose escalation must not (#171/#227). The contract, decided by state (pure, `lib/followup.ts` `isFollowUpHidden` / the shared `isItemHiddenBySuppression`), routes through the ONE `isHiddenUnderPolicy` decision in `lib/lifecycle.ts` (#942) — the same gate the bus-gated nudges and the dose-escalation carve-out use:

| Signal / follow-up state          | Suppression policy   | Honors SNOOZE (time-boxed) | Honors DISMISS (indefinite) |
| --------------------------------- | -------------------- | -------------------------- | --------------------------- |
| upcoming (due today / future)     | `normal`             | yes                        | yes                         |
| resolvable (later record on file) | `normal`             | yes                        | yes                         |
| **overdue** (past planned date)   | **`snooze-only`**    | **yes**                    | **NO — resisted**           |
| **dose reminder / escalation**    | **`safety-ungated`** | **NO — ignored**           | **NO — ignored**            |

The `safety-ungated` row is the #449 carve-out named as a first-class policy (#942): missed-dose escalation is the first lifecycle tenant, declaring it in `ESCALATION_SUPPRESSION_POLICY`. The bus is ignored ENTIRELY — no dismiss and no snooze can hide it — so a page dismissal can never silence a possibly-critical medication signal.

An overdue follow-up carries `carePersistent: true`: the shared suppression filter IGNORES a `dismissed_at` row for it (a page dismiss can never permanently silence a possibly-missed nodule follow-up), but a live `snooze_until` still defers it (a deliberate "remind me next week"), and it reappears when the snooze expires. The surfaces render a **snooze-only** menu (no Dismiss) for it. This is scoped EXPLICITLY: only the _overdue_ state resists dismiss; an upcoming or resolvable follow-up is fully suppressible like any finding. The pure pin is `lib/__tests__/followup.test.ts` (overdue + a dismiss → NOT hidden; + a live snooze → hidden), and the end-to-end pin is `lib/__db_tests__/followup-findings.test.ts` (a dismiss on `collectUpcoming` leaves the overdue follow-up live).

### Domain-agnostic core, domain adapters (#700 ask 6)

The chain/state-machine/persistence/resolution-precedence live ONCE in `lib/followup.ts` (auth-blind, pure). Each finding-producing domain supplies a `FollowUpAdapter<Source, Candidate>` — three domain questions, nothing else:

```ts
interface FollowUpAdapter<Source, Candidate> {
  kind: string; // stored in care_plan_items.source_kind
  describeSource(source): string; // "6 mm RLL nodule (2026-03)" — the reason "why"
  followUpTitle(source): string; // "Follow-up CT"
  findResolvingRecord(source, followUp, candidates): Candidate | null; // confirm-first OFFER
  describeResolvingRecord(candidate): string; // "CT chest · 2026-03"
}
```

**Imaging** is the first adapter (`lib/followup-imaging.ts`): its resolution rule is a LATER study of the same modality + overlapping body region (never cross-modality). A new domain plugs in by (1) appending its own source FK column to `care_plan_items` (an append-only migration + the same NULL-first row-ops at every source-record delete/reassign seam — see `unlinkFollowUpsForImagingStudy` + the import-footprint null-sweeps), (2) shipping its adapter, and (3) extending the builder's gather. **#698** (IOP awaiting a glaucoma workup), **#705** (dental "re-eval in 3 months"), **#715** (skin "recheck in 3 months"), and flagged labs each map onto this exact shape.

---

## Display units on finding surfaces — the policy (#1019)

A finding/item string that contains a **measurement** (a temperature, a weight, a distance) renders under one fixed policy — decided once here so no builder re-litigates it:

1. **Web: the viewer's login pref, always.** Any measurement-carrying string either takes the unit at format time (the `tempRedFlagTitle`/`tempRedFlagDetail` display parameter, `enduranceEventItems`' distance unit) or carries the raw canonical value on its envelope for render-time formatting — never a baked-in unit. The web boundaries (the Upcoming page, the dashboard hero) resolve `getUnitPrefs(login.id)` and thread it into `collectAttentionModel`/`collectUpcoming` (`UpcomingDisplayUnits`).
2. **Telegram/notifications: canonical units (kg/km/°F), documented — EXCEPT safety-critical temperature, which renders dual-unit** (`fmtTempDual`, "38.5 °C / 101.3 °F"). Unit prefs are per-**login**; notifications are per-**profile** — there is no pref to consult. The digest/recap weight and distance lines deliberately stay canonical (dual-unit everywhere would be noise); the temperature red-flag nudge is the one safety message where a mixed-preference household must read the number correctly either way, so it errs toward redundancy.
3. **Identity is display-independent.** `dedupeKey`s and item `key`s never depend on the display unit (pinned in `lib/__tests__/temp-red-flag.test.ts`), so a dismiss on a °C surface silences the °F and Telegram twins through the shared bus.
4. **Cited source text never converts.** A threshold quoted from a curated dataset (`entry.line`/`entry.label` in `lib/datasets/temperature-red-flags.ts`) is the source's own words and passes through verbatim; only app-authored fact clauses convert.

## The reason model — structured "why", carried as data (#656, Track A of #860)

Status: **shipped** (findings/upcoming/notification spine; import-review `ActivityDupPair.reason` + `SuggestionDraft.rationale` deliberately out of scope — documented follow-ups)

Many engines decide _due / overdue / prioritized_, and the deciding engine often produces a good, cited reason — but before #656 those reasons were flattened by string concatenation into `UpcomingItem.detail` at generation, so a compact surface (the Telegram digest) could only re-derive per-domain counts and the "why sooner" never reached the push, and flagged biomarkers carried no reason at all. `Reason` (`lib/reasons.ts`) is the **first-class, structured** form carried ALONGSIDE — never replacing — the display `detail`:

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

This is **"one question, one computation" at the explanation layer**: the reason is computed ONCE by the deciding engine and carried as `UpcomingItem.reasons` / `Finding.reasons` (copied across the bus by `upcomingToFinding`); each surface is a formatter over it, never a second derivation. The **closed `ReasonCode` union** keeps the code set honest (a source-scan would be overkill — a union + the shared-fixture pin suffices, the issue's own call); **`source`** carries provenance where the reason is citation-backed (the risk rules' ACC/AHA-style informational citation, threaded through `risk-stratification.ts`'s new `SourcedReason`).

**Where reasons attach (generators stop flattening).** The Upcoming generators (`lib/queries/upcoming/generators.ts`) attach `reasons` — the SAME lines the `detail` string still flattens (display unchanged) — on: the biomarker retest item (cited `risk-elevated` from `retestModulationFor().sourced` + a `biomarker-flagged` reason), immunization (`immunizationPriorityFor().sourced`), preventive visit/screening (text-only `risk-elevated` — the assessor's pre-merged strings aren't sourced through it yet, a follow-up), and the **situational dose** (`situation-active` — "Due because Illness is active", lifted from the medicine-page bare tag so the same explanation can reach the digest/reminder). The **flagged-biomarker** item (`lib/attention.ts` `buildFlaggedItem`, gathered by `collectAttentionModel`) gains a **why-for-this-profile line**: the risk-layer reasons for the flagged analyte — computed via the SAME `retestModulationFor` over the SAME factors the retest generator uses — are attached and appended to its detail (`biomarker-flag-copy.ts`), so a flagged LDL for a family-cardiac-history profile explains its elevation, not just orders it.

**The digest surfaces the top reason (#656 item 2).** `buildUpcomingDigest` (`lib/notifications/upcoming-digest.ts`) adds `highlights` — the highest-priority reasoned items' `primaryReason()` — rendered after the per-band counts, so the push says WHY the important item matters. `primaryReason()` (the first carried reason; generators order the cited risk line first) is the ONE lead-reason computation the digest and the page share.

**The pin (one computation, three surfaces).** `lib/__db_tests__/reason-model.test.ts` seeds one fixture (family-cardiac-history + a stale flagged LDL) and asserts the SAME `risk-elevated` reason string appears on the Upcoming item, the attention-model item, and the digest highlight — plus the flagged why-line and the situational-dose reason. Reasons are **explanation only**: they never change a finding's tier or reach (#449 unchanged).

**`coaching-held` — the "why it's quiet" reason (#837).** Situation-aware coaching (below) pauses the routine-gap / pace nags during an open flagged-illness episode. That's not "nothing to say" — it's a deliberate context hold, so the dashboard coaching card renders a calm HELD note (`illnessHeldNote()`, `lib/coaching/engine.ts`) carrying a `coaching-held` reason ("Held — illness episode open"), threaded onto the coaching `Finding` by `recommendationToFinding` (`Recommendation.reasons` → `Finding.reasons`). It's a fact about the app's own tracked situation, so it carries no `source`.

## Situation-aware coaching — hold nags during illness, ease back on close (#837)

Status: **shipped**

During an OPEN flagged-illness episode (the `illness_episodes` row covering today, #856 — the SAME derivation the illness hero/timeline use, never a second engine), the coaching engine HOLDS the go-train / routine-gap / cardio-gap / behind-pace nags: `illnessCoachingMode(input.illness, today)` (`lib/coaching/engine.ts`) returns `held`, `recommendCoaching` skips the training-side recommendations and emits only the rest recommendation (untouched — recovery/safety always fire) plus the calm held note. Because BOTH the dashboard coaching card and the Telegram workout slot read this ONE decision off the shared `gatherCoachingInput` (`recommendWorkout` returns null in `held`/`ease-back`, so the workout-reminder slot goes quiet), they can't drift (#221). **This alters what FIRES, never what's ADVISED** — the recommendations themselves are unchanged; suppressing a nag during the app's own tracked illness state is context, not medical judgment (#666's mechanism line).

On episode close, a short **ease-back ramp** (`EASE_BACK_RAMP_DAYS = 3`, from the episode's exclusive end / first-well day) replaces the immediately-resumed gap nags with a one-shot, coaching-tier ease-back re-entry recommendation ("a light session or easy Zone 2 is a good re-entry"), then normal coaching resumes. The read surfaces show the ease-back rec through the ramp; the notify tick sends it **once per episode** (`runEaseBack`, `lib/notifications/ease-back.ts`, marker `notify_ease_back_<episodeId>` — an id-keyed one-shot, #203-safe). The ease-back push is a deliberate **one-time transition notice**, NOT part of the calm `collectCoachingFindings` stream the #449 "coaching tier never notifies" rule governs — it's a single close-of-episode courtesy, in the same family as the weekly-recap/milestone one-shots. The weekly recap stays honest too: `illnessDaysInWindow` feeds a "sick N days" recovery line so a sick week reads as a sick week, not a failed one. Pins: `lib/__tests__/coaching-illness.test.ts` (pure hold/ramp), `lib/__db_tests__/coaching-illness.test.ts` (gather → card AND workout slot agree end-to-end).

---

## Documented exemption — intake suggestions are proposals, not findings (#662)

Status: **shipped** (exemption; the divergence is deliberate, not a gap to close)

AI supplement/medication suggestions (`intake_item_suggestions` — the `rationale`/`trigger`/`model` provenance columns; produced by `generateAndStoreSuggestions` in `lib/supplement-suggest.ts`, surfaced on Nutrition → Supplements with per-row **Accept**/**Dismiss** — `acceptSuggestion`/`dismissSuggestion` in `app/(app)/nutrition/supplement-actions.ts`) are a **parallel mechanism**: they never become `Finding`s and their dismissal does NOT flow through the shared `upcoming_dismissals` bus. That is the RIGHT call — this is the exemption, so the next engine doesn't route a proposal through the findings envelope by copying the "every surface renders the SAME Finding through the shared bus" rule where it doesn't apply.

**Why a suggestion is not a finding.** A `Finding` (#449) is an **observation** about existing state — a flagged marker, a preventive gap, a routine lapse — that the user reads and, at most, dismisses; dismissing it says "I've seen this, stop showing it," and the shared bus makes that one dismissal silence every surface (page, hero, Telegram) because they're all views of the ONE observation. A suggestion is the opposite shape on three axes:

- **It has a materialization step, not just a read.** `acceptSuggestion` INSERTs a brand-new `intake_items` row with parsed doses (`insertDoses`) and flips the suggestion to `status='accepted'`. "Accept" creates a first-class tracked entity; a finding has no analog to that — there is nothing for a finding's dismissal bus to model. Routing a proposal through the findings envelope would give it a dismiss-everywhere semantic while stranding its accept-and-materialize semantic outside the model.
- **Its terminal state lives on its own row, id-keyed — there is nothing to re-key (#203).** Dismissal is `UPDATE intake_item_suggestions SET status='dismissed' WHERE id=?` — an integer-id-keyed row transition (`pending → accepted | dismissed`), never a name/code-keyed `dedupeKey` in `upcoming_dismissals`. So it needs no name-keyed re-key on rename/merge and can't drift the way a string-keyed suppression can. The bus buys it nothing.
- **It's user-initiated and one-shot, not a standing signal.** A finding recomputes every load from live state and keeps reappearing until the underlying fact changes; a suggestion is generated on the user's explicit **Generate** tap and then sits in one of three states forever. It's a generative proposal with provenance, closer to the suggest-only **materialization** pattern (#560 — "confirm-first, never a silent insert", the same shape as the condition-suggestion and records-bridge accepts) than to an observational finding.

**Tier fit (#449).** It belongs to neither reach tier: not **care** (no push — it is never a nudge; the user opts into generation), not **coaching** (the coaching tier is _observations_ aggregated by `collectCoachingFindings`; a suggestion is a proposal, not an observation, and materializes rather than merely informs). The suggest/accept/dismiss surface on the Supplements tab is the whole of its reach, by design.

**What WOULD change this.** If a suggestion ever needed to (a) reach a second surface that also had to honor one dismissal, or (b) suppress a corresponding observational finding when dismissed, it would then owe a shared `dedupeKey` and a bus entry — but that would be a real observation riding alongside the proposal, registered in `RULE_FINDING_PREFIXES` like any finding. Until then, the parallel mechanism is correct and this exemption is why.
