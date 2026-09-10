// Part of the lib/queries/intake barrel (#319), split out of adherence.ts under
// #2960 / rule #5670. The profile-scoping guard walks all of lib/, so this module
// stays covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
//
// THE REDOSE AND OVER-MAX READS (#798, #1027, #4686). Three gathers that answer a
// SAFETY question about as-needed dosing — who is due a one-shot redose notice, what
// a family's arming state is right now, and who is over a confirmed daily ceiling.
//
// They are reads, and they are separate from the quick-log gather beside them because
// their answers are consumed as VERDICTS rather than rendered as labels. That is the
// distinction #4686 drew and it is the reason this module never falls back to a
// capture stamp: an interval clock computed off "when we recorded it" would turn a
// past-day check-off into a fresh dose and hold a real one back. The liability gate
// lives in the gather itself — an unconfirmed interval or max means no notice, ever —
// so the pure decision downstream may assume valid positives.
import { db } from "../../db";
import {
  ARMING_ORDER,
  armingFromRow,
  CEILING_WINDOW_SQL,
  ceilingWindowBounds,
  getMedicationFamilyStates,
} from "./prn-family";
import type { FamilyArming, PrnExposureBasis } from "../../prn-redose";

// ---- PRN redose notice (#798) ----

// An opted-in PRN med with CONFIRMED redose fields, for the notify tick's one-shot
// redose notice. Only items with redose_notice=1 AND both min_interval_hours and
// max_daily_count set are returned — an unconfirmed/empty field means no notice, ever
// (the liability gate lives HERE, in the gather, so the pure decision can assume
// valid positives). Active PRN medications only.
export interface RedoseNoticeItem {
  id: number;
  name: string;
  product: string | null;
  amount: string | null;
  minIntervalHours: number;
  maxDailyCount: number;
}

export function getRedoseNoticeItems(profileId: number): RedoseNoticeItem[] {
  return db
    .prepare(
      `SELECT id, name, product,
              (SELECT d.amount FROM intake_item_doses d
                WHERE d.item_id = intake_items.id AND d.retired = 0
                ORDER BY d.sort, d.id LIMIT 1) AS amount,
              min_interval_hours AS minIntervalHours,
              max_daily_count AS maxDailyCount
         FROM intake_items
        WHERE profile_id = ? AND active = 1 AND kind = 'medication'
          AND obligation = 'may' AND redose_notice = 1
          AND min_interval_hours IS NOT NULL AND min_interval_hours > 0
          AND max_daily_count IS NOT NULL AND max_daily_count > 0
        ORDER BY name`
    )
    .all(profileId) as RedoseNoticeItem[];
}

// The arming state for one PRN item's redose one-shot: what arms the timer (#4686's
// `FamilyArming`, keyed by administration id per the notify_last_* discipline) and the
// TRAILING-24h administration count (drives the "N of M" + max suppression). Profile-
// scoped via the parent item. `nowMinute` is the instant the ceiling window ends, and
// the count reads the same one predicate the family gather does — the two must never
// disagree about what is inside the window.
//
// THE PER-ITEM READ ANSWERS IN THE SAME UNION AS THE FAMILY GATHER, deliberately: this
// is the fallback a caller reaches when the family map has no entry, and a fallback
// that answered in a different shape is exactly how `recorded_at` got back into the
// interval clock in three files.
export interface RedoseArmingState {
  arming: FamilyArming;
  countInWindow: number;
}

export function getRedoseArmingState(
  profileId: number,
  itemId: number,
  nowMinute: number
): RedoseArmingState {
  // The row that arms the one-shot, under the SHARED ordering (`ARMING_ORDER`) — no
  // COALESCE, so a capture stamp can never reach the interval clock through here, and a
  // taken row stating no instant wins outright. Scoped through the parent item so a
  // forged itemId can't read across profiles.
  const latest = db
    .prepare(
      `SELECT l.id AS id, l.occurred_at AS givenAt
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id = ? AND l.status = 'taken'
        ORDER BY ${ARMING_ORDER}
        LIMIT 1`
    )
    .get(profileId, itemId) as
    { id: number; givenAt: string | null } | undefined;
  const count = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id = ?
          AND l.status = 'taken' AND ${CEILING_WINDOW_SQL}`
    )
    .get(profileId, itemId, ...ceilingWindowBounds(profileId, nowMinute)) as {
    n: number;
  };
  return {
    arming: armingFromRow(latest ? { ...latest, itemId } : undefined),
    countInWindow: count.n,
  };
}

// A PRN med (or ingredient FAMILY, #1027) whose TRAILING-24h administration count has
// EXCEEDED the confirmed max (#798, window corrected in #4686) — the input to the
// over-max care finding (the #148 UL-warning shape). "Over" is strictly greater than
// the max (you've logged MORE than the label allows in 24 hours).
//
// FAMILY-AWARE (#1027 ask 2): the exposure is the ingredient family's COMBINED
// taken administrations (OTC ibuprofen + Rx ibuprofen 800 together), compared
// against the most conservative confirmed ceiling among members. The finding is
// anchored to the member holding the binding max (lowest id on a tie), so its
// dedupeKey stays `prn-max:<itemId>` — identical to the pre-family key for a
// single-item family (#203: keys stable where possible). Members with unconfirmed
// fields still contribute their logged administrations (a logged dose is a fact
// regardless of config); a family with NO confirmed ceiling produces nothing (the
// #798 liability gate).
//
// AMOUNT-AWARE (#1854): basis/total/max come straight from the family state's
// prnDayExposure verdict — summed snapshotted MILLIGRAMS against a confirmed
// mg/day max when every administration's amount parses (3 × 800 mg is 2400 mg,
// not a calm "3 of 6"), the administration COUNT as the fallback for unparseable
// amounts. `basis` tells the copy which one was used.
export interface PrnOverMaxItem {
  id: number;
  name: string;
  // The basis the day was judged on, its total and confirmed ceiling — mg for the
  // amount-aware path, administrations for the count fallback (prnDayExposure).
  basis: PrnExposureBasis;
  total: number;
  max: number;
  // mg basis only: administrations with no parseable snapshotted amount (the
  // lower-bound path — copy must read "at least"). Always 0 on the count basis.
  unknownAmounts: number;
  // Every family member's name, when the exposure spans MORE than one item (the
  // #531 label-by-what-differs rule for the finding copy); absent for a solo item.
  memberNames?: string[];
}

export function getPrnOverMaxItems(
  profileId: number,
  nowMinute: number
): PrnOverMaxItem[] {
  const out: PrnOverMaxItem[] = [];
  const seenFamilies = new Set<string>();
  const states = getMedicationFamilyStates(profileId, nowMinute);
  // Anchor selection needs each member's own confirmed maxes + PRN flag; re-read
  // the active PRN-configured meds once (profile-scoped). Either ceiling form
  // (count or mg/day, #1854) makes an item "configured".
  const configured = db
    .prepare(
      `SELECT id, name, max_daily_count AS maxDailyCount,
              max_daily_amount_mg AS maxDailyAmountMg
         FROM intake_items
        WHERE profile_id = ? AND active = 1
          AND obligation = 'may' AND kind = 'medication'
          AND ((max_daily_count IS NOT NULL AND max_daily_count > 0)
            OR (max_daily_amount_mg IS NOT NULL AND max_daily_amount_mg > 0))
        ORDER BY id`
    )
    .all(profileId) as {
    id: number;
    name: string;
    maxDailyCount: number | null;
    maxDailyAmountMg: number | null;
  }[];
  for (const item of configured) {
    const state = states.get(item.id);
    if (!state || seenFamilies.has(state.familyKey)) continue;
    seenFamilies.add(state.familyKey);
    const exposure = state.exposure;
    if (!exposure || !exposure.over) continue;
    // Anchor: the configured member holding the binding most-conservative max on
    // the basis actually used (lowest id on a tie) — `configured` is id-ordered,
    // so the first match wins.
    const anchor =
      configured.find(
        (c) =>
          state.memberIds.includes(c.id) &&
          (exposure.basis === "mg"
            ? c.maxDailyAmountMg === exposure.max
            : c.maxDailyCount === exposure.max)
      ) ?? item;
    out.push({
      id: anchor.id,
      name: anchor.name,
      basis: exposure.basis,
      total: exposure.total,
      max: exposure.max,
      unknownAmounts: exposure.unknownAmounts,
      ...(state.memberIds.length > 1 ? { memberNames: state.memberNames } : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
