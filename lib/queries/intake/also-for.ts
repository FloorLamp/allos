// "Also for" — the reads behind the offer and the ONE atomic write behind the tap
// (#5230). The pure model (the recipient's dose, the schedule copy, the offer's basis,
// the typed refusals and the receipt) lives in lib/intake-also-for.ts; this module
// gathers the rows it needs and performs the copy.
//
// AUTH-BLIND (the lib/ write-core convention): nothing here imports lib/auth. The
// Server Action owns the whole gate — the TARGET's own write access, exactly as
// linkItemAction gates an item's profile, plus the bottle's membership-management gate
// (#5560, requirePoolWriteAccess). Every profile id reaching these functions has been
// proved accessible by the caller's ProfileScope; each read is single-profile
// `profile_id = ?` SQL, or the pool's own allowlisted cross-profile membership read.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DERIVE, after two falsifying passes broke on
// exactly these: a clinical verdict (allergy warns through the receipt, it does not
// gate) and a product identity (a bottle has no code, and none is minted by scanning
// its membership — #4717 owns that seam, and until it lands the duplicate question
// answers "unknown" out loud instead of withholding on a guess).

import { db, today, writeTx } from "../../db";
import { snapshotCached } from "../../read-snapshot";
import { parseRxcuiIngredients } from "../../rxnorm";
import { isHiddenUnderPolicy } from "../../lifecycle";
import { alsoForOfferKey } from "../../dismissal-keys";
import {
  dismissFinding,
  getFindingSuppressions,
} from "../upcoming/suppressions";
import { getIntakeSafetyContext } from "./safety";
import { getPediatricFormContext } from "./medications";
import { createIntakeItemCore } from "../../intake-item-create";
import { prnLabelIdentityFor } from "../../prn-defaults";
import {
  alsoForBasis,
  alsoForAllergenNotes,
  alsoForBasisRefusal,
  alsoForDetectedSlugs,
  alsoForDoseSeeds,
  alsoForEligible,
  alsoForIdentity,
  alsoForReceipt,
  alsoForScheduleLabel,
  alsoForWritten,
  decodeAlsoForBasis,
  encodeAlsoForBasis,
  resolveAlsoForDose,
  sourcePlanRows,
  type AlsoForCandidateFacts,
  type AlsoForDoseRow,
  type AlsoForLabelIdentity,
  type AlsoForNotes,
  type AlsoForRefusal,
  type AlsoForSchedule,
  type AlsoForWritten,
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
  // What the SOURCE's own row calls the medicine — not the bottle's name. Read for one
  // sentence only: where neither the bottle's name nor the source's code resolves to a
  // curated label, the receipt names what the source row actually says rather than a
  // product nobody resolved (#5230 ruling 10's second consequence, state F).
  name: string;
  // The product facts an ITEM carries and a `shared_supplies` row has no column for.
  // The bottle still owns what the product IS (#1705); these travel with the copy as
  // its own provenance, and the basis binds them so a mid-flight re-code refuses.
  rxcui: string | null;
  rxcuiIngredients: string[] | null;
  brand: string | null;
  product: string | null;
  schedule: AlsoForSchedule;
}

// ONE member's copyable plan, profile-scoped on the member's own profile so a forged id
// cannot read another household's row.
//
// The dose rows come back AS STORED. Filtering them is a question about a day, and the
// questions that used to share one filter are asked in two different days by two
// different callers (lib/intake-also-for.ts): the label describes the SOURCE's plan in
// the source's day; the copy takes the rows that travel in the RECIPIENT's day.
export function alsoForSource(
  profileId: number,
  itemId: number
): AlsoForSource | null {
  const item = db
    .prepare(
      `SELECT id, name, kind, obligation, condition, situation, rxcui, rxcui_ingredients,
              brand, product, supply_id,
              cadence_kind, cadence_weekdays, cadence_interval_days,
              cadence_anchor_date
         FROM intake_items
        WHERE id = ? AND profile_id = ?`
    )
    .get(itemId, profileId) as
    | {
        id: number;
        name: string;
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
    name: item.name,
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

// The label identity of the ROW THE COPY WILL CREATE: the bottle's name over the source
// row's own codes. That projection is `prnLabelIdentityFor` (#5518) — the repository's
// one answer to "what product is this pooled item" — so the chip's dose and the dose
// the created row derives tomorrow cannot disagree.
//
// It is NOT a bottle identity, and nothing here scans the membership for a code: the
// codes belong to the ONE source the person named, and the basis binds them.
function labelIdentityFor(
  pool: Pick<PoolView, "id" | "name">,
  source: AlsoForSource
): AlsoForLabelIdentity {
  const identity = prnLabelIdentityFor({
    name: pool.name,
    rxcui: source.rxcui,
    rxcuiIngredients: source.rxcuiIngredients,
    supplyId: pool.id,
    supplyName: pool.name,
  });
  return {
    name: identity.name,
    rxcui: identity.rxcui ?? null,
    rxcuiIngredients: identity.rxcuiIngredients ?? null,
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
  return getPediatricFormContext(profileId);
}

// The person's live allergy facts, gathered once per profile per read.
//
// The NON-RESOLVED, actionable set (`getIntakeSafetyContext`), not the ingestible
// widening: this is a note about the person's live record, and a resolved allergy should
// not keep being read back to them. The belt that keeps resolved allergens exists to
// drop a MACHINE's suggestion, which this is not. That gather also builds `allergens`
// and `allergyRecords` from ONE pass over the live rows, so the two matchers the
// composition runs see the same strings and the dedupe can compare them; the ingestible
// variant overrides `allergens` alone and the two sides stop being one-to-one.
const safetyFor = snapshotCached(
  "also-for.safety",
  (profileId: number) => String(profileId),
  (profileId: number) => {
    const ctx = getIntakeSafetyContext(profileId);
    return { allergens: ctx.allergens, records: ctx.allergyRecords };
  }
);

// Whether the offer for this bottle has been declined for this person. The suppression
// bus's own read, under the same "normal" policy every other declined offer uses: a
// dismissal hides indefinitely, which is what "dismissible without recurrence" means.
//
// THE KEY CARRIES WHAT THE BOTTLE'S NAME SAYS IT IS, derived here from the pool's own
// name — never from anything a client posted — so that correcting a mismatched name
// brings the offer back (ruling 7). The write derives it the same way through the same
// helper; two derivations would let a decline be written under one tail and looked for
// under another.
function declinedAlsoFor(
  profileId: number,
  pool: Pick<PoolView, "id" | "name">
): boolean {
  return isHiddenUnderPolicy(
    "normal",
    getFindingSuppressions(profileId).get(
      alsoForOfferKey(pool.id, alsoForDetectedSlugs(pool.name))
    ),
    today(profileId)
  );
}

// The two facts the offer asks about one person.
export function alsoForCandidateFacts(input: {
  profileId: number;
  name: string;
  pool: Pick<PoolView, "id" | "name">;
  isMember: boolean;
}): AlsoForCandidateFacts {
  return {
    profileId: input.profileId,
    name: input.name,
    isMember: input.isMember,
    declined: input.isMember
      ? false
      : declinedAlsoFor(input.profileId, input.pool),
  };
}

// ---- The card's offer -------------------------------------------------------

export interface AlsoForSourceOption {
  itemId: number;
  profileId: number;
  personName: string;
  scheduleLabel: string;
}

// What one source would give one recipient: the basis the tap posts back, and the
// life-stage refusal if the product has one for them. A withheld dose is a SENTENCE on
// the card, not a missing chip.
export interface AlsoForOfferSource {
  basis: string;
  withheld: string | null;
}

export interface AlsoForOffer {
  profileId: number;
  name: string;
  bySource: Record<number, AlsoForOfferSource>;
}

export interface AlsoForCardModel {
  sources: AlsoForSourceOption[];
  offers: AlsoForOffer[];
}

// The bottle's offer as ONE caller sees it. `visibleMembers` are the members that
// caller may SEE (hidden members are never source options); `candidates` are the
// profiles they may WRITE. An empty source list means no automatic copy — the ordinary
// management doors stand.
//
// A member is never dropped from the source list for having nothing live: that was a
// silent withhold answered in the wrong person's day, and the honest form is to offer
// the copy and let the receipt say what actually landed.
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
    const source = alsoForSource(member.profileId, member.itemId);
    if (!source) continue;
    sources.push({
      option: {
        itemId: source.itemId,
        profileId: source.profileId,
        personName: member.name,
        // A statement ABOUT THE SOURCE, so it is asked in the SOURCE's own day. This is
        // the one day question here that is not the recipient's, and it is why the card
        // can name one schedule per bottle instead of one per reader.
        scheduleLabel: alsoForScheduleLabel({
          ...source.schedule,
          doses: sourcePlanRows(source.schedule.doses, today(source.profileId)),
        }),
      },
      source,
    });
  }
  if (sources.length === 0) return { sources: [], offers: [] };

  // The MEMBERSHIP, not the visible subset: who already draws from this bottle is a
  // fact about the bottle, and the write re-reads exactly this — a card that answered
  // from what its viewer can see would offer a person who is already a member behind
  // someone else's grant.
  //
  // AN INACTIVE LINKED ITEM IS NOT MEMBERSHIP (owner ruling 8, 2026-09-09). A person
  // whose link to this bottle is stopped gets the chip again, and the tap restarts them
  // with a FRESH item. `poolMembers` returns stopped rows on purpose — eleven-plus
  // consumers depend on it, including the write-access gate — so the filter belongs at
  // each decision point, not in the reader.
  const memberIds = new Set(
    poolMembers(input.pool.id)
      .filter((m) => m.active)
      .map((m) => m.profileId)
  );
  const offers: AlsoForOffer[] = [];
  for (const candidate of input.candidates) {
    const facts = alsoForCandidateFacts({
      profileId: candidate.id,
      name: candidate.name,
      pool: input.pool,
      isMember: memberIds.has(candidate.id),
    });
    if (!alsoForEligible(facts)) continue;
    // THE RECIPIENT'S DAY, per recipient — not the source's and not the reader's.
    const targetDay = today(candidate.id);
    const pediatric = pediatricContextFor(candidate.id);
    const bySource: Record<number, AlsoForOfferSource> = {};
    for (const { option, source } of sources) {
      const dose = resolveAlsoForDose({
        label: labelIdentityFor(input.pool, source),
        pediatric,
        // The two refusals that name the disagreement read this, and the write derives
        // it the same way — a chip whose reason and receipt disagreed would be two
        // answers to one question.
        source: { personName: option.personName, itemName: source.name },
      });
      bySource[source.itemId] = {
        basis: encodeAlsoForBasis(
          alsoForBasis({
            pool: input.pool,
            sourceItemId: source.itemId,
            sourceIdentity: source,
            schedule: source.schedule,
            targetProfileId: candidate.id,
            targetDay,
            dose,
          })
        ),
        withheld: dose.kind === "withheld" ? dose.reason : null,
      };
    }
    offers.push({ profileId: candidate.id, name: candidate.name, bySource });
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
      written: AlsoForWritten;
    }
  | { ok: false; reason: AlsoForRefusal; detail?: string };

// Copy ONE member's plan onto another person, atomically.
//
// Everything the offer was derived from is re-read HERE, under the write lock: the
// bottle, the source's membership, the target's membership and decline state, the
// recipient's own day and their dose basis. A stale intent is REFUSED — never silently
// resolved to a different person's plan — which is also what makes a double tap land at
// most one item: the second tap finds the target already a member.
//
// EVERY REFUSAL IS A NAMED FACT. One `STALE` string for every failure is what let an
// over-block present itself as "reload and try again"; the reasons below say which fact
// moved, and `alsoForRefusalRefreshes` says which of them a fresh render fixes.
export function copyPoolMemberPlan(input: {
  supplyId: number;
  sourceProfileId: number;
  sourceItemId: number;
  // WHOSE plan is being copied, by display name. Read by the two refusals that have to
  // name the disagreement — ruling 7's own register is "the bottle is named Tylenol but
  // Dune's item is ibuprofen" — never by the write itself.
  sourceName: string;
  targetProfileId: number;
  targetName: string;
  // The basis the caller was shown. Unreadable refuses: an offer with no stated basis
  // is an offer nobody looked at.
  basis: string;
}): AlsoForCopyResult {
  const shown = decodeAlsoForBasis(input.basis);
  if (
    !shown ||
    shown.sourceItemId !== input.sourceItemId ||
    shown.targetProfileId !== input.targetProfileId
  ) {
    return { ok: false, reason: "no-offer" };
  }
  return writeTx(() => {
    const pool = getPoolView(input.supplyId);
    if (!pool) return { ok: false, reason: "no-bottle" };
    // ACTIVE MEMBERS ONLY, and it is ONE read answering two questions (owner ruling 8).
    // A stopped link is not membership: the recipient is offered the bottle again, and
    // the SOURCE lookup is filtered by the same rule — without that, a forged or stale
    // post could copy a stopped member's plan, and a member who stops between render and
    // tap refuses with `source-gone` rather than handing over a plan nobody is on.
    const members = poolMembers(input.supplyId).filter((m) => m.active);
    const sourceMember = members.find(
      (m) =>
        m.itemId === input.sourceItemId && m.profileId === input.sourceProfileId
    );
    if (!sourceMember) return { ok: false, reason: "source-gone" };
    if (members.some((m) => m.profileId === input.targetProfileId)) {
      return { ok: false, reason: "already-member" };
    }
    if (declinedAlsoFor(input.targetProfileId, pool)) {
      return { ok: false, reason: "declined" };
    }
    const source = alsoForSource(input.sourceProfileId, input.sourceItemId);
    if (!source) return { ok: false, reason: "source-gone" };

    // THE RECIPIENT'S DAY decides which of the source's dose windows travel, and it is
    // bound in the basis so the two sides compare one value rather than each deriving
    // its own in a different timezone.
    const targetDay = today(input.targetProfileId);
    const label = labelIdentityFor(pool, source);
    // WHAT THE BOTTLE IS, asked before what it doses (#5230 ruling 11). The dose reads
    // this precedence too; the receipt reads it to say which check could not run, and
    // the allergy composition reads it to know whether it may run at all.
    const identity = alsoForIdentity(label);
    const dose = resolveAlsoForDose({
      label,
      pediatric: pediatricContextFor(input.targetProfileId),
      source: { personName: input.sourceName, itemName: source.name },
    });
    const moved = alsoForBasisRefusal(
      shown,
      alsoForBasis({
        pool,
        sourceItemId: source.itemId,
        sourceIdentity: source,
        schedule: source.schedule,
        targetProfileId: input.targetProfileId,
        targetDay,
        dose,
      })
    );
    if (moved) return { ok: false, reason: moved };
    // The product's own life-stage gate, refused by NAME so the card can say it. It is
    // asked after the basis so a withhold that was on screen and a withhold that
    // appeared since read the same way to the person.
    if (dose.kind === "withheld") {
      return { ok: false, reason: "age-gated", detail: dose.reason };
    }

    const schedule = source.schedule;
    const seeds = alsoForDoseSeeds(schedule.doses, dose, targetDay);
    // What the receipt may claim is what the copy WROTE and what is LIVE: an amount
    // with no row to carry it is not a dose, and a row that starts next month is not a
    // dose you have today (alsoForWritten asks `doseOnDay`).
    const written = alsoForWritten(dose, seeds, targetDay);
    // THE ALLERGY COMPOSITION DOES NOT RUN UNDER A MISMATCH (ruling 11): when the name
    // and the code disagree there is no single thing to check the person's allergies
    // against, and checking one of two disagreeing identities would report a clean
    // result about the wrong medicine. The receipt says the check could not run instead.
    //
    // IT DOES RUN UNDER A PLURAL NAME (ruling 10, and the PM's 2026-09-10 01:40 ruling
    // that plural is never a dispute): a combination bottle has no single identity to
    // DOSE from, but every product its name lists is a thing to check an allergy
    // against, and landing dose-less AND silently is the worse of the two failures.
    const notes: AlsoForNotes = {
      allergens:
        identity.state === "mismatch"
          ? []
          : alsoForAllergenNotes({
              label,
              ...safetyFor(input.targetProfileId),
            }),
      identity: identity.state,
    };
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
    if (!created.ok) {
      return { ok: false, reason: "create-failed", detail: created.error };
    }
    // A new member changes what the bottle owes everyone, so the pooled refill offers
    // are re-derived rather than answered from a cached projection — the same sweep the
    // link path runs.
    invalidatePoolRefillOffers(input.supplyId);
    return {
      ok: true,
      itemId: created.id,
      kind: source.kind,
      receipt: alsoForReceipt(input.targetName, written, notes),
      written,
    };
  });
}

// ---- The decline ------------------------------------------------------------

// "Not for them": one row on the suppression bus, under the RECIPIENT's own profile,
// and nothing else. No health data, no membership and no notification setting — which
// is exactly what this issue's design boundary requires of a decline, and why Restore
// in the recipient's "Snoozed & dismissed" puts the chip back.
//
// THE IDENTITY TAIL IS DERIVED HERE, from the bottle's own name, through the same helper
// the read uses. The action posts a bottle and a person and nothing else: a client-supplied
// slug list would let a caller decline under a tail the read will never look for, which is
// a decline that silently does nothing. False when the bottle is gone — one reason and one
// message across deleted, foreign and unreachable (see the action).
export function declineAlsoForOffer(
  supplyId: number,
  targetProfileId: number
): boolean {
  const pool = getPoolView(supplyId);
  if (!pool) return false;
  dismissFinding(
    targetProfileId,
    alsoForOfferKey(supplyId, alsoForDetectedSlugs(pool.name))
  );
  return true;
}
