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
import { allergenConflict } from "../../supplement-safety";
import { createIntakeItemCore } from "../../intake-item-create";
import {
  alsoForBasis,
  alsoForDoseSeeds,
  alsoForEligible,
  alsoForReceipt,
  alsoForScheduleLabel,
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
export function alsoForSource(
  profileId: number,
  itemId: number
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
      doses,
    },
  };
}

// The bottle's product identity: its OWN name and strength, and nothing borrowed from
// a member.
//
// THE BOTTLE OWNS WHAT THE PRODUCT IS (#1705 / #5518's `prnLabelIdentityFor`), which is
// also what makes this answer STABLE — and the offer's basis is only worth checking if
// both sides compute it the same way. Reading a member's RxCUI here would make the
// bottle's identity depend on WHICH members the reader can see: the card sees the
// members behind its own grants, the write sees the membership, and the two would
// disagree about a bottle whose coded member is hidden — refusing every tap. The
// members of one bottle are the same product by construction, so the bottle's own two
// facts are the honest identity. A copied row still carries the SOURCE's RxNorm codes
// as its product provenance; that is the item's fact, not the bottle's.
export function poolProductIdentity(
  pool: Pick<PoolView, "name" | "strength">
): IntakeProductIdentity {
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
function hasUnpooledDuplicate(
  profileId: number,
  product: IntakeProductIdentity
): boolean {
  const rows = db
    .prepare(
      `SELECT i.id, i.name, i.rxcui, i.rxcui_ingredients,
              (SELECT d.amount FROM intake_item_doses d
                WHERE d.item_id = i.id AND d.retired = 0
                ORDER BY d.sort, d.id LIMIT 1) AS amount
         FROM intake_items i
        WHERE i.profile_id = ? AND i.supply_id IS NULL AND i.active = 1`
    )
    .all(profileId) as {
    id: number;
    name: string;
    rxcui: string | null;
    rxcui_ingredients: string | null;
    amount: string | null;
  }[];
  return rows.some((row) =>
    sameIntakeProduct(product, {
      name: row.name,
      strength: row.amount,
      rxcui: row.rxcui,
      rxcuiIngredients: parseRxcuiIngredients(row.rxcui_ingredients),
    })
  );
}

// Every recorded allergen, resolved ones included — the conservative set an INGESTIBLE
// offer is screened against (the getIngestibleSafetyContext posture, #691).
const recordedAllergens = snapshotCached(
  "also-for.allergens",
  (profileId: number) => String(profileId),
  recordedAllergensUncached
);

function recordedAllergensUncached(profileId: number): string[] {
  const rows = db
    .prepare("SELECT substance FROM allergies WHERE profile_id = ?")
    .all(profileId) as { substance: string }[];
  return rows.map((r) => r.substance);
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
  const allergenText = [product.name, product.strength]
    .filter((v): v is string => !!v && v.trim() !== "")
    .join(" ");
  return {
    profileId,
    name: input.name,
    canWrite: input.canWrite,
    isMember: input.isMember,
    hasUnpooledDuplicate:
      input.canWrite &&
      !input.isMember &&
      hasUnpooledDuplicate(profileId, product),
    allergen:
      allergenConflict(allergenText, recordedAllergens(profileId))?.allergen ??
      null,
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
  memberProfileIds: readonly number[];
  candidates: readonly { id: number; name: string }[];
}): AlsoForCardModel {
  const sources: { option: AlsoForSourceOption; source: AlsoForSource }[] = [];
  for (const member of input.visibleMembers) {
    const source = alsoForSource(member.profileId, member.itemId);
    if (!source) continue;
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

  const product = poolProductIdentity(input.pool);
  const memberIds = new Set(input.memberProfileIds);
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
    const source = alsoForSource(input.sourceProfileId, input.sourceItemId);
    if (!source) return { ok: false, error: STALE };

    const product = poolProductIdentity(pool);
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
      schedule: source.schedule,
      targetProfileId: input.targetProfileId,
      dose: facts.dose,
    });
    if (!input.basis || basis !== input.basis) {
      return { ok: false, error: STALE };
    }

    const schedule = source.schedule;
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
      doses: alsoForDoseSeeds(
        schedule.doses,
        facts.dose,
        today(input.targetProfileId)
      ),
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
      receipt: alsoForReceipt(input.targetName, facts.dose),
      dose: facts.dose,
    };
  });
}
