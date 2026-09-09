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
//     NAMES a hit `allergenConflict` returns — which is the only place a supplement's
//     allergen can ever be said, because `getIntakeSafetyContext` screens medications
//     only and `crossCheckDrugAllergies` carries no food cross-reactivity.
//   • THE DUPLICATE QUESTION IS NOT ASKED. #4717 owns product identity; a bottle has no
//     code column and none may be minted by scanning its membership, so the answer is
//     "unknown" for every bottle — which the receipt says, rather than withholding on a
//     guess. "Already on this bottle" stays: that one is a fact about membership.
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
import { prnDefaultsFor } from "./prn-defaults";
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
  | { kind: "amount"; amount: string; basis: string }
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

// The recipient's dose from the LABEL, never from the bottle and never from the source
// member. The child path is the #798 weight band (#4713's canonical result and its own
// refusal reasons); the adult path is the label's low adult figure; a product with no
// curated label states nothing, which is a dose-less copy rather than a guess.
//
// Deliberately NOT `prnDoseBandStatement`: that wrapper describes an EXISTING row
// against its stored amount, which a brand-new item does not have.
export function resolveAlsoForDose(input: {
  label: AlsoForLabelIdentity;
  pediatric: PediatricFormContext | null;
}): AlsoForDose {
  const entry = prnDefaultsFor({
    name: input.label.name,
    rxcui: input.label.rxcui,
    rxcuiIngredients: input.label.rxcuiIngredients,
  });
  if (!entry) return { kind: "none", reason: NO_LABEL_REASON };

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
  | { kind: "dose"; amount: string; basis: string }
  | { kind: "pending"; amount: string; basis: string }
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
      return "Couldn’t find that shared bottle.";
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

// The facts the copy could not check, or wants said. Each is TEXT ON A LINE, never a
// withheld chip — which is the whole of the 2026-09-09 model.
export interface AlsoForNotes {
  // A recorded allergen the bottle's product matches (allergenConflict, #153). Stated
  // whatever the kind: `getIntakeSafetyContext` screens medications only, so for a
  // supplement this line is the only place in the app the hit can ever be said.
  allergen: { allergen: string; viaCrossReactivity?: string } | null;
  // Whether "does this person already keep this product" could be asked at all. Today
  // it never can — a bottle carries no code and none is derived from its members
  // (#4717) — so the receipt says so rather than letting silence read as "checked, no".
  productMatched: boolean;
}

export function alsoForReceipt(
  name: string,
  written: AlsoForWritten,
  notes: AlsoForNotes
): string {
  const parts: string[] = [];
  if (written.kind === "dose") {
    parts.push(`Added for ${name} · ${written.amount} ${written.basis}`);
  } else if (written.kind === "pending") {
    parts.push(
      `Added for ${name} · ${written.amount} ${written.basis}, nothing due yet`
    );
  } else {
    parts.push(`Added for ${name} · no dose yet — ${written.reason}`);
  }
  if (notes.allergen) {
    const hit = notes.allergen;
    parts.push(
      hit.viaCrossReactivity
        ? `${name} has a ${hit.allergen} allergy recorded, and this is ${hit.viaCrossReactivity}`
        : `${name} has a ${hit.allergen} allergy recorded`
    );
  }
  if (!notes.productMatched) {
    parts.push(`we couldn’t check whether ${name} already has this`);
  }
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
