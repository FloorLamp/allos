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
  // ⤓ The dose-time correction chips + picker (#2020) ride the dose reminder and inherit
  // its family, the same ride-along shape `demote` has. They die on their OWN clock — a
  // burst older than an hour — rather than on the doses': a confirmed session keeps its
  // chips for the hour in which the instant can still be wrong, and a still-pending one
  // is not kept alive by them, because the family's `dead` set covers both prefixes.
  { prefix: "dosetime", family: "intake-dose" },
  { prefix: "dosetimeat", family: "intake-dose" },

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
  // The eating-time correction chips + picker (#2019). NOT inert: unlike "Show more",
  // these DO make a state claim — "these servings are still correctable here" — which
  // stops being true one hour after the burst was tapped. That is what the sweep strips,
  // in one trailing edit per logging burst, and it is also what closes an abandoned open
  // picker instead of leaving a modal keyboard stranded in the chat.
  { prefix: "foodtime", family: "food" },
  { prefix: "foodtimeat", family: "food" },

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
    prefix: "plog",
    inert:
      "the on-demand `/practice` list's ✅ button (#1895) — the `prn` shape one domain over: logging a session is additive and valid at any time, the token carries no date, and the list claims nothing about dueness (that is the `pdone` nudge's job, which keeps its own family)",
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
  {
    prefix: "actype",
    inert:
      "the post-workout type ask (#2272) — 'your tracker didn't say what this was'. It rides the recap the way `demote` rides a dose reminder, carries an activity id and no date, and its write is a COMPARE-AND-SWAP on the row still being `unclassified`: a session classified in the app since, or absorbed by the duplicate auto-merge (#2271), refuses the tap and says which happened (already-classified / out-of-date) instead of confirming a write that did not occur. That is the difference from the correction chips, which are NOT inert — those expire on a CLOCK nothing can re-check at tap time, so only the sweep can stop them lying. This one cannot lie: it is asked ONCE, and the answer it can still write is the only one it will ever accept.",
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
  {
    kind: "practice-list",
    reissuable: true,
    why: "`/practice` renders the tracked practices from live state (#1895), each line carrying this week's count. Typing it again means 'show me that again', so the earlier copy is a stale reading of the same question — and two live lists make 'which one did I tap' unanswerable, which for a session log matters: it is not idempotent.",
  },

  // ── Not re-issuable ────────────────────────────────────────────────────────
  {
    kind: "wear-reminder",
    reissuable: false,
    why: "It sends at most once a night by construction (one Bedtime slot, one per-day marker), so there is never a previous copy in the chat to supersede. It also carries no keyboard — its whole content is words — so it records no pointer and would have nothing to rotate even if a second send existed.",
  },
  {
    kind: "temp",
    reissuable: false,
    why: "A `/temp` call in a MULTI-PROFILE chat sends one prompt PER profile in a single invocation, each carrying its own reply marker. The sibling-closing hazard that first justified this entry is gone since #1995 — those prompts now declare their own subjects, so the supersede lookup is per profile and cannot reach a sibling's copy — but the entry stands on its own footing: a `/temp` prompt asks for a typed REPLY and carries no keyboard, so it records no pointer and supersedes nothing either way. If a prompt ever gains buttons, re-issue becomes a real question and gets answered then, per profile.",
  },
  {
    kind: "weight",
    reissuable: false,
    why: "A `/weight` prompt asks for a typed REPLY and carries no keyboard (#1895), so it records no pointer and supersedes nothing either way — the `temp` entry's reasoning, one quantity over. A multi-profile chat's per-profile prompts each declare their own subject (#1995), so re-issue cannot reach a sibling's copy even if the prompt gained buttons.",
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
    why: "One per day, and the sweep never re-issues it. It also never reaches the keyboard-expiry arm that closes a rolled-over message: `digest` declares a PROSE reconciler below, so the sweep's prose branch owns the pointer end to end, and at the day boundary it DROPS the pointer — untracked, no edit, no closing line — rather than closing the message (#2071). That arm could never have closed one anyway: every digest token is inert, so `decideReconcile` sees no claim and answers `none`. The keyboard itself is the offer tail, which the tick re-labels in place rather than re-sending (#1505).",
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

// ── THE PROSE-CLAIM DECLARATION (issue #1913 item 4) ─────────────────────────
//
// The two tables above are KEYBOARD-shaped. #1779 made the buttons honest and #1898 made
// them singular, and both key on what a message can be TAPPED to do. That left a whole
// class of lie untouched: a message whose claims live in its PROSE.
//
// The morning digest is the app's most-read message and the sharpest instance. It states
// "Supplements: 8/9 taken — missed Glycine (2 days)", and the owner's question exposed
// the gap: "if I mark yesterday's Glycine now, will this message fix itself?" It did not.
// Every digest keyboard token is INERT by the table above (an offer tail, a ⚙️ Tune
// control — correctly, they claim nothing), so `owningFamily` returns null and the sweep
// concluded there was nothing to reconcile. The reconciler was keyboard-claim-driven and
// the digest's claims are sentences.
//
// A PROSE-CLAIM KIND therefore declares its own reconciler, and the rule is the one
// every other class already obeys: NO SECOND RENDERER. The reconciler re-runs the SAME
// builder the send ran, for the SAME date, and edits only when the render actually
// differs — so an unchanged tick performs zero Telegram calls, exactly like the food
// nudge's additive class.
//
// DAY ROLLOVER DROPS THE POINTER, IT DOES NOT CLOSE THE MESSAGE. A dated report is honest
// AS HISTORY:
// yesterday's digest described yesterday, and replacing its text with "this is
// yesterday's message" would destroy a report the reader may legitimately scroll back
// to. Only the LIVE day's claims have to track the ledger, so the sweep simply stops
// tracking at the boundary.
//
// The declaration is exhaustive over kinds so the completeness scan covers this class
// too: the next report-shaped message (a weekly recap) has to say whether its prose
// reconciles rather than inheriting silence.

export type ProseReconciler = "digest";

export interface KindProseEntry {
  kind: NotificationKind;
  // The prose reconciler that owns this kind's claims, or null when its text makes no
  // claim that an in-app write can resolve.
  prose: ProseReconciler | null;
  // Why. Required in BOTH directions, like every other table here — "we decided this
  // message states no outstanding claim" and "nobody looked" must stay distinguishable.
  why: string;
}

export const KIND_PROSE: readonly KindProseEntry[] = [
  {
    kind: "digest",
    prose: "digest",
    why: "The digest's claims ARE its prose — an adherence fraction, a named missed item, a count of what is due — and every one of them can be resolved in the app while the message sits in the chat. Its keyboard is entirely inert, so nothing else in this registry could ever have covered it. Reconciled by re-running buildDigest for the pointer's date and rebuilding on change — behind the cheap dependency pre-check in ./digest-deps (#2069), which decides whether that rebuild is worth paying for and can only ever make it sooner. At the day boundary the pointer is DROPPED, not closed (#2071).",
  },
  {
    kind: "weekly-recap",
    prose: null,
    why: "A recap is about the seven days it names, and it is sent AFTER they are over — its claims are history the moment they are made, so there is no live day whose ledger they could drift from. (A recap that ever starts reporting the CURRENT week would have to move to a reconciler.)",
  },
  {
    kind: "workout-recap",
    prose: null,
    why: "A record of one session that happened. Nothing in the app makes a completed workout un-happen, so the sentence cannot become false. Since #2272 the line can be followed by the type ASK when the session's source declined to classify it — a question, not a claim, and its buttons refuse a stale tap on their own (see the `actype` entry above), so there is still no sentence here for a prose reconciler to correct.",
  },
  {
    kind: "milestone",
    prose: null,
    why: "An event announcement about a threshold that was crossed. It reports the past, and a later reading does not un-cross it.",
  },
  {
    kind: "dose",
    prose: null,
    why: "Its claims are carried by the KEYBOARD, which the intake-dose family already reconciles token by token — and that reconciler REBUILDS the whole message through renderMergedIntakeMessage, so the text follows the buttons. A prose reconciler here would be a second answer to the same question.",
  },
  {
    kind: "escalation",
    prose: null,
    why: "Same as the dose reminder, on the safety tier: the escalation family owns its tokens and the resolved dose closes the message outright.",
  },
  {
    kind: "food",
    prose: null,
    why: "The food nudge's counts live in its button labels and its tally line, and the `food` family already re-renders the whole message from buildFoodNudge on change. Covered, by a keyboard family that happens to rebuild text.",
  },
  {
    kind: "redose",
    prose: null,
    why: "A notice that one PRN window is open. The window closes on its own clock rather than on a ledger write, and the message is a heads-up about that moment, not a standing claim.",
  },
  {
    kind: "followup",
    prose: null,
    why: "Two sends per tracked item (#1866), each about its own overdue date at the moment it was sent. The Upcoming item is where the live state is read; the message is the notice that it existed.",
  },
  {
    kind: "refill",
    prose: null,
    why: "Its one claim — this item is running low — is carried by the rfsnooze token the `refill` family already reconciles, and the message closes when the shortage ends.",
  },
  {
    kind: "preventive",
    prose: null,
    why: "The `preventive` family owns its done / not-applicable / remind-later tokens against the same actionable slice the nudge was composed from; the whole message closes when the rule stops being due.",
  },
  {
    kind: "illness-care",
    prose: null,
    why: "A care finding derived from logged symptoms at the moment it fired. It describes a trajectory the bus decided to surface, not a due item a later write settles.",
  },
  {
    kind: "practice",
    prose: null,
    why: "The `practice` family reconciles its pdone token against live weekly progress, closing the message once the shortfall is gone.",
  },
  {
    kind: "workout",
    prose: null,
    why: "A recommendation for today, not a claim about state. Training the suggested session does not make the sentence false — it makes it answered, and the day's own rollover ends it.",
  },
  {
    kind: "workout-stale",
    prose: null,
    why: "Its claim — this draft is still running — is the `workout-draft` family's token, reconciled against getWorkoutPresence.",
  },
  {
    kind: "ease-back",
    prose: null,
    why: "One-shot guidance at the end of an illness episode (#837). It offers a way to resume, and no in-app write contradicts it.",
  },
  {
    kind: "mood",
    prose: null,
    why: "A question, not a claim. The `mood` family closes it the moment the day's check-in exists, whichever surface logged it.",
  },
  {
    kind: "symptom",
    prose: null,
    why: "The `/symptom` grid is a picker; the `symptom` family removes each entry the day's log answers.",
  },
  {
    kind: "wear-reminder",
    prose: null,
    why: "A question about the data (\"your watch hasn't recorded since 21:05 — still on the charger?\"), not a claim an in-app write can resolve. Putting the watch back on is not an app action at all, and the stream healing is already answered by the next night's silence: the reminder is evaluated fresh at each Bedtime slot and simply does not send.",
  },
  {
    kind: "prn-list",
    prose: null,
    why: "A user-initiated listing of what is available right now. Its buttons are declared inert because an as-needed dose stays loggable all day, and its text is that same offer — it asserts nothing outstanding.",
  },
  {
    kind: "temp",
    prose: null,
    why: "A prompt asking for a reading. Like the check-in, it poses a question rather than claiming an answer.",
  },
  {
    kind: "weight",
    prose: null,
    why: "The `/weight` prompt (#1895) — the `temp` prompt one quantity over. It asks for a number and asserts nothing that a later write could falsify.",
  },
  {
    kind: "practice-list",
    prose: null,
    why: "A user-initiated listing of the tracked practices (#1895), the `prn-list` shape one domain over: its buttons are inert because logging a session is additive and always valid, and its text is that same offer plus this week's counts as they stood when the user asked. It claims nothing outstanding — the pace NUDGE is the message that does, and the `practice` family already owns its keyboard.",
  },
  {
    kind: "upcoming",
    prose: null,
    why: "Folded into the digest by #1108 — nothing dispatches it. Were it ever revived it would be a report-shaped message and would have to answer this question for real.",
  },
  {
    kind: "test",
    prose: null,
    why: "A send-test exists to prove a message ARRIVED. Editing it afterwards would corrupt the very evidence the user pressed the button to get.",
  },
  {
    kind: "other",
    prose: null,
    why: "The unclassified catch-all. Everything with no kind lands here, so a reconciler on it would re-render arbitrary unrelated messages through the digest builder — the one bucket where this must never apply.",
  },
];

const BY_KIND_PROSE = new Map(KIND_PROSE.map((e) => [e.kind as string, e]));

// The prose reconciler that owns a delivered message's claims, or null. An UNKNOWN kind
// answers null and fails safe — a kind that slipped past the completeness scan is left
// exactly as it was delivered rather than re-rendered through somebody else's builder.
export function proseReconcilerFor(
  kind: string | null | undefined
): ProseReconciler | null {
  return kind == null ? null : (BY_KIND_PROSE.get(kind)?.prose ?? null);
}

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
