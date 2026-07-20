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
import { parseRxcuiIngredients } from "../../rxnorm";
import {
  medicationFamilies,
  familyDisplayLabel,
  type MedicationFamily,
} from "../../medication-family";

// The per-family safety state every cross-item counter reads. One object is shared
// by all members of a family (the map has one entry per member item id).
export interface MedFamilyState {
  familyKey: string;
  memberIds: number[];
  memberNames: string[];
  // Human label for the family ("Ibuprofen") — the duplication/over-max copy.
  label: string;
  // Latest administration across ALL members (given_at required — the arming dose),
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
}

interface FamilyMemberRow {
  id: number;
  name: string;
  rxcui: string | null;
  rxcui_ingredients: string | null;
  max_daily_count: number | null;
  as_needed: number;
}

// The profile's ACTIVE medication items partitioned into ingredient families —
// shared by the state gather below and the therapeutic-duplication note builder.
export function getActiveMedicationFamilies(
  profileId: number
): MedicationFamily<FamilyMemberRow & { rxcuiIngredients: string[] | null }>[] {
  const rows = db
    .prepare(
      `SELECT id, name, rxcui, rxcui_ingredients, max_daily_count, as_needed
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

// Family safety state for every ACTIVE medication item, keyed by ITEM id (one
// shared state object per family). `date` is the profile-local day the count
// resets on. Two small queries per family (latest arming administration +
// today's combined count), profile-scoped through the parent-item JOIN.
export function getMedicationFamilyStates(
  profileId: number,
  date: string
): Map<number, MedFamilyState> {
  const out = new Map<number, MedFamilyState>();
  for (const family of getActiveMedicationFamilies(profileId)) {
    const ids = family.members.map((m) => m.id);
    const placeholders = ids.map(() => "?").join(", ");
    const latest = db
      .prepare(
        `SELECT l.id AS id, l.given_at AS givenAt, l.item_id AS itemId
           FROM intake_item_logs l
           JOIN intake_items s ON s.id = l.item_id
          WHERE s.profile_id = ? AND l.item_id IN (${placeholders})
            AND l.status = 'taken' AND l.given_at IS NOT NULL
          ORDER BY l.given_at DESC, l.id DESC
          LIMIT 1`
      )
      .get(profileId, ...ids) as
      { id: number; givenAt: string; itemId: number } | undefined;
    const count = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM intake_item_logs l
           JOIN intake_items s ON s.id = l.item_id
          WHERE s.profile_id = ? AND l.item_id IN (${placeholders})
            AND l.date = ? AND l.status = 'taken'`
      )
      .get(profileId, ...ids, date) as { n: number };

    const confirmedMaxes = family.members
      .map((m) => m.max_daily_count)
      .filter((m): m is number => m != null && m > 0);
    const state: MedFamilyState = {
      familyKey: family.familyKey,
      memberIds: ids,
      memberNames: family.members.map((m) => m.name),
      label: familyDisplayLabel(family.members),
      latestId: latest?.id ?? null,
      latestGivenAt: latest?.givenAt ?? null,
      latestItemId: latest?.itemId ?? null,
      latestItemName: latest
        ? (family.members.find((m) => m.id === latest.itemId)?.name ?? null)
        : null,
      countToday: count.n,
      minConfirmedMax: confirmedMaxes.length
        ? Math.min(...confirmedMaxes)
        : null,
    };
    for (const id of ids) out.set(id, state);
  }
  return out;
}
