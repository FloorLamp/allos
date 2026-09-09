// "Also for" — copying ONE shared-bottle member's plan to another person (#5230).
//
// A shared bottle is one PRODUCT, not one dose. So the copy fans exactly three things —
// the bottle's product, the source member's obligation, and the source member's
// schedule — and derives the recipient's own amount from their own facts. It never
// copies an amount, a weight, a start date, an administration, or a stock count.
//
// THREE THINGS THAT LOOK LIKE A START DATE AND ARE NOT, decided here so the copy can
// keep a schedule's meaning without inventing when anyone began:
//
//   • INTERVAL PHASE (`cadence_anchor_date`). An every-3-days item needs an anchor to
//     say WHICH days it lands on; it is a phase reference, not a claim that the person
//     started that day. Copying it verbatim keeps the recipient on the same rhythm as
//     the rest of the household bottle, which is the point of copying a schedule at
//     all. The medication course still opens with an UNKNOWN start (#5576).
//   • PER-DOSE ACTIVATION WINDOWS (`start_date` / `end_date`, #1602). These express a
//     taper's steps. A window that has already ELAPSED is the source's own history, so
//     it is not part of the plan a new person joins: rows whose window has closed are
//     dropped, and an already-open `start_date` is dropped with it, because for the
//     recipient the row is simply in force. A FUTURE step keeps both bounds — that is
//     the schedule stating what happens next, which is exactly what a copy should say.
//   • SITUATION REFERENCES (#560 / #1296). `situation_id` and `pause_situation_id` name
//     rows in the SOURCE's profile and must never be written onto someone else's item.
//     The LABEL is copied instead: `isOfferedOn` and `heldBySituation` both resolve a
//     situation by NAME against the profile's own active situations, so the copied rule
//     reads in the RECIPIENT's vocabulary — and stays inert (not due, not held) until
//     they have that situation of their own.
//
// Pure: no db, no auth, no React.

import { cadenceLabel, type ItemCadence } from "./intake-cadence";
import {
  CONDITION_LABELS,
  TIME_BUCKET_LABELS,
  timeBucket,
} from "./intake-schedule";
import type { IntakeItemDoseSeed } from "./intake-item-create";
import { ingredientCuiKey } from "./medication-family";
import { medNameKey } from "./medication-record-match";
import { prnDefaultsFor } from "./prn-defaults";
import {
  formulationDoseAmount,
  isChildProfileAge,
  pediatricDoseSuggestion,
  pediatricRefusalLine,
  type PediatricFormContext,
} from "./prn-dosing";
import type { AppRoute } from "./hrefs";
import type { IntakeCondition, IntakeObligation } from "./types";

// ---- Product identity (#4717) ----------------------------------------------

// What the bottle IS, for the two questions this feature asks about a product: does the
// recipient already keep one of their own, and what does the label say to give them.
// RxCUI is the identity when both sides carry one; otherwise name + strength, which is
// the pair a household actually reads off a box.
export interface IntakeProductIdentity {
  name: string;
  strength: string | null;
  rxcui: string | null;
  rxcuiIngredients: string[] | null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

// A strength compares on its digits and units, not its spacing or case: "200mg" and
// "200 MG" are the same box.
function strengthKey(strength: string | null): string {
  return (strength ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[.,]$/, "");
}

// Whether two things are the same PRODUCT: the RxNorm ingredient identity when both
// sides carry one, else the cleaned generic name.
//
// STRENGTH IS DELIBERATELY NOT COMPARED, and #4717's "name + strength" leg cannot be
// honoured here honestly. `intake_items` has no strength column at all (lib/supply-
// product.ts: the bottle owns the product, the item owns the use), so the only
// per-item figure available is a DOSE AMOUNT — which is per-dose, not per-unit. Reading
// it as a strength says a person taking two 200 mg tablets (a "400 mg" dose row) does
// not already have the 200 mg bottle, and hands them a second active item: two reminder
// streams for one drug. Comparing nothing is the conservative direction for this
// question — it can only ever WITHHOLD an offer, never duplicate a medication.
export function sameIntakeProduct(
  a: IntakeProductIdentity,
  b: IntakeProductIdentity
): boolean {
  const aCui = ingredientCuiKey(a);
  const bCui = ingredientCuiKey(b);
  if (aCui && bCui) return aCui === bCui;
  const aName = medNameKey(a.name);
  const bName = medNameKey(b.name);
  return !!aName && aName === bName;
}

// ---- The recipient's own dose ----------------------------------------------

// What amount, if any, this copy may write for THIS person — and why.
//   • `amount`   — a figure derived from the recipient's own facts, with the basis to
//                  state in the receipt.
//   • `none`     — no figure is derivable, so the item lands with ZERO dose rows and
//                  the reason is the receipt. Never a placeholder row with a blank
//                  amount: an untimed row would count as scheduled (#5285).
//   • `withheld` — the label refuses for this person at all, so no offer is made.
export type AlsoForDose =
  | { kind: "amount"; amount: string; basis: string }
  | { kind: "none"; reason: string }
  | { kind: "withheld"; reason: string };

const NO_LABEL_REASON = "set the amount on the new row";

// The recipient's dose from the LABEL, never from the bottle and never from the source
// member. The child path is the #798 weight band (#4713's canonical result and its own
// refusal reasons); the adult path is the label's low adult figure; a product with no
// curated label states nothing, which is a dose-less copy rather than a guess.
//
// Deliberately NOT `prnDoseBandStatement`: that wrapper describes an EXISTING row
// against its stored amount, which a brand-new item does not have.
export function resolveAlsoForDose(input: {
  identity: Pick<IntakeProductIdentity, "name" | "rxcui" | "rxcuiIngredients">;
  pediatric: PediatricFormContext | null;
}): AlsoForDose {
  const entry = prnDefaultsFor({
    name: input.identity.name,
    rxcui: input.identity.rxcui,
    rxcuiIngredients: input.identity.rxcuiIngredients,
  });
  if (!entry) return { kind: "none", reason: NO_LABEL_REASON };

  const pediatric = input.pediatric;
  const ageMonths = pediatric?.ageMonths ?? null;
  if (pediatric && ageMonths != null && isChildProfileAge(ageMonths)) {
    // The product's own life-stage gate. A curated label with NO pediatric chart is
    // adult-only by the dataset's own statement (aspirin — Reye's; naproxen; the
    // age-dosed antihistamines), and the adult figure is exactly what must not be
    // handed to a child, so the offer is withheld rather than landed dose-less.
    if (!entry.pediatric) {
      return {
        kind: "withheld",
        reason: `${entry.label} has no children's dosing chart on its label.`,
      };
    }
    const result = pediatricDoseSuggestion({
      entry: { ...entry, pediatric: entry.pediatric },
      ageMonths,
      weightKg: pediatric.weightKg,
      weightDate: pediatric.weightDate,
      today: pediatric.today,
      // No formulation slug: the copy stores MILLIGRAMS (the exposure basis), and a
      // volume belongs to the product the recipient actually holds, which their own
      // row states. mlForBand would only add a number nothing here writes.
    });
    if (result.kind === "dose") {
      return {
        kind: "amount",
        amount: formulationDoseAmount(result.mg),
        basis: `from the ${result.bandLabel} label band`,
      };
    }
    // The label's hard age gate is a refusal to dose this person at all.
    if (result.kind === "ask-doctor") {
      return { kind: "withheld", reason: result.reason };
    }
    // Missing weight, stale weight, below the smallest band: the item still lands,
    // dose-less, carrying the band's own reason.
    return {
      kind: "none",
      reason: pediatricRefusalLine(result) ?? NO_LABEL_REASON,
    };
  }

  return {
    kind: "amount",
    amount: formulationDoseAmount(entry.adult.doseMgLow),
    basis: "from the adult label dose",
  };
}

// ---- Eligibility (an offer, not a warning) ---------------------------------

// Everything the offer asks about ONE person, already gathered. Interactions and
// conditions are deliberately absent: they are warnings the member's own row renders,
// not reasons to withhold the chip (#5230 shape item 4).
export interface AlsoForCandidateFacts {
  profileId: number;
  name: string;
  // The caller may WRITE them.
  //
  // STATED, NOT ENFORCED — say so rather than let this field look like a gate. Both
  // call sites pass `true`: the cabinet page has already narrowed its candidates to the
  // profiles the caller may write, and the action has already been through
  // `requireProfileWriteAccess(targetProfileId)` before the write core runs. Those two
  // are the real enforcement, and they are where a reviewer should look. This field
  // keeps the predicate below readable as the whole rule; it decides nothing today.
  canWrite: boolean;
  // They already draw from this bottle.
  isMember: boolean;
  // They keep an unpooled item of the same product (#4717 identity).
  hasUnpooledDuplicate: boolean;
  // A recorded allergen the bottle's product matches, or null.
  allergen: string | null;
  dose: AlsoForDose;
}

export function alsoForEligible(facts: AlsoForCandidateFacts): boolean {
  return (
    facts.canWrite &&
    !facts.isMember &&
    !facts.hasUnpooledDuplicate &&
    facts.allergen == null &&
    facts.dose.kind !== "withheld"
  );
}

// ---- The source member's schedule ------------------------------------------

// One source member's schedule, as the offer must state it before anyone taps: the
// action copies ONE person's plan, so the person names which.
export interface AlsoForSchedule extends ItemCadence {
  condition: IntakeCondition;
  obligation: IntakeObligation;
  situation: string | null;
  doses: readonly AlsoForDoseRow[];
}

export interface AlsoForDoseRow {
  amount: string | null;
  time_of_day: string | null;
  food_timing: IntakeItemDoseSeed["food_timing"];
  weekdays: string | null;
  start_date: string | null;
  end_date: string | null;
}

// "Daily · Morning, Evening", "As needed", "Every 3 days · Morning". Short enough to
// sit above the recipient's action, specific enough to tell two members apart.
export function alsoForScheduleLabel(schedule: AlsoForSchedule): string {
  const when =
    schedule.condition === "situational" && schedule.situation
      ? `When ${schedule.situation}`
      : (cadenceLabel(schedule) ?? CONDITION_LABELS[schedule.condition]);
  const parts = [schedule.obligation === "may" ? "As needed" : when];
  // A dose time is either one of the named buckets or a clock value the person typed.
  // Named buckets read as their label; a clock reads as itself, which is what every
  // other dose line does (formatMedicationDoseLine).
  const buckets: string[] = [];
  for (const dose of schedule.doses) {
    const stored = clean(dose.time_of_day);
    const bucket = timeBucket(stored);
    const label =
      bucket === "Anytime" && stored ? stored : TIME_BUCKET_LABELS[bucket];
    if (!buckets.includes(label)) buckets.push(label);
  }
  if (buckets.length > 0) parts.push(buckets.join(", "));
  else parts.push("no dose times");
  return parts.join(" · ");
}

// The dose rows of a source that are still IN FORCE on `today` — the only ones a person
// joining now inherits. A window that has already closed is the source's own history
// (see the module header), and a row whose window has closed is not part of the plan.
//
// ONE computation behind the label, the seeds and the basis, because the card must not
// name a dose time the copy will not write: that was how an all-elapsed taper produced
// a receipt claiming an amount over an item with no dose rows at all.
export function inForceDoseRows(
  doses: readonly AlsoForDoseRow[],
  today: string
): AlsoForDoseRow[] {
  return doses.filter((row) => {
    const end = clean(row.end_date);
    return !(end && end < today);
  });
}

// The recipient's dose rows: the source's schedule, the recipient's amount.
//
// Dose-less means ZERO rows (see AlsoForDose). Elapsed per-dose windows are the
// source's history and are dropped; an already-open start is dropped with them, because
// for a person joining today the row is simply in force (see the module header).
export function alsoForDoseSeeds(
  doses: readonly AlsoForDoseRow[],
  dose: AlsoForDose,
  today: string
): IntakeItemDoseSeed[] {
  if (dose.kind !== "amount") return [];
  const seeds: IntakeItemDoseSeed[] = [];
  for (const row of inForceDoseRows(doses, today)) {
    const end = clean(row.end_date);
    const start = clean(row.start_date);
    seeds.push({
      amount: dose.amount,
      time_of_day: row.time_of_day,
      food_timing: row.food_timing,
      weekdays: row.weekdays,
      start_date: start && start > today ? start : null,
      end_date: end,
    });
  }
  return seeds;
}

// What the copy ACTUALLY wrote, which is the only honest thing to put in a receipt.
// A derived amount with no row to carry it is not a dose: the item lands active with
// nothing ever due, so a receipt naming the amount would state a schedule the person
// does not have.
export function alsoForWrittenDose(
  dose: AlsoForDose,
  seeds: readonly IntakeItemDoseSeed[]
): AlsoForDose {
  if (dose.kind !== "amount" || seeds.length > 0) return dose;
  return {
    kind: "none",
    reason: "the copied schedule has no dose times still in force",
  };
}

// ---- The offer's basis, so a stale tap refuses -----------------------------

// What the person was looking at when they tapped. Re-derived under the write lock and
// compared: a changed product, source schedule, or recipient dose basis must refuse the
// tap rather than quietly copy a different plan. Membership and access are re-read as
// their own refusals, so they are not repeated here.
//
// IT BINDS EVERY FIELD THE COPY CARRIES, not just the ones on screen. The source's
// KIND, its RxNorm identity and its brand/product text are all written onto the
// recipient's row by an ordinary edit of the source between render and tap, and a basis
// blind to them would copy a warfarin's identity under the supplement the card named —
// and, because only a medication opens a course, skip the #5576 unknown-start
// guarantee on the way past. The owner's ruling says a changed PRODUCT refuses; this is
// the list of what "product" is made of.
export function alsoForBasis(input: {
  product: IntakeProductIdentity;
  sourceItemId: number;
  sourceIdentity: {
    kind: string;
    rxcui: string | null;
    rxcuiIngredients: string[] | null;
    brand: string | null;
    product: string | null;
  };
  schedule: AlsoForSchedule;
  targetProfileId: number;
  dose: AlsoForDose;
}): string {
  const { product, schedule, dose } = input;
  const rows = schedule.doses.map((d) =>
    [
      d.time_of_day ?? "",
      d.food_timing,
      d.weekdays ?? "",
      d.start_date ?? "",
      d.end_date ?? "",
    ].join("|")
  );
  return [
    "v1",
    input.sourceItemId,
    input.targetProfileId,
    product.name.trim(),
    strengthKey(product.strength),
    product.rxcui ?? "",
    schedule.condition,
    schedule.obligation,
    schedule.situation ?? "",
    schedule.cadence_kind ?? "daily",
    schedule.cadence_weekdays ?? "",
    schedule.cadence_interval_days ?? "",
    schedule.cadence_anchor_date ?? "",
    rows.join(";"),
    dose.kind,
    dose.kind === "amount" ? dose.amount : "",
    // Everything the copy carries off the SOURCE row.
    input.sourceIdentity.kind,
    ingredientCuiKey(input.sourceIdentity) ?? "",
    input.sourceIdentity.brand ?? "",
    input.sourceIdentity.product ?? "",
  ].join("~");
}

// ---- The receipt -----------------------------------------------------------

// What the card says after the tap. One line, naming the person, the amount and where
// it came from — or saying plainly that there is no dose yet and why.
export function alsoForReceipt(name: string, dose: AlsoForDose): string {
  if (dose.kind === "amount") {
    return `Added for ${name} · ${dose.amount} ${dose.basis}`;
  }
  return `Added for ${name} · no dose yet — ${dose.reason}`;
}

// ---- The action's answer ----------------------------------------------------

// What one tap returns. `href` is the created member's own row — the receipt's edit
// door, and the only place a dose the copy could not derive is set.
export interface AlsoForResult {
  ok: boolean;
  error?: string;
  receipt?: string;
  href?: AppRoute;
}
