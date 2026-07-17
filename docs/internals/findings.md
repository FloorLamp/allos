# Findings reach — the two-tier policy

Status: **shipped** · extracted verbatim from AGENTS.md (#597; the policy was decided in #449)

How far a rule-engine finding travels — page, dashboard hero, notification — is a deliberate two-tier decision, not a per-feature accident. This page holds the full policy and how a new engine joins a tier; the one-line rule stays in AGENTS.md's conventions.

---

**Findings reach is a two-tier policy — decide it on purpose (#449).** The #45 rule engines split into two reach tiers. The **care tier** (preventive findings, drug-interaction/dietary-limit items, and the illness-care duration/trajectory findings — #805) is _push_: it reaches Upcoming, the dashboard **Needs attention** hero, AND the Telegram nudge (one assessor). The **coaching tier** — the four observational builders (`buildTrainingObservationFindings`/`buildBodyHygieneFindings`/`buildGoalPacingFindings`/`buildAdherencePatternFindings`, aggregated by `collectCoachingFindings`) — is _calm/observational_: it reaches its own tab AND the hideable dashboard **Coaching observations** rollup, but **never a notification and never the non-hideable hero** (reach without noise). A new observational engine joins the coaching tier by adding its builder to `collectCoachingFindings` and its dedupeKey prefix to `RULE_FINDING_PREFIXES`; it does NOT get a push channel unless it's genuinely _care_. Every surface renders the SAME `Finding` (one computation) with the SAME dedupeKey, so a dismiss on any surface silences it on all of them through the shared bus.

---

## Illness-care findings (care tier, #805)

The illness-care engine (`lib/illness-care.ts`, builder `lib/illness-care-findings.ts`) is a **care-tier** member: a logged symptom in the profile's current open illness episode (the #801 `assembleIllnessEpisode` assembly — no second gather) that has crossed a **cited duration or trajectory line** becomes a push finding. Its dedupeKey prefix (`illness-care:`) is registered in `RULE_FINDING_PREFIXES` (so the #448 reflection guard proves the keys are guardable) even though it is a push builder, not a coaching one — it is NOT part of `collectCoachingFindings`. It reaches Upcoming + the hero as an `illness-care`-domain `UpcomingItem` banded `today` (via `illnessCareItems` in the Upcoming generator fan-out) and the Telegram nudge via `runIllnessCare` (`lib/notifications/illness-care.ts`), all keyed by the SAME dedupeKey through the shared bus.

**Thresholds are a curated, per-entry-cited dataset** (`lib/illness-thresholds.json`, the #798 prn-defaults pattern), keyed by the #799 symptom slugs. Every finding states the logged **fact** + the cited **line** + the **source** + an "informational, not medical advice" tail — never "you should", never a diagnosis. No dataset entry for a symptom ⇒ no finding for it, ever; age bands are the SOURCE's own (infant fever renders the "contact a clinician" refusal, never a number we computed), applied only when age is known.

**Hard non-goal — no symptom-combination triage.** The engine judges ONE symptom against ONE citable duration/trajectory line at a time. Red-flag COMBINATIONS ("fever + rash + stiff neck ⇒ ER") are out of scope **entirely** — not even as "informational" — because that is diagnosis, and one missed emergency or one false alarm both end badly. No auto-created conditions, no auto-contacting anyone, no severity-only alarms without a citable duration source. The illness hero accordion / Household "sick day" chip's **worsening ↑** marker (`episodeIsWorsening`) is a pure visibility arrow over the same assembly — a trend indicator with no medical claim, distinct from these cited findings.
