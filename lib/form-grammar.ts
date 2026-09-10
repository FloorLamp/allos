// THE ONE FORM GRAMMAR, declared per form (#5300 rule 7).
//
// The app's add and edit forms share one grammar: one identifying field above the
// chips, the chip row as the only summary, an open chip that stays, no standing
// prose, one host, verb-plus-noun headings. This is where each form says which of
// those it renders — its FACTS, or an argued reason it states its data as FIELDS
// instead.
//
// ── Why a typed record rather than a scan (owner ruling, 2026-09-05) ─────────
//
// Rule 7 originally asked for a reflection test that listed every `*Form.tsx` under
// `app/` and `components/` and failed on one not registered. That clause is STRUCK.
// A file listing answers "is there a file whose name ends in Form" — which is not the
// question. `MeasurementsQuickAdd`, `PracticeEditor` and `RoutineBuilder` are forms
// with no `Form` in their names; `LoginForm` and `UploadForm` are not add/edit forms
// of a record at all. The set that matters is the forms the app HOSTS, and the host
// can ask for the id itself: `components/AddEntryPanel.tsx` requires a `FormId`, so
// hosting implies registration and there is nothing to scan. A form mounted outside a
// host is the defect #2774 already names, not this registry's job to catch.
//
// docs/change-policy.md states the general rule this follows: completeness belongs in
// a typed manifest that fails `tsc` on omission, not in a census test over `app/**`.
//
// ── What an entry means ──────────────────────────────────────────────────────
//
// `facts` — the form summarises itself in the shared chip row (#3218), and these are
// its fact keys, split the way the primitive splits them:
//
//   essential — the row states it, and renders a DASHED prompt when it is absent.
//               The form already knows it wants this one.
//   optional  — the row renders NOTHING when it is absent. It stays reachable through
//               the single trailing more-line, which names what it holds.
//
// The keys are each form's own `*FactKey` union, imported, so a key the form's facts
// module does not have fails `tsc` and a renamed fact cannot leave a stale entry here.
//
// `fields` — the form states its data as labelled fields, WITH THE ARGUMENT FOR IT and
// somewhere to read the rest. The shape is #4425's `Declared`: a reason and an
// `IssueRef` the type demands, so "excluded" can never be a bare boolean. Measurements
// is the exclusion rule 7 names first.
//
// PURE: every import is `import type`, erased at build, so a server component, a
// client form and a test all read this the same way.

import type { IssueRef, LogDomain } from "./log-manifest";
import type { IntakeFactKey } from "./intake-facts";
import type { ActivitySessionFactKey } from "./activity-session-facts";
import type { PartFactKey } from "./activity-part-facts";
import type { GoalFactKey } from "./goal-facts";
import type { ProtocolFactKey } from "./protocol-facts";
import type { VisitFactKey } from "./visit-facts";
import type { InjuryFactKey } from "./injury-facts";
import type { SleepFactKey } from "./sleep-facts";

// Every form the app hosts. A new form joins this union and then must answer the
// grammar below before it compiles; a host mount naming an id that is not here does
// not compile either.
export type FormId =
  // ── On the facts primitive (#3218) ─────────────────────────────────────────
  | "intake-item"
  | "activity-session"
  | "activity-part"
  | "goal"
  | "protocol"
  | "appointment"
  | "encounter"
  | "injury"
  | "sleep-mood"
  // ── The log domains' field forms (#4424) ───────────────────────────────────
  | "food-serving"
  | "historical-dose"
  | "practice-session"
  | "mood"
  | "symptom"
  | "stool"
  | "substance-entry"
  | "measurements"
  // ── The clinical record forms (#5302) ──────────────────────────────────────
  | "allergy"
  | "condition"
  | "family-history"
  | "care-plan"
  | "care-goal"
  | "procedure"
  | "dental-procedure"
  | "audiogram"
  | "optical-prescription"
  | "skin-lesion"
  | "immunization"
  | "mental-health-screening"
  | "substance-screening"
  | "visit"
  | "result"
  | "imaging-study"
  | "genomic-variant"
  // ── Everything else the hosts open ─────────────────────────────────────────
  | "cycle"
  | "tracked-substance"
  | "substance-cap"
  | "provider-affiliation"
  | "fitness-check"
  | "routine"
  | "practice"
  | "equipment"
  | "body-reading"
  | "progress-photo"
  | "sleep-retime"
  | "illness-episode";

/** What the chip row does with a fact when the person has not stated it. */
export type FactRole = "essential" | "optional";

/** A form that summarises itself in the shared chip row, and the facts it states. */
export interface FactsDeclaration {
  readonly kind: "facts";
  /** Stated, and dashed-prompted when absent. */
  readonly essential: readonly string[];
  /** Silent when absent; named by the trailing more-line. */
  readonly optional: readonly string[];
}

/**
 * A form that states its data as labelled fields, and why. The #4425 shape: the
 * reason and a tracker reference are both required by the type, so an exclusion
 * always carries its argument and somewhere to read the rest of it.
 */
export interface ArguedFields {
  readonly kind: "fields";
  readonly reason: string;
  readonly ref: IssueRef;
}

export type FormGrammar = FactsDeclaration | ArguedFields;

// Every fact the form has, classified — `Record<K, FactRole>` over the form's own
// `*FactKey` union, so a fact added to a form fails `tsc` here until this says what
// the row does with it, and a fact renamed or retired fails as an unknown key. That
// is the same enforcement `LogDomainManifest` gets from its columns (#4425), one
// level down: the declaration cannot go stale in the quiet direction.
const facts = <K extends string>(
  roles: Record<K, FactRole>
): FactsDeclaration => {
  const keys = Object.keys(roles) as K[];
  return {
    kind: "facts",
    essential: keys.filter((k) => roles[k] === "essential"),
    optional: keys.filter((k) => roles[k] === "optional"),
  };
};

const fields = (reason: string, ref: IssueRef): ArguedFields => ({
  kind: "fields",
  reason,
  ref,
});

export const FORM_GRAMMAR = {
  // ── On the facts primitive ─────────────────────────────────────────────────

  // components/IntakeItemForm.tsx. `timing` is optional because an as-needed item
  // with no confirmed ceiling has no schedule to state; a scheduled one always does.
  "intake-item": facts<IntakeFactKey>({
    dose: "essential",
    // An as-needed item with no confirmed ceiling has no schedule to state, so timing
    // reaches the more-line there; a scheduled item always states one.
    timing: "optional",
    importance: "essential",
    prescription: "essential",
    indication: "optional",
    identity: "optional",
    rxnorm: "essential",
    supply: "essential",
    stopDate: "optional",
    composition: "optional",
    purpose: "optional",
    notes: "optional",
  }),

  // components/ActivityForm.tsx states facts at TWO scopes, and they are two chip
  // rows with two key unions rather than one row with a mixed vocabulary: the session
  // (what the whole workout used) and each part (what one exercise did). `equipment`
  // is optional at the session — a ride with no bike on file is complete — and
  // essential at the part, where a bare variant base cannot be saved without one.
  "activity-session": facts<ActivitySessionFactKey>({ equipment: "optional" }),
  "activity-part": facts<PartFactKey>({
    equipment: "essential",
    sides: "optional",
    intent: "optional",
    effort: "optional",
  }),

  // app/(app)/training/GoalForm.tsx. The deadline is essential rather than optional
  // on purpose: a goal with no target date is invisible to pacing and to Upcoming.
  goal: facts<GoalFactKey>({
    subject: "essential",
    kind: "essential",
    target: "essential",
    equipment: "essential",
    deadline: "essential",
    startingFrom: "optional",
    title: "optional",
    category: "optional",
    notes: "optional",
  }),

  // app/(app)/protocols/ProtocolForm.tsx. Cadence is an essential of the PRACTICE,
  // so it is stated only once a practice is picked.
  protocol: facts<ProtocolFactKey>({
    practice: "essential",
    cadence: "essential",
    window: "essential",
    link: "optional",
    situation: "optional",
    notes: "optional",
  }),

  // app/(app)/encounters/AppointmentForm.tsx and EncounterForm.tsx read one facts
  // module. The one essential is the date: both writes reject a visit without one.
  // Only the encounter states diagnoses.
  appointment: facts<VisitFactKey>({
    when: "essential",
    provider: "optional",
    kind: "optional",
    reason: "optional",
    location: "optional",
    notes: "optional",
    // Stated by the encounter only; the appointment form has no diagnoses field, so
    // its chip is one the row never renders.
    diagnoses: "optional",
  }),
  encounter: facts<VisitFactKey>({
    when: "essential",
    provider: "optional",
    kind: "optional",
    reason: "optional",
    location: "optional",
    notes: "optional",
    diagnoses: "optional",
  }),

  // app/(app)/training/InjuryBar.tsx. The two essentials are the two the write
  // refuses without; the status is always stated because a new injury is born active.
  injury: facts<InjuryFactKey>({
    label: "essential",
    regions: "essential",
    // Always stated: a new injury is born active, and a default the form will write is
    // exactly the kind of fact the row exists to show before it is written.
    status: "essential",
    laterality: "optional",
    movements: "optional",
    exercises: "optional",
    loadFactor: "optional",
    reviewDate: "optional",
  }),

  // app/(app)/sleep/SleepMoodEditDialog.tsx. Nothing is optional: the night chip is
  // offered only where the date is editable, and the other two are what the dialog is.
  "sleep-mood": facts<SleepFactKey>({
    night: "essential",
    duration: "essential",
    mood: "essential",
  }),

  // ── The log domains' field forms ───────────────────────────────────────────

  "food-serving": fields(
    "A dated one-shot fact — one serving, and when it was eaten. The chip row exists to summarise several stated facts so the person can disagree with ONE of them; a form with a quantity and a time has nothing to summarise, and its adoption of this grammar is rules 4, 5 and 6 rather than rule 2.",
    "#4424"
  ),
  "historical-dose": fields(
    "The same dated one-shot shape as the food serving: which dose, and when it was taken. It states the two, and its adoption is the prose, host and heading rules.",
    "#4424"
  ),
  "practice-session": fields(
    "A dated one-shot fact with a duration. Its facts are the two fields it already renders.",
    "#4424"
  ),
  mood: fields(
    "A single rated value against a day. There is no second fact for a chip row to hold apart from it.",
    "#4424"
  ),
  symptom: fields(
    "A symptom is quick-logged against a day rather than declared as an entry, so the form is the severity and the day it belongs to.",
    "#4424"
  ),
  stool: fields(
    "One instrument reading — the Bristol Stool Form Scale type — against a day. The scale IS the closed vocabulary a chip would open an editor onto, and the form renders it directly.",
    "#4424"
  ),
  "substance-entry": fields(
    "An amount in the substance's own unit, against a day. One value and its time.",
    "#4424"
  ),
  // The exclusion rule 7 names first.
  measurements: fields(
    "Free numeric entry over a grid of measures fails the facts primitive's third precondition: no coded vocabulary pre-answers the fields, and every save states new numbers rather than confirming a derived one. A chip row would be a row of dashed prompts on every open.",
    "#3218"
  ),

  // ── The clinical record forms ──────────────────────────────────────────────
  //
  // Family 3 of the census. Each renders six to fifteen labelled fields with no
  // shared scaffold, and each MEETS the primitive's preconditions better than most —
  // a coded vocabulary pre-answers the fields, most saves are confirmations, the
  // fields are discrete facts. They are declared as fields because that is what they
  // render today; #5302 rewrites the family onto the chip row one form per PR, and
  // each adoption replaces its entry here with the fact keys it then has.

  allergy: fields(
    "Renders labelled fields; the allergen vocabulary that would pre-answer them arrives with the family's rewrite.",
    "#5302"
  ),
  condition: fields(
    "Renders labelled fields over the ICD-10 vocabulary; adopts the chip row with the family.",
    "#5302"
  ),
  "family-history": fields(
    "Renders labelled fields — relation, condition, age — and adopts the chip row with the family.",
    "#5302"
  ),
  "care-plan": fields(
    "Renders labelled fields; adopts the chip row with the family.",
    "#5302"
  ),
  "care-goal": fields(
    "Renders labelled fields; adopts the chip row with the family.",
    "#5302"
  ),
  procedure: fields(
    "Renders labelled fields over a coded procedure vocabulary; adopts the chip row with the family.",
    "#5302"
  ),
  "dental-procedure": fields(
    "Renders labelled fields over the dental procedure vocabulary; adopts the chip row with the family.",
    "#5302"
  ),
  audiogram: fields(
    "A grid of thresholds per ear and frequency. Free numeric entry, so it fails the primitive's third precondition the way measurements does, and the family's rewrite is expected to argue it out rather than in.",
    "#3218"
  ),
  "optical-prescription": fields(
    "Sphere, cylinder, axis and add per eye — a numeric grid with the same precondition failure as the audiogram.",
    "#3218"
  ),
  "skin-lesion": fields(
    "Renders labelled fields; adopts the chip row with the family.",
    "#5302"
  ),
  immunization: fields(
    "Renders labelled fields over the vaccine vocabulary; adopts the chip row with the family.",
    "#5302"
  ),
  "mental-health-screening": fields(
    "An instrument's own item list — PHQ-9, GAD-7 — rendered as the instrument states it. The questionnaire is not a summary of facts the person may disagree with one of; it is the instrument, and it renders whole.",
    "#5302"
  ),
  "substance-screening": fields(
    "An instrument's own item list, on the same argument as the mental-health screening.",
    "#5302"
  ),
  visit: fields(
    "The add door picks between an appointment and an encounter before either form exists, so the door itself states no facts. Both forms it opens declare theirs above.",
    "#5302"
  ),
  result: fields(
    "A lab result is a value, a unit and a reference range against a measured day — the analyte's definition supplies the rest. Its adoption is the prose, host and heading rules.",
    "#5302"
  ),
  "imaging-study": fields(
    "Renders labelled fields — modality, body site, date, findings; adopts the chip row with the family.",
    "#5302"
  ),
  "genomic-variant": fields(
    "Renders labelled fields over the gene and variant vocabularies; adopts the chip row with the family.",
    "#5302"
  ),

  // ── Everything else the hosts open ─────────────────────────────────────────

  cycle: fields(
    "Two dates that bound one period. A chip row over a start and an end would state the same span twice.",
    "#5300"
  ),
  "tracked-substance": fields(
    "One name, which is the identifying field rule 1 already puts above the chips. There is no second fact for the row to hold.",
    "#5300"
  ),
  "substance-cap": fields("One weekly number. The form is the field.", "#5300"),
  "provider-affiliation": fields(
    "A link between two records the person picks, plus its role. The picker IS the form; a chip row would open an editor onto the same combobox.",
    "#5300"
  ),
  "fitness-check": fields(
    "One measured entry per fitness definition — a number and its date. Free numeric entry, the measurements argument.",
    "#3218"
  ),
  routine: fields(
    "A builder over an ordered list of lifts, not a set of independent facts: the order and the grouping are the content, and a chip row cannot state a sequence.",
    "#5300"
  ),
  practice: fields(
    "A catalog entry — a name and its cadence. The name is rule 1's identifying field and the cadence is the only other fact.",
    "#5300"
  ),
  equipment: fields(
    "A catalog entry behind the shared catalog editor, whose grammar is #5237's list row and lifecycle control rather than this one.",
    "#5237"
  ),
  "body-reading": fields(
    "A correction to one reading: its value and its stated time. Free numeric entry, the measurements argument, on the same domain.",
    "#3218"
  ),
  "progress-photo": fields(
    "How an existing photo is filed — pose and date. The image itself never changes, so there is no fact set to summarise.",
    "#5300"
  ),
  "sleep-retime": fields(
    "Two clock times on one night, corrected together. The night's facts are the sleep dialog's, declared above; this surface only moves the boundaries.",
    "#5300"
  ),
  "illness-episode": fields(
    "An episode's lifecycle — its label and its open window. The episode's facts are its symptoms and doses, which live on their own rows.",
    "#5300"
  ),
} as const satisfies Record<FormId, FormGrammar>;

// The bridge between this registry and the log domains (#4425's own pattern, one
// level down). Without it "a log domain has a registered form" would be true only of
// the eight ids above, and a NINTH domain — added to `LOG_DOMAINS`, which is the list
// a new dated write core actually joins — could ship with no grammar declared at all.
// Its form is what the record's add door opens.
export const FORM_ID_OF_LOG_DOMAIN = {
  food: "food-serving",
  dose: "historical-dose",
  practice: "practice-session",
  mood: "mood",
  symptom: "symptom",
  stool: "stool",
  substance: "substance-entry",
  body: "measurements",
} as const satisfies Record<LogDomain, FormId>;
