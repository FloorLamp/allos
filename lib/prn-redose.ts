// Pure PRN redose-window decision (issue #798). No DB/network — the notify tick
// gathers the inputs (latest administration, the 24h count, the confirmed per-item
// interval/max) and this decides whether the one-shot notice fires. Unit-tested in
// lib/__tests__/prn-redose.test.ts.
//
// ONE-SHOT, ADMINISTRATION-ARMED (issue #798):
//   • The timer is armed by the LATEST logged administration. The notice fires ONCE
//     when the minimum interval elapses since that administration, then is silent —
//     the marker is keyed by the administration id (the notify_last_* discipline).
//   • It RE-ARMS only when a NEWER administration is logged (a new id ⇒ the marker no
//     longer matches ⇒ eligible again).
//   • It is SUPPRESSED once the TRAILING-24h count reaches the confirmed max (no "you
//     can take more" past the label max, #4686).
//
// The opt-in + confirmed-fields gate lives in the gather query (getRedoseNoticeItems
// only returns opted-in items with BOTH interval and max confirmed), so this function
// assumes those are valid positives and focuses purely on the timing/one-shot logic.
//
// QUIET-HOURS EXCEPTION (deliberate): this decision has NO waking-window input. The
// notice is armed only by an actual administration and is opt-in per item, and 3am is
// exactly the fever case — so the tick calls this UNCONDITIONALLY, unlike the episode
// nudges. Documented in docs/internals/notifications.md.

// ---- Over-max care finding (#798, #148 UL-warning shape applied to count/day) ----

// The findings-bus namespace for the "over the confirmed daily max" care finding. A
// per-item analogue of the dietary-limit (UL) warning: when the trailing 24 hours'
// administrations EXCEED the user's confirmed max_daily_count, surface a dismissible
// care-tier finding (Upcoming + dashboard placement). Registered on the
// intake-surface dismiss guard so a dismiss silences it like any other finding.
import {
  dateStrInTz,
  parseUtcSql,
  shiftDateStr,
  utcInstant,
  zonedWallTimeToUtc,
} from "./date";
import {
  clampTickMinutes,
  SLOT_RETRY_DELAY_MIN,
} from "./notifications/schedule";

export const PRN_MAX_PREFIX = "prn-max:";

// ---- The ceiling WINDOW: a trailing 24 hours, not a calendar day (#4686) ----
//
// Every ceiling this module judges — `suppressed-max`, the "Max reached" card line,
// the over-max care finding — cites a figure taken verbatim off an OTC Drug Facts
// label ("do not take more than 5 doses IN 24 HOURS"). Those counts used to be
// gathered for one profile-local `date`, so midnight disarmed them: doses at 16:00,
// 20:00 and 23:45 read "3 of 5", and five more before 15:45 the next day produced
// EIGHT administrations inside 24 hours with every surface calm. The window the
// ceiling is judged on is now the one the label states.
//
// The interval half is untouched and stays instant-based: "how long since the last
// dose" is a duration and never needed a window.
export const PRN_CEILING_WINDOW_HOURS = 24;
const CEILING_WINDOW_MINUTES = PRN_CEILING_WINDOW_HOURS * 60;

// THE INSTANT THE WINDOW ENDS, AS THE MINUTES-SINCE-EPOCH THE GATHERS TAKE.
//
// A NUMBER, and that is load-bearing twice over.
//
// It has to be a PRIMITIVE because the family-state gather is memoized per request
// with React's `cache`, which keys on ARGUMENT IDENTITY (#2111) — a `Date` would
// miss on every call. And it has to be TRUNCATED because the several gathers that
// render together each take their own `now`; at minute resolution they agree, and the
// window is widened by under a minute, which no ceiling can feel.
//
// It has to be a NUMBER rather than a canonical instant string because these gathers
// used to take the profile-local `date`. Same type, different meaning is how a stale
// call site goes on compiling while silently asking for a ~48-hour window; a number
// makes every one of them a compile error instead. Do not widen this back to `string`.
export function ceilingWindowEndMinute(now: Date): number {
  return Math.floor(now.getTime() / 60_000);
}

// The instant the ceiling window opens, as a canonical instant to compare `occurred_at`
// against.
export function prnCeilingWindowStart(nowMinute: number): string {
  return utcInstant(new Date((nowMinute - CEILING_WINDOW_MINUTES) * 60_000));
}

// WHERE A ROW THAT STATES NO ADMINISTRATION INSTANT SITS IN THAT WINDOW.
//
// A taken row may carry no `occurred_at` — a past-day check-off states which day the
// dose belongs to and nothing about the minute (#4428). For the COUNT that is still
// answerable: the row is inside the window or it is not, and profile-local NOON of the
// row's own `date` is the honest midpoint of a day nobody timed. So this returns the
// EARLIEST `date` whose local noon is not before the window start — the exact floor a
// `l.date >= ?` comparison needs, since noon is monotonic in the date.
//
// The floor is what an unplaced row needs; the CAP is profile-local today, and the two
// are not symmetric. Local noon of TODAY is in the future until midday, so capping by
// the anchor would drop a dose logged this morning out of the ceiling for the first
// half of every day — a count LOWER than the calendar-day one it replaced, on the
// safety line. Capping by the row's own DAY has no such cost: `isDoseDateAccepted`
// admits a day either side of today, and two writers pass `takenAt: null` for any
// non-today date, so a row dated TOMORROW is writable — and an administration nobody
// timed, filed under a day that has not happened, is not inside the last 24 hours by
// any reading. Latent rather than live (no surface offers a future day today), and
// free to close.
//
// This anchor is for the COUNT only. Nothing here feeds the interval clock: an elapsed
// time computed from a placeholder is how a safety line says "Redose OK" for a dose
// that may have been given minutes ago.
export function prnUntimedDateFloor(
  tz: string,
  windowStartUtc: string
): string {
  const start = parseUtcSql(windowStartUtc);
  if (!start) return "";
  const candidate = dateStrInTz(tz, start);
  const noon = zonedWallTimeToUtc(tz, candidate, "12:00");
  return noon && noon.getTime() >= start.getTime()
    ? candidate
    : shiftDateStr(candidate, 1);
}

// ---- Window exposure: milligrams when known, administrations as the fallback ----
// (issue #1854). The family-wide counters (#1027) made "a dose" ambiguous: 200 mg
// OTC ibuprofen and 800 mg Rx ibuprofen are the same ingredient but 4× the
// exposure. The confirm-dose snapshot stamps the amount onto every log row, so
// when a mg/day max is confirmed AND every administration's amount parses, the
// window's exposure is the SUM of snapshotted milligrams; the confirmed count stays
// the fallback basis. ONE computation — the over-max care finding, the med-card /
// widget / Telegram status line, and the redose notice's ceiling all read this.
// The rows it is handed are the trailing-24h ones (#4686); the type keeps its
// #1854 name because the CEILINGS it compares against are unchanged.

// Snapshotted dose amount → milligrams, or null when it doesn't parse. Accepts
// the stored shapes: a leading number + mass unit ("200 mg", "0.5 g", "500 mcg"),
// including a liquid "<mg> mg / <mL> mL" line (the administered mg leads). A bare
// count ("2 capsules") or an unknown unit (IU) is NOT a mass — null, never a
// guess: the mg basis must never imply precision it doesn't have.
export function parseAmountMg(
  amount: string | null | undefined
): number | null {
  const m = amount
    ?.trim()
    .match(/^(\d+(?:\.\d+)?)\s*(mg|mcg|µg|ug|g)\b(?!\s*(?:\/|per)\s*kg)/i);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = m[2].toLowerCase();
  if (unit === "g") return value * 1000;
  if (unit === "mg") return value;
  return value / 1000; // mcg/µg/ug
}

// The basis the window's PRN exposure was computed on. "mg" only when it is honest:
// a confirmed mg/day max AND (for the full-precision path) parseable amounts.
export type PrnExposureBasis = "mg" | "count";

export interface PrnDayExposure {
  basis: PrnExposureBasis;
  // Summed milligrams (mg basis) or the administration count (count basis).
  total: number;
  // The confirmed ceiling on the same basis (the label's mg or doses per 24h).
  max: number;
  // Strictly over the ceiling — the care finding's gate ("you've logged MORE").
  over: boolean;
  // At or over — the notice-suppression / "Max reached" ceiling.
  atMax: boolean;
  // mg basis only: the window's administrations whose snapshotted amount did NOT
  // parse. Non-zero only on the lower-bound path (no count fallback existed), and
  // the copy must then say "at least". Always 0 on the count basis.
  unknownAmounts: number;
}

// Decide the window's exposure for one ingredient family. `amounts` are the
// snapshotted amount strings of the trailing 24 hours' taken administrations;
// the maxes are the most conservative CONFIRMED ceilings among members (null =
// no member confirmed one). Basis selection, most honest first:
//   1. mg — mg max confirmed and EVERY administration's amount parses.
//   2. count — the confirmed count max (the fallback for unparseable amounts).
//   3. mg lower bound — mg max confirmed, some amounts unparseable, and NO count
//      fallback exists: the known sum still catches a certain over-exposure
//      (a lower bound past the ceiling is past the ceiling), with
//      `unknownAmounts` carried so the copy never claims full precision.
// Neither max confirmed ⇒ null (the #798 liability gate: no ceiling, no verdict).
export function prnDayExposure(input: {
  amounts: (string | null)[];
  maxDailyAmountMg: number | null;
  maxDailyCount: number | null;
}): PrnDayExposure | null {
  const mgMax =
    input.maxDailyAmountMg != null && input.maxDailyAmountMg > 0
      ? input.maxDailyAmountMg
      : null;
  const countMax =
    input.maxDailyCount != null && input.maxDailyCount > 0
      ? input.maxDailyCount
      : null;
  const parsed = input.amounts.map(parseAmountMg);
  const unknown = parsed.filter((mg) => mg == null).length;
  if (mgMax != null && (unknown === 0 || countMax == null)) {
    const total = parsed.reduce<number>((sum, mg) => sum + (mg ?? 0), 0);
    return {
      basis: "mg",
      total,
      max: mgMax,
      over: total > mgMax,
      atMax: total >= mgMax,
      unknownAmounts: unknown,
    };
  }
  if (countMax != null) {
    const total = input.amounts.length;
    return {
      basis: "count",
      total,
      max: countMax,
      over: total > countMax,
      atMax: total >= countMax,
      unknownAmounts: 0,
    };
  }
  return null;
}

// The stable dedupe/suppression key for an over-max finding: `prn-max:<itemId>`, keyed
// on the AUTOINCREMENT item id (never recycles, #203). Doses aging out of the window
// reset the UNDERLYING condition, but the key stays stable so a same-episode dismiss
// holds.
export function prnMaxSignalKey(itemId: number): string {
  return `${PRN_MAX_PREFIX}${itemId}`;
}

// ── WHAT ARMS THE INTERVAL CLOCK, AS A UNION (#4686) ────────────────────────
//
// The count and the interval want DIFFERENT rules from the same column, and four
// adversarial passes on this window found every defect in one of two shapes: an arming
// read silently falling back to `recorded_at`, or an absent arm that never engages.
// This union makes the first impossible and the second checkable.
//
//   • `placed`   — the latest taken administration STATES its instant. That instant is
//                  an event, so an elapsed time computed from it is a fact.
//   • `unplaced` — some taken administration for this family states NO instant and
//                  could be the latest. It carries the row's id and NEVER an instant:
//                  there is no honest elapsed time, so there is no field to read one
//                  from. No window, no anchor, no arithmetic — the question is only
//                  "does any taken row state no instant", which is why an earlier pass
//                  testing membership against the count's noon anchor produced an arm
//                  that engaged for half of every day.
//   • `none`     — nothing taken at all.
//
// The capture stamp appears in no arm. `recorded_at` is when the app was TOLD, and a
// duration measured from it becomes "Redose OK" for a dose that may have been given
// minutes ago — a number nobody can check, on the permissive side.
export type FamilyArming =
  | {
      kind: "placed";
      administrationId: number;
      // A canonical UTC instant string (`lib/time-columns.ts`), not a Date: this value
      // crosses the server/client boundary on the quick-log gathers.
      givenAt: string;
      // WHICH member's dose armed the clock, so a notice can honestly say "6h since OTC
      // Ibuprofen" when a sibling's administration is the latest.
      itemId: number | null;
      itemName: string | null;
    }
  | { kind: "unplaced"; administrationId: number }
  | { kind: "none" };

export const NO_ARMING: FamilyArming = { kind: "none" };

export interface RedoseWindowInput {
  // Confirmed per-item numbers (both > 0; guaranteed by the gather query).
  minIntervalHours: number;
  maxDailyCount: number;
  // What arms the one-shot (#4686). `none` ⇒ nothing logged; `unplaced` ⇒ a taken row
  // states no instant, so there is no elapsed time and no notice.
  arming: FamilyArming;
  // The trailing-24h administration count (#4686) — drives "N of M" + max suppression.
  countInWindow: number;
  now: Date;
  // The administration id the marker was last set to (notify_last_redose_<itemId>),
  // or null when never notified. Equal to latestAdministrationId ⇒ already fired for
  // THIS administration ⇒ one-shot done.
  notifiedAdministrationId: number | null;
  // The scheduler's observed cadence. It sizes two bounded attempt bands around the
  // instant the interval opens, so a restart cannot "catch up" on a weeks-old dose.
  tickMinutes: number;
  // The window's amount-aware exposure (#1854), when the caller computed one. When
  // present its ceiling REPLACES the count comparison: 3 × 800 mg is suppressed at
  // a 2400 mg/day max even though "3 of 6 doses" reads calm. Absent/null keeps the
  // count-basis suppression exactly as before.
  exposure?: PrnDayExposure | null;
}

export type RedoseDecision =
  | {
      kind: "fire";
      administrationId: number;
      countInWindow: number;
      maxDailyCount: number;
      sinceHours: number;
      // The arming administration's own stated instant, canonical UTC — the notice's
      // clock label formats it, and it comes from the `placed` arm rather than from a
      // second reading of the row.
      lastGivenAt: string;
      // The exposure the ceiling was judged on (null ⇒ plain count), so the
      // notice body can phrase the SAME basis ("1200 of 2400 mg in 24h").
      exposure: PrnDayExposure | null;
    }
  | { kind: "not-armed" } // no administration to arm the timer
  // A taken administration states no instant, so there is no elapsed time to compare
  // against the interval. THE NOTICE NEVER FIRES HERE, and it carries no duration to
  // read: a push saying "your minimum interval has passed" with a Log-dose button, off
  // a capture stamp, is the exact defect a planted deletion on this path once shipped
  // with CI green (#4686, the 2026-09-02 ruling).
  | { kind: "unplaced-dose" }
  | { kind: "already-notified" } // one-shot already fired for the latest administration
  | { kind: "not-yet"; opensInHours: number } // interval hasn't elapsed
  | { kind: "missed-window" } // the opening + bounded retry bands are both past
  | { kind: "suppressed-max" }; // the 24h count has reached the confirmed max

// Hours elapsed between two instants (may be fractional).
function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 3_600_000;
}

// The redose notice is an EDGE, not a standing condition. Attempt on the first tick
// after the minimum interval opens, then once more an hour later if delivery did not
// earn the administration marker. The bands are one OBSERVED tick wide, matching the
// scheduled-notification retry budget without turning an outage into a catch-up send.
export function redoseAttempt(
  elapsedHours: number,
  minIntervalHours: number,
  observedTickMinutes: number
): 0 | 1 | null {
  const offsetMinutes = (elapsedHours - minIntervalHours) * 60;
  if (!Number.isFinite(offsetMinutes) || offsetMinutes < 0) return null;
  const tick = clampTickMinutes(observedTickMinutes);
  if (offsetMinutes < tick) return 0;
  if (
    offsetMinutes >= SLOT_RETRY_DELAY_MIN &&
    offsetMinutes < SLOT_RETRY_DELAY_MIN + tick
  )
    return 1;
  return null;
}

export function redoseNoticeDecision(input: RedoseWindowInput): RedoseDecision {
  const { arming } = input;
  // Not armed: nothing logged, so there's no window to open.
  if (arming.kind === "none") return { kind: "not-armed" };
  // A dose was given and nobody said when. Refused BEFORE the one-shot marker and
  // before any arithmetic — there is no instant in this arm to do arithmetic with.
  if (arming.kind === "unplaced") return { kind: "unplaced-dose" };
  const latestGivenAt = parseUtcSql(arming.givenAt);
  // A canonical event column that will not parse is not an instant this can subtract.
  if (!latestGivenAt) return { kind: "not-armed" };
  // One-shot: we already notified for THIS exact administration. Only a newer
  // administration (a different id) re-arms it.
  if (input.notifiedAdministrationId === arming.administrationId) {
    return { kind: "already-notified" };
  }
  const elapsed = hoursBetween(latestGivenAt, input.now);
  if (elapsed < input.minIntervalHours) {
    return { kind: "not-yet", opensInHours: input.minIntervalHours - elapsed };
  }
  // Window is open. Suppress at/over the confirmed 24h ceiling (label max) — no
  // marker is written, so a later administration (new id) re-evaluates cleanly.
  // With an amount-aware exposure (#1854) the ceiling is ITS verdict (mg when
  // known); otherwise the plain count comparison stands.
  const exposure = input.exposure ?? null;
  if (exposure ? exposure.atMax : input.countInWindow >= input.maxDailyCount) {
    return { kind: "suppressed-max" };
  }
  if (
    redoseAttempt(elapsed, input.minIntervalHours, input.tickMinutes) == null
  ) {
    return { kind: "missed-window" };
  }
  return {
    kind: "fire",
    administrationId: arming.administrationId,
    countInWindow: input.countInWindow,
    maxDailyCount: input.maxDailyCount,
    sinceHours: elapsed,
    lastGivenAt: arming.givenAt,
    exposure,
  };
}

// A marker-AGNOSTIC redose status for the always-on SURFACING paths (the med card,
// the shared PRN quick-log content) — unlike redoseNoticeDecision, this ignores the one-shot
// notification marker, because a card should always show the current window state, not
// go silent after the notice fired. Returns null when nothing has been logged yet
// (no window to describe). The interval/max are the item's confirmed numbers.
// The 24h max is OPTIONAL on this path (#1458). "Maximum doses in 24 hours" is the
// field a caregiver is least likely to know offhand, and the single number they want
// at 2am — when is the next dose OK — is computable from the minimum interval alone.
// So a null max means only that the count-ceiling half of the status is unknown:
// `atMax` is false (an unknown ceiling is never a reached one) and the count fragment
// drops its "of N". When no amount ceiling exists either, the shared formatter names
// that no 24h limit is on record (#4254). The window half (open / opens-in) needs
// only the interval and the last administration. The one-shot NOTIFICATION path
// (redoseNoticeDecision above) keeps requiring both — its gather gate only returns
// items with both confirmed.
//
// A UNION, SO THE SEPARATE RULES ARE STRUCTURAL RATHER THAN REMEMBERED (#4686). The
// COUNT keeps its window and its noon anchor; the INTERVAL has neither. The `unknown`
// arm therefore has NO `open` and no `sinceHours`/`opensInHours` field at all — no
// field of it can be misread as an elapsed time, because none exists — while `atMax`,
// `countInWindow` and `exposure` come straight from `CEILING_WINDOW_SQL` and are as
// answerable as ever. "Max reached" still wins on that arm.
interface RedoseCeiling {
  atMax: boolean; // the window's exposure has reached the ceiling (false when unset)
  // Administrations inside the trailing 24 hours (#4686), NOT a calendar-day tally.
  countInWindow: number;
  maxDailyCount: number | null; // null ⇒ no confirmed count ceiling
  // The window's amount-aware exposure (#1854), when one was computable — the "N of
  // M" fragment then reads milligrams and atMax is ITS verdict. null keeps the
  // plain count fragment/ceiling.
  exposure: PrnDayExposure | null;
}

export type RedoseStatus =
  | (RedoseCeiling & {
      kind: "window";
      open: boolean; // the minimum interval has elapsed since the last administration
      sinceHours: number; // hours since the last administration
      opensInHours: number; // hours until the window opens (0 when already open)
    })
  | (RedoseCeiling & {
      kind: "unknown";
      // The unplaced administration, so a surface can name the row to place.
      administrationId: number;
    });

export function redoseWindowStatus(input: {
  minIntervalHours: number;
  maxDailyCount: number | null;
  arming: FamilyArming;
  countInWindow: number;
  now: Date;
  exposure?: PrnDayExposure | null;
}): RedoseStatus | null {
  const { arming } = input;
  if (arming.kind === "none") return null;
  const exposure = input.exposure ?? null;
  const ceiling: RedoseCeiling = {
    atMax: exposure
      ? exposure.atMax
      : input.maxDailyCount != null &&
        input.countInWindow >= input.maxDailyCount,
    countInWindow: input.countInWindow,
    maxDailyCount: input.maxDailyCount,
    exposure,
  };
  if (arming.kind === "unplaced") {
    return {
      kind: "unknown",
      administrationId: arming.administrationId,
      ...ceiling,
    };
  }
  const latestGivenAt = parseUtcSql(arming.givenAt);
  // A canonical event column that will not parse is not an instant to subtract from,
  // and the ceiling half alone is not a redose status. Say nothing rather than guess.
  if (!latestGivenAt) return null;
  const elapsed = hoursBetween(latestGivenAt, input.now);
  const open = elapsed >= input.minIntervalHours;
  return {
    kind: "window",
    open,
    sinceHours: elapsed,
    opensInHours: open ? 0 : input.minIntervalHours - elapsed,
    ...ceiling,
  };
}

// The most conservative confirmed daily max among an item and its ingredient family
// (#1027), or null when NO member carries one (#1458). One computation, because all
// three redose surfacing gathers (the med card, the Today panel, the dashboard PRN
// widget) have to widen and degrade identically — a hand-rolled `??` chain at one
// site is how "min of the confirmed maxes" quietly became "the item's own max".
export function effectiveMaxDailyCount(
  ...maxes: (number | null | undefined)[]
): number | null {
  const confirmed = maxes.filter((m): m is number => m != null && m > 0);
  return confirmed.length ? Math.min(...confirmed) : null;
}

// The redose window status for one PRN med as the quick-log gathers carry it —
// the FAMILY-widened math (#1027) plus the optional-max degrade (#1458), in one
// place. Three surfaces computed this identically by hand (the dashboard PRN
// widget, the medications list, and — since #1717 — the Telegram `/dose` list),
// which is how "the interval alone answers when the next dose is OK" quietly
// became three subtly different gates. Returns null when there is no confirmed
// interval or nothing has been administered: no window to report, so the caller
// falls back to the plain day count and NEVER invents a ceiling.
export function prnQuickLogRedoseStatus(
  med: {
    minIntervalHours: number | null;
    maxDailyCount: number | null;
    familyCount: number;
    // The union (#4686), never a nullable instant beside one: a nullable string next
    // to a union is the shape a `??` re-collapses onto a capture stamp.
    familyArming: FamilyArming;
    familyMaxDailyCount: number | null;
    // The family's amount-aware window exposure (#1854), computed by the ONE
    // getMedicationFamilyStates gather; null when no ceiling is confirmed (or on
    // a legacy caller), which keeps the count basis exactly as before.
    familyExposure?: PrnDayExposure | null;
  },
  now: Date
): RedoseStatus | null {
  if (med.minIntervalHours == null) return null;
  return redoseWindowStatus({
    minIntervalHours: med.minIntervalHours,
    maxDailyCount: effectiveMaxDailyCount(
      med.maxDailyCount,
      med.familyMaxDailyCount
    ),
    arming: med.familyArming,
    countInWindow: med.familyCount,
    now,
    exposure: med.familyExposure ?? null,
  });
}
