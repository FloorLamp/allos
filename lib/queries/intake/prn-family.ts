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
// care finding, the med card's redose line, and the dashboard quick-log widget —
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
import { tickCached } from "../../tick-cache";
import { parseRxcuiIngredients } from "../../rxnorm";
import {
  medicationFamilies,
  familyDisplayLabel,
  type MedicationFamily,
} from "../../medication-family";
import { prnDayExposure, type PrnDayExposure } from "../../prn-redose";
import type { IntakeObligation } from "../../types";

// The per-family safety state every cross-item counter reads. One object is shared
// by all members of a family (the map has one entry per member item id).
export interface MedFamilyState {
  familyKey: string;
  memberIds: number[];
  memberNames: string[];
  // Human label for the family ("Ibuprofen") — the duplication/over-max copy.
  label: string;
  // Latest administration across ALL members (recorded_at required — the arming dose),
  // plus WHICH member it belongs to, so a notice can honestly say "6h since OTC
  // Ibuprofen" when a sibling's dose armed the clock.
  latestId: number | null;
  latestGivenAt: string | null;
  latestItemId: number | null;
  latestItemName: string | null;
  // Today's combined taken count across all members (profile-local `date`).
  countToday: number;
  // The most conservative confirmed max_daily_count among members, or null when no
  // member carries one.
  minConfirmedMax: number | null;
  // The most conservative confirmed max_daily_amount_mg among members (#1854), or
  // null when no member carries one.
  minConfirmedMaxMg: number | null;
  // The snapshotted amount of each of today's taken administrations across the
  // family (the confirm-dose snapshot invariant is what makes this summable).
  amountsToday: (string | null)[];
  // The day's amount-aware exposure verdict (#1854): summed milligrams when the
  // mg ceiling applies and amounts parse, the administration count as the
  // fallback, null when NO ceiling is confirmed. THE one computation every
  // counter surface (over-max finding, card/widget/Telegram line, redose-notice
  // ceiling) formats over.
  exposure: PrnDayExposure | null;
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
  // Establish that the administration which opened THIS window still exists as a
  // taken, timed fact in the item's current family. If the user undid it in the app,
  // an older remaining administration must not be misreported as a newer dose.
  const arming = db
    .prepare(
      `SELECT 1
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id IN (${placeholders}) AND l.id = ?
          AND l.status = 'taken' AND l.recorded_at IS NOT NULL
        LIMIT 1`
    )
    .get(profileId, ...ids, armingAdministrationId);
  if (!arming) return "cancelled";
  const latest = db
    .prepare(
      `SELECT l.id AS id
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id IN (${placeholders})
          AND l.status = 'taken' AND l.recorded_at IS NOT NULL
        ORDER BY l.recorded_at DESC, l.id DESC
        LIMIT 1`
    )
    .get(profileId, ...ids) as { id: number } | undefined;
  // `arming` is itself eligible for this query, so absence is only possible if the
  // ledger changed between these two reads outside the callback's write transaction.
  if (!latest) return "cancelled";
  return latest.id === armingAdministrationId ? "current" : "superseded";
}

// Family safety state for every ACTIVE medication item, keyed by ITEM id (one
// shared state object per family). `date` is the profile-local day the count
// resets on. Two small queries per family (latest arming administration +
// today's combined count), profile-scoped through the parent-item JOIN.
//
// MEMOIZED ON BOTH LIFETIMES (#2111). Every cross-item PRN counter is a formatter over
// this ONE state, and a surface that renders several of them used to pay for the whole
// gather once per formatter: the dashboard reached it twice (the quick-log gather and
// the attention model's over-max finding), `/medications` twice, and the hourly tick
// two or three times (redose notice, the digest's over-max item, the quick-log
// gather) — where `cache()` is identity.
//
//   • `cache()` — collapses the per-render fan-out, the #2094 shape, keyed
//     (profileId, date) as primitives so identity actually matches.
//   • `tickCached` — the same collapse for the tick, whose scope
//     `scripts/notify.ts` opens per profile (lib/tick-cache.ts).
//
// The one thing a memo here MUST NOT do is outlive a dose confirm: this is a safety
// counter, and a stale low count is the "you may redose" false GO the family gather
// exists to prevent. Neither lifetime can. A request is one render — `markDoseTaken`
// revalidates, and the next render is a new request with a new memo — and a tick
// scope contains no dose write at all (taps land in the webhook route or the sidecar's
// separate `poll` mode, never in `tick()`).
export const getMedicationFamilyStates = cache(
  tickCached(
    "getMedicationFamilyStates",
    (profileId: number, date: string) => `${profileId}:${date}`,
    getMedicationFamilyStatesUncached
  )
);

function getMedicationFamilyStatesUncached(
  profileId: number,
  date: string
): Map<number, MedFamilyState> {
  const out = new Map<number, MedFamilyState>();
  for (const family of getActiveMedicationFamilies(profileId)) {
    const ids = family.members.map((m) => m.id);
    const placeholders = ids.map(() => "?").join(", ");
    const latest = db
      .prepare(
        `SELECT l.id AS id, l.recorded_at AS recordedAt, l.item_id AS itemId
           FROM intake_item_logs l
           JOIN intake_items s ON s.id = l.item_id
          WHERE s.profile_id = ? AND l.item_id IN (${placeholders})
            AND l.status = 'taken' AND l.recorded_at IS NOT NULL
          ORDER BY l.recorded_at DESC, l.id DESC
          LIMIT 1`
      )
      .get(profileId, ...ids) as
      { id: number; recordedAt: string; itemId: number } | undefined;
    // Today's taken administrations WITH their snapshotted amounts — the count is
    // the row count, and the amounts feed the amount-aware exposure (#1854).
    const todaysLogs = db
      .prepare(
        `SELECT l.amount AS amount
           FROM intake_item_logs l
           JOIN intake_items s ON s.id = l.item_id
          WHERE s.profile_id = ? AND l.item_id IN (${placeholders})
            AND l.date = ? AND l.status = 'taken'`
      )
      .all(profileId, ...ids, date) as { amount: string | null }[];
    const amountsToday = todaysLogs.map((l) => l.amount);

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
      latestGivenAt: latest?.recordedAt ?? null,
      latestItemId: latest?.itemId ?? null,
      latestItemName: latest
        ? (family.members.find((m) => m.id === latest.itemId)?.name ?? null)
        : null,
      countToday: amountsToday.length,
      minConfirmedMax,
      minConfirmedMaxMg,
      amountsToday,
      exposure: prnDayExposure({
        amounts: amountsToday,
        maxDailyAmountMg: minConfirmedMaxMg,
        maxDailyCount: minConfirmedMax,
      }),
    };
    for (const id of ids) out.set(id, state);
  }
  return out;
}
