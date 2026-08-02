// Pure PRN redose-window decision (issue #798). No DB/network — the notify tick
// gathers the inputs (latest administration, today's count, the confirmed per-item
// interval/max) and this decides whether the one-shot notice fires. Unit-tested in
// lib/__tests__/prn-redose.test.ts.
//
// ONE-SHOT, ADMINISTRATION-ARMED (issue #798):
//   • The timer is armed by the LATEST logged administration. The notice fires ONCE
//     when the minimum interval elapses since that administration, then is silent —
//     the marker is keyed by the administration id (the notify_last_* discipline).
//   • It RE-ARMS only when a NEWER administration is logged (a new id ⇒ the marker no
//     longer matches ⇒ eligible again).
//   • It is SUPPRESSED once the day's count reaches the confirmed max (no "you can
//     take more" past the label max).
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
// per-item, count-per-day analogue of the dietary-limit (UL) warning: when today's
// administrations EXCEED the user's confirmed max_daily_count, surface a dismissible
// care-tier finding (Upcoming + the dashboard attention hero). Registered on the
// intake-surface dismiss guard so a dismiss silences it like any other finding.
import { parseUtcSql } from "./date";

export const PRN_MAX_PREFIX = "prn-max:";

// ---- Day exposure: milligrams when known, administrations as the fallback ----
// (issue #1854). The family-wide counters (#1027) made "a dose" ambiguous: 200 mg
// OTC ibuprofen and 800 mg Rx ibuprofen are the same ingredient but 4× the
// exposure. The confirm-dose snapshot stamps the amount onto every log row, so
// when a mg/day max is confirmed AND every administration's amount parses, the
// day's exposure is the SUM of snapshotted milligrams; the confirmed count stays
// the fallback basis. ONE computation — the over-max care finding, the med-card /
// widget / Telegram status line, and the redose notice's ceiling all read this.

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

// The basis the day's PRN exposure was computed on. "mg" only when it is honest:
// a confirmed mg/day max AND (for the full-precision path) parseable amounts.
export type PrnExposureBasis = "mg" | "count";

export interface PrnDayExposure {
  basis: PrnExposureBasis;
  // Summed milligrams (mg basis) or the administration count (count basis).
  total: number;
  // The confirmed ceiling on the same basis (mg/day or doses/day).
  max: number;
  // Strictly over the ceiling — the care finding's gate ("you've logged MORE").
  over: boolean;
  // At or over — the notice-suppression / "Max reached" ceiling.
  atMax: boolean;
  // mg basis only: today's administrations whose snapshotted amount did NOT
  // parse. Non-zero only on the lower-bound path (no count fallback existed), and
  // the copy must then say "at least". Always 0 on the count basis.
  unknownAmounts: number;
}

// Decide the day's exposure for one ingredient family. `amounts` are the
// snapshotted amount strings of TODAY's taken administrations across the family;
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
// on the AUTOINCREMENT item id (never recycles, #203). A new day's count resets the
// UNDERLYING condition, but the key stays stable so a same-episode dismiss holds.
export function prnMaxSignalKey(itemId: number): string {
  return `${PRN_MAX_PREFIX}${itemId}`;
}

export interface RedoseWindowInput {
  // Confirmed per-item numbers (both > 0; guaranteed by the gather query).
  minIntervalHours: number;
  maxDailyCount: number;
  // The latest logged administration for the item (arms the one-shot). null ⇒ nothing
  // logged yet ⇒ not armed.
  latestAdministrationId: number | null;
  latestGivenAt: Date | null;
  // Today's administration count in the profile's timezone (drives "N of M" + max
  // suppression).
  countToday: number;
  now: Date;
  // The administration id the marker was last set to (notify_last_redose_<itemId>),
  // or null when never notified. Equal to latestAdministrationId ⇒ already fired for
  // THIS administration ⇒ one-shot done.
  notifiedAdministrationId: number | null;
  // The day's amount-aware exposure (#1854), when the caller computed one. When
  // present its ceiling REPLACES the count comparison: 3 × 800 mg is suppressed at
  // a 2400 mg/day max even though "3 of 6 doses" reads calm. Absent/null keeps the
  // count-basis suppression exactly as before.
  exposure?: PrnDayExposure | null;
}

export type RedoseDecision =
  | {
      kind: "fire";
      administrationId: number;
      countToday: number;
      maxDailyCount: number;
      sinceHours: number;
      lastGivenAt: Date;
      // The exposure the ceiling was judged on (null ⇒ plain count), so the
      // notice body can phrase the SAME basis ("1200 of 2400 mg today").
      exposure: PrnDayExposure | null;
    }
  | { kind: "not-armed" } // no administration to arm the timer
  | { kind: "already-notified" } // one-shot already fired for the latest administration
  | { kind: "not-yet"; opensInHours: number } // interval hasn't elapsed
  | { kind: "suppressed-max" }; // day's count has reached the confirmed max

// Hours elapsed between two instants (may be fractional).
function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 3_600_000;
}

export function redoseNoticeDecision(input: RedoseWindowInput): RedoseDecision {
  const { latestAdministrationId, latestGivenAt } = input;
  // Not armed: nothing logged, so there's no window to open.
  if (latestAdministrationId == null || latestGivenAt == null) {
    return { kind: "not-armed" };
  }
  // One-shot: we already notified for THIS exact administration. Only a newer
  // administration (a different id) re-arms it.
  if (input.notifiedAdministrationId === latestAdministrationId) {
    return { kind: "already-notified" };
  }
  const elapsed = hoursBetween(latestGivenAt, input.now);
  if (elapsed < input.minIntervalHours) {
    return { kind: "not-yet", opensInHours: input.minIntervalHours - elapsed };
  }
  // Window is open. Suppress at/over the confirmed daily ceiling (label max) — no
  // marker is written, so a later administration (new id) re-evaluates cleanly.
  // With an amount-aware exposure (#1854) the ceiling is ITS verdict (mg when
  // known); otherwise the plain count comparison stands.
  const exposure = input.exposure ?? null;
  if (exposure ? exposure.atMax : input.countToday >= input.maxDailyCount) {
    return { kind: "suppressed-max" };
  }
  return {
    kind: "fire",
    administrationId: latestAdministrationId,
    countToday: input.countToday,
    maxDailyCount: input.maxDailyCount,
    sinceHours: elapsed,
    lastGivenAt: latestGivenAt,
    exposure,
  };
}

// A marker-AGNOSTIC redose status for the always-on SURFACING paths (the med card,
// the dashboard PRN widget) — unlike redoseNoticeDecision, this ignores the one-shot
// notification marker, because a card should always show the current window state, not
// go silent after the notice fired. Returns null when nothing has been logged yet
// (no window to describe). The interval/max are the item's confirmed numbers.
// The daily max is OPTIONAL on this path (#1458). "Maximum doses per day" is the
// field a caregiver is least likely to know offhand, and the single number they want
// at 2am — when is the next dose OK — is computable from the minimum interval alone.
// So a null max means only that the ceiling half of the status is unknown: `atMax`
// is false (an unknown ceiling is never a reached one) and the count fragment drops
// its "of N". The window half (open / opens-in) needs only the interval and the last
// administration. The one-shot NOTIFICATION path (redoseNoticeDecision above) keeps
// requiring both — its gather gate only returns items with both confirmed.
export interface RedoseStatus {
  open: boolean; // the minimum interval has elapsed since the last administration
  atMax: boolean; // today's exposure has reached the confirmed ceiling (false when unset)
  countToday: number;
  maxDailyCount: number | null; // null ⇒ no confirmed count ceiling
  sinceHours: number; // hours since the last administration
  opensInHours: number; // hours until the window opens (0 when already open)
  // The day's amount-aware exposure (#1854), when one was computable — the "N of
  // M" fragment then reads milligrams and atMax is ITS verdict. null keeps the
  // plain count fragment/ceiling.
  exposure: PrnDayExposure | null;
}

export function redoseWindowStatus(input: {
  minIntervalHours: number;
  maxDailyCount: number | null;
  latestGivenAt: Date | null;
  countToday: number;
  now: Date;
  exposure?: PrnDayExposure | null;
}): RedoseStatus | null {
  if (!input.latestGivenAt) return null;
  const elapsed = hoursBetween(input.latestGivenAt, input.now);
  const open = elapsed >= input.minIntervalHours;
  const exposure = input.exposure ?? null;
  return {
    open,
    atMax: exposure
      ? exposure.atMax
      : input.maxDailyCount != null && input.countToday >= input.maxDailyCount,
    countToday: input.countToday,
    maxDailyCount: input.maxDailyCount,
    sinceHours: elapsed,
    opensInHours: open ? 0 : input.minIntervalHours - elapsed,
    exposure,
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
    familyLastGivenAt: string | null;
    familyMaxDailyCount: number | null;
    // The family's amount-aware day exposure (#1854), computed by the ONE
    // getMedicationFamilyStates gather; null when no ceiling is confirmed (or on
    // a legacy caller), which keeps the count basis exactly as before.
    familyExposure?: PrnDayExposure | null;
  },
  now: Date
): RedoseStatus | null {
  if (med.minIntervalHours == null || !med.familyLastGivenAt) return null;
  return redoseWindowStatus({
    minIntervalHours: med.minIntervalHours,
    maxDailyCount: effectiveMaxDailyCount(
      med.maxDailyCount,
      med.familyMaxDailyCount
    ),
    latestGivenAt: parseUtcSql(med.familyLastGivenAt),
    countToday: med.familyCount,
    now,
    exposure: med.familyExposure ?? null,
  });
}
