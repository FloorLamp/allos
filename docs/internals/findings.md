# Findings reach — the two-tier policy

Status: **shipped** · extracted verbatim from AGENTS.md (#597; the policy was decided in #449)

How far a rule-engine finding travels — page, dashboard hero, notification — is a deliberate two-tier decision, not a per-feature accident. This page holds the full policy and how a new engine joins a tier; the one-line rule stays in AGENTS.md's conventions.

---

**Findings reach is a two-tier policy — decide it on purpose (#449).** The #45 rule engines split into two reach tiers. The **care tier** (preventive findings, drug-interaction/dietary-limit items) is _push_: it reaches Upcoming, the dashboard **Needs attention** hero, AND the Telegram nudge (one assessor). The **coaching tier** — the four observational builders (`buildTrainingObservationFindings`/`buildBodyHygieneFindings`/`buildGoalPacingFindings`/`buildAdherencePatternFindings`, aggregated by `collectCoachingFindings`) — is _calm/observational_: it reaches its own tab AND the hideable dashboard **Coaching observations** rollup, but **never a notification and never the non-hideable hero** (reach without noise). A new observational engine joins the coaching tier by adding its builder to `collectCoachingFindings` and its dedupeKey prefix to `RULE_FINDING_PREFIXES`; it does NOT get a push channel unless it's genuinely _care_. Every surface renders the SAME `Finding` (one computation) with the SAME dedupeKey, so a dismiss on any surface silences it on all of them through the shared bus.
