// "Also for" — copying ONE shared-bottle member's plan to another person (#5230).
//
// A shared bottle is one PRODUCT, not one dose. So the copy fans exactly three things —
// the bottle's product, the source member's obligation, and the source member's
// schedule — and derives the recipient's own amount from their own facts. It never
// copies an amount, a weight, a start date, an administration, or a stock count.
//
// TWO FACTS ARE THIS FEATURE'S OWN, and no more (the 2026-09-09 ownership model): may
// the caller write this person, and is this person already on this bottle. Every other
// verdict arrives from a model that owns it — the label band for a dose (#4713/#5518),
// `allergenConflict` for an allergen hit (#153), `doseOnDay` for whether a dose is live
// — and every one of them becomes VISIBLE TEXT rather than a missing chip. Two earlier
// rounds failed by deriving clinical and identity verdicts here; the mechanisms that
// did are gone, not narrowed:
//
//   • ALLERGY IS NOT A GATE (owner ruling, 2026-09-09). No model in this app blocks a
//     write on allergy grounds, and neither candidate matcher's silence is clearance.
//     The chip stands; the copied row takes the ordinary warning path, and the receipt
//     NAMES every hit BOTH matchers return, composed and deduped (PM, 18:45 UTC): the
//     food/cross-reactivity one is the only thing that can say "shrimp, via krill" and
//     the only one a supplement reaches at all, and the drug one is the only one that
//     knows a penicillin allergy meets amoxicillin. Running one was half a check read
//     back as a whole one.
//   • THE DUPLICATE QUESTION IS NOT ASKED. #4717 owns product identity; a bottle has no
//     code column and none may be minted by scanning its membership, so the answer is
//     "unknown" for every bottle — which the receipt says UNCONDITIONALLY, rather than
//     withholding on a guess. "Already on this bottle" stays: that one is a fact about
//     membership.
//   • THE LIFE-STAGE GATE STAYS AND IS STATED. A curated adult-only product withholds
//     the chip for a child WITH ITS REASON ON SCREEN (#3067's one clinical gate); an
//     uncurated product is still offered dose-less, which is the same asymmetry the
//     dataset itself has.
//   • EVERY REFUSAL CARRIES A TYPED REASON. A gate and a race are different facts, and
//     "reload and try again" is the one instruction that cannot help someone whose
//     offer is deterministic rather than stale.
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

import { cadenceLabel, doseOnDay, type ItemCadence } from "./intake-cadence";
import {
  CONDITION_LABELS,
  TIME_BUCKET_LABELS,
  timeBucket,
} from "./intake-schedule";
import type { IntakeItemDoseSeed } from "./intake-item-create";
import {
  formulationDoseAmount,
  isChildProfileAge,
  pediatricDoseSuggestion,
  pediatricRefusalLine,
  type PediatricFormContext,
} from "./prn-dosing";
import {
  prnDefaultsFor,
  prnProductsNamedIn,
  type PrnDefaultEntry,
} from "./prn-defaults";
import { ingredientCuiKey } from "./medication-family";
import { allergenConflicts } from "./supplement-safety";
import { drugAllergyMatch, type DrugAllergySubstance } from "./drug-allergy";
import { normalizeAllergenSubstance } from "./allergen-vocabulary";
import type { AppRoute } from "./hrefs";
import type { IntakeCondition, IntakeObligation } from "./types";

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

// A strength compares on its digits and units, not its spacing or case: "200mg" and
// "200 MG" are the same box. Still needed after the duplicate question retired, because
// the offer's basis binds the BOTTLE's strength and a re-labelled bottle must refuse.
export function strengthKey(strength: string | null): string {
  return (strength ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[.,]$/, "");
}

// ---- The recipient's own dose ----------------------------------------------

// What amount, if any, this copy may write for THIS person — and why.
//   • `amount`   — a figure derived from the recipient's own facts, with the basis to
//                  state in the receipt.
//   • `none`     — no figure is derivable, so the item lands with ZERO dose rows and
//                  the reason is the receipt. Never a placeholder row with a blank
//                  amount: an untimed row would count as scheduled (#5285).
//   • `withheld` — the product's own life-stage gate refuses this person, so no chip is
//                  offered — and the reason is SAID on the card (owner ruling,
//                  2026-09-09 16:10 UTC). A withhold is never a silent absence.
export type AlsoForDose =
  | { kind: "amount"; amount: string; basis: string; ingredient: string }
  | { kind: "none"; reason: string }
  | { kind: "withheld"; reason: string };

const NO_LABEL_REASON = "set the amount on the new row";

// The label identity of the ROW THE COPY WILL CREATE — the bottle's name over the
// source row's own codes, which is `prnLabelIdentityFor`'s projection (#5518) and
// exactly what the created row will answer with the day after it lands.
//
// NOT a bottle-level identity: `shared_supplies` has no code column and none is minted
// by scanning the membership (#4717 owns that seam). The source's codes are bound in
// the offer's basis, so swapping the source or re-coding its row refuses the tap.
export interface AlsoForLabelIdentity {
  name: string;
  rxcui: string | null;
  rxcuiIngredients: string[] | null;
}

// ---- WHAT THE BOTTLE IS, before what it doses ------------------------------
//
// IDENTITY FIRST (#5230 ruling 11). A dose is derived from a product, so the question
// "which product is this" has to be answered — or refused — before any figure is
// reached for. Two independent readings can disagree: the bottle's NAME, which is what
// the household wrote on it, and the source member's stored CODE, which is what a
// scan or a prescription put on their row. The six states below are the whole of that
// disagreement, they are evaluated in order, and they are mutually exclusive.
//
//   A plural      the name lists two or more medicines. No single identity to dose.
//   B mismatch    one named product, one coded product, and they disagree.
//   C agreement   one named product, one coded product, the same one.
//   D coded-only  the name says nothing this app knows; the code does. The code wins.
//   E name-only   NO code is stored at all, and the name resolves. Unchanged behaviour.
//   F no-product  neither reading lands on a curated label. Nothing to dose from.
//
// THE DIVIDING PREDICATE IS "IS A CODE STORED", never "does the code resolve".
// `prnDefaultsFor` is code-first WITH a name fallback and `ingredientCuiKey` falls back
// to the raw rxcui, so ANY stored code at all suppresses the name fallback, resolvable
// or not: an uncoded bottle named `Aspirin` resolves and withholds for a child with the
// Reye's sentence, while the same bottle carrying an unrecognised code resolves to
// nothing and lands dose-less. Branching on "does it resolve" instead gets state F
// wrong in whichever direction the reader was leaning.
export type AlsoForIdentityState =
  | "plural"
  | "mismatch"
  | "agreement"
  | "coded-only"
  | "name-only"
  | "no-product";

export interface AlsoForIdentity {
  state: AlsoForIdentityState;
  // The curated products the NAME says this bottle is (#5230 ruling 9's detector).
  detected: readonly PrnDefaultEntry[];
  // The curated label a dose may derive from, or null when identity refuses to answer.
  // Null for `plural`, `mismatch` and `no-product` — the three dose-less states.
  product: PrnDefaultEntry | null;
  // What the source row's stored CODE resolves to, independent of the name. Only the
  // mismatch receipt reads it — it is the half of the disagreement the name did not say.
  coded: PrnDefaultEntry | null;
}

// A DISPUTED identity yields no verdict at all: no dose, and no life-stage gate either,
// because running the label's own age refusal against one of two disagreeing products
// answers about the wrong medicine. `plural` and `mismatch` are the two disputes.
export function alsoForIdentityDisputed(state: AlsoForIdentityState): boolean {
  return state === "plural" || state === "mismatch";
}

// #5230's precedence. Pure, and the ONE place the six states are decided — the dose,
// the receipt, the allergy composition and the decline key all read this answer rather
// than each re-deriving it from the name.
export function alsoForIdentity(label: AlsoForLabelIdentity): AlsoForIdentity {
  const item = {
    name: label.name,
    rxcui: label.rxcui,
    rxcuiIngredients: label.rxcuiIngredients,
  };
  const detected = prnProductsNamedIn(label.name);
  const resolved = prnDefaultsFor(item);
  const hasCode = ingredientCuiKey(item) != null;
  const codedProduct = hasCode ? resolved : null;
  const nameProduct = hasCode ? null : resolved;

  const coded = codedProduct;
  if (detected.length >= 2) {
    return { state: "plural", detected, product: null, coded };
  }
  if (detected.length === 1 && codedProduct) {
    return detected[0].slug === codedProduct.slug
      ? { state: "agreement", detected, product: codedProduct, coded }
      : { state: "mismatch", detected, product: null, coded };
  }
  if (codedProduct) {
    return { state: "coded-only", detected, product: codedProduct, coded };
  }
  if (nameProduct) {
    return { state: "name-only", detected, product: nameProduct, coded };
  }
  return { state: "no-product", detected, product: null, coded };
}

// The curated slugs a bottle's NAME detects — the identity half of the decline key
// (#5230). Derived server-side at BOTH the write and the read from the bottle's own
// name: one helper, or a decline is written under one tail and looked for under another
// and can never be read back. `alsoForOfferKey` owns the tail's ORDER and its spelling
// of the empty list.
export function alsoForDetectedSlugs(poolName: string): string[] {
  return prnProductsNamedIn(poolName).map((entry) => entry.slug);
}

// The recipient's dose from the LABEL, never from the bottle and never from the source
// member. The child path is the #798 weight band (#4713's canonical result and its own
// refusal reasons); the adult path is the label's low adult figure; a product with no
// curated label states nothing, which is a dose-less copy rather than a guess.
//
// IDENTITY IS ASKED FIRST (`alsoForIdentity`). Where the two readings of what this
// bottle is disagree, the answer is no figure AND no life-stage gate, with the receipt
// saying which check could not run — not a figure derived from whichever reading the
// resolver happened to prefer. The shipped resolver is code-first, so a bottle named
// `Tylenol Extra Strength` over an ibuprofen-coded row used to hand a six-year-old
// 200 mg of ibuprofen, and a child's Reye's refusal used to be quoted about a product
// nobody had named.
//
// Deliberately NOT `prnDoseBandStatement`: that wrapper describes an EXISTING row
// against its stored amount, which a brand-new item does not have.
export function resolveAlsoForDose(input: {
  label: AlsoForLabelIdentity;
  pediatric: PediatricFormContext | null;
  // Who the plan is being copied FROM, and what their own row calls the medicine. Only
  // the two refusals that have to name the disagreement read these.
  source?: { personName: string; itemName: string | null } | null;
}): AlsoForDose {
  const identity = alsoForIdentity(input.label);
  const sourceName = input.source?.personName ?? null;

  if (identity.state === "plural") {
    return {
      kind: "none",
      reason: `this bottle's name lists more than one medicine, ${NO_LABEL_REASON}`,
    };
  }
  if (identity.state === "mismatch") {
    const named = identity.detected[0].label;
    const whose = sourceName ? `${sourceName}'s item` : "the source's item";
    return {
      kind: "none",
      reason: `the bottle is named ${named} but ${whose} is ${identity.coded?.label ?? named}, ${NO_LABEL_REASON}`,
    };
  }
  const entry = identity.product;
  if (!entry) {
    const rowName = clean(input.source?.itemName ?? null);
    const whose = sourceName
      ? rowName
        ? `${sourceName}'s ${rowName}`
        : `${sourceName}'s row`
      : (rowName ?? "this bottle");
    return {
      kind: "none",
      reason: `no label dose for ${whose}, ${NO_LABEL_REASON}`,
    };
  }

  const pediatric = input.pediatric;
  const ageMonths = pediatric?.ageMonths ?? null;
  if (pediatric && ageMonths != null && isChildProfileAge(ageMonths)) {
    // The product's own life-stage gate — the ONE clinical gate this door keeps
    // (#3067). A curated label with NO pediatric chart is adult-only by the dataset's
    // own statement (aspirin — Reye's; naproxen; the age-dosed antihistamines), and the
    // adult figure is exactly what must not be handed to a child. The chip goes; the
    // sentence stays, which is the whole difference from the gate that just retired.
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
        ingredient: entry.label,
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
    ingredient: entry.label,
  };
}

// ---- Eligibility: the two facts this feature owns ---------------------------

// Everything the OFFER asks about one person — and it is two booleans, because two
// facts are all #5230 owns. Allergy, interactions, conditions and product identity are
// deliberately absent: they are statements other models own, and each of them reaches
// the person as text (the receipt) rather than as a missing chip.
//
// The dose is NOT here either: it depends on the SOURCE as well as the person (the
// label identity is the source row's codes under the bottle's name), so it is answered
// per person × source alongside that pair's basis.
export interface AlsoForCandidateFacts {
  profileId: number;
  name: string;
  // They already draw from this bottle.
  isMember: boolean;
  // The offer for this bottle was declined for them (the suppression bus).
  declined: boolean;
}

// WRITE ACCESS IS NOT A FIELD HERE, and that is deliberate. It was one, always passed
// `true` — a literal standing in for half the model, telling the next reader a gate
// exists where none does. The two real enforcements are the cabinet page, which narrows
// its candidates to the profiles the caller may WRITE, and `alsoForAction`, which runs
// `requireProfileWriteAccess(targetProfileId)` before the write core is reached. This
// module is auth-blind by the lib/ write-core convention, so it cannot be a third.
export function alsoForEligible(facts: AlsoForCandidateFacts): boolean {
  return !facts.isMember && !facts.declined;
}

// ---- The source member's schedule ------------------------------------------

// One source member's schedule, as the offer must state it before anyone taps: the
// action copies ONE person's plan, so the person names which. `doses` are the source's
// rows AS STORED — filtering them is a question about a DAY, and which day depends on
// which of the three questions below is being asked.
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

// ---- THREE QUESTIONS ABOUT A DOSE ROW, and three names -----------------------
//
// One predicate used to answer all three, and round two's receipt claimed a dose that
// would never come due because one answer was read as another. They differ in WHOSE DAY
// they are asked in and in what a yes MEANS:
//
//   1. `travellingDoseRows` — which rows travel with the copy, asked in the RECIPIENT's
//      day. A future taper step TRAVELS; a closed window is the source's own history.
//   2. `sourcePlanRows` — what the SOURCE's plan is, asked in the SOURCE's own day.
//      This is a statement about the source, which is the only reason the card may name
//      one schedule per bottle rather than one per reader.
//   3. `anyDoseLiveOn` — is a dose LIVE, which is `doseOnDay`'s question and nobody
//      else's. It is what the receipt may claim, and a future step is not a yes.

// A per-dose activation window that has already CLOSED on `day`.
function elapsedOn(row: AlsoForDoseRow, day: string): boolean {
  const end = clean(row.end_date);
  return !!end && end < day;
}

// (1) The rows a person joining on `recipientDay` inherits.
export function travellingDoseRows(
  doses: readonly AlsoForDoseRow[],
  recipientDay: string
): AlsoForDoseRow[] {
  return doses.filter((row) => !elapsedOn(row, recipientDay));
}

// (2) The source's own live plan on `sourceDay`, for the label that names it.
export function sourcePlanRows(
  doses: readonly AlsoForDoseRow[],
  sourceDay: string
): AlsoForDoseRow[] {
  return doses.filter((row) => !elapsedOn(row, sourceDay));
}

// (3) Whether any row the copy WROTE is live on `day` — the shared cadence model's
// question, asked of the shared cadence model.
export function anyDoseLiveOn(
  seeds: readonly IntakeItemDoseSeed[],
  day: string
): boolean {
  return seeds.some((seed) =>
    doseOnDay(
      {
        weekdays: seed.weekdays ?? null,
        start_date: seed.start_date ?? null,
        end_date: seed.end_date ?? null,
      },
      day
    )
  );
}

// The recipient's dose rows: the source's schedule, the recipient's amount.
//
// Dose-less means ZERO rows (see AlsoForDose). Elapsed per-dose windows are the
// source's history and are dropped; an already-open start is dropped with them, because
// for a person joining today the row is simply in force (see the module header).
export function alsoForDoseSeeds(
  doses: readonly AlsoForDoseRow[],
  dose: AlsoForDose,
  recipientDay: string
): IntakeItemDoseSeed[] {
  if (dose.kind !== "amount") return [];
  const seeds: IntakeItemDoseSeed[] = [];
  for (const row of travellingDoseRows(doses, recipientDay)) {
    const end = clean(row.end_date);
    const start = clean(row.start_date);
    seeds.push({
      amount: dose.amount,
      time_of_day: row.time_of_day,
      food_timing: row.food_timing,
      weekdays: row.weekdays,
      start_date: start && start > recipientDay ? start : null,
      end_date: end,
    });
  }
  return seeds;
}

// ---- What the copy actually wrote -------------------------------------------

// The receipt may only claim what the copy WROTE, and only what is live.
//   • `dose`    — an amount on at least one row that is due from today.
//   • `pending` — an amount written onto rows that have not started yet. A source whose
//                 only step begins next month copies that step, and the receipt must
//                 not say the recipient has a dose now.
//   • `none`    — no row carries an amount, so there is no dose at all.
export type AlsoForWritten =
  | { kind: "dose"; amount: string; basis: string; ingredient: string }
  | { kind: "pending"; amount: string; basis: string; ingredient: string }
  | { kind: "none"; reason: string };

export function alsoForWritten(
  dose: AlsoForDose,
  seeds: readonly IntakeItemDoseSeed[],
  recipientDay: string
): AlsoForWritten {
  if (dose.kind !== "amount") return { kind: "none", reason: dose.reason };
  // A derived amount with no row to carry it is not a dose: the item lands active with
  // nothing ever due, so a receipt naming the amount would state a schedule the person
  // does not have.
  if (seeds.length === 0) {
    return {
      kind: "none",
      reason: "the copied schedule has no dose times still in force",
    };
  }
  return {
    kind: anyDoseLiveOn(seeds, recipientDay) ? "dose" : "pending",
    amount: dose.amount,
    basis: dose.basis,
    ingredient: dose.ingredient,
  };
}

// ---- The offer's basis, so a stale tap refuses a NAMED thing -----------------

// What the person was looking at when they tapped, in NAMED PARTS. Re-derived under the
// write lock and compared part by part, so the refusal can say which fact moved. One
// opaque string meant a life-stage gate, a mid-flight product swap and a midnight
// crossing all came back as "reload and try again" — the one instruction that cannot
// help someone whose offer is deterministic rather than stale.
//
// IT BINDS EVERY FIELD THE COPY CARRIES, not just the ones on screen. The source's
// KIND, its RxNorm identity and its brand/product text are all written onto the
// recipient's row by an ordinary edit of the source between render and tap, and a basis
// blind to them would copy a warfarin's identity under the supplement the card named —
// and, because only a medication opens a course, skip the #5576 unknown-start guarantee
// on the way past.
//
// AND IT BINDS THE DAY, which is the RECIPIENT's (PM ruling, 2026-09-09): the rows are
// written into their schedule and judged every day after against their local day, so
// the source's day has no standing over it. Carried as DATA, so the two sides compare
// one value instead of each deriving its own — a source in UTC+13 and a target in UTC−7
// have two todays for most of the day, and round two's card offered a chip whose every
// tap refused forever because of it.
export interface AlsoForBasis {
  v: 1;
  sourceItemId: number;
  targetProfileId: number;
  // The RECIPIENT's local day the offer was computed in.
  day: string;
  // The BOTTLE's own facts. No code: a bottle has none, and none is derived from its
  // members (#4717).
  product: string;
  // Everything the copy carries off the SOURCE row.
  sourceIdentity: string;
  schedule: string;
  dose: string;
}

export function alsoForBasis(input: {
  pool: { name: string; strength: string | null };
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
  targetDay: string;
  dose: AlsoForDose;
}): AlsoForBasis {
  const { schedule, dose } = input;
  const rows = schedule.doses.map((d) =>
    [
      d.time_of_day ?? "",
      d.food_timing,
      d.weekdays ?? "",
      d.start_date ?? "",
      d.end_date ?? "",
    ].join("|")
  );
  return {
    v: 1,
    sourceItemId: input.sourceItemId,
    targetProfileId: input.targetProfileId,
    day: input.targetDay,
    product: [input.pool.name.trim(), strengthKey(input.pool.strength)].join(
      "~"
    ),
    sourceIdentity: [
      input.sourceIdentity.kind,
      input.sourceIdentity.rxcui ?? "",
      (input.sourceIdentity.rxcuiIngredients ?? []).join(","),
      input.sourceIdentity.brand ?? "",
      input.sourceIdentity.product ?? "",
    ].join("~"),
    schedule: [
      schedule.condition,
      schedule.obligation,
      schedule.situation ?? "",
      schedule.cadence_kind ?? "daily",
      schedule.cadence_weekdays ?? "",
      schedule.cadence_interval_days ?? "",
      schedule.cadence_anchor_date ?? "",
      rows.join(";"),
    ].join("~"),
    dose: [dose.kind, dose.kind === "amount" ? dose.amount : ""].join("~"),
  };
}

// The basis crosses the wire as one form field, so it travels as JSON and comes back
// through a parse that refuses anything that is not the shape above.
export function encodeAlsoForBasis(basis: AlsoForBasis): string {
  return JSON.stringify(basis);
}

export function decodeAlsoForBasis(raw: string): AlsoForBasis | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const b = parsed as Partial<AlsoForBasis>;
  if (
    b.v !== 1 ||
    typeof b.sourceItemId !== "number" ||
    typeof b.targetProfileId !== "number" ||
    typeof b.day !== "string" ||
    typeof b.product !== "string" ||
    typeof b.sourceIdentity !== "string" ||
    typeof b.schedule !== "string" ||
    typeof b.dose !== "string"
  ) {
    return null;
  }
  return b as AlsoForBasis;
}

// ---- Typed refusals ----------------------------------------------------------

// Why one tap did not land. A gate and a race are different facts, so they are
// different values — and the message each carries says whether tapping again can work.
export type AlsoForRefusal =
  // The posted offer could not be read at all: a forged or garbled post.
  | "no-offer"
  // The bottle is gone.
  | "no-bottle"
  // The named source is no longer a member the caller may copy.
  | "source-gone"
  // The recipient already draws from this bottle — which is also what makes a double
  // tap land exactly one item.
  | "already-member"
  // The offer was declined for this person.
  | "declined"
  // The RECIPIENT's local day rolled over between render and tap.
  | "day-rolled"
  // The bottle was renamed or re-labelled.
  | "product-changed"
  // The source's own row or schedule changed under the offer.
  | "source-changed"
  // The recipient's derivable dose changed (a new weight, a birthday).
  | "dose-changed"
  // The product's life-stage gate refuses this person (#3067).
  | "age-gated"
  // The item create refused; it carries its own message.
  | "create-failed";

// A refusal whose cause is that the world moved on from what was rendered. The action
// re-validates the cabinet for these, so the card re-reads a FRESH offer and the next
// tap works — which is why their messages say "tap again" and never "reload".
const REFRESHES: ReadonlySet<AlsoForRefusal> = new Set<AlsoForRefusal>([
  // A bottle that is gone, foreign, or unreachable is ONE reason with ONE message, and
  // it refreshes unconditionally. Refreshing only for a genuinely DELETED bottle would
  // make the refresh itself an oracle: "the card reloaded" would mean "that bottle
  // existed and you may not see it", which is the disclosure the single reason exists to
  // prevent. The card the person is looking at stops showing a bottle that is not there.
  "no-bottle",
  "source-gone",
  "already-member",
  "declined",
  "day-rolled",
  "product-changed",
  "source-changed",
  "dose-changed",
]);

export function alsoForRefusalRefreshes(reason: AlsoForRefusal): boolean {
  return REFRESHES.has(reason);
}

export function alsoForRefusalMessage(
  reason: AlsoForRefusal,
  name: string
): string {
  switch (reason) {
    case "no-offer":
      return "Couldn’t read that offer.";
    case "no-bottle":
      return "Couldn’t find that shared bottle. The card is up to date.";
    case "source-gone":
      return "That member no longer draws from this bottle. The card is up to date — pick a source again.";
    case "already-member":
      return `${name} already draws from this bottle.`;
    case "declined":
      return `This bottle was already declined for ${name}.`;
    case "day-rolled":
      return `It’s a new day for ${name}. The card is up to date — tap again.`;
    case "product-changed":
      return "This bottle changed. The card is up to date — tap again.";
    case "source-changed":
      return "That member’s plan changed. The card is up to date — tap again.";
    case "dose-changed":
      return `${name}’s dose works out differently now. The card is up to date — tap again.`;
    case "age-gated":
      return `This isn’t offered for ${name}.`;
    case "create-failed":
      return "Couldn’t add it.";
  }
}

// Which stated fact moved between render and tap, or null when the offer still stands.
// The day is asked first, because it is the one that changes on its own.
export function alsoForBasisRefusal(
  shown: AlsoForBasis,
  current: AlsoForBasis
): AlsoForRefusal | null {
  if (
    shown.sourceItemId !== current.sourceItemId ||
    shown.targetProfileId !== current.targetProfileId
  ) {
    return "no-offer";
  }
  if (shown.day !== current.day) return "day-rolled";
  if (shown.product !== current.product) return "product-changed";
  if (
    shown.sourceIdentity !== current.sourceIdentity ||
    shown.schedule !== current.schedule
  ) {
    return "source-changed";
  }
  if (shown.dose !== current.dose) return "dose-changed";
  return null;
}

// ---- The receipt -----------------------------------------------------------

// ---- The allergy composition ------------------------------------------------

// Every recorded allergy this bottle meets for this person — FOR THE RECEIPT, never for
// a gate (owner ruling, 2026-09-09) — as the UNION OF BOTH MATCHERS, deduplicated by
// allergen (PM ruling, 2026-09-09 18:45 UTC).
//
// NEITHER MATCHER ALONE IS THE CHECK, which is the whole reason this is a composition:
//
//   • `allergenConflicts` covers ingestibles and the #153 food cross-reactivity
//     families. It is the only thing in the repository that can answer "shrimp, via
//     krill", and a krill-oil supplement carries no RxCUI at all — so a code-only
//     composition deletes ruling 4's own case.
//   • `drugAllergyMatch` is the only one that knows a penicillin allergy meets
//     amoxicillin, or an aspirin allergy meets ibuprofen. It matches on the NAME too:
//     its ingredient tier is folded token containment, so it fires on an uncoded row.
//
// Both are fed the SAME label identity the dose reads — the bottle's name over the
// source row's codes. There is no code-only mode and no name-only mode.
//
// It does not run at all under a MISMATCH (ruling 11): with two disagreeing identities
// there is nothing single to check against, and the receipt says so instead. The caller
// owns that gate; this function answers the question it is asked.
export function alsoForAllergenNotes(input: {
  label: AlsoForLabelIdentity;
  // The recorded substances, as the food/cross-reactivity matcher takes them.
  allergens: readonly string[];
  // The SAME recorded allergies with their coded allergen, as the drug matcher takes
  // them. One gather builds both, so the two sides carry the same strings.
  records: readonly DrugAllergySubstance[];
}): AlsoForAllergenNote[] {
  const notes: AlsoForAllergenNote[] = [];
  // DIRECT HITS KEY ON THE CANONICAL SUBSTANCE — `normalizeAllergenSubstance` returns
  // "the form the safety cross-checks match on", which is exactly this question, so
  // "Penicillin" from the drug matcher and "Penicillin" from the food matcher are ONE
  // allergy. Keying the drug side on its allergy row id and the food side on the trigger
  // string does not dedupe at all: two key spaces that can never collide, and the person
  // reads their one penicillin allergy back twice in one line.
  const stated = new Set<string>();
  const stateDirect = (substance: string): void => {
    const key = normalizeAllergenSubstance(substance);
    if (stated.has(key)) return;
    stated.add(key);
    notes.push({ allergen: substance });
  };

  for (const record of input.records) {
    if (drugAllergyMatch(record, input.label)) stateDirect(record.substance);
  }
  const foodHits = allergenConflicts(input.label.name, input.allergens);
  for (const hit of foodHits) {
    if (!hit.triggers) stateDirect(hit.allergen);
  }
  // CROSS-REACTIVE HITS KEY ON THEIR UNJOINED TRIGGERS, never on the joined display
  // string: "Shrimp, Crab" is a pseudo-allergen no vocabulary knows and can never
  // compare equal to either half. A trigger a direct hit already stated drops out of the
  // clause, and a hit with nothing left says nothing at all.
  for (const hit of foodHits) {
    if (!hit.triggers) continue;
    const left = hit.triggers.filter(
      (t) => !stated.has(normalizeAllergenSubstance(t))
    );
    if (left.length === 0) continue;
    for (const t of left) stated.add(normalizeAllergenSubstance(t));
    notes.push({
      allergen: left.join(", "),
      viaCrossReactivity: hit.viaCrossReactivity,
    });
  }
  return notes;
}

// One recorded allergy this bottle meets, as the receipt states it.
export interface AlsoForAllergenNote {
  // The recorded substance, or for a cross-reactive hit the trigger(s) this receipt has
  // not already stated.
  allergen: string;
  // The family member the bottle carried, when the match was INDIRECT (#153).
  viaCrossReactivity?: string;
}

// The facts the copy could not check, or wants said. Each is TEXT ON A LINE, never a
// withheld chip — which is the whole of the 2026-09-09 model.
export interface AlsoForNotes {
  // EVERY recorded allergy this bottle meets, from BOTH matchers composed and deduped
  // (PM ruling, 2026-09-09 18:45 UTC) — the food/cross-reactivity matcher, which is the
  // only thing in the app that can say "shrimp, via krill" and the only one a supplement
  // reaches at all, and the drug-allergy matcher, which is the only one that knows a
  // penicillin allergy meets amoxicillin. Neither one's silence is clearance, so one
  // alone was half a check read back as a whole one. A LIST, because "N clauses" is what
  // a person with two recorded allergies on one bottle is owed.
  allergens: readonly AlsoForAllergenNote[];
  // What the two readings of this bottle said it is (§2 of #5230's precedence). The
  // receipt reads it for one thing: a DISPUTED identity has to say which check could not
  // run, because a plural or contradicted name means the life-stage gate — and, under a
  // mismatch, the allergy composition — was not asked at all (ruling 11).
  identity: AlsoForIdentityState;
}

export function alsoForReceipt(
  name: string,
  written: AlsoForWritten,
  notes: AlsoForNotes
): string {
  const parts: string[] = [];
  // THE DOSE CLAUSE NAMES THE INGREDIENT, always (ruling 10's third consequence). A
  // combination-style name that happens to detect exactly ONE curated product —
  // `Tylenol PM`, `Advil Cold & Sinus`, `Aleve-D` (each executed, each one hit) — is
  // invisible to the plural rule, so the figure is the LABEL's dose for that one
  // ingredient and not the bottle's. The receipt cannot tell those names from ordinary
  // ones, so it stops claiming the figure is the bottle's on every dose it states.
  if (written.kind === "dose") {
    parts.push(
      `Added for ${name} · ${written.amount} of ${written.ingredient} ${written.basis}`
    );
  } else if (written.kind === "pending") {
    parts.push(
      `Added for ${name} · ${written.amount} of ${written.ingredient} ${written.basis}, nothing due yet`
    );
  } else {
    parts.push(`Added for ${name} · no dose yet — ${written.reason}`);
  }
  // A WITHHOLD IS NEVER SILENT, and neither is a check that could not run (ruling 11).
  // Under a mismatch the allergy composition did not run either, so the same sentence
  // carries both halves rather than leaving the allergy half as an absence.
  if (alsoForIdentityDisputed(notes.identity)) {
    parts.push(
      notes.identity === "mismatch"
        ? `we couldn’t confirm what this bottle is, so we couldn’t check whether it’s for children or against ${name}’s allergies`
        : `we couldn’t confirm what this bottle is, so we couldn’t check whether it’s for children`
    );
  }
  for (const hit of notes.allergens) {
    parts.push(
      hit.viaCrossReactivity
        ? `${name} has a ${hit.allergen} allergy recorded, and this is ${hit.viaCrossReactivity}`
        : `${name} has a ${hit.allergen} allergy recorded`
    );
  }
  // UNCONDITIONAL. "Does this person already keep this product" cannot be asked at all:
  // a bottle carries no code column and none is derived from its membership (ruling 2;
  // #4717 owns that seam), so there is no state of the world in which this line is
  // wrong. It was a flag that could only ever be false — a literal standing in for a
  // check nobody can run — and silence here would read like a clean check.
  parts.push(`we couldn’t check whether ${name} already has this`);
  return parts.join(" · ");
}

// ---- The action's answer ----------------------------------------------------

// What one tap returns. `href` is the created member's own row — the receipt's edit
// door, and the only place a dose the copy could not derive is set. A refusal carries
// its TYPED reason beside the sentence, so a caller can tell a gate from a race.
export interface AlsoForResult {
  ok: boolean;
  error?: string;
  reason?: AlsoForRefusal;
  receipt?: string;
  href?: AppRoute;
}
