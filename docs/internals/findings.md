# Findings reach — the two-tier policy

Status: **shipped** · extracted verbatim from AGENTS.md (#597; the policy was decided in #449)

How far a rule-engine finding travels — page, dashboard hero, notification — is a deliberate two-tier decision, not a per-feature accident. This page holds the full policy and how a new engine joins a tier; the one-line rule stays in AGENTS.md's conventions.

---

**Findings reach is a two-tier policy — decide it on purpose (#449).** The #45 rule engines split into two reach tiers. The **care tier** (preventive findings, drug-interaction/dietary-limit items, and the illness-care duration/trajectory findings — #805) is _push_: it reaches Upcoming, the dashboard **Needs attention** hero, AND the Telegram nudge (one assessor). The **coaching tier** — the four observational builders (`buildTrainingObservationFindings`/`buildBodyHygieneFindings`/`buildGoalPacingFindings`/`buildAdherencePatternFindings`, aggregated by `collectCoachingFindings`) — is _calm/observational_: it reaches its own tab AND the hideable dashboard **Coaching observations** rollup, but **never a notification and never the non-hideable hero** (reach without noise). A new observational engine joins the coaching tier by adding its builder to `collectCoachingFindings` and its dedupeKey prefix to `RULE_FINDING_PREFIXES`; it does NOT get a push channel unless it's genuinely _care_. Every surface renders the SAME `Finding` (one computation) with the SAME dedupeKey, so a dismiss on any surface silences it on all of them through the shared bus.

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
