// Cycle plausibility — the ONE guard/offer layer beside lib/cycle.ts's derivations
// (issues #1681, #1682). Pure (no DB, no clock, no auth): the form, the quick actions,
// and any future import path all route through here, so a rule is never re-validated —
// or quietly re-invented — per surface (#221).
//
// Two halves, both stated as DATA rather than as a write:
//
//   • REFUSALS (#1682 c/d) — a write that would store something the domain cannot mean:
//     a future date, an overlap with an existing period, or a SECOND simultaneously-open
//     period. Each refusal is typed and names its conflict, so the Server Action can
//     answer honestly and the user resolves it explicitly. We never "repair" by inferring
//     an end date or silently shifting a boundary.
//
//   • THE CONTROL STATE (#1681) — what the Cycle surface may OFFER. A quick action is for
//     the common case; the dated form owns the exceptions. So "Period started today" is
//     offered only once a plausible gap has elapsed since the last period ended, and the
//     accidental-tap recovery ("Still bleeding") is offered only inside a small recency
//     window. The page computes this ONCE and passes it down as data — the client
//     component decides nothing.
//
// What is deliberately NOT here: any notion of expiring, closing, or rewriting a stored
// row. A long-open period reads as "probably forgot to end" (lib/cycle.isStaleOpenPeriod)
// and is PROMPTED about; the user's tap is the write.

import { daysBetweenDateStr } from "./date";
import {
  CYCLE_PHASE_LABELS,
  MIN_PLAUSIBLE_PERIOD_GAP_DAYS,
  cycleDayOnDate,
  cyclePhaseOnDate,
  isStaleOpenPeriod,
  type CyclePeriod,
} from "./cycle";

// How recently a period must have ENDED for the one-tap "Still bleeding" reopen to apply
// (issue #1681 bug 3). The affordance repairs a just-noticed mis-tap; it must not be able
// to resurrect last month's period, which would silently merge two cycles into one.
export const REOPEN_PERIOD_MAX_AGE_DAYS = 3;

// ---- Selection helpers ------------------------------------------------------

// The currently OPEN period (no recorded end), most-recently started, or null. Mirrors
// the store's getOpenPeriod ordering so the pure and SQL answers agree.
export function openPeriodIn(periods: CyclePeriod[]): CyclePeriod | null {
  const open = periods.filter((p) => p.period_end == null);
  if (open.length === 0) return null;
  return open.reduce((a, b) =>
    b.period_start > a.period_start ||
    (b.period_start === a.period_start && b.id > a.id)
      ? b
      : a
  );
}

// The most recently ENDED period (greatest period_end), or null when none is closed.
export function lastEndedPeriodIn(periods: CyclePeriod[]): CyclePeriod | null {
  const ended = periods.filter(
    (p): p is CyclePeriod & { period_end: string } => p.period_end != null
  );
  if (ended.length === 0) return null;
  return ended.reduce((a, b) =>
    b.period_end > a.period_end ||
    (b.period_end === a.period_end && b.id > a.id)
      ? b
      : a
  );
}

// ---- The quick-action offer conditions (#1681) ------------------------------

// Whether the one-tap "period started today" is a plausible thing to do on `date` — the
// SAME predicate the Cycle page renders from and the write core enforces, so a stale page
// can't produce a write the surface would not have offered.
//
// False while a period is open (end that one first), and false until
// MIN_PLAUSIBLE_PERIOD_GAP_DAYS have elapsed since the last recorded end — the window in
// which a tap would mint a back-to-back period rather than record a real one. With NO
// recorded history at all there is nothing implausible about starting, so it is offered.
export function canStartPeriodOn(
  periods: CyclePeriod[],
  date: string
): boolean {
  if (openPeriodIn(periods) != null) return false;
  const last = lastEndedPeriodIn(periods);
  if (last == null) return true; // no history — nothing to be back-to-back with
  const gap = daysBetweenDateStr(last.period_end!, date);
  return gap != null && gap >= MIN_PLAUSIBLE_PERIOD_GAP_DAYS;
}

// Whether the one-tap "Still bleeding" reopen applies on `date`: nothing is currently
// open, and the most recent end is within the small recency window (and not in the
// future). Outside it, the dated form is the surface for editing an end date.
export function canReopenLastPeriodOn(
  periods: CyclePeriod[],
  date: string
): boolean {
  if (openPeriodIn(periods) != null) return false;
  const last = lastEndedPeriodIn(periods);
  if (last == null) return false;
  const age = daysBetweenDateStr(last.period_end!, date);
  return age != null && age >= 0 && age <= REOPEN_PERIOD_MAX_AGE_DAYS;
}

// The contextual cycle state as one line — "Day 6 · Follicular" — formatted over the SAME
// cycleDayOnDate + cyclePhaseOnDate derivations every other surface reads (#221/#1221), so
// the Cycle control and the dashboard tile can never disagree. Null before any recorded
// period, where no state is derivable.
export function cycleStateLine(
  periods: CyclePeriod[],
  date: string
): string | null {
  const day = cycleDayOnDate(periods, date);
  // `date` IS this surface's today — cycleControlState is always resolved for the
  // profile-local current day — so it is both the subject and the horizon (#2613).
  const phase = cyclePhaseOnDate(periods, date, date);
  if (day == null || phase == null) return null;
  return `Day ${day} · ${CYCLE_PHASE_LABELS[phase]}`;
}

// Everything the Cycle quick-action control needs, resolved ONCE on the server.
export interface CycleControlState {
  // The open period's id, or null when none is open.
  openPeriodId: number | null;
  // The open period's start date, or null.
  openPeriodStart: string | null;
  // The open period has outrun MAX_PLAUSIBLE_PERIOD_DAYS: prompt for the real end date
  // rather than claiming menstrual (#1682 fix a).
  staleOpenPeriod: boolean;
  // "Day 6 · Follicular", or null before any history.
  stateLine: string | null;
  // Offer "Period started today".
  canStart: boolean;
  // Offer the one-tap "Still bleeding" reopen.
  canReopen: boolean;
}

export function cycleControlState(
  periods: CyclePeriod[],
  date: string
): CycleControlState {
  const open = openPeriodIn(periods);
  return {
    openPeriodId: open?.id ?? null,
    openPeriodStart: open?.period_start ?? null,
    staleOpenPeriod: open != null && isStaleOpenPeriod(open, date),
    stateLine: cycleStateLine(periods, date),
    canStart: canStartPeriodOn(periods, date),
    canReopen: canReopenLastPeriodOn(periods, date),
  };
}

// ---- The ONE offer (#1892) --------------------------------------------------
//
// `cycleControlState` says what is TRUE; this says what a one-tap affordance may
// OFFER, and names the write that tap will perform. Three surfaces render it — the
// Cycle page control, the dashboard phase widget, and the quick-log sheet's overlay —
// and none of them re-derives it (`lib/__tests__/cycle-offer-renderers.test.ts` is the
// #221 pin). Same shape as lib/workout-offer.ts: labels are exported constants, so a
// surface cannot spell the verb its own way.
//
// AT MOST ONE offer at a time, which is a fact about the constants rather than a
// choice made here: `canReopen` holds only within REOPEN_PERIOD_MAX_AGE_DAYS (3) of an
// end, and `canStart` only once MIN_PLAUSIBLE_PERIOD_GAP_DAYS (10) have elapsed since
// one, so the two windows cannot overlap; and both are false while a period is open.
// Between them — days 4–9 after an end — there is NO offer, and that silence is the
// point: a tap there would mint an implausible back-to-back period, so the dated form
// on the Cycle page owns that exception.

export const START_PERIOD_LABEL = "Period started today";
export const END_PERIOD_LABEL = "Period ended today";
export const REOPEN_PERIOD_LABEL = "Still bleeding";

// Which write core the tap reaches: startPeriodCore / endPeriodCore / reopenPeriodCore.
export type CyclePeriodWrite = "start" | "end" | "reopen";

export interface CycleOffer {
  write: CyclePeriodWrite;
  // The button's text. ALWAYS names the write it will perform.
  label: string;
}

// The one action a cycle affordance may offer on this state, or null when none is
// plausible. Ordered open → reopen → start, most-specific first; the windows are
// disjoint (see above), so the order documents intent rather than resolving a tie.
export function cycleOffer(state: CycleControlState): CycleOffer | null {
  if (state.openPeriodId != null)
    return { write: "end", label: END_PERIOD_LABEL };
  if (state.canReopen) return { write: "reopen", label: REOPEN_PERIOD_LABEL };
  if (state.canStart) return { write: "start", label: START_PERIOD_LABEL };
  return null;
}

// ---- Write refusals (#1682 c/d) ---------------------------------------------

// A period a write would store: `id` is null for a new row, or the row being edited (which
// is excluded from its own conflict checks).
export interface PeriodWriteCandidate {
  id: number | null;
  start: string;
  end: string | null; // null = open/ongoing
}

// Why a cycle write is refused. `conflict` names the existing period responsible, so the
// message can point at it instead of saying "invalid".
export type CycleWriteRefusal =
  | { kind: "future-start" }
  | { kind: "future-end" }
  | { kind: "end-before-start" }
  | { kind: "overlap"; conflict: CyclePeriod }
  | { kind: "second-open"; conflict: CyclePeriod };

// Do two periods share any day? An open period (null end) runs from its start onward for
// this test — for CONFLICT purposes we take the record at its word rather than applying
// the derivation's plausibility cap, because an overlap with a still-open period is a real
// conflict the user must resolve. Ranges that merely touch (one ends the day before the
// other starts) do NOT overlap.
function periodsOverlap(a: PeriodWriteCandidate, b: CyclePeriod): boolean {
  const aStartsAfterB = b.period_end != null && a.start > b.period_end;
  const bStartsAfterA = a.end != null && b.period_start > a.end;
  return !aStartsAfterB && !bStartsAfterA;
}

// The ONE plausibility gate for any period write. Returns the refusal, or null when the
// write may proceed. `existing` is the profile's recorded periods (the candidate's own row
// included — it is excluded by id here, so callers need not pre-filter); `today` is the
// profile's own today (lib/db.today), never the server's wall clock.
//
// Order matters for the message the user gets: date sanity first (it explains itself),
// then the second-open conflict (more specific than the overlap it also is), then overlap.
export function checkPeriodWrite(
  candidate: PeriodWriteCandidate,
  existing: CyclePeriod[],
  today: string
): CycleWriteRefusal | null {
  if (candidate.start > today) return { kind: "future-start" };
  if (candidate.end != null && candidate.end > today)
    return { kind: "future-end" };
  if (candidate.end != null && candidate.end < candidate.start)
    return { kind: "end-before-start" };

  const others = existing.filter((p) => p.id !== candidate.id);
  if (candidate.end == null) {
    const alreadyOpen = others.find((p) => p.period_end == null);
    if (alreadyOpen) return { kind: "second-open", conflict: alreadyOpen };
  }
  const clash = others.find((p) => periodsOverlap(candidate, p));
  if (clash) return { kind: "overlap", conflict: clash };
  return null;
}

// A stored period as a plain range for a message ("2026-01-01 – 2026-01-10", or
// "2026-01-01 – ongoing" while open). ISO dates: the refusal crosses a Server Action
// boundary, where the reader's display-format preference is not in scope.
function periodRangeText(p: CyclePeriod): string {
  return `${p.period_start} – ${p.period_end ?? "ongoing"}`;
}

// The user-facing message for a refusal — one place, so the form, the quick actions, and
// any future import path phrase the same refusal the same way.
export function cycleRefusalMessage(r: CycleWriteRefusal): string {
  switch (r.kind) {
    case "future-start":
      return "A period can't start in the future. Enter today or an earlier date.";
    case "future-end":
      return "A period can't end in the future. Enter today or an earlier date.";
    case "end-before-start":
      return "Enter an end on or after the period start.";
    case "second-open":
      return `A period is already open (${periodRangeText(r.conflict)}). End that one before starting another.`;
    case "overlap":
      return `A period is already recorded ${periodRangeText(r.conflict)}. Adjust the dates so they don't overlap.`;
  }
}
