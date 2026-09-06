// THE SHARED-CADENCE BOUNDARY (issue #2089) — for every notification family, WHAT
// decides when it sends.
//
// #2036 (via PR #2077) extracted `planNudgeCadence` (lib/nudge-cadence.ts): one answer
// to "given what has already been sent, what is live, and what the user has silenced,
// which nudges go out now and which stale markers get swept?". Four planners that had
// each re-derived those three rules by hand became thin adapters over it.
//
// What the extraction did NOT do is say where its jurisdiction ENDS. Nothing declared
// which families must ride it, so every family outside it carried private cadence code
// with no way to tell "this was decided" from "nobody looked" — and #2033 is what that
// costs: the workout nudge decided its own driver logic privately and got it wrong.
//
// This is the same shape every registry in this repo started as: a good shared core
// with voluntary adoption. The dismissal registry (#1931), the send-marker registry
// (#2036) and the reconcile registry (#1779/#1898/#1913) each became reliable at the
// moment membership became TOTAL — everything registered, or explicitly exempt with a
// written reason. So: every `NotificationKind` declares which mechanism owns its
// cadence, and since #5351 the declaration is KEYED on that union, so a kind that never
// answered does not compile.
//
// THE EXEMPTIONS ARE THE POINT, not an admission. `planNudgeCadence` answers ONE
// question — when does an EPISODE nudge repeat, and when is its marker stale? — and
// most send families are not episode nudges at all. A morning digest is a scheduled
// composition; a dose reminder is a slot on a schedule the user wrote; a milestone is
// an announcement of something that happened once. Routing those through an episode
// planner would not share a decision, it would impose the wrong one. Each exemption
// therefore names the mechanism that DOES own the decision, so "exempt" is a positive
// claim about where the code lives rather than a hole.
//
// NO POLICY MOVES HERE. This declares existing behaviour; it changes no send, no
// marker, no suppression. In particular SAFETY STANDING is untouched and stated by the
// TYPE: dose reminders and missed-dose escalations keep their own timing contract and
// their never-suppressed status, and a safety kind may never be declared a member (the
// planner's freeze rule reads the suppression bus, which must never reach them).
//
// Related: `./reconcile-registry.ts` (three sibling per-kind declarations, same shape),
// `./send-markers.ts` (what each marker PROMISES — the storage-side twin of this file),
// `docs/internals/notifications.md`.

import type { NotificationKind } from "./types";
import type { SafetyKind } from "./kinds";

/**
 * What decides when a family sends.
 *
 * One member — `nudge-cadence` — IS the shared engine. Every other value names a
 * different owner of the decision, which is what makes an exemption checkable: a
 * reader can go read the named mechanism.
 */
export type SendCadence =
  /** `planNudgeCadence` (lib/nudge-cadence.ts) decides sends and marker sweeps. */
  | "nudge-cadence"
  /**
   * A SCHEDULE the user configured decides the moment — a slot hour, a weekday, an
   * inferred training time — and a profile-local-date marker only stops the same
   * schedule firing twice in one day. There is no episode to repeat or sweep.
   */
  | "user-schedule"
  /**
   * A per-subject CLOCK owns the timing: a PRN redose interval, the missed-dose
   * escalation ladder. Safety-tier timing contracts live here and nowhere else.
   */
  | "item-clock"
  /**
   * ONE send per subject, keyed on a row id that never recycles. The subject happening
   * IS the trigger, and it cannot happen again, so there is no cadence to decide.
   */
  | "per-subject-event"
  /** The user asked, in the chat, one second earlier. The request IS the cadence. */
  | "on-demand"
  /** Nothing dispatches this kind. */
  | "not-dispatched";

/** The exemption half of the vocabulary — every value that is NOT the shared engine. */
export type ExemptCadence = Exclude<SendCadence, "nudge-cadence">;

/**
 * One kind's answer. A member's `why` names the adapter module that calls
 * `planNudgeCadence`; there used to be a separate `planner` PATH field beside it, read
 * back against the real import graph by a source scan. Both are gone (#5351): the path
 * was a second copy of a sentence the `why` already carried, and the scan's other half
 * — that a module calling the engine has joined this declaration — is a class it might
 * catch rather than a defect it has, which is not what earns a scan
 * (docs/orchestration/what-earns-a-guard.md).
 */
export type KindCadenceEntry = { cadence: SendCadence; why: string };

/**
 * WHAT DECIDES WHEN EACH FAMILY SENDS — keyed on `NotificationKind`, so `tsc` tracks
 * it (#5351/#5346). A new kind does not compile until it answers; a retired one does
 * not compile until it is removed; a duplicate cannot be written down. This used to be
 * an ARRAY with `lib/__tests__/cadence-registry.test.ts` reconciling it against the
 * union on every run, which is the shape
 * docs/internals/verification-failure-modes.md line 83 names: a guard that lists a
 * union's members does not track the union.
 *
 * A SAFETY KIND MAY NOT BE A MEMBER, and that is the row's TYPE rather than a rule a
 * test restates: `planNudgeCadence`'s freeze rule is a suppression-bus lookup, so
 * membership for a safety kind would put a dismissal between a person and their
 * medication — the one policy AGENTS.md forbids moving.
 *
 * `why` is required in BOTH directions — a member has to say what makes it an episode
 * nudge, and an exemption has to name the mechanism that owns the decision instead, in
 * enough words to be read. "We decided against it" and "nobody looked" must stay
 * distinguishable, and a member's `why` names its adapter module.
 */
export const KIND_CADENCE: {
  readonly [K in NotificationKind]: K extends SafetyKind
    ? { cadence: ExemptCadence; why: string }
    : KindCadenceEntry;
} = {
  // ── Members: the episode nudges the shared engine decides ──────────────────
  refill: {
    cadence: "nudge-cadence",
    why: "A supply shortage is an EPISODE: it opens when the on-hand count drops under the threshold, it gets one send, and its marker is swept the moment the item is no longer low so the NEXT shortage nudges afresh. planRefillNudges (lib/refill-nudge.ts) and its pooled twin are adapters over the shared decision; the freeze half is the Upcoming dismissal (#227's dismiss-once-silence-everywhere).",
  },
  preventive: {
    cadence: "nudge-cadence",
    why: "A screening's due window is an episode keyed by the catalog rule: one send while it stays due, marker cleared when the rule is satisfied or ages out so the next interval fires. planPreventiveNudges (lib/preventive-nudge.ts) rides the FROZEN-KEEPS policy, because a rule covered by a booked visit must keep its marker (#183) rather than re-nudge the same episode when the booking is cancelled.",
  },
  "illness-care": {
    cadence: "nudge-cadence",
    why: "A care finding is anchored to an illness episode and its marker is the finding's own dedupeKey, so the bus key the user can dismiss and the key the cadence is spent against are the SAME string. planIllnessCareNudges (lib/illness-care.ts) decides it, and the temperature red-flag nudge shares that planner rather than owning a second copy.",
  },
  followup: {
    cadence: "nudge-cadence",
    why: "The only REPEAT cadence in the app: two sends per overdue tracked item, spaced off the first (#1866), which is exactly the `maxSends`/`repeatDays` axis the shared planner exposes. planFollowUpNudges (lib/followup-nudge.ts) reads the comma-joined send dates out of one marker, so the whole cadence is data rather than a second marker.",
  },

  // ── Exempt: a schedule the user wrote owns the moment ──────────────────────
  dose: {
    cadence: "user-schedule",
    why: "The item's own schedule slot IS the cadence, and it is a SAFETY signal: the reminder fires because the user said take this at 08:00, not because an episode opened. `notify_last_supp_<slot>` only stops one slot sending twice in a day. An episode planner would put its freeze rule — which reads the suppression bus — between a person and their medication, which AGENTS.md forbids outright.",
  },
  digest: {
    cadence: "user-schedule",
    why: "A scheduled COMPOSITION, not a nudge: it goes out once at the configured (or wake-inferred) hour and reports whatever the day holds, including nothing-to-say sections it simply skips. There is no per-subject episode to spend or sweep — its subjects are the findings it renders, each of which already carries its own cadence upstream.",
  },
  "weekly-recap": {
    cadence: "user-schedule",
    why: "The same scheduled composition on a periodic grain: the chosen weekday and time decide the SLOT, and `notify_last_recap_<scale>` stops a period being reported twice. It narrates a period that is already over, so there is no live episode a cadence engine could be spacing sends across. #2178 added a second decision INSIDE that slot — which scale (week / month / quarter) speaks — and it is deliberately not the shared planner either: `planRecapSend` (lib/recap-scale.ts) answers 'which of these closed calendar periods claims this one arrival', which is a precedence question over the calendar, not a candidate/freeze/sweep question over live subjects. It can never increase the number of sends, so it moves no contact policy.",
  },
  workout: {
    cadence: "user-schedule",
    why: "The inferred training schedule (weekdays + hour) decides the moment; the message then either has something to say about the week's routine or returns null. #2033 fixed its DRIVER — what counts as behind — which is a gather question, not a cadence one: routing it through the episode planner would not have caught that bug, because the bug was in deciding what to say, not when to say it.",
  },
  food: {
    cadence: "user-schedule",
    why: "Rides the profile's own morning/midday/evening supplement slot hours with a per-window per-day marker (`notify_last_food_<Window>`). A meal window is a slot, not an episode: it recurs on the clock whether or not the previous one was answered, and nothing about it is ever swept.",
  },
  mood: {
    cadence: "user-schedule",
    why: "One gentle ask riding the evening slot hour, deduped by `notify_last_mood_checkin` for the day. Its only non-slot rule is the ENGAGEMENT auto-pause (#992/#1668) — hold after N unanswered sends, re-arm on any logged check-in — which is a consent mechanism about contact, not an episode lifecycle: there is no subject that stops being live, and the shared planner's sweep would have nothing to sweep.",
  },
  practice: {
    cadence: "user-schedule",
    why: "Once per profile-local day inside the waking window, gathered from the targets that are behind their weekly floor. The DAY is the cadence and `notify_last_practice` is the whole of it; the bus gate is applied inside behindPractices, so a dismissed target is simply absent from the gather. A practice with an inferred weekly rhythm additionally holds itself for its next predicted day and typical hour (#2188, practiceNudgeReleased) — a RELEASE refinement inside the gather, only ever later within the week and never more often, with the flip-day rule back once the week's last predicted day passes. Nothing here is spaced from a first send or swept when a subject leaves — the marker re-arms at midnight regardless.",
  },
  "wear-reminder": {
    cadence: "user-schedule",
    why: "One opt-in ask riding the profile's Bedtime slot minute, deduped by `notify_last_wear_reminder` for the night. There is no episode and no subject: the marker re-arms at midnight, and every silencing condition — the consent flag, the expected-active gate, the provider-health deference, the quiet-stream tolerance — is evaluated fresh at the slot and reported as a null build, which leaves the marker UNSET rather than spending the night. The shared planner's candidate/freeze/sweep vocabulary has nothing to attach to here.",
  },

  // ── Exempt: a per-subject clock owns the timing ────────────────────────────
  escalation: {
    cadence: "item-clock",
    why: "A safety LADDER with its own timing contract: it fires a fixed interval after a scheduled dose goes unconfirmed, per dose, and is deliberately un-suppressible — dismissing the matching item elsewhere never silences it. The shared planner's freeze rule is a suppression-bus lookup, so membership would be a policy change in the one place policy must not move.",
  },
  redose: {
    cadence: "item-clock",
    why: "One notice per PRN redose window, armed by an administration and released by its minimum interval (#798). Two observed-tick attempt bands surround that opening (immediate + one retry an hour later), and the marker stores the administration id; a newer dose spends the old button and arms a new item clock, while an outage can never turn an old open condition into a catch-up send.",
  },

  // ── Exempt: one send per subject; the subject cannot recur ─────────────────
  "workout-recap": {
    cadence: "per-subject-event",
    why: "One summary per finished session, keyed on the activity id (`notify_last_post_workout_<id>`). Finishing a workout is the trigger and it happens once; ids never recycle (#203), so a stranded marker is an inert dead row rather than a lost or duplicated send.",
  },
  "practice-recap": {
    cadence: "per-subject-event",
    why: "One note per finished practice ROW, keyed on the practice_logs id (`notify_last_practice_recap_<id>`); ids never recycle (#203). The trigger is not the tap but the moment the minute stream first covers the session's window, so the tick re-asks each pass inside a two-hour bound and stops — a row that never gains coverage sends nothing and leaves the marker unset, because the marker records a send that happened.",
  },
  "workout-stale": {
    cadence: "per-subject-event",
    why: "One nudge per unfinished draft (#1205), keyed on the draft's activity id. The draft either gets finished or discarded — nothing ever puts the same draft back into the un-nudged state — so there is no second send to space and no marker to sweep.",
  },
  "ease-back": {
    cadence: "per-subject-event",
    why: "One post-illness re-entry note per episode, forever (#837), keyed on the illness episode id. Re-firing for an episode already eased back out of is the exact bug the marker exists to prevent, which is the opposite of a cadence that repeats.",
  },
  milestone: {
    cadence: "per-subject-event",
    why: "The `milestones` table IS the fired marker (#32/#378): a crossing is recorded once and announced once, and a cumulative milestone cannot un-cross. Re-running the check every waking tick is idempotent by construction, so there is no cadence state for a planner to hold.",
  },

  // ── Exempt: the user asked one second ago ─────────────────────────────────
  "prn-list": {
    cadence: "on-demand",
    why: "The reply to a `/dose` command (#797). The request IS the cadence — a rule that could delay or withhold the answer to something the user typed a second earlier would be a bug, not a policy. Kinded only so the single-live-keyboard invariant (#1898) can key on it.",
  },
  symptom: {
    cadence: "on-demand",
    why: "The reply to a `/symptom` command (#859): a picker rendered in place, with no scheduled send behind it. Same reasoning as the other direct replies — there is nothing to schedule, only something to answer.",
  },
  temp: {
    cadence: "on-demand",
    why: "The prompt a `/temp` command answers with (#859). It asks for a reading the user just said they wanted to record; nothing decides WHEN it goes out except the command itself.",
  },
  "practice-list": {
    cadence: "on-demand",
    why: "The reply to a `/practice` command (#1895) — the tracked practices as one-tap buttons. Nothing schedules it, and nothing may delay it: the pace NUDGE is the scheduled member of this domain (kind `practice`, which carries its own cadence entry), and keeping the two kinds apart is what stops a cadence rule written for the nag from throttling an answer.",
  },
  weight: {
    cadence: "on-demand",
    why: "The prompt a `/weight` command answers with (#1895) — the `temp` prompt one quantity over, and the same reasoning: the command itself is the only thing that decides when it goes out.",
  },
  test: {
    cadence: "on-demand",
    why: "The Settings send-test, which exists to prove the wiring delivers. Any cadence at all — a hold, a dedupe, a spacing rule — would stop the test from answering the only question it is asked.",
  },

  // ── Exempt: nothing dispatches it ─────────────────────────────────────────
  upcoming: {
    cadence: "not-dispatched",
    why: "Folded into the morning digest's Today section by #1108; no send path mints this kind any more. The kind stays in the union for back-compat with stored disabled-kind blobs. Were it ever revived it would be a scheduled composition and would have to answer this question for real.",
  },
  other: {
    cadence: "not-dispatched",
    why: "The unclassified catch-all every un-kinded message lands in. It has no builder, no schedule and no subject, so there is no cadence to own — and giving the bucket one would apply it to arbitrary unrelated messages.",
  },
};

/** The kinds the shared engine decides. */
export const SHARED_CADENCE_KINDS: readonly NotificationKind[] = Object.entries(
  KIND_CADENCE
).flatMap(([kind, e]) =>
  e.cadence === "nudge-cadence" ? [kind as NotificationKind] : []
);
