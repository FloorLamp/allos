// "Also for" — the reads behind the offer and the ONE atomic write behind the tap
// (#5230). The pure model (identity, the recipient's dose, the schedule copy, the
// offer's basis) lives in lib/intake-also-for.ts; this module gathers the rows it needs
// and performs the copy.
//
// AUTH-BLIND (the lib/ write-core convention): nothing here imports lib/auth. The
// Server Action owns the whole gate — the TARGET's own write access, exactly as
// linkItemAction gates an item's profile, plus the bottle's membership-management gate
// (#5560, requirePoolWriteAccess). Every profile id reaching these functions has been
// proved accessible by the caller's ProfileScope; each read is single-profile
// `profile_id = ?` SQL, or the pool's own allowlisted cross-profile membership read.

import { db, today, writeTx } from "../../db";
import { snapshotCached } from "../../read-snapshot";
import { getLatestBodyMetricDated } from "../metrics";
import { profileAgeMonths } from "../../settings";
import { parseRxcuiIngredients } from "../../rxnorm";
import { crossCheckDrugAllergies } from "../../drug-allergy";
import { getIntakeSafetyContext } from "./safety";
import { createIntakeItemCore } from "../../intake-item-create";
import {
  alsoForBasis,
  alsoForDoseSeeds,
  alsoForEligible,
  alsoForReceipt,
  alsoForScheduleLabel,
  alsoForWrittenDose,
  inForceDoseRows,
  resolveAlsoForDose,
  sameIntakeProduct,
  type AlsoForCandidateFacts,
  type AlsoForDose,
  type AlsoForDoseRow,
  type AlsoForSchedule,
  type IntakeProductIdentity,
} from "../../intake-also-for";
import type { PediatricFormContext } from "../../prn-dosing";
import type { IntakeItemKind } from "../../types/intake";
import {
  getPoolView,
  invalidatePoolRefillOffers,
  poolMembers,
  type PoolMember,
  type PoolView,
} from "./supply-pool";

// ---- The source: one member's item, product and schedule --------------------

export interface AlsoForSource {
  itemId: number;
  profileId: number;
  kind: IntakeItemKind;
  // The product facts an ITEM carries and a `shared_supplies` row has no column for.
  // The bottle still owns what the product IS (#1705); these travel with the copy as
  // its own provenance.
  rxcui: string | null;
  rxcuiIngredients: string[] | null;
  brand: string | null;
  product: string | null;
  schedule: AlsoForSchedule;
}

// ONE member's copyable plan, profile-scoped on the member's own profile so a forged id
// cannot read another household's row.
//
// The schedule it returns carries only the dose rows still IN FORCE on the RECIPIENT's
// day, which is the schedule a person joining now would actually inherit. Reading the
// raw rows here instead is what let the card name "Morning" over an elapsed taper the
// copy would not write.
export function alsoForSource(
  profileId: number,
  itemId: number,
  today: string
): AlsoForSource | null {
  const item = db
    .prepare(
      `SELECT id, kind, obligation, condition, situation, rxcui, rxcui_ingredients,
              brand, product, supply_id,
              cadence_kind, cadence_weekdays, cadence_interval_days,
              cadence_anchor_date
         FROM intake_items
        WHERE id = ? AND profile_id = ?`
    )
    .get(itemId, profileId) as
    | {
        id: number;
        kind: IntakeItemKind;
        obligation: AlsoForSchedule["obligation"];
        condition: AlsoForSchedule["condition"];
        situation: string | null;
        rxcui: string | null;
        rxcui_ingredients: string | null;
        brand: string | null;
        product: string | null;
        supply_id: number | null;
        cadence_kind: AlsoForSchedule["cadence_kind"];
        cadence_weekdays: string | null;
        cadence_interval_days: number | null;
        cadence_anchor_date: string | null;
      }
    | undefined;
  if (!item) return null;
  const doses = db
    .prepare(
      `SELECT d.amount, d.time_of_day, d.food_timing, d.weekdays,
              d.start_date, d.end_date
         FROM intake_item_doses d
         JOIN intake_items i ON i.id = d.item_id
        WHERE d.item_id = ? AND i.profile_id = ? AND d.retired = 0
        ORDER BY d.sort, d.id`
    )
    .all(itemId, profileId) as AlsoForDoseRow[];
  return {
    itemId: item.id,
    profileId,
    kind: item.kind,
    rxcui: item.rxcui,
    rxcuiIngredients: parseRxcuiIngredients(item.rxcui_ingredients),
    brand: item.brand,
    product: item.product,
    schedule: {
      condition: item.condition,
      obligation: item.obligation,
      situation: item.situation,
      cadence_kind: item.cadence_kind,
      cadence_weekdays: item.cadence_weekdays,
      cadence_interval_days: item.cadence_interval_days,
      cadence_anchor_date: item.cadence_anchor_date,
      doses: inForceDoseRows(doses, today),
    },
  };
}

// The bottle's product identity: its own name and strength, plus the RxNorm codes its
// MEMBERSHIP carries (`poolProductCodes`).
//
// THE BOTTLE OWNS WHAT THE PRODUCT IS (#1705 / #5518's `prnLabelIdentityFor`), and a
// `shared_supplies` row has no code column — but #4717's identity is RxCUI FIRST, and
// an identity with no code can only ever match on a name, which is how a Penicillin
// allergy failed to recognise an Amoxicillin bottle and an existing Advil failed to
// recognise an Ibuprofen one.
//
// The codes are read across the WHOLE membership in a fixed order rather than off the
// members this reader can see, which is what makes the answer stable: the card and the
// write must derive the same product or every offer would refuse itself as stale.
export function poolProductIdentity(
  pool: Pick<PoolView, "name" | "strength">,
  members: readonly PoolMember[]
): IntakeProductIdentity {
  // Lowest item id wins: the members of one bottle are the same product by
  // construction, so any coded member answers for the bottle and the oldest is the
  // stable choice. The MEMBERSHIP is the one cross-profile read (poolMembers, the
  // allowlisted accounting read); each member's own facts are then read under that
  // member's profile, so no statement here is unscoped.
  for (const member of [...members].sort((a, b) => a.itemId - b.itemId)) {
    const row = db
      .prepare(
        "SELECT rxcui, rxcui_ingredients FROM intake_items WHERE id = ? AND profile_id = ?"
      )
      .get(member.itemId, member.profileId) as
      { rxcui: string | null; rxcui_ingredients: string | null } | undefined;
    const rxcui = row?.rxcui ?? null;
    const rxcuiIngredients = parseRxcuiIngredients(
      row?.rxcui_ingredients ?? null
    );
    if (rxcui || rxcuiIngredients?.length) {
      return {
        name: pool.name,
        strength: pool.strength,
        rxcui,
        rxcuiIngredients,
      };
    }
  }
  return {
    name: pool.name,
    strength: pool.strength,
    rxcui: null,
    rxcuiIngredients: null,
  };
}

// ---- The recipient's facts --------------------------------------------------

// The pediatric-dosing context for a subject the caller may write. Same computation as
// the medication form's (getPediatricFormContext) — one context, so a chip and a form
// cannot disagree about a child's dose.
const pediatricContextFor = snapshotCached(
  "also-for.pediatric",
  (profileId: number) => String(profileId),
  pediatricContextForUncached
);

function pediatricContextForUncached(profileId: number): PediatricFormContext {
  const todayStr = today(profileId);
  const weight = getLatestBodyMetricDated(profileId, "weight");
  return {
    ageMonths: profileAgeMonths(profileId, todayStr),
    weightKg: weight?.value ?? null,
    weightDate: weight?.date ?? null,
    weightUnit: "kg",
    today: todayStr,
  };
}

// Whether this person already keeps an UNPOOLED item of the same product (#4717
// identity). An item on another bottle is another bottle; an archived one is history.
//
// Matched on identity alone — see `sameIntakeProduct` for why an item's dose amount is
// not a product strength and must not stand in for one.
//
// UNCACHED, unlike the two per-profile reads above, because its answer depends on the
// PRODUCT as well as the person: an admin who may write many profiles pays one item
// scan per candidate per bottle on a `/supplies` render. Recorded rather than optimised
// — the scan is a single indexed profile read and the cabinet is a small page, so the
// right time to cache it is when a real cabinet is slow, keyed on both halves.
function hasUnpooledDuplicate(
  profileId: number,
  product: IntakeProductIdentity
): boolean {
  const rows = db
    .prepare(
      `SELECT i.id, i.name, i.rxcui, i.rxcui_ingredients
         FROM intake_items i
        WHERE i.profile_id = ? AND i.supply_id IS NULL AND i.active = 1`
    )
    .all(profileId) as {
    id: number;
    name: string;
    rxcui: string | null;
    rxcui_ingredients: string | null;
  }[];
  return rows.some((row) =>
    sameIntakeProduct(product, {
      name: row.name,
      strength: null,
      rxcui: row.rxcui,
      rxcuiIngredients: parseRxcuiIngredients(row.rxcui_ingredients),
    })
  );
}

// The recipient's recorded allergies, as the CANONICAL drug-allergy cross-check
// consumes them: coded (`substance_code`), non-resolved and actionable (#1405), from
// the one shared gather every other safety surface reads.
const allergyRecordsFor = snapshotCached(
  "also-for.allergy-records",
  (profileId: number) => String(profileId),
  (profileId: number) => getIntakeSafetyContext(profileId).allergyRecords
);

// The recorded allergy this bottle meets for this person, or null.
//
// THE CANONICAL MODEL, NOT A SECOND ONE. This used to run `allergenConflict` — the
// SUPPLEMENT-SUGGESTION matcher, which is name-token containment plus the #153 FOOD
// cross-reactivity dataset — over the bottle's display name. It caught only a near-
// exact name, so a Penicillin allergy was offered the household Amoxicillin, an Aspirin
// allergy was offered the Ibuprofen, and an Ibuprofen allergy was offered the Advil;
// the app's own `crossCheckDrugAllergies` then flagged the very row the offer had just
// created. Asking the row-level check about the row the copy WOULD create makes the
// offer and the warning the same judgment: ingredient, class and documented
// cross-class all withhold, code-first where a code is recorded.
//
// The med id is 0 because the row does not exist yet — only the hit's substance is read
// here, never its dedupeKey or row anchor.
function allergyBlocking(
  profileId: number,
  product: IntakeProductIdentity
): string | null {
  const hits = crossCheckDrugAllergies(allergyRecordsFor(profileId), [
    {
      id: 0,
      name: product.name,
      rxcui: product.rxcui,
      rxcuiIngredients: product.rxcuiIngredients,
    },
  ]);
  return hits[0]?.substance ?? null;
}

// Everything the offer asks about one person, gathered from their own rows.
export function alsoForCandidateFacts(input: {
  profileId: number;
  name: string;
  canWrite: boolean;
  isMember: boolean;
  product: IntakeProductIdentity;
}): AlsoForCandidateFacts {
  const { profileId, product } = input;
  return {
    profileId,
    name: input.name,
    canWrite: input.canWrite,
    isMember: input.isMember,
    hasUnpooledDuplicate:
      input.canWrite &&
      !input.isMember &&
      hasUnpooledDuplicate(profileId, product),
    allergen: allergyBlocking(profileId, product),
    dose: resolveAlsoForDose({
      identity: product,
      pediatric: pediatricContextFor(profileId),
    }),
  };
}

// ---- The card's offer -------------------------------------------------------

export interface AlsoForSourceOption {
  itemId: number;
  profileId: number;
  personName: string;
  scheduleLabel: string;
}

export interface AlsoForOffer {
  profileId: number;
  name: string;
  // What each source would give this person, keyed by source item id: the basis the tap
  // posts back, so a changed plan refuses instead of substituting another member's.
  basisBySource: Record<number, string>;
}

export interface AlsoForCardModel {
  sources: AlsoForSourceOption[];
  offers: AlsoForOffer[];
}

// The bottle's offer as ONE caller sees it. `members` are the members that caller may
// SEE (hidden members are never source options); `candidates` are the profiles they may
// WRITE. An empty source list means no automatic copy — the ordinary management doors
// stand.
export function alsoForCardModel(input: {
  pool: Pick<PoolView, "id" | "name" | "strength">;
  visibleMembers: readonly {
    itemId: number;
    profileId: number;
    name: string;
  }[];
  candidates: readonly { id: number; name: string }[];
}): AlsoForCardModel {
  // Nobody to offer this bottle to means nothing to read: the sources exist only to be
  // chosen between, and reading each member's schedule to render no action is work the
  // cabinet does once per bottle per page.
  if (input.candidates.length === 0) return { sources: [], offers: [] };
  const sources: { option: AlsoForSourceOption; source: AlsoForSource }[] = [];
  for (const member of input.visibleMembers) {
    const source = alsoForSource(
      member.profileId,
      member.itemId,
      today(member.profileId)
    );
    // A member with no dose row still in force has no schedule to hand on: every row
    // it has is a window that already closed. Offering it would name a plan the copy
    // cannot write, so it is not a source — the ordinary management doors stand.
    if (!source || source.schedule.doses.length === 0) continue;
    sources.push({
      option: {
        itemId: source.itemId,
        profileId: source.profileId,
        personName: member.name,
        scheduleLabel: alsoForScheduleLabel(source.schedule),
      },
      source,
    });
  }
  if (sources.length === 0) return { sources: [], offers: [] };

  // The MEMBERSHIP, not the visible subset: who already draws from this bottle and
  // what product it is are both facts about the bottle, and the write re-reads exactly
  // this — a card that answered from what its viewer can see would offer a person who
  // is already a member behind someone else's grant.
  const members = poolMembers(input.pool.id);
  const product = poolProductIdentity(input.pool, members);
  const memberIds = new Set(members.map((m) => m.profileId));
  const offers: AlsoForOffer[] = [];
  for (const candidate of input.candidates) {
    const facts = alsoForCandidateFacts({
      profileId: candidate.id,
      name: candidate.name,
      canWrite: true,
      isMember: memberIds.has(candidate.id),
      product,
    });
    if (!alsoForEligible(facts)) continue;
    const basisBySource: Record<number, string> = {};
    for (const { source } of sources) {
      basisBySource[source.itemId] = alsoForBasis({
        product,
        sourceItemId: source.itemId,
        sourceIdentity: source,
        schedule: source.schedule,
        targetProfileId: candidate.id,
        dose: facts.dose,
      });
    }
    offers.push({
      profileId: candidate.id,
      name: candidate.name,
      basisBySource,
    });
  }
  return { sources: sources.map((s) => s.option), offers };
}

// ---- The write --------------------------------------------------------------

export type AlsoForCopyResult =
  | {
      ok: true;
      itemId: number;
      kind: IntakeItemKind;
      receipt: string;
      dose: AlsoForDose;
    }
  | { ok: false; error: string };

const STALE = "This offer changed. Reload the cabinet and try again.";

// Copy ONE member's plan onto another person, atomically.
//
// Everything the offer was derived from is re-read HERE, under the write lock: the
// bottle, the source's membership, the target's membership and duplicate eligibility,
// and the target's own dose basis. A stale intent is REFUSED — never silently resolved
// to a different person's plan — which is also what makes a double tap land at most one
// item: the second tap finds the target already a member.
export function copyPoolMemberPlan(input: {
  supplyId: number;
  sourceProfileId: number;
  sourceItemId: number;
  targetProfileId: number;
  targetName: string;
  // The basis the caller was shown. Empty refuses: an offer with no stated basis is an
  // offer nobody looked at.
  basis: string;
}): AlsoForCopyResult {
  return writeTx(() => {
    const pool = getPoolView(input.supplyId);
    if (!pool) return { ok: false, error: "Couldn't find that shared bottle." };
    const members = poolMembers(input.supplyId);
    const sourceMember = members.find(
      (m) =>
        m.itemId === input.sourceItemId && m.profileId === input.sourceProfileId
    );
    if (!sourceMember) {
      return { ok: false, error: STALE };
    }
    if (members.some((m) => m.profileId === input.targetProfileId)) {
      return {
        ok: false,
        error: `${input.targetName} already draws from this bottle.`,
      };
    }
    // The recipient's day decides which of the source's dose windows are still in
    // force, exactly as it did when the offer was rendered.
    const targetToday = today(input.targetProfileId);
    const source = alsoForSource(
      input.sourceProfileId,
      input.sourceItemId,
      targetToday
    );
    if (!source) return { ok: false, error: STALE };

    const product = poolProductIdentity(pool, members);
    const facts = alsoForCandidateFacts({
      profileId: input.targetProfileId,
      name: input.targetName,
      canWrite: true,
      isMember: false,
      product,
    });
    if (!alsoForEligible(facts)) return { ok: false, error: STALE };
    const basis = alsoForBasis({
      product,
      sourceItemId: source.itemId,
      sourceIdentity: source,
      schedule: source.schedule,
      targetProfileId: input.targetProfileId,
      dose: facts.dose,
    });
    if (!input.basis || basis !== input.basis) {
      return { ok: false, error: STALE };
    }

    const schedule = source.schedule;
    const seeds = alsoForDoseSeeds(schedule.doses, facts.dose, targetToday);
    // What the receipt may claim is what the copy WRITES, not what was derivable: an
    // amount with no row to carry it is not a dose (alsoForWrittenDose).
    const written = alsoForWrittenDose(facts.dose, seeds);
    // PRODUCT, OBLIGATION AND SCHEDULE — and nothing else. No amount, no weight, no
    // start date, no administrations, no stock. The PRN redose figures are absent for
    // the same reason as the amount: they are the label numbers confirmed for THAT
    // person's age, and the recipient's own form is where theirs are confirmed.
    const base = {
      // The BOTTLE owns what the product is (#1705), so the new row is named after it
      // rather than after the source member's own display name.
      name: pool.name,
      provenance: { source: "manual" } as const,
      obligation: schedule.obligation,
      condition: schedule.condition,
      // The label, never the source's id-keyed row: situation rules resolve by NAME in
      // the recipient's own vocabulary (see lib/intake-also-for.ts).
      situation:
        schedule.condition === "situational" ? schedule.situation : null,
      brand: source.brand,
      product: source.product,
      rxcui: source.rxcui,
      rxcuiIngredients: source.rxcuiIngredients?.length
        ? JSON.stringify(source.rxcuiIngredients)
        : null,
      // Membership, not a count: a pooled item keeps no private stock (#1705).
      supplyId: input.supplyId,
      cadenceKind: schedule.cadence_kind ?? "daily",
      cadenceWeekdays: schedule.cadence_weekdays ?? null,
      cadenceIntervalDays: schedule.cadence_interval_days ?? null,
      cadenceAnchorDate: schedule.cadence_anchor_date ?? null,
      doses: seeds,
    };
    const created = createIntakeItemCore(
      input.targetProfileId,
      source.kind === "medication"
        ? {
            ...base,
            kind: "medication",
            // A copy states nothing about when this person started (#5229/#5576):
            // the course opens with an UNKNOWN start.
            course: { kind: "open", startedOn: null },
          }
        : { ...base, kind: "supplement" }
    );
    if (!created.ok) return { ok: false, error: created.error };
    // A new member changes what the bottle owes everyone, so the pooled refill offers
    // are re-derived rather than answered from a cached projection — the same sweep the
    // link path runs.
    invalidatePoolRefillOffers(input.supplyId);
    return {
      ok: true,
      itemId: created.id,
      kind: source.kind,
      receipt: alsoForReceipt(input.targetName, written),
      dose: written,
    };
  });
}
