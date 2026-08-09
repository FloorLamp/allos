// THE send-marker registry (issue #2036) — every `notify_*` settings key the app writes
// to remember that something was already sent, and what keeps it honest.
//
// `docs/internals/notifications.md` names "the `notify_last_*` discipline" in eight
// places, and code comments reach for it by name ("the marker is keyed by the
// administration id (the notify_last_* discipline)"). It was a convention with no
// registry: every namespace hand-built, parsed and swept its own keys, six of them
// appeared in `NON_DISMISSAL_PREFIXES` for the unrelated reason that they are NOT
// dismissals, and the rest were inline string literals — which lib/dismissal-classes.ts
// explicitly names as the hole its own source scan cannot catch.
//
// WHY IT MATTERS, in one sentence: a send marker keyed on something recyclable, or never
// swept after its subject is deleted, is a SILENT WRONG-CADENCE bug — either a nudge that
// never fires again or one that fires for a subject nobody asked about. That is the same
// class #1931 made unshippable for dismissal keys, one file over, with the same shape of
// registry and the same reflection guard.
//
// THE TEETH (lib/__tests__/send-markers.test.ts):
//   1. TOTALITY. A source scan over lib/ and scripts/ collects every `notify_…` string
//      literal and template-literal prefix. Each must resolve to an entry below or be
//      listed in NON_MARKER_NOTIFY_KEYS with what it actually keys. This closes the
//      inline-literal hole: `notify_last_practice` was spelled in the tick and nowhere
//      else, and nothing could have found it.
//   2. EVIDENCE PER CLASS. Every entry states its tail shape, its stored value, its
//      cadence and its retention. `name-keyed-swept` additionally has to NAME the sweep,
//      and `legacy` has to state its residue.
//   3. AGREEMENT with lib/dismissal-classes.ts: every `notify_`-prefixed entry in that
//      file's NON_DISMISSAL_PREFIXES must be a namespace declared here, and no send
//      marker may also be a dismissal namespace. The two registries describe two
//      different stores and must not overlap.
//
// NO SCHEMA CHANGE, NO POLICY CHANGE. Markers stay in the tiers they already live in;
// this is knowledge about them. In particular the SAFETY STANDING of the dose-escalation
// marker is untouched: dose reminders and missed-dose escalations are never silenced by
// an Upcoming dismissal (AGENTS.md), and registering their bookkeeping does not put them
// on the suppression bus.
//
// THE BUILDERS AT THE BOTTOM exist so the declaration and the minting cannot drift.
// A key composed from a variable tail (`notify_last_${slot}`) is unresolvable BY
// CONSTRUCTION — a scan cannot follow it — so the two families that were built that way
// now mint through a builder here, over a closed slot union. That is what turns the scan
// from "checks the literals someone happened to write out" into a real total.

import type { RecapScale } from "../recap-scale";
import type { FoodNudgeWindow } from "./food-format";
import type { IntakeSendSlot } from "./supplement-format";

/**
 * How a send marker is protected from re-attaching to a subject it was never set for —
 * the send-side twin of `DismissalKeyClass`.
 */
export type SendMarkerClass =
  /** The tail is an AUTOINCREMENT row id. Ids never recycle (#203), so a stranded
   *  marker is an inert dead row rather than wrong suppression. */
  | "id-keyed"
  /** The tail is a fixed curated vocabulary token — a catalog rule key. The SUBJECT is
   *  the topic itself, so outliving any particular row is intended. */
  | "catalog-keyed"
  /** The tail carries a date, period or episode anchor, so a new occurrence mints a new
   *  key and a dormant marker can only ever match the same past anchor. */
  | "anchored"
  /** The tail is a member of a closed, code-declared slot vocabulary (a reminder
   *  window, a nudge window). It cannot be minted from data at all. */
  | "slot-keyed"
  /** No tail: one key per profile. */
  | "profile-fixed"
  /** The tail embeds a user-recyclable NAME and a named sweep de-orphans it. `sweptBy`
   *  is required. No namespace claims this today — recorded so that the first one that
   *  needs it cannot ship without naming its sweep. */
  | "name-keyed-swept"
  /** No write path mints this anymore; `retention` states the bounded residue. */
  | "legacy";

/** How often a marker lets its signal through, i.e. what the marker actually promises. */
export type SendMarkerCadence =
  /** The value is a date; a new profile-local day re-arms the signal. */
  | "per-day"
  /** Set on send and CLEARED when the condition ends, so the NEXT episode fires. */
  | "per-episode"
  /** Set once for a subject and never cleared — the subject itself never returns. */
  | "one-shot"
  /** The value accumulates send dates; the cadence is spent after N of them. */
  | "repeat-n"
  /**
   * The value is the END DATE of the PERIOD the signal last spoke for. A newly closed
   * period re-arms it; the same period can never fire twice however many ticks or
   * retries see it (#2178). Distinct from `per-day`, whose subject is the day itself:
   * a per-period marker is a claim about a SPAN of days, and one arrival day is not it.
   */
  | "per-period"
  /** Not a dedup marker at all: an instant the next run reads "since" from. */
  | "watermark"
  /** Nothing reads it anymore. */
  | "retired";

/** Which settings tier holds it, which decides who the marker belongs to. */
export type SendMarkerStore = "profile_settings" | "settings";

export interface SendMarkerEntry {
  /** The namespace prefix (with its trailing separator), or the whole key when fixed. */
  key: string;
  /** True when `key` IS the whole key — there is no tail. */
  fixed?: true;
  markerClass: SendMarkerClass;
  cadence: SendMarkerCadence;
  store: SendMarkerStore;
  /** The tail's shape, so a reader can check the class without chasing the builder. */
  shape: string;
  /** What the stored VALUE means. A marker whose value nobody can describe is a bug. */
  value: string;
  /** The module that sets it. */
  writer: string;
  /** The sweep that clears it — or, in writing, why none is needed. Never empty. */
  retention: string;
  /** For `name-keyed-swept`: the function that de-orphans this namespace. */
  sweptBy?: string;
}

// The single source of truth. One entry per send-marker namespace.
export const SEND_MARKER_REGISTRY: readonly SendMarkerEntry[] = [
  // ── id-keyed: the tail is a row id (#203 — ids never recycle) ───────────────
  {
    key: "notify_last_refill_",
    markerClass: "id-keyed",
    cadence: "per-episode",
    store: "profile_settings",
    shape: "`<intakeItemId>`",
    value: "the profile-local date the low-supply nudge was sent",
    writer: "lib/notifications/refill.ts (key: lib/refill-nudge.ts)",
    retention:
      "planRefillNudges' self-healing clear (#325) — the notifier feeds it the FULL live-marker set, so a marker whose item is no longer a tracked low candidate is swept whichever transition removed it. The write seams clear eagerly too: leftRefillTrackedSet on pause/untrack, and sweepIntakeItemMarkers (lib/intake-marker-cleanup.ts) on delete.",
  },
  {
    key: "notify_last_pool_refill_",
    markerClass: "id-keyed",
    cadence: "per-episode",
    store: "settings",
    shape: "`<sharedSupplyId>`",
    value: "the anchor profile's local date the pool nudge was sent",
    writer: "lib/notifications/supply-pool.ts (key: lib/refill-nudge.ts)",
    retention:
      "planPoolRefillNudges' self-healing clear, plus an eager deleteSetting when the pool is deleted (app/(app)/supplies/actions.ts). GLOBAL tier deliberately: a pool is household-shared and a per-profile marker would let one bottle re-nudge once per linked member (#1374).",
  },
  {
    key: "notify_last_esc_",
    markerClass: "id-keyed",
    cadence: "per-day",
    store: "profile_settings",
    shape: "`<doseId>`",
    value: "the profile-local date this dose was last escalated for",
    writer:
      "lib/notifications/escalate.ts, the Telegram ack (telegram-callbacks.ts) and the in-app resolve (lib/queries/intake/adherence.ts) — all three through escalationMarkerKey (lib/notifications/escalation-keys.ts)",
    retention:
      "sweepIntakeItemMarkers (lib/intake-marker-cleanup.ts) clears every dose's marker on item delete, from BOTH delete paths (#328). SAFETY TIER: this marker dedups an escalation within a day; it is not a suppression, and an Upcoming dismissal can never set it.",
  },
  {
    key: "notify_last_followup_",
    markerClass: "id-keyed",
    cadence: "repeat-n",
    store: "profile_settings",
    shape: "`<carePlanItemId>`",
    value:
      "the send dates, comma-joined — so the whole two-send cadence is ONE value and the repeat spacing is data rather than a second marker (#1866)",
    writer: "lib/notifications/followup.ts (key: lib/followup-nudge.ts)",
    retention:
      "planFollowUpNudges' self-healing clear: a follow-up that settled, resolved, was deleted or re-dated leaves the overdue set and its marker goes with it, so a NEW overdue date starts a fresh cadence (a new tracked due date is a new consent).",
  },
  {
    key: "notify_last_redose_",
    markerClass: "id-keyed",
    cadence: "one-shot",
    store: "profile_settings",
    shape: "`<intakeItemId>`",
    value:
      "the ADMINISTRATION id the notice last fired for — equal to the latest administration means already notified, and a newer administration re-arms it",
    writer: "lib/notifications/redose.ts",
    retention:
      "None, deliberately. The key is item-keyed and the value is an administration id; both are AUTOINCREMENT and never recycle (#203), so a marker whose item was deleted is a dead row that can never match a later item. Documented as such in docs/internals/supplements.md.",
  },
  {
    key: "notify_ease_back_",
    markerClass: "id-keyed",
    cadence: "one-shot",
    store: "profile_settings",
    shape: "`<illnessEpisodeId>`",
    value: "the profile-local date the ease-back note was sent",
    writer: "lib/notifications/ease-back.ts",
    retention:
      "None, deliberately: one note per illness episode, forever (#837). An episode id never recycles, and re-firing for an episode already eased back out of would be the bug the marker exists to prevent.",
  },
  {
    key: "notify_last_post_workout_",
    markerClass: "id-keyed",
    cadence: "one-shot",
    store: "profile_settings",
    shape: "`<activityId>`",
    value: "the profile-local date the finish reminder was delivered",
    writer:
      "lib/notifications/workout-presence.ts, and the Telegram finish tap (telegram-callbacks.ts), which stamps it so the tick's separate dispatch cannot duplicate the message (#924)",
    retention:
      "None: one reminder per finished session. The activity id never recycles, so a marker outliving its activity can never suppress another session's reminder.",
  },
  {
    key: "notify_stale_workout_",
    markerClass: "id-keyed",
    cadence: "one-shot",
    store: "profile_settings",
    shape: "`<activityId>`",
    value: "the profile-local date the stale-draft nudge was sent",
    writer: "lib/notifications/workout-presence.ts",
    retention:
      "None: one nudge per unfinished draft (#1205), keyed on an id that never recycles.",
  },

  // ── catalog-keyed: a curated vocabulary; the topic IS the subject ───────────
  {
    key: "notify_last_preventive_",
    markerClass: "catalog-keyed",
    cadence: "per-episode",
    store: "profile_settings",
    shape: "`<preventiveRuleKey>` (lib/preventive-catalog)",
    value: "the profile-local date the screening nudge was sent",
    writer: "lib/notifications/preventive.ts",
    retention:
      "planPreventiveNudges' self-healing clear the moment the rule stops being actionable (satisfied, overridden, aged out) — which is what lets the NEXT interval nudge. A rule frozen by a booked visit or a page dismissal is held out of the clear so a later un-cover does not re-nudge the SAME episode (#183/#227).",
  },

  // ── anchored: an episode/date anchor bounds re-attachment ───────────────────
  {
    key: "notify_last_illnesscare_",
    markerClass: "anchored",
    cadence: "per-episode",
    store: "profile_settings",
    shape:
      "the finding's full `dedupeKey` — `illness-care:<variant>:<episodeAnchor>:<symptom>` — so the marker maps 1:1 onto the bus key its visible Upcoming twin carries",
    value: "the profile-local date the care nudge was sent",
    writer: "lib/notifications/illness-care.ts",
    retention:
      "planIllnessCareNudges' self-healing clear: a finding whose episode closed is no longer actionable and its marker is swept. The episode anchor means a later episode mints a different key regardless.",
  },
  {
    key: "notify_last_tempredflag_",
    markerClass: "anchored",
    cadence: "per-episode",
    store: "profile_settings",
    shape:
      "the finding's full `dedupeKey` — `temp-red-flag:<episodeAnchor>:<date>:<ruleKey>`, which embeds the reading's own date",
    value: "the profile-local date the red-flag nudge was sent",
    writer: "lib/notifications/temp-red-flag.ts",
    retention:
      "planIllnessCareNudges' self-healing clear (the same planner illness-care uses). The date inside the key bounds it further: a marker can only ever match a finding about that same reading.",
  },

  // ── slot-keyed: a closed, code-declared send-slot vocabulary ────────────────
  {
    key: "notify_last_supp_",
    markerClass: "slot-keyed",
    cadence: "per-day",
    store: "profile_settings",
    shape:
      "`<IntakeSendSlot>` — Morning / Midday / Evening / Bedtime / PreWorkout (lib/notifications/supplement-format)",
    value: "the profile-local date this slot's merged reminder was delivered",
    writer:
      "scripts/notify.ts (the hourly tick), read back by lib/notifications/escalate.ts to know which windows actually went out today",
    retention:
      "None needed: the vocabulary is closed and declared in code, so a marker cannot outlive its subject. A new day is a new value, which is the whole dedup.",
  },
  {
    key: "notify_last_household_",
    markerClass: "slot-keyed",
    cadence: "per-day",
    store: "profile_settings",
    shape: "`<IntakeSendSlot>`",
    value:
      "the profile-local date the receiver's household round was delivered",
    writer: "scripts/notify.ts (key: lib/notifications/household-round.ts)",
    retention:
      "None needed (closed vocabulary). Stored on the RECEIVER's profile: the round is the receiver's notification, and the members' own markers are untouched — a member still gets their own reminder and their own escalation (#1459).",
  },
  {
    key: "notify_last_food_",
    markerClass: "slot-keyed",
    cadence: "per-day",
    store: "profile_settings",
    shape:
      "`<FoodNudgeWindow>` — Morning / Midday / Evening (lib/notifications/food-format); Bedtime is deliberately excluded",
    value: "the profile-local date this window's food nudge was delivered",
    writer: "scripts/notify.ts, through foodNudgeMarkerKey below",
    retention: "None needed (closed vocabulary).",
  },

  {
    key: "notify_last_recap_",
    markerClass: "slot-keyed",
    cadence: "per-period",
    store: "profile_settings",
    shape:
      "`<RecapScale>` — week / month / quarter, the closed cadence union declared in lib/recap-scale.ts and minted ONLY through recapMarkerKey below",
    value:
      "the END DATE of the period this scale last spoke for — not a send date (#2178). Equality with the candidate period's end is what makes a scale already-spent, which is also how a SUPERSEDED scale is retired: when a quarterly recap replaces a weekly one, the week's marker is advanced to the week it would have reported, so those days are never delivered twice.",
    writer:
      "lib/notifications/recap-data.ts (runRecap), gated by scripts/notify.ts on the profile's one recap slot",
    retention:
      "None needed. The vocabulary is closed and declared in code, so a marker cannot outlive its subject, and the stored value is a period end that only ever moves forward. A profile that switches cadence simply stops consulting the scales below its new floor; their markers go inert rather than stranded, and switching back resumes from the last period they actually reported on.",
  },
  // ── profile-fixed: one key per profile, re-armed by the day ─────────────────
  {
    key: "notify_last_digest",
    fixed: true,
    markerClass: "profile-fixed",
    cadence: "per-day",
    store: "profile_settings",
    shape: "none — one key per profile",
    value: "the profile-local date the morning digest was delivered",
    writer: "lib/notifications/digest-data.ts, gated by scripts/notify.ts",
    retention:
      "None needed. Hard per-day dedup so a bug cannot spam a family chat at 7am; the day rolling over is the re-arm.",
  },
  {
    key: "notify_digest_attempt",
    fixed: true,
    markerClass: "profile-fixed",
    cadence: "per-day",
    store: "profile_settings",
    shape: "none — one key per profile",
    value:
      "`<profile-local date>|<attempts>|<minute of day>` — the Dynamic digest's FAILED attempts today and when the last one ran. It is the retry ANCHOR (#2211 rule 2: a Dynamic send fires at whatever tick the data landed on, so its retry band is `attempt + SLOT_RETRY_DELAY_MIN`, not `floor + 60`, which would already be in the past), and by its presence it is also what distinguishes a DECLINE (nothing written) from a FAILURE. Delivery is still `notify_last_digest`.",
    writer: "lib/notifications/digest-data.ts, gated by scripts/notify.ts",
    retention:
      "None needed. The stored date IS the key's lifetime: a record for any other day parses as absent (parseDigestAttempt), so the day rolling over re-arms both the attempt budget and the decline/failure distinction. Static never writes it.",
  },
  {
    key: "notify_last_workout",
    fixed: true,
    markerClass: "profile-fixed",
    cadence: "per-day",
    store: "profile_settings",
    shape: "none — one key per profile",
    value: "the profile-local date the training reminder was delivered",
    writer: "scripts/notify.ts, through TICK_SLOT_MARKER_KEYS below",
    retention:
      "None needed. Read (never written) by lib/workout-presence-gate.ts and lib/notifications/recommend.ts, whose HOLD is marker-NEUTRAL: returning null leaves the slot unmarked so the normal lifecycle resumes next tick rather than the day being burned.",
  },
  {
    key: "notify_last_practice",
    fixed: true,
    markerClass: "profile-fixed",
    cadence: "per-day",
    store: "profile_settings",
    shape: "none — one key per profile",
    value: "the profile-local date the practice-pace nudge was delivered",
    writer: "scripts/notify.ts, through TICK_SLOT_MARKER_KEYS below",
    retention:
      "None needed. Bus-gated coaching tier: when every behind target's `practice:<id>` twin is dismissed the builder returns null and NO marker is set, so un-dismissing resumes the lifecycle instead of finding the day spent.",
  },
  {
    key: "notify_last_mood_checkin",
    fixed: true,
    markerClass: "profile-fixed",
    cadence: "per-day",
    store: "profile_settings",
    shape: "none — one key per profile",
    value: "the profile-local date the daily check-in was delivered",
    writer: "scripts/notify.ts, through TICK_SLOT_MARKER_KEYS below",
    retention:
      "None needed. Auto-pause is a separate mechanism (mood_checkin_ignored), not this marker.",
  },
  {
    key: "notify_last_wear_reminder",
    fixed: true,
    markerClass: "profile-fixed",
    cadence: "per-day",
    store: "profile_settings",
    shape: "none — one key per profile",
    value:
      "the profile-local date the opt-in bedtime wear reminder was delivered (#2161)",
    writer: "scripts/notify.ts, through TICK_SLOT_MARKER_KEYS below",
    retention:
      "None needed — the standard date rollover IS the sweep. The value is a date, so a new profile-local day re-arms the signal and a stale value can only ever match a past night. There is nothing recyclable in the key, and turning the opt-in off simply stops the builder returning a message, which leaves the last marker inert rather than stranded. One send per night, no escalation, no repeat.",
  },
  {
    key: "notify_preventive_assessed",
    fixed: true,
    markerClass: "profile-fixed",
    cadence: "per-day",
    store: "profile_settings",
    shape: "none — one key per profile",
    value: "the profile-local date the preventive ASSESSMENT last ran",
    writer: "scripts/notify.ts",
    retention:
      "None needed. Not a send marker: it rations the expensive per-day GATHER, while `notify_last_preventive_<ruleKey>` is what decides whether anything is sent. Registered here because it is a `notify_` key the tick writes, and the census is only useful if it is total.",
  },
  {
    key: "notify_illnesscare_assessed",
    fixed: true,
    markerClass: "profile-fixed",
    cadence: "per-day",
    store: "profile_settings",
    shape: "none — one key per profile",
    value: "the profile-local date the illness-care ASSESSMENT last ran",
    writer: "scripts/notify.ts",
    retention: "None needed — the per-day gather gate, as above.",
  },
  {
    key: "notify_followup_assessed",
    fixed: true,
    markerClass: "profile-fixed",
    cadence: "per-day",
    store: "profile_settings",
    shape: "none — one key per profile",
    value: "the profile-local date the follow-up ASSESSMENT last ran",
    writer: "scripts/notify.ts",
    retention: "None needed — the per-day gather gate, as above.",
  },
  {
    key: "notify_digest_last_at",
    fixed: true,
    markerClass: "profile-fixed",
    cadence: "watermark",
    store: "profile_settings",
    shape: "none — one key per profile",
    value:
      "an ISO instant, not a date: the digest reads 'what changed since' from it. Deliberately distinct from `notify_last_digest`, which is the per-day send dedup.",
    writer: "lib/notifications/digest-data.ts",
    retention:
      "None needed: a watermark is overwritten by every send and means nothing once passed.",
  },

  // ── legacy: no write path mints these anymore ──────────────────────────────
  {
    key: "notify_last_weekly_recap",
    fixed: true,
    markerClass: "legacy",
    cadence: "retired",
    store: "profile_settings",
    shape: "none — one key per profile",
    value: "was the profile-local DATE the weekly recap was delivered",
    writer:
      "nobody — #2178 replaced the single weekly marker with the per-scale, period-anchored `notify_last_recap_<scale>` family",
    retention:
      "No sweep, and none is needed: nothing reads the key, so the residue is inert. It is deliberately NOT migrated into the new family. The two carry different values (a send date vs a period end), and the changeover costs nothing to leave alone — the new week marker reads as absent, so the first recap fires at the profile's normal recap slot, which is exactly the day it would have fired anyway.",
  },
  {
    key: "notify_last_error",
    markerClass: "legacy",
    cadence: "retired",
    store: "profile_settings",
    shape: "`` / `_at` / `_channel` — the three pre-#942 delivery-health keys",
    value: "was the last delivery error, its instant and its channel",
    writer:
      "nobody — migration 061 moved delivery health to `notify_lifecycle`",
    retention:
      "Migration 061 folded these onto the notify_lifecycle row and lib/notifications/delivery-marker.ts is the only thing that still knows they existed. No reader consults them, so the residue is inert; the set/clear/freeze decision is lib/notifications/delivery-status.ts.",
  },
  {
    key: "notify_last_upcoming",
    fixed: true,
    markerClass: "legacy",
    cadence: "retired",
    store: "profile_settings",
    shape: "none",
    value: "was the date the separate upcoming digest was sent",
    writer: "nobody — the separate upcoming digest was folded into the digest",
    retention:
      "#1108 merged the upcoming digest into the morning digest and migration 093 SWEEPS the dead keys, so no residue is left to re-attach to anything.",
  },
];

// `notify_`-prefixed strings in lib/ and scripts/ that are NOT send markers. The scan
// requires every one of them to be listed with what it actually keys, because "not a
// marker" is a claim that has to be checkable.
export const NON_MARKER_NOTIFY_KEYS: readonly {
  key: string;
  what: string;
}[] = [
  // Tables, not settings keys.
  {
    key: "notify_lifecycle",
    what: "the delivery-health TABLE (migration 061) — one row per profile, the store the retired notify_last_error keys were folded into",
  },
  {
    key: "notify_messages",
    what: "the live-message pointer TABLE (migration 135), enumerated in lib/owned-tables.ts",
  },
  {
    key: "notify_message_id",
    what: "a COLUMN, not a key: the #2264 tap-provenance link on food_log_events and intake_item_logs (migration 170), referencing notify_messages(id) so a correction row renders only on the message that produced its burst",
  },
  // Reconciliation bookkeeping (profile_settings), not a send marker: it gates a silent
  // EDIT, never a send, so it can never suppress an interruption.
  {
    key: "notify_digest_recon",
    what: "the digest prose reconciler's last-rebuild record (#2069): `date|dependency stamp|epoch ms`, written by lib/notifications/reconcile.ts and read back by its own pre-check. Nothing is ever suppressed by it — it only decides whether a REBUILD is worth paying for, and its floor forces one regardless once the record is old enough",
  },
  // Per-profile SCHEDULE and content preferences (profile_settings), not markers.
  {
    key: "notify_digest_hour",
    what: "profile schedule: the morning digest's hour (lib/settings/notifications)",
  },
  {
    key: "notify_recap_day",
    what: "profile schedule: the recap slot's weekday (and its off switch)",
  },
  {
    key: "notify_recap_hour",
    what: "profile schedule: the recap slot's time",
  },
  {
    key: "notify_recap_scale",
    what: "profile CONTENT preference (#2178): which scale — week / month / quarter — the recap slot speaks at. It decides what the send says, never whether or when one happens; the schedule keys above own that.",
  },
  {
    key: "notify_supp_morning_hour",
    what: "profile schedule: the Morning intake-reminder slot hour (also read by lib/profile-food-slot for the food windows)",
  },
  {
    key: "notify_supp_midday_hour",
    what: "profile schedule: the Midday intake-reminder slot hour",
  },
  {
    key: "notify_supp_evening_hour",
    what: "profile schedule: the Evening intake-reminder slot hour",
  },
  {
    key: "notify_supp_bedtime_hour",
    what: "profile schedule: the Bedtime intake-reminder slot hour",
  },
  {
    key: "notify_waking_start",
    what: "profile schedule: the waking-window start hour (#450)",
  },
  {
    key: "notify_waking_end",
    what: "profile schedule: the waking-window end hour",
  },
  {
    key: "notify_workout_enabled",
    what: "profile preference: whether training reminders are on",
  },
  {
    key: "notify_milestones",
    what: "profile preference: whether milestone announcements are on",
  },
  {
    key: "notify_preventive",
    what: "profile preference: whether preventive nudges are on (distinct from notify_preventive_assessed, which is the tick's per-day gather gate)",
  },
  // The tick's own cadence bookkeeping (global `settings`), not send markers: neither
  // key can ever suppress a message — they only size slotDue's attempt bands (#2121).
  {
    key: "notify_tick_last_run_at",
    what: "global watermark: the ISO instant the tick last started, from which the next tick derives its OBSERVED cadence (scripts/notify.ts → observedTickMinutes). Overwritten every tick; means nothing once passed.",
  },
  {
    key: "notify_tick_interval_min",
    what: "global record of the observed tick cadence in minutes (clamped 1-60), written every tick and read by Settings → Notifications for the sub-hourly honesty warning (subHourlySlotsAtRisk). Never consulted by a send decision — the tick passes the freshly derived value down in-process.",
  },
  // Login-tier flags — a person/device preference, never a per-subject send marker.
  {
    key: "notify_mute_profile_",
    what: "login_settings mute flag keyed by profile id: this login does not want THIS profile's notifications (lib/settings/notifications)",
  },
  {
    key: "notify_review_needed",
    what: "login_settings flag raising the Data → Review badge",
  },
  // Migration bookkeeping.
  {
    key: "notify_channel_migration_report",
    what: "migration 105's one-shot report of the profile→login notification-channel move",
  },
];

const BY_LENGTH = [...SEND_MARKER_REGISTRY].sort(
  (a, b) => b.key.length - a.key.length
);

/**
 * The registry entry a stored settings key belongs to, or null. Longest declaration
 * first, so `notify_last_supp_PreWorkout` resolves to the `notify_last_supp_` family and
 * a fixed key is never shadowed by a shorter namespace.
 */
export function sendMarkerEntryFor(key: string): SendMarkerEntry | null {
  return (
    BY_LENGTH.find((e) => (e.fixed ? key === e.key : key.startsWith(e.key))) ??
    null
  );
}

/** Every declared namespace, for the guards and docs. */
export const SEND_MARKER_KEYS: readonly string[] = SEND_MARKER_REGISTRY.map(
  (e) => e.key
);

// ── Key builders ─────────────────────────────────────────────────────────────
// A marker whose tail is interpolated from a variable is invisible to the scan, which
// is exactly how `notify_last_practice`, `notify_last_workout`, `notify_last_mood_checkin`
// and the food windows stayed unregistered. These builders give those tails a closed,
// TYPED vocabulary and put the only literal spelling in the declaring module.

/** The per-window food nudge's per-day marker. */
export const FOOD_NUDGE_MARKER_PREFIX = "notify_last_food_";
export function foodNudgeMarkerKey(window: FoodNudgeWindow): string {
  return `${FOOD_NUDGE_MARKER_PREFIX}${window}`;
}

/** The merged intake reminder's per-slot, per-day marker. */
export const INTAKE_SLOT_MARKER_PREFIX = "notify_last_supp_";
export function intakeSlotMarkerKey(slot: IntakeSendSlot): string {
  return `${INTAKE_SLOT_MARKER_PREFIX}${slot}`;
}

/**
 * The tick's remaining per-day slots, whose markers were composed as
 * `notify_last_${slot}` from a free-form string. Declaring them as a closed record is
 * what lets the scan see them at all.
 */
export const TICK_SLOT_MARKER_KEYS = {
  workout: "notify_last_workout",
  mood_checkin: "notify_last_mood_checkin",
  practice: "notify_last_practice",
  wear_reminder: "notify_last_wear_reminder",
} as const;

export type TickSlot = keyof typeof TICK_SLOT_MARKER_KEYS;

/** The morning digest's per-day send marker. */
export const DIGEST_MARKER_KEY = "notify_last_digest";
/** The Dynamic digest's per-day FAILED-attempt record (#2211) — see the entry above. */
export const DIGEST_ATTEMPT_KEY = "notify_digest_attempt";
/**
 * The recap's per-scale, period-anchored marker (#2178). The tail is a member of the
 * closed `RecapScale` union, so the scan can see every key this family can ever mint —
 * the reason it is a builder and not an interpolation at the call site.
 */
export const RECAP_MARKER_PREFIX = "notify_last_recap_";
export function recapMarkerKey(scale: RecapScale): string {
  return `${RECAP_MARKER_PREFIX}${scale}`;
}
