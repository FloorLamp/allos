// THE CALLBACK-VOCABULARY REGISTRY (issue #1779 §3) — every button family the app can
// put in a chat, and what happens when it goes stale.
//
// PURE and declarative on purpose. It is the thing the completeness guard
// (lib/__tests__/reconcile-registry.test.ts) scans the notification source against, so
// a new button family cannot ship without answering the question "what happens when
// this message is still sitting in the chat tomorrow?". The two legal answers are:
//
//   • a FAMILY — a reconciler in ./reconcile.ts owns it, and knows how to ask the
//     ledger whether each of its tokens is still actionable;
//   • INERT — with a written reason. A view control ("▲ Collapse", "⚙️ Tune",
//     "➕ Show more") makes no state claim, so it cannot lie and must not, by its mere
//     presence, keep a fully resolved message alive.
//
// There is deliberately no third answer. "Not covered yet" is exactly the state that
// produced the defect.
//
// Since #1898 the module carries a SECOND declaration, keyed by message KIND rather
// than button prefix — see KIND_REISSUE below, and since #2018 a THIRD, keyed by
// family — see RECONCILE_DATE_GUARD.

import { isDoseDateAccepted } from "../dose-log-window";
import { tapDateGuard } from "./callback-data";
import type { CloseReason } from "./reconcile-core";
import type { NotificationKind } from "./types";

// The reconciler families. Each is one small read-only predicate over the SAME ledger
// the tap handler writes to — never a second dueness model (#221).
export type ReconcileFamily =
  | "intake-dose"
  | "escalation"
  | "household-round"
  | "food"
  | "food-optin"
  | "preventive"
  | "refill"
  | "symptom"
  | "mood"
  | "workout-draft"
  | "practice";

export interface ReconcilePrefixEntry {
  // The callback token prefix, without its colon.
  prefix: string;
  // The reconciler that owns messages led by this token.
  family?: ReconcileFamily;
  // …or the written reason this button makes no state claim.
  inert?: string;
}

export const RECONCILE_PREFIXES: readonly ReconcilePrefixEntry[] = [
  // ── Class 1: state-claim buttons ───────────────────────────────────────────
  // The message asserts something is outstanding and an in-app write can resolve it.

  // Dose reminders (#232/#1154). The sharpest case in the issue: a dose taken in the
  // app leaves a live "✅ Taken" six hours later, and that is the prompt that invites a
  // double dose.
  { prefix: "take", family: "intake-dose" },
  { prefix: "skip", family: "intake-dose" },
  { prefix: "all", family: "intake-dose" },
  // ⤓ May rides the dose reminder (#1505 part 2) and dies with the same message —
  // and separately once the item is already `may`, when the suggestion is moot.
  { prefix: "demote", family: "intake-dose" },

  // Missed-dose escalation (#233 phase 2) — safety tier. A confirmed-taken dose must
  // not keep a caregiver's chat claiming it was missed.
  { prefix: "esctake", family: "escalation" },
  { prefix: "escskip", family: "escalation" },
  { prefix: "escack", family: "escalation" },

  // The household round (#1459): one message, one button per member. Members resolve
  // independently, so this is the canonical PARTIAL case.
  { prefix: "hh", family: "household-round" },

  // Preventive nudges (#233 phase 1): done / not-applicable / remind-later, all three
  // resolvable from the app.
  { prefix: "pvdone", family: "preventive" },
  { prefix: "pvna", family: "preventive" },
  { prefix: "pvlater", family: "preventive" },

  // Refill nudge (#233 phase 3): logging the refill in the app ends the shortage.
  { prefix: "rfsnooze", family: "refill" },

  // Symptom follow-up (#859): the day's symptom logged in the app answers the ask.
  { prefix: "symp", family: "symptom" },
  { prefix: "symsev", family: "symptom" },

  // Daily check-in (#992) and its confirm-to-KEEP affordance (#1668).
  { prefix: "mood", family: "mood" },
  { prefix: "moodkeep", family: "mood" },

  // Stale-workout nudge (#1205): the draft finished or discarded in the app.
  { prefix: "wofinish", family: "workout-draft" },
  { prefix: "wodiscard", family: "workout-draft" },

  // Practice pace nudge (#1259): a session logged in the app clears the shortfall.
  { prefix: "pdone", family: "practice" },
  // ⤓ Right-size rides that same nudge (#1670) and dies with the same message — and
  // separately once the floor has been lowered in the app, when the offer is moot.
  // The `demote`-on-a-dose-reminder shape one domain over: a ride-along inherits the
  // family of the message it decorates rather than earning one of its own.
  { prefix: "rslower", family: "practice" },

  // ── Class 2: additive quick-log buttons ────────────────────────────────────
  // The buttons don't lie — logging another serving stays valid all day — but the
  // COUNTS they carry go stale. Reconciled by re-rendering from the same builder and
  // editing only when the render actually differs.
  { prefix: "food", family: "food" },
  { prefix: "foodprotein", family: "food" },

  // ── Class 3: decision buttons ──────────────────────────────────────────────
  // A choice made in the app leaves the message offering a choice that no longer exists.
  { prefix: "foodoptin", family: "food-optin" },

  // ── Inert: view controls, not state claims ─────────────────────────────────
  {
    prefix: "foodmore",
    inert:
      "reveals the next page of the SAME nudge's ranked buttons — a stateless view change that logs nothing and claims nothing",
  },
  {
    prefix: "foodless",
    inert:
      "collapses that expansion one page back (#1807) — the exact mirror of foodmore, pure keyboard view state, and it clamps at the compact default rather than emptying the keyboard",
  },
  {
    prefix: "offer",
    inert:
      "expands the digest's guaranteed-access tail (#1505); the expansion re-resolves the slot AT TAP, so the collapsed button cannot be stale",
  },
  {
    prefix: "offerc",
    inert: "collapses the offer tail back — pure keyboard view state",
  },
  {
    prefix: "prn",
    inert:
      "an additive access affordance (#797/#1505): logging an as-needed dose is valid at any time, and the token carries no date, so it never becomes a false claim",
  },
  {
    prefix: "tune",
    inert:
      "opens the digest's per-category preferences (#1714) — a preference control, never a claim about the day",
  },
  {
    prefix: "tunec",
    inert: "closes the ⚙️ Tune panel — pure keyboard view state",
  },
  {
    prefix: "tunet",
    inert:
      "flips one digest category's demotion (#1714); a preference is whatever it currently is and cannot go stale",
  },
];

// ── THE DATE-GUARD DECLARATION (issue #2018) ─────────────────────────────────
//
// The table above asks, per BUTTON, "what happens when this message is still sitting in
// the chat tomorrow?". This one asks the follow-up, per FAMILY: "HOW LATE may it still
// be acted on?" — and the only legal way to answer is to NAME THE GUARD THE TAP HANDLER
// ALREADY CONSULTS.
//
// #1784 answered it once, globally, in the sweep: `pointer.date < today` ⇒ close. That
// is `tapDateGuard`'s equality rule lifted out of the food handler and applied to every
// family, and it is wrong wherever the handler is MORE generous. A bedtime dose reminder
// lost its buttons at the first tick after local midnight while `markDoseTaken` would
// have honored the tap for two more days (#614) — the sweep deleting a button on the
// grounds that the handler would refuse the tap, and the handler having been built to
// accept it.
//
// So the answer here is a REFERENCE, never a number. There is deliberately no per-family
// "rollover policy" constant: any button-specific number would be a second answer to
// "how late may this be logged", which is the drift being fixed. If ±2 days is too
// generous for a dose, `DOSE_LOG_DATE_WINDOW_DAYS` moves the button, the Telegram tap,
// the web path and the offline replay together.
export type ReconcileDateGuard =
  // `tapDateGuard` (#221/#947): the token's date must still be the subject's today.
  | "exact-day"
  // `isDoseDateAccepted` (#614/#1427): within DOSE_LOG_DATE_WINDOW_DAYS of it.
  | "dose-window"
  // No date axis at all — the family's `dead` predicate answers completely.
  | "none";

export interface ReconcileDateGuardEntry {
  guard: ReconcileDateGuard;
  // Why THAT guard. Required for all three answers, including `none`: "this family has
  // no date question" and "nobody asked" have to stay distinguishable, exactly as they
  // do for an inert prefix and a non-re-issuable kind.
  why: string;
}

// Exhaustive by TYPE: a new family cannot ship without saying how late its message may
// be acted on.
export const RECONCILE_DATE_GUARD: Record<
  ReconcileFamily,
  ReconcileDateGuardEntry
> = {
  "intake-dose": {
    guard: "dose-window",
    why: "handleDoseTap applies no date check of its own — it passes the token's date straight into markDoseTaken/markDoseSkipped, which gate on isDoseDateAccepted. A dose's token date is a fact the SYSTEM established (the schedule's day, assigned before the message was sent), so the tap does not report when something happened, it confirms that a scheduled thing did. There is no second candidate answer to reconcile, which is why a late tap is not a stale guess and why deleting the button at midnight was pure loss.",
  },
  escalation: {
    guard: "dose-window",
    why: "The safety tier's version of the same tap: esctake/escskip run the very same markDoseTaken/markDoseSkipped cores, so they accept the same window. An overnight missed-dose escalation must keep its buttons while the dose is still unconfirmed — closing it at midnight removes a caregiver's only affordance over a dose nobody answered.",
  },
  "household-round": {
    guard: "exact-day",
    why: "handleHouseholdDoseTap consults tapDateGuard directly (#1719) before touching the member's ledger, so closing at the day boundary is exactly the refusal a tap would be answered with.",
  },
  food: {
    guard: "exact-day",
    why: "handleFoodTap consults foodTapDateGuard (#947). The token's date is the system's GUESS at a user-owned fact — a tap means 'I am eating now', and the button carries nothing that settles which day that was — so the handler writes only where its two candidate answers agree and refuses where they diverge. That guess expires at the day boundary, so rollover-close is correct here.",
  },
  "food-optin": {
    guard: "none",
    why: "foodoptin:<profileId>:<yes|no> carries no date, and the choice is about a SETTING rather than a day: while food logging is still off the prompt is exactly as true tomorrow as today. The dead predicate closes it the moment the setting flips.",
  },
  preventive: {
    guard: "none",
    why: "pvdone/pvna/pvlater carry a rule key, not a date; the tap acts on the rule's CURRENT dueness and 'remind later' snoozes from today. Whether the rule is still in assessProfilePreventive's actionable slice answers completely.",
  },
  refill: {
    guard: "none",
    why: "rfsnooze carries an item id. A shortage is a standing state rather than a day, and the snooze runs from today; the dead predicate ends the message when the supply is no longer low.",
  },
  symptom: {
    guard: "none",
    why: "symp/symsev carry a slug and a severity and no date at all — handleSymptomSeverity logs to today(profileId), never to a token date. There is no stale day for the sweep to refuse on the handler's behalf.",
  },
  mood: {
    guard: "exact-day",
    why: "mood:<profileId>:<valence>:<date> names ONE day's check-in, and the token's date is a guess at a user-owned fact in exactly food's sense: a next-morning tap on last night's face picker would answer yesterday's question. handleMoodTap writes the token's date without consulting the guard, so the sweep is deliberately the STRICTER of the two here — the safe direction, since reconciliation may only ever REDUCE what a chat claims. Should that handler ever gain a date check it must be this one, not a third.",
  },
  "workout-draft": {
    guard: "none",
    why: "wofinish/wodiscard carry an activity id and no date, because a draft is not a DAY's claim — it is the live session, and getWorkoutPresence answers whether it still is. A draft running across midnight must keep its finish and discard buttons; date is not an axis this object has.",
  },
  practice: {
    guard: "none",
    why: "pdone carries a target id and a render nonce; logPracticeByTargetId logs the session NOW against the weekly floor. No day is being confirmed, so there is nothing for a date guard to protect.",
  },
};

// The close reason for a message the day has moved past — or null while its family's
// handler would still honor a tap on it. THE sweep's date answer, and a pure consumer of
// the two existing guards rather than a third opinion about how late a tap may land.
//
// `family` is null for a keyboard whose tokens nobody has reasoned about (the
// completeness guard makes that a build failure) or one that makes no state claim at
// all; both fail safe by never expiring, the same posture `dead` takes.
export function messageExpiry(
  family: ReconcileFamily | null,
  messageDate: string,
  todayDate: string
): Extract<CloseReason, "rollover" | "expired"> | null {
  if (!family) return null;
  switch (RECONCILE_DATE_GUARD[family].guard) {
    case "exact-day":
      return tapDateGuard(messageDate, todayDate).kind === "stale-date"
        ? "rollover"
        : null;
    case "dose-window":
      return isDoseDateAccepted(todayDate, messageDate) ? null : "expired";
    case "none":
      return null;
  }
}

// ── THE RE-ISSUE DECLARATION (issue #1898) ───────────────────────────────────
//
// #1779 made stale keyboards HONEST — every registered message gets its counts and
// buttons refreshed hourly. Nothing made them SINGULAR. Repeated `/dose` or `/symptom`
// calls accumulate live keyboards in a chat: each is safe to tap (typed-outcome cores)
// and each stays fresh (the sweep edits all of them), so the reconciler pays an hourly
// Telegram edit per duplicate, forever, to keep clutter honest.
//
// THE INVARIANT: ONE LIVE KEYBOARD PER (chat, kind). A send of a re-issuable kind
// re-issues THE keyboard; it never adds another. #947 solved this for the food nudge by
// hand; this declares, per kind, whether that rationale applies — and the completeness
// scan (lib/__tests__/reconcile-registry.test.ts) fails the build for a kind that never
// answered the question, exactly as the prefix table above does for buttons.
//
// "Not re-issuable" is the DEFAULT ANSWER FOR STATE-CLAIM KINDS and it is not a gap: a
// morning dose reminder and an evening one are two different claims, both legitimately
// live, and closing one because the other sent would destroy an outstanding safety
// prompt. Every `false` therefore carries its reason, so the two cases — "we decided
// against it" and "nobody looked" — stay distinguishable.

export interface KindReissueEntry {
  kind: NotificationKind;
  // True ⇒ a new send of this kind supersedes the chat's previous one: the older
  // message's keyboard is removed and its text closed with the attributed supersede
  // line (#1822's honest-subject convention).
  reissuable: boolean;
  // Why. Required in BOTH directions — a `true` has to say what makes re-sending an
  // act of replacement rather than an addition.
  why: string;
}

export const KIND_REISSUE: readonly KindReissueEntry[] = [
  // ── Re-issuable ────────────────────────────────────────────────────────────
  {
    kind: "prn-list",
    reissuable: true,
    why: "`/dose` renders the chat's as-needed list from live state; typing it again means 'show me that again', so the earlier copy is superseded by definition — and its buttons carry send-time redose counters that the new list has already recomputed.",
  },
  {
    kind: "symptom",
    reissuable: true,
    why: "`/symptom` renders the recency-ranked grid on demand. A second call re-ranks it, so the earlier grid is a stale ordering of the same question, and two open grids in one chat make 'which one did I tap' unanswerable.",
  },
  {
    kind: "mood",
    reissuable: true,
    why: "One wellbeing check-in per day, re-sent (or asked for) as one question. A second live face-picker in the chat would let the same day be answered twice from two messages, and the newer send is the one whose date the tokens carry.",
  },

  // ── Not re-issuable ────────────────────────────────────────────────────────
  {
    kind: "temp",
    reissuable: false,
    why: "A `/temp` call in a MULTI-PROFILE chat sends one prompt PER profile in a single invocation, each carrying its own reply marker. The sibling-closing hazard that first justified this entry is gone since #1995 — those prompts now declare their own subjects, so the supersede lookup is per profile and cannot reach a sibling's copy — but the entry stands on its own footing: a `/temp` prompt asks for a typed REPLY and carries no keyboard, so it records no pointer and supersedes nothing either way. If a prompt ever gains buttons, re-issue becomes a real question and gets answered then, per profile.",
  },
  {
    kind: "food",
    reissuable: false,
    why: "The food nudge already holds the single-live invariant through its own #947/#1945 pointer rotation, whose strip is conditioned on the NEW message actually carrying a `food:` quick-log token. The generic (chat, kind) rule cannot express that condition, and without it a view-control-only nudge (#1807's '➖ Show less' shape) would close the only keyboard in the chat that can still log a serving.",
  },
  {
    kind: "dose",
    reissuable: false,
    why: "Tick-owned and per-SLOT: the morning session and the evening session are two outstanding claims, both true at once. Closing one because the other sent would remove a safety prompt nobody answered.",
  },
  {
    kind: "redose",
    reissuable: false,
    why: "One notice per PRN redose window; two windows can be open for two different items, and neither supersedes the other.",
  },
  {
    kind: "escalation",
    reissuable: false,
    why: "Safety tier, per missed dose. A second escalation is a second unanswered dose, never a re-issue of the first.",
  },
  {
    kind: "followup",
    reissuable: false,
    why: "Two sends ever, per tracked follow-up item (#1866), each about its own overdue date — additive by construction.",
  },
  {
    kind: "refill",
    reissuable: false,
    why: "Per item running low; several items can be short at once and each nudge names its own.",
  },
  {
    kind: "preventive",
    reissuable: false,
    why: "Per due screening. Two recommendations coming due in one week are two separate asks.",
  },
  {
    kind: "illness-care",
    reissuable: false,
    why: "A care finding derived from logged symptoms (#805); each send is about a different trajectory the bus decided to surface, not a re-render of the last one.",
  },
  {
    kind: "practice",
    reissuable: false,
    why: "Per practice behind its weekly floor — the nudge names which one, and a second practice falling behind is a second message.",
  },
  {
    kind: "workout",
    reissuable: false,
    why: "Schedule-driven training reminder; each is tied to the session it is nudging.",
  },
  {
    kind: "workout-stale",
    reissuable: false,
    why: "One per unfinished session draft (#1205). Two drafts left running are two messages, each with its own finish/discard pair.",
  },
  {
    kind: "workout-recap",
    reissuable: false,
    why: "A recap line about ONE logged session — a record of something that happened, which a later session never supersedes.",
  },
  {
    kind: "ease-back",
    reissuable: false,
    why: "One-shot per illness episode (#837); there is no second send to supersede the first.",
  },
  {
    kind: "digest",
    reissuable: false,
    why: "One per day, and the sweep's date arm closes yesterday's as soon as the guard of whichever family owns its keyboard refuses a tap. That keyboard is the offer tail, whose pointer the tick re-labels in place rather than re-sending.",
  },
  {
    kind: "upcoming",
    reissuable: false,
    why: "Folded into the digest by #1108 — nothing dispatches it, so there is nothing to re-issue. The kind stays in the union for stored disabled-kind blobs.",
  },
  {
    kind: "weekly-recap",
    reissuable: false,
    why: "One per week, about the seven days it names; a later week's recap is a different subject.",
  },
  {
    kind: "milestone",
    reissuable: false,
    why: "Each milestone is its own event. Superseding would erase the note about the previous one.",
  },
  {
    kind: "test",
    reissuable: false,
    why: "A send-test exists to prove a message ARRIVED; closing the previous test would delete the evidence the user pressed the button to get.",
  },
  {
    kind: "other",
    reissuable: false,
    why: "The unclassified catch-all. Everything with no kind lands here, so superseding on it would let any two unrelated messages close each other — the one bucket where the invariant must never apply.",
  },
];

const BY_KIND = new Map(KIND_REISSUE.map((e) => [e.kind as string, e]));

// Does a new send of `kind` supersede the chat's previous live keyboard of that kind?
// An UNKNOWN kind answers false — a kind that slipped past the completeness scan must
// fail safe (leave the older message alone) rather than close something nobody reasoned
// about. The scan is what makes "unknown" a build failure instead of a silent no-op.
export function isReissuableKind(kind: string | null | undefined): boolean {
  return kind == null ? false : (BY_KIND.get(kind)?.reissuable ?? false);
}

const BY_PREFIX = new Map(RECONCILE_PREFIXES.map((e) => [e.prefix, e]));

export function reconcileEntryFor(
  prefix: string | null
): ReconcilePrefixEntry | undefined {
  return prefix == null ? undefined : BY_PREFIX.get(prefix);
}

// The family that OWNS a message, given its keyboard's tokens in keyboard order: the
// first token that makes a state claim. Builders put the primary action rows first and
// ride-along rows (the offer tail, ⚙️ Tune) last, so "first" is the message's subject.
//
// Null when nothing on the keyboard claims state — a `/dose` list, a fully collapsed
// digest — in which case there is nothing to reconcile and the sweep makes no call.
export function owningFamily(
  tokens: readonly string[],
  prefixOf: (token: string) => string | null
): ReconcileFamily | null {
  for (const t of tokens) {
    const entry = reconcileEntryFor(prefixOf(t));
    if (entry?.family) return entry.family;
  }
  return null;
}

// Which of a keyboard's tokens are INERT — passed to the pure decision so they neither
// die nor keep a resolved message alive. An UNKNOWN prefix is deliberately NOT inert:
// it is treated as a live claim, so a family that slips past the registry fails safe
// (its message is left alone rather than silently closed). The completeness guard is
// what makes "unknown" a build failure rather than a runtime surprise.
export function inertTokens(
  tokens: readonly string[],
  prefixOf: (token: string) => string | null
): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    if (reconcileEntryFor(prefixOf(t))?.inert) out.add(t);
  }
  return out;
}
