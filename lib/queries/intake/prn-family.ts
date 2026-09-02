// Part of the lib/queries/intake barrel (#319). The profile-scoping guard walks all
// of lib/, so this module's reads are profile-scoped directly or through the parent
// intake_items JOIN.
//
// The medication ingredient-FAMILY state gather (issue #1027): the ONE computation
// behind every cross-item PRN safety counter. A profile tracking the same active
// ingredient as two items (OTC ibuprofen 200 mg + Rx ibuprofen 800 mg) used to get
// strictly per-item counters — the Rx item's redose notice could fire "you may
// redose" an hour after an OTC dose (a false GO in the dangerous direction, the
// #798 notice's worst failure mode). This gather partitions the ACTIVE medication
// items into #482 ingredient families (lib/medication-family) and derives, per
// family: the latest administration across ALL members (the interval clock's arming
// dose), today's combined administration count, and the most conservative confirmed
// daily max among members. Consumers — the redose notice orchestrator, the over-max
// care finding, the med card's redose line, and shared PRN quick-log content —
// are formatters over this ONE state, so they can never disagree ("one question,
// one computation").
//
// A logged dose is a fact regardless of config (#1027 ask 2): a member with
// UNCONFIRMED interval/max fields never gets its own notice (the #798 liability
// gate stands, in getRedoseNoticeItems), but its administrations still count into a
// sibling's family math. Scheduled members count too — a scheduled 800 mg confirm
// is an ibuprofen intake.

import { db } from "../../db";
import { cache } from "../../request-cache";
import { snapshotCached } from "../../read-snapshot";
import { tickCached } from "../../tick-cache";
import { parseRxcuiIngredients } from "../../rxnorm";
import {
  medicationFamilies,
  familyDisplayLabel,
  type MedicationFamily,
} from "../../medication-family";
import {
  prnWindowExposure,
  PRN_CEILING_WINDOW_HOURS,
  type PrnWindowExposure,
} from "../../prn-redose";
import { now as clockNow } from "../../clock";
import {
  dateStrInTz,
  shiftDateStr,
  utcInstant,
  zonedWallTimeToUtc,
} from "../../date";
import { getTimezone } from "../../settings";
import { bestKnownInstant } from "../../row-instants";
import type { IntakeObligation } from "../../types";

// The per-family safety state every cross-item counter reads. One object is shared
// by all members of a family (the map has one entry per member item id).
export interface MedFamilyState {
  familyKey: string;
  memberIds: number[];
  memberNames: string[];
  // Human label for the family ("Ibuprofen") — the duplication/over-max copy.
  label: string;
  // Latest administration across ALL members (the stated event instant when present,
  // otherwise the immutable capture instant),
  // plus WHICH member it belongs to, so a notice can honestly say "6h since OTC
  // Ibuprofen" when a sibling's dose armed the clock.
  latestId: number | null;
  latestGivenAt: string | null;
  latestItemId: number | null;
  latestItemName: string | null;
  // Combined taken count across all members inside the CEILING WINDOW — the
  // trailing 24 hours (#4686), which is the basis the label figures it is compared
  // against are stated on ("no more than 5 doses in 24 hours"). NOT a calendar day:
  // the midnight reset was more permissive than the label in exactly the
  // fevered-child-overnight case this counter exists for.
  count24h: number;
  // The most conservative confirmed max_daily_count among members, or null when no
  // member carries one.
  minConfirmedMax: number | null;
  // The most conservative confirmed max_daily_amount_mg among members (#1854), or
  // null when no member carries one.
  minConfirmedMaxMg: number | null;
  // The snapshotted amount of each administration in the window across the family
  // (the confirm-dose snapshot invariant is what makes this summable).
  amounts24h: (string | null)[];
  // Whether an administration inside the ceiling window states no instant. The
  // interval half of every redose surface then reads UNKNOWN, because nothing can
  // honestly stand in for a time nobody recorded (owner ruling, pass three).
  untimedInWindow: boolean;
  // The window's amount-aware exposure verdict (#1854): summed milligrams when the
  // mg ceiling applies and amounts parse, the administration count as the
  // fallback, null when NO ceiling is confirmed. THE one computation every
  // counter surface (over-max finding, card/widget/Telegram line, redose-notice
  // ceiling) formats over.
  exposure: PrnWindowExposure | null;
}

interface FamilyMemberRow {
  id: number;
  name: string;
  rxcui: string | null;
  rxcui_ingredients: string | null;
  max_daily_count: number | null;
  max_daily_amount_mg: number | null;
  obligation: IntakeObligation;
}

// The profile's ACTIVE medication items partitioned into ingredient families —
// shared by the state gather below and the therapeutic-duplication note builder.
export function getActiveMedicationFamilies(
  profileId: number
): MedicationFamily<FamilyMemberRow & { rxcuiIngredients: string[] | null }>[] {
  const rows = db
    .prepare(
      `SELECT id, name, rxcui, rxcui_ingredients, max_daily_count,
              max_daily_amount_mg, obligation
         FROM intake_items
        WHERE profile_id = ? AND active = 1 AND kind = 'medication'
        ORDER BY id`
    )
    .all(profileId) as FamilyMemberRow[];
  return medicationFamilies(
    rows.map((r) => ({
      ...r,
      rxcuiIngredients: parseRxcuiIngredients(r.rxcui_ingredients),
    }))
  );
}

export type RedoseWindowState =
  "current" | "superseded" | "cancelled" | "unavailable";

// Is one administration-armed Telegram redose window still the CURRENT window for
// this item? Uncached on purpose: the callback write asks inside an IMMEDIATE
// transaction, where a request cache could turn a concurrent app log into a second
// dose. Family-aware for the same reason every redose clock is family-aware — an OTC
// ibuprofen administration supersedes the Rx sibling's old window too.
export function redoseWindowState(
  profileId: number,
  itemId: number,
  armingAdministrationId: number
): RedoseWindowState {
  const family = getActiveMedicationFamilies(profileId).find((f) =>
    f.members.some((m) => m.id === itemId)
  );
  if (!family) return "unavailable";
  const ids = family.members.map((m) => m.id);
  const placeholders = ids.map(() => "?").join(", ");
  // Read the current family's administrations once inside the caller's write
  // transaction. The shared row-instant model chooses administration time first and
  // immutable capture second; this window check does not invent a third pairing.
  const administrations = db
    .prepare(
      `SELECT l.id, l.occurred_at, l.recorded_at
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id IN (${placeholders})
          AND l.status = 'taken'`
    )
    .all(profileId, ...ids) as {
    id: number;
    occurred_at: string | null;
    recorded_at: string;
  }[];
  if (!administrations.some((row) => row.id === armingAdministrationId))
    return "cancelled";
  const latest = administrations.reduce((best, row) => {
    const at = bestKnownInstant("intake_item_logs", row);
    const bestAt = bestKnownInstant("intake_item_logs", best);
    if (!at.known) return best;
    if (!bestAt.known || at.at > bestAt.at) return row;
    return at.at === bestAt.at && row.id > best.id ? row : best;
  });
  return latest.id === armingAdministrationId ? "current" : "superseded";
}

// Family safety state for every ACTIVE medication item, keyed by ITEM id (one
// shared state object per family). Two small queries per family (latest arming
// administration + the ceiling window's combined count), profile-scoped through the
// parent-item JOIN.
//
// NO DAY ARGUMENT (#4686). This state used to take the profile-local day its count
// reset on; the ceiling window is the trailing 24 hours the label states, so there is
// no day here to pass, to key on, or to get wrong. The window's endpoint is the clock
// seam, frozen for a render or a tick exactly like every other read in that scope.
//
// MEMOIZED ON BOTH LIFETIMES (#2111). Every cross-item PRN counter is a formatter over
// this ONE state, and a surface that renders several of them used to pay for the whole
// gather once per formatter: the dashboard reached it twice (the quick-log gather and
// the attention model's over-max finding), `/medications` twice, and the hourly tick
// two or three times (redose notice, the digest's over-max item, the quick-log
// gather) — where `cache()` is identity.
//
//   • `cache()` — collapses the per-render fan-out, the #2094 shape, keyed on the
//     profile id as a primitive so identity actually matches.
//   • `tickCached` — the same collapse for the tick, whose scope
//     `scripts/notify.ts` opens per profile (lib/tick-cache.ts).
//
// The one thing a memo here MUST NOT do is outlive a dose confirm: this is a safety
// counter, and a stale low count is the "you may redose" false GO the family gather
// exists to prevent. Neither lifetime can. A request is one render — `markDoseTaken`
// revalidates, and the next render is a new request with a new memo — and a tick
// scope contains no dose write at all (taps land in the webhook route or the sidecar's
// separate `poll` mode, never in `tick()`).
const getMedicationFamilyStatesForRequest = cache(
  tickCached(
    "getMedicationFamilyStates",
    (profileId: number) => String(profileId),
    getMedicationFamilyStatesUncached
  )
);
export const getMedicationFamilyStates = snapshotCached(
  "intake.medication-family-states",
  (profileId: number) => String(profileId),
  getMedicationFamilyStatesForRequest
);

// THE CEILING WINDOW JUDGES THE ADMINISTRATION INSTANT (#4686).
//
// A row that STATES one (`occurred_at` — every PRN log, every backfill) is judged on
// it. A row that states NONE is judged at profile-local NOON of its own `date`, which
// is the same anchoring lib/school-return-data.ts already gives an untimed reading —
// one rule, not a second one.
//
// IT IS NEVER JUDGED ON `recorded_at`. That column is the immutable CAPTURE stamp, and
// letting it stand in for the event instant is exactly the substitution
// lib/row-instants.ts exists to stop; `COALESCE(occurred_at, recorded_at)` is that
// substitution spelled in SQL. It mattered here rather than theoretically: a scheduled
// check-off for a day the parent missed carries a capture stamp of NOW, so catching up
// on two missed days put three administrations inside today's window off one real dose
// and the card read "Max reached · 3 of 3 in 24h" — a safety line telling a parent not
// to treat a fevered child, wrong.
export interface PrnCeilingWindow {
  // The window's opening instant, canonical, for rows that state a time.
  fromInstant: string;
  // The profile-local days whose NOON anchor falls inside the window — how an untimed
  // row is judged. At most two; an empty list is representable and matches nothing.
  untimedDates: string[];
}

// THE ARMING ADMINISTRATION: the newest one that STATES an instant.
//
// `date` IS THE ADHERENCE DAY, NOT A CLAIM ABOUT WHEN THE DOSE WAS GIVEN (owner ruling,
// pass three). `restampDoseLogsCore` says so in its own header — a dose-time correction
// crossing midnight "moves only `occurred_at` and leaves the adherence day where the
// schedule put it", and it returns `crossedMidnight` as a first-class outcome. So a row
// filed to an EARLIER day can carry a LATER stated instant, and narrowing this read by
// `MAX(date)` dropped the genuinely-latest administration: four real hours after a
// 22:00 dose the card said "Redose OK".
//
// It reads ONLY rows that state an instant. A row that states none is not a candidate
// for arming a clock at all — see `untimedInWindow` below, which turns the interval
// UNKNOWN rather than letting anything stand in for the missing time.
//
// Profile-scoped in its own right (CLAUDE.md), not by trusting that its ids arrived
// from a scoped call.
export function armingAdministration(
  profileId: number,
  itemIds: readonly number[]
): { id: number; administeredAt: string; itemId: number } | null {
  if (itemIds.length === 0) return null;
  const placeholders = itemIds.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT l.id AS id, l.occurred_at AS administeredAt, l.item_id AS itemId
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id IN (${placeholders})
          AND l.status = 'taken' AND l.occurred_at IS NOT NULL
        ORDER BY l.occurred_at DESC, l.id DESC
        LIMIT 1`
    )
    .get(profileId, ...itemIds) as
    { id: number; administeredAt: string; itemId: number } | undefined;
  return row ?? null;
}

export function prnCeilingWindow(profileId: number): PrnCeilingWindow {
  const now = clockNow();
  const from = new Date(now.getTime() - PRN_CEILING_WINDOW_HOURS * 3_600_000);
  const tz = getTimezone(profileId);
  // Candidates around both ends, then filtered by the anchor itself, so a DST day
  // that carries zero or two noons inside the window answers for itself.
  const seen = new Set<string>();
  const untimedDates: string[] = [];
  for (const anchorDay of [dateStrInTz(tz, from), dateStrInTz(tz, now)]) {
    for (const offset of [-1, 0, 1]) {
      const day = shiftDateStr(anchorDay, offset);
      if (seen.has(day)) continue;
      seen.add(day);
      const noon = zonedWallTimeToUtc(tz, day, "12:00");
      if (noon && noon >= from && noon <= now) untimedDates.push(day);
    }
  }
  return { fromInstant: utcInstant(from), untimedDates: untimedDates.sort() };
}

// The window as a SQL predicate over `intake_item_logs l`, with its bound parameters —
// ONE spelling, so the family gather and the per-item arming fallback in ./adherence
// cannot drift. The CAST is load-bearing: `strftime('%s', …)` returns TEXT, and a bare
// `>=` compares two epochs as STRINGS — right for every 10-digit epoch and INVERTED
// below 2001-09-09, where '999907200' sorts above '1788254160', so an ancient stamp
// would read as inside the window and count against the ceiling forever.
export function prnCeilingWindowClause(profileId: number): {
  sql: string;
  params: (string | number)[];
} {
  const { fromInstant, untimedDates } = prnCeilingWindow(profileId);
  // No qualifying noon ⇒ the untimed arm matches nothing, spelled as a false literal
  // because `IN ()` is not valid SQLite.
  const untimed = untimedDates.length
    ? `l.date IN (${untimedDates.map(() => "?").join(", ")})`
    : "0";
  return {
    sql: `(CASE WHEN l.occurred_at IS NOT NULL
                THEN CAST(strftime('%s', l.occurred_at) AS INTEGER)
                     >= CAST(strftime('%s', ?) AS INTEGER)
                ELSE ${untimed} END)`,
    params: [fromInstant, ...untimedDates],
  };
}

function getMedicationFamilyStatesUncached(
  profileId: number
): Map<number, MedFamilyState> {
  const out = new Map<number, MedFamilyState>();
  // ONE window for the whole gather: every family in this map is judged against the
  // same instant, which is what makes the map a single consistent state.
  const window = prnCeilingWindowClause(profileId);
  for (const family of getActiveMedicationFamilies(profileId)) {
    const ids = family.members.map((m) => m.id);
    const placeholders = ids.map(() => "?").join(", ");
    const latest = armingAdministration(profileId, ids);
    // The CEILING WINDOW's taken administrations WITH their snapshotted amounts — the
    // count is the row count, and the amounts feed the amount-aware exposure (#1854).
    // The window predicate and its reasoning live in prnCeilingWindowClause above.
    const windowLogs = db
      .prepare(
        `SELECT l.amount AS amount, l.occurred_at AS occurredAt
           FROM intake_item_logs l
           JOIN intake_items s ON s.id = l.item_id
          WHERE s.profile_id = ? AND l.item_id IN (${placeholders})
            AND l.status = 'taken' AND ${window.sql}`
      )
      .all(profileId, ...ids, ...window.params) as {
      amount: string | null;
      occurredAt: string | null;
    }[];
    const amounts24h = windowLogs.map((l) => l.amount);
    // An administration in the window that states NO instant makes the interval
    // unknowable — not just its own elapsed time, but WHICH administration is latest,
    // since an unplaced dose could sit after every placed one. The count is unaffected:
    // counting does not need to know when.
    const untimedInWindow = windowLogs.some((l) => l.occurredAt == null);

    const confirmedMaxes = family.members
      .map((m) => m.max_daily_count)
      .filter((m): m is number => m != null && m > 0);
    const confirmedMgMaxes = family.members
      .map((m) => m.max_daily_amount_mg)
      .filter((m): m is number => m != null && m > 0);
    const minConfirmedMax = confirmedMaxes.length
      ? Math.min(...confirmedMaxes)
      : null;
    const minConfirmedMaxMg = confirmedMgMaxes.length
      ? Math.min(...confirmedMgMaxes)
      : null;
    const state: MedFamilyState = {
      familyKey: family.familyKey,
      memberIds: ids,
      memberNames: family.members.map((m) => m.name),
      label: familyDisplayLabel(family.members),
      latestId: latest?.id ?? null,
      latestGivenAt: latest?.administeredAt ?? null,
      latestItemId: latest?.itemId ?? null,
      latestItemName: latest
        ? (family.members.find((m) => m.id === latest.itemId)?.name ?? null)
        : null,
      count24h: amounts24h.length,
      untimedInWindow,
      minConfirmedMax,
      minConfirmedMaxMg,
      amounts24h,
      exposure: prnWindowExposure({
        amounts: amounts24h,
        maxDailyAmountMg: minConfirmedMaxMg,
        maxDailyCount: minConfirmedMax,
      }),
    };
    for (const id of ids) out.set(id, state);
  }
  return out;
}
