// The ONE-TAP LOGGING substrate (issues #2041 and #2007).
//
// Three separate things live here because they are three halves of one question —
// "what happens when a person taps a logging affordance?" — and the repository had
// been answering it five to nine different ways:
//
//  1. THE FEEDBACK REGISTRY (#2041 finding 2). One-tap logging answered "did my tap
//     land?" with four unrelated designs and nothing recorded which applied where.
//     `ONE_TAP_AFFORDANCES` is that record: every one-tap affordance in the app
//     declares how it repeats, what feedback design it uses, and what interval (if
//     any) it expects between taps. A new one-tap surface picks from a named set
//     instead of inventing a fifth design.
//  2. THE LEDGER STATE MACHINE (#2041 finding 1). The "#748 item 2" pattern —
//     optimistic delta, rollback on failure, ADOPT the server's authoritative total
//     on success — was hand-rolled on five surfaces, each re-deriving the rollback
//     closure. `ledgerReducer` is that pattern as a pure machine;
//     `components/useOptimisticLedger.ts` is the one React binding over it. This is
//     the CLIENT half of the day-counter contract whose server half #2037 settled in
//     `lib/day-counter-ledger.ts` — step 4 there ("an authoritative re-SELECT, so the
//     caller answers with what the database now holds") is exactly the number the
//     `adopt` settlement here takes over whatever the tap guessed.
//  3. THE RE-LOG CONFIRM (#2007 layer 3). Whether a deliberate second tap should
//     ask first, from the affordance's declared interval + when the last one
//     happened + now. Pure, so the web button, the Telegram handler and any future
//     surface share one answer.
//
// Pure by construction: no DB, no clock, no React. Every caller supplies its own
// `nowMs`/`today` so a frozen test clock and a real one behave identically.

// ── 1. The feedback family ───────────────────────────────────────────────────────

// How a one-tap affordance answers "did my tap land?". These are the four designs
// that already exist in the app; the point of naming them is that the NEXT one-tap
// surface picks one rather than inventing a fifth.
//
//   optimistic-count — the number beside the tap moves immediately, then adopts the
//                      server's authoritative total (the #748 item 2 pattern).
//   cooldown         — no count to move: the tap's own inert window is the feedback,
//                      and the surface re-renders from the server's revalidation.
//   outcome-toast    — the write can REFUSE (retired dose, paused item), so the tap
//                      is answered from its typed outcome and never confirmed
//                      unconditionally.
//   recency-line     — an informational "you just did this" line beside a button that
//                      stays fully enabled (#1893/#798: informational, never
//                      permissive).
//
// These compose: EVERY affordance also gets the post-success cooldown (#2007 layer
// 1), which is why `cooldown` here means "the cooldown is the ONLY feedback".
export type OneTapFeedback =
  "optimistic-count" | "cooldown" | "outcome-toast" | "recency-line";

// What a SECOND tap means for this affordance — the classification that decides
// whether a confirm may ever appear (#2007's audited table).
//
//   idempotent — a second tap changes nothing (set semantics, upsert per day, a
//                per-(row, date) resolution). Layer 1 only.
//   additive   — a second tap writes again AND that is the point (a second serving,
//                a second PRN dose). Layer 1 only, and it MUST NEVER confirm:
//                asking "are you sure?" about a repeat that is the whole use case is
//                the failure mode this classification exists to prevent.
//   cadenced   — additive, but with a real expected interval between taps, so a
//                repeat inside that interval is worth asking about once.
export type OneTapRepeat = "idempotent" | "additive" | "cadenced";

// The declared interval an affordance expects between two legitimate taps. `none` is
// stated EXPLICITLY rather than left undefined so the confirm cannot leak onto an
// additive tap by omission — the whole reason #2007 asked for a declaration instead
// of a `oncePerDay` boolean.
export type ExpectedInterval = "day" | "supply-cycle" | "none";

export interface OneTapAffordanceDecl {
  readonly repeat: OneTapRepeat;
  readonly expectedInterval: ExpectedInterval;
  readonly feedback: OneTapFeedback;
  // Why this affordance is classified the way it is — the sentence that keeps a
  // later change honest.
  readonly why: string;
}

// Every one-tap logging affordance in the app. Adding a one-tap write means adding a
// row here: `lib/__tests__/one-tap.test.ts` enforces the invariants (a cadenced
// affordance declares an interval, and nothing else does), and
// `components/useOptimisticLedger.ts` takes one of these ids so a surface cannot run
// the shared machinery without declaring what its tap means.
export const ONE_TAP_AFFORDANCES = {
  "food-serving": {
    repeat: "additive",
    expectedInterval: "none",
    feedback: "optimistic-count",
    why: "DO UPDATE SET servings = servings + 1 — the (n) counts exist to celebrate repeat taps (#1016).",
  },
  "food-usual": {
    repeat: "idempotent",
    expectedInterval: "none",
    feedback: "outcome-toast",
    why: "ONE offer rendered from server state (#2380): its contents ARE the habitual groups this window still has nothing logged for, so a second tap has nothing left to offer and the write core re-derives the same set with a typed `nothing-to-log` refusal — a stale tap lands on an honest answer, never a second breakfast.",
  },
  "routine-usual": {
    repeat: "idempotent",
    expectedInterval: "none",
    feedback: "outcome-toast",
    why: "The COMPOSED morning offer (#2458) — the food half of `food-usual` PLUS the doses declared in that window and still pending. Both halves are rendered from server state and both are re-derived by the write core, which writes only the intersection: a second tap finds an empty bundle and answers `nothing-to-log`, and a partly-stale one writes the remainder and names what it could not. A separate id from `food-usual` deliberately — its tap also confirms doses, which moves a supply ledger, and misdeclaring that as the food tap would hide it from every census that reads this registry.",
  },
  "protein-grams": {
    repeat: "additive",
    expectedInterval: "none",
    feedback: "optimistic-count",
    why: "grams = grams + excluded.grams — a second shake is a second shake.",
  },
  "substance-unit": {
    repeat: "additive",
    expectedInterval: "none",
    feedback: "cooldown",
    why: "Several units a day is the use case; the week count re-renders from the server.",
  },
  "prn-dose": {
    repeat: "additive",
    expectedInterval: "none",
    feedback: "outcome-toast",
    why: "Multiple administrations are legitimate; #798's redose window advises without blocking.",
  },
  "mobility-move": {
    repeat: "idempotent",
    expectedInterval: "none",
    feedback: "optimistic-count",
    why: "Set semantics — a move is present or absent in today's session, never a count.",
  },
  "symptom-severity": {
    repeat: "idempotent",
    expectedInterval: "none",
    feedback: "optimistic-count",
    why: "A symptom-day keeps its WORST severity, so re-tapping the same chip settles on the same row.",
  },
  "mood-valence": {
    repeat: "idempotent",
    expectedInterval: "none",
    feedback: "optimistic-count",
    why: "UNIQUE(profile_id, date) upsert (#992) — re-tapping a face settles the day's single row; the selected face is the moving value, adopted from the server row on revalidation (#2130).",
  },
  "period-lifecycle": {
    repeat: "idempotent",
    expectedInterval: "none",
    feedback: "outcome-toast",
    why: "ONE offer rendered from server state (#1892); the write core re-enforces the same predicates with typed refusals, so a repeated or stale tap lands on an honest refusal, never a double period (#2130).",
  },
  "dose-status": {
    repeat: "idempotent",
    expectedInterval: "none",
    feedback: "outcome-toast",
    why: "Idempotent per (dose, date); the typed outcome already answers 'already taken' and can refuse (#2039).",
  },
  "practice-session": {
    repeat: "cadenced",
    expectedInterval: "day",
    feedback: "outcome-toast",
    why: "Multi-session days are legitimate, but a practice is a ~daily thing: the second tap of a day is worth one question.",
  },
  "medication-refill": {
    repeat: "cadenced",
    expectedInterval: "supply-cycle",
    feedback: "recency-line",
    why: "A fill lasts weeks; the double-tap failure mode is two bottles of phantom stock (#1893).",
  },
} as const satisfies Record<string, OneTapAffordanceDecl>;

export type OneTapAffordance = keyof typeof ONE_TAP_AFFORDANCES;

// The affordances whose declared repeat class is `idempotent`, DERIVED from the
// registry at the type level (#2130, owner direction). The offline queue declares
// its coverage over every affordance (lib/offline/queue.ts), and this union is
// what makes the sharpest half of that rule structural: an affordance declared
// idempotent — the queue's own stated admission criterion — cannot ship without
// the queue either carrying its flow or arguing its exclusion, because the
// coverage record's keys are checked against the registry's, not against a
// hand-maintained list.
export type IdempotentTap = {
  [
    K in OneTapAffordance
  ]: (typeof ONE_TAP_AFFORDANCES)[K]["repeat"] extends "idempotent" ? K : never;
}[OneTapAffordance];

export function oneTapAffordance(id: OneTapAffordance): OneTapAffordanceDecl {
  return ONE_TAP_AFFORDANCES[id];
}

// ── 2. The ledger state machine (#2041 finding 1, #2007 layer 1) ─────────────────

// How long a successful one-tap affordance stays inert (#2007 layer 1). `SubmitButton`
// / `useFormStatus` already disable a control DURING its request; the gap is the
// instant after the response returns, when the control re-enables and a queued or
// repeated tap lands a real second write. Short on purpose: long enough to absorb the
// second half of a double-tap, short enough that a deliberate repeat a moment later
// still lands.
export const POST_SUCCESS_COOLDOWN_MS = 2000;

//   ready    — a tap is accepted.
//   writing  — the write is in flight; the optimistic value is showing.
//   cooldown — the write landed and its authoritative value is showing; a repeat tap
//              inside this window is ABSORBED, not queued (#2007 layer 1).
export type LedgerPhase = "ready" | "writing" | "cooldown";

// What the caller decided the settled write means for the displayed value:
//   adopt    — take the server's authoritative value, whatever the optimistic guess was
//   keep     — the write was captured elsewhere (an offline queue) and the optimistic
//              value stands in for it until replay
//   rollback — nothing was written (a refusal or a failure): restore the pre-tap value
export type LedgerSettlement<V> =
  | { readonly kind: "adopt"; readonly value: V }
  | { readonly kind: "keep" }
  | { readonly kind: "rollback" };

export interface LedgerState<V> {
  readonly phase: LedgerPhase;
  // What the affordance shows right now.
  readonly value: V;
  // The value as it was before the in-flight tap, held only while `writing` so a
  // rollback restores it exactly instead of re-deriving an inverse delta.
  readonly preTap: V | null;
}

export type LedgerEvent<V> =
  | { readonly kind: "tap"; readonly optimistic: V }
  | { readonly kind: "settled"; readonly settlement: LedgerSettlement<V> }
  | { readonly kind: "cooled" };

export function initialLedger<V>(value: V): LedgerState<V> {
  return { phase: "ready", value, preTap: null };
}

// A tap is accepted only from `ready`. This is the double-tap pin: during `writing`
// the request is already out, and during `cooldown` the write has just landed — in
// both cases a second tap is the same tap arriving twice.
export function acceptsTap(phase: LedgerPhase): boolean {
  return phase === "ready";
}

// The state machine every optimistic one-tap surface runs. Deliberately total: an
// event that cannot apply in the current phase returns the state unchanged rather
// than throwing, because the events come from user taps and network responses that
// genuinely can arrive at the wrong moment.
export function ledgerReducer<V>(
  state: LedgerState<V>,
  event: LedgerEvent<V>
): LedgerState<V> {
  switch (event.kind) {
    case "tap":
      // Absorbed unless ready — the whole point of the machine.
      if (!acceptsTap(state.phase)) return state;
      return { phase: "writing", value: event.optimistic, preTap: state.value };
    case "settled": {
      if (state.phase !== "writing") return state;
      const settlement = event.settlement;
      if (settlement.kind === "rollback") {
        // A refused or failed write must be immediately retryable: no cooldown, and
        // the value returns to exactly what it was before the tap.
        return {
          phase: "ready",
          value: state.preTap as V,
          preTap: null,
        };
      }
      // ADOPT the server's authoritative value even when it disagrees with the
      // optimistic guess (the drift case that motivated #748 item 2): another
      // device, a Telegram tap or a queued replay may have moved the day's total
      // between render and response, and the server's figure is the one that is true.
      return {
        phase: "cooldown",
        value: settlement.kind === "adopt" ? settlement.value : state.value,
        preTap: null,
      };
    }
    case "cooled":
      if (state.phase !== "cooldown") return state;
      return { ...state, phase: "ready" };
  }
}

// ── 3. The cadence-aware re-log confirm (#2007 layer 3) ──────────────────────────

// The confirm exists to catch a repeat of the SAME restock, not to police an early
// refill (a pharmacy that fills a week early is legitimate and must not be nagged).
// So the window is the shorter of a fixed "that was basically just now" ceiling and a
// quarter of however long a fill actually lasts — which the app can compute from
// `last_fill_size` and the consumption rate. A 90-day supply asks for 3 days; a
// 4-day supply asks for 1.
export const REFILL_CONFIRM_MAX_DAYS = 3;
export const REFILL_CONFIRM_CYCLE_FRACTION = 0.25;
// Used when nothing is known about how long a fill lasts (no rate, no fill size).
export const DEFAULT_SUPPLY_CYCLE_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// How long after a refill a second one still asks, in days.
export function refillConfirmWindowDays(
  supplyCycleDays: number | null | undefined
): number {
  const cycle =
    supplyCycleDays != null &&
    Number.isFinite(supplyCycleDays) &&
    supplyCycleDays > 0
      ? supplyCycleDays
      : DEFAULT_SUPPLY_CYCLE_DAYS;
  return Math.min(
    REFILL_CONFIRM_MAX_DAYS,
    cycle * REFILL_CONFIRM_CYCLE_FRACTION
  );
}

export interface RelogCheck {
  readonly affordance: OneTapAffordance;
  // `day` interval: the local date of the last log and the profile's today, both
  // YYYY-MM-DD. Dates rather than a timestamp because "already today" is a calendar
  // question that must answer identically in every timezone.
  readonly lastLoggedDate?: string | null;
  readonly today?: string | null;
  // `supply-cycle` interval: when the last one happened and now, plus the predicted
  // days a fill lasts when the caller knows it.
  readonly lastLoggedAtMs?: number | null;
  readonly nowMs?: number | null;
  readonly supplyCycleDays?: number | null;
}

// Should this tap ask before it writes? ALWAYS a confirm, never a block (#798): the
// caller renders a dialog whose default is to proceed, and a `false` here means the
// tap writes with no dialog at all.
export function shouldConfirmRelog(check: RelogCheck): boolean {
  const decl = oneTapAffordance(check.affordance);
  // The leak guard. An additive or idempotent affordance declares `none`, and no
  // amount of recency can turn that into a question.
  if (decl.expectedInterval === "none") return false;
  if (decl.expectedInterval === "day") {
    const { lastLoggedDate, today } = check;
    if (!lastLoggedDate || !today) return false;
    return lastLoggedDate === today;
  }
  const { lastLoggedAtMs, nowMs } = check;
  if (lastLoggedAtMs == null || nowMs == null) return false;
  const elapsedDays = (nowMs - lastLoggedAtMs) / MS_PER_DAY;
  // A clock that moved backwards (skew, a frozen test clock) reads as "just now" —
  // elapsed time is only ever used to decide when to STOP asking.
  if (elapsedDays < 0) return true;
  return elapsedDays < refillConfirmWindowDays(check.supplyCycleDays);
}

// "just now" / "12 minutes ago" / "2 hours ago" / "3 days ago" — the elapsed phrase
// the refill confirm names its previous tap with. Coarse on purpose: the sentence is
// "was that you, a moment ago?", not a duration readout.
export function elapsedPhrase(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 60_000) return "just now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60)
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

// A fill size as the confirm prints it: whole numbers bare, fractions to at most two
// decimals (the lib/refill-recency.ts rule, so the line and the dialog agree).
function fillText(fillSize: number): string {
  return String(Math.round(fillSize * 100) / 100);
}

// "You logged Sauna today at 08:12. Log another session?" — the practice re-log
// question. The time is optional: a surface that knows when today's last session was
// says it, and one that only knows the count still asks an honest question rather
// than inventing a time.
export function practiceRelogMessage(
  practice: string,
  todayCount: number,
  lastLoggedTime: string | null | undefined
): string {
  const when = lastLoggedTime ? ` at ${lastLoggedTime}` : "";
  const already =
    todayCount === 1
      ? `You logged ${practice} today${when}.`
      : `You logged ${practice} ${todayCount} times today${when}.`;
  return `${already} Log another session?`;
}

// "You marked this refilled 2 hours ago (+90). Add another 90?" — the refill re-log
// question, which names BOTH the previous fill and the one this tap would add,
// because the corrupting outcome (#1893) is two bottles of stock nobody has.
export function refillRelogMessage(
  lastFillSize: number,
  nextFillSize: number,
  elapsedMs: number
): string {
  return `You marked this refilled ${elapsedPhrase(elapsedMs)} (+${fillText(
    lastFillSize
  )}). Add another ${fillText(nextFillSize)}?`;
}
