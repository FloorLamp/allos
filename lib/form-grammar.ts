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
// question. Twenty of the ids below name forms with no `*Form.tsx` file of their own
// (`MeasurementsQuickAdd`, `PracticeEditor`, `RoutineBuilder`, `InjuryBar`,
// `EndurancePlanBar`, the screening instrument views), and three `*Form.tsx` files are
// the login screen. The
// set that matters is the forms the app HOSTS, and the host
// can ask for the id itself: `components/AddEntryPanel.tsx` requires a `FormId`, so
// hosting implies registration and there is nothing to scan. A form mounted outside a
// host is #2774's convergence question rather than this registry's to catch — and it
// is also, exactly, the form this mechanism cannot see. The boundary section below
// says that out loud instead of leaving it to be discovered.
//
// HOW FAR THAT MECHANISM REACHES TODAY, stated so nobody reads it as universal: the
// nineteen forms `AddEntryPanel` hosts cannot compile without an id, and neither can a
// ninth log domain (`FORM_ID_OF_LOG_DOMAIN`, at the foot of this file). The forms the
// converged DIALOG host opens register BY DECLARATION — their entries are below, but
// nothing yet makes their mounts name one. `components/ModalShell.tsx` cannot carry the
// requirement as it stands: it hosts about fifteen surfaces that are not forms at all
// (the command palette, four share dialogs, the camera, the reconcile dialogs), and the
// amendment gave no vocabulary for those. #5787 closes it with a form-hosting variant of
// that host, and its acceptance includes correcting this paragraph — the boundary must
// never read wider here than it is in the code.
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
// A `fields` entry is not always an EXCLUSION. Some say the form should adopt and has
// not yet (`cycle`, `endurance-plan`, the #5302 family), and those say it in the reason
// rather than dressing a deferral as a ruling — a reason that reads settled when it is
// not is the failure mode this arm is most prone to.
//
// ── The boundaries, and WHICH ONE a missing form fell over ───────────────────
//
// `FormId` covers the app's ADD AND EDIT FORMS over a profile's records and its
// preferences. Two boundaries bound it and they are different in kind, so an id that
// is not here means two different things depending on which one it fell over.
//
// RULED. The three authentication forms under `app/(auth)` are outside it: they
// establish an identity rather than write anything a profile owns, they render no
// facts a person could disagree with before saving, and none of the six rules has
// anything to say to them. Absence there is a decision.
//
// DERIVED, and therefore NOT a census. This set was read off the two hosts' call
// sites and the log-domain door. Over those three the set is complete and the type
// keeps it complete. An INLINE-hosted form — one that renders `<form>` in its own
// surface with no host between — is reachable by none of them, so it is here only
// because somebody declared it, and absence there means UNREGISTERED, not excluded.
// The inline ids came from ONE sweep of `<form>` under `app/` and `components/`
// (#5790's review): four are grouped under "Inline-hosted" below, `crisis-resources`
// sits with the preference family it belongs to, and the mobility card's one-tap
// accept is argued inside `frequency-target` rather than given an id. That sweep does
// not run on every push, so this paragraph claims nothing about inline forms it did
// not look for.
//
// The two blind spots are mirror images, which is the part worth carrying back to
// #5300. The struck file scan saw FILES and missed hosts — it would have demanded
// three login screens and missed every form whose file is named for its surface. A
// host-derived set sees HOSTS and misses files. Only the type-enforced part is a
// guarantee, and it covers the three doors named above and nothing else. #5787 widens
// the enforced part by giving the dialog host a form-hosting variant; nothing on the
// table widens it over inline forms.
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
import type { ConditionFactKey } from "./condition-facts";
import type { AllergyFactKey } from "./allergy-facts";
import type { CarePlanFactKey } from "./care-plan-facts";
import type { CareGoalFactKey } from "./care-goal-facts";
import type { FamilyHistoryFactKey } from "./family-history-facts";
import type { SkinLesionFactKey } from "./skin-lesion-facts";
import type { DentalProcedureFactKey } from "./dental-procedure-facts";
import type { ProcedureFactKey } from "./procedure-facts";
import type { ImmunizationFactKey } from "./immunization-facts";
import type { ResultFactKey } from "./result-facts";
import type { ImagingStudyFactKey } from "./imaging-study-facts";
import type { GenomicVariantFactKey } from "./genomic-variant-facts";

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
  | "illness-episode"
  | "document-upload"
  | "food-suggestions"
  // ── Inline-hosted, declared rather than required (#5790 review) ────────────
  | "endurance-plan"
  | "provider"
  | "frequency-target"
  | "food-habit"
  // ── Settings and background (#5287) ────────────────────────────────────────
  | "profile"
  | "own-profile"
  | "format-prefs"
  | "unit-prefs"
  | "training-zones"
  | "protein-goal"
  | "free-days"
  | "dietary-preferences"
  | "recommendation-cadence"
  | "anxiety-scale"
  | "mental-health-privacy"
  | "smoking-history"
  | "risk-factors"
  | "crisis-resources";

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
 * reason and a tracker reference are both required by the type, so a declaration
 * always carries its argument and somewhere to read the rest of it. The reason says
 * whether it is an exclusion or an adoption not yet made; the type cannot tell them
 * apart, so the prose must.
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

// The settings family's shared argument. See the section that uses it.
const PREFERENCE =
  "An autosaving preference form: it has no Save, so there is no moment before the " +
  "write for a chip row to summarise, and every preference already holds a value so " +
  "no fact can be a missing essential.";

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
  // fields are discrete facts. #5302 rewrote the family onto the chip row a slice at
  // a time, and each adoption replaced its `fields` entry here with the fact keys it
  // then has. ALL TWELVE ARE NOW ADOPTED (slice 1: allergy, condition; slice 2:
  // family-history, care-plan, care-goal; slice 3: procedure, dental-procedure,
  // skin-lesion; slice 4: immunization, result, imaging-study, genomic-variant).
  // `audiogram` and `optical-prescription` are the two this family argues OUT rather
  // than defers, both on #3218's numeric-grid precondition failure — which is why the
  // thirteen of #5302's body are twelve here, and why slice 3 was three forms and not
  // four (PM ruling, 2026-09-11). The three `fields` entries still in this section are
  // ARGUMENTS rather than deferrals: two screening forms render an instrument's own
  // item list, and `visit` is a door that opens one of two forms which declare their
  // facts above.
  //
  // EACH ADOPTED FORM GETS ITS OWN FACTS MODULE rather than the thirteen sharing one
  // keyed union, and slice 1 argued it once so the other slices do not re-argue it.
  // `Record<K, FactRole>` demands a role for EVERY key of K: over a shared union of
  // roughly sixty keys each of the thirteen entries would have to classify the fifty-
  // odd facts it does not have, and a fact ADDED to one form would then already be a
  // known key here — which is exactly the staleness this arm exists to prevent. The
  // `appointment` entry above shows the cost at its smallest, with one borrowed key
  // (`diagnoses`) it never renders. Sharing also merges names that are not the same
  // question: a condition's `severity` is mild/moderate/severe for the problem, an
  // allergy's is the grade of one manifestation. The visit pair remains the shape a
  // shared module is FOR — two forms stating the same facts about the same thing.

  // app/(app)/records/problems/allergies/AllergyForm.tsx, ADOPTED (#5302 slice 1).
  // The two essentials are #5302's own for this form: a reaction and its grade. They
  // are two chips over ONE editor, because a peanut allergy that causes both hives and
  // anaphylaxis is two graded rows rather than one string (#1405).
  //
  // `status` is essential rather than optional for the reason `injury.status` is: the
  // select is born "active" and the action writes whatever it holds, so the fact can
  // never be absent and the more-line can never hold it. Calling it optional would say
  // the trailing affordance might, which is false.
  //
  // There is NO CODE FACT here, and the asymmetry with `condition` below is deliberate:
  // the allergy form renders no `substance_code` field and its actions parse none, so a
  // code chip would make the form post a field it has never posted — which #5302 rules
  // out. #5287's `allergy-code` gap stays in the data-quality model.
  allergy: facts<AllergyFactKey>({
    reaction: "essential",
    severity: "essential",
    criticality: "optional",
    verification: "optional",
    status: "essential",
    onset: "optional",
    provider: "optional",
    encounter: "optional",
    notes: "optional",
  }),

  // app/(app)/records/problems/conditions/ConditionForm.tsx, ADOPTED (#5302 slice 1)
  // and the family's pattern-setter. The name is rule 1's identifying field — a
  // Combobox over the curated ICD-10-CM names — and the code chip is seeded from it.
  //
  // `code` is essential because a code-less condition is the row the coded safety
  // screens cannot read (#5287's `condition-code` gap): the dashed prompt IS that gap's
  // sentence, said where it can be answered. `status` is essential on the same argument
  // as the allergy's above.
  condition: facts<ConditionFactKey>({
    code: "essential",
    status: "essential",
    onset: "optional",
    laterality: "optional",
    severity: "optional",
    stage: "optional",
    resolved: "optional",
    notes: "optional",
  }),
  // app/(app)/records/care/overview/FamilyHistoryForm.tsx, ADOPTED (#5302 slice 2).
  // The condition is rule 1's identifying field — the same curated ICD-10-CM Combobox
  // the condition form uses, and this form's required value — and the code chip is
  // seeded from it.
  //
  // `relation` is essential because it is the half of the assertion the reader cannot
  // infer: `familyRelativeLabel` falls back to a bare "Relative", which is the row
  // saying it cannot name whose history this is. A legibility reason, not a derivation
  // one — the risk classifier does not consult it today (#1039 Ask 5).
  //
  // `code` is essential on the condition form's reason at this address: the classifier
  // reads a family row code-FIRST with a name-substring fallback (#1030), so an
  // uncoded relative's condition reaches the screening cadence only if its spelling
  // happens to match a keyword stem.
  //
  // The three death columns are ONE fact (`death`) over one editor, read back through
  // `familyDeathLabel` — three chips would state one event three times. `relationship`
  // and `onsetAge` are optional because their absence is DEFINED rather than missing:
  // a NULL relation_type reads as genetic and a missing onset age activates the base
  // site factor and never a fabricated early onset.
  "family-history": facts<FamilyHistoryFactKey>({
    relation: "essential",
    code: "essential",
    relationship: "optional",
    lineage: "optional",
    onsetAge: "optional",
    death: "optional",
    notes: "optional",
  }),

  // app/(app)/records/care/overview/CarePlanForm.tsx, ADOPTED (#5302 slice 2). The
  // planned item is rule 1's identifying field.
  //
  // `planned` is the one essential, and it is the sharpest of the family's: an UNDATED
  // care-plan item never reaches Upcoming at all, because `carePlanUpcomingItems`
  // keeps only `planned_date != null` rows. A plan with no date is recorded and then
  // never mentioned again, so the dashed prompt is that omission's sentence.
  //
  // `status` is OPTIONAL here while `care-goal` below calls the same field essential,
  // and the asymmetry is the point: a care-plan item's absent status is READ
  // (`isCarePlanItemOpen(null)` is true, the safe direction) and the app ITSELF writes
  // the close — `markCarePlanItemDone` sets 'completed' from the Upcoming chip and the
  // completed-appointment offer. Prompting would ask for a value whose absence already
  // means the right thing.
  "care-plan": facts<CarePlanFactKey>({
    planned: "essential",
    category: "optional",
    status: "optional",
    code: "optional",
    provider: "optional",
    notes: "optional",
  }),

  // app/(app)/records/care/overview/CareGoalForm.tsx, ADOPTED (#5302 slice 2) and the
  // smallest of the thirteen. The goal statement is rule 1's identifying field.
  //
  // `status` is essential because NOTHING IN THE APP EVER WRITES A CARE GOAL'S STATUS
  // — the only writer of `care_goals.status` is this form's own action, unlike the
  // care-plan item above. `isCareGoalOpen` gives "achieved" a terminal meaning the
  // broader CarePlan vocabulary lacks, and an unstated status reads as open, so a goal
  // nobody states one for keeps presenting as live.
  //
  // `target` is essential because the goal's target date is the DATE WINDOW the
  // scheduled-appointment reflection matches within (#1355: HealthGoalsSection passes
  // it as `planned_date`, and `itemMatches` skips the window entirely when it is
  // null), so an undated goal matches on words alone at any distance in time.
  "care-goal": facts<CareGoalFactKey>({
    target: "essential",
    status: "essential",
    code: "optional",
    notes: "optional",
  }),
  // app/(app)/records/history/procedures/ProcedureForm.tsx, ADOPTED (#5302 slice 3)
  // and the smallest of the twelve after the care goal. The procedure name is rule 1's
  // identifying field — also the form's required value, and the field #1083's
  // preventive deep link arrives with prefilled.
  //
  // `code` is essential on the condition form's reason at the address where the reader
  // is the PREVENTIVE CLOCK: every procedure reaches
  // `getInferredPreventiveSatisfactions` as `{code, name, date, allow: ["screening"]}`
  // and `matchRuleKeys` reads the code against the concept map FIRST with a whole-word
  // name-synonym fallback, so a free-typed "lower endoscopy" satisfies colorectal
  // screening only if its spelling happens to hit a curated needle — and the person is
  // told they are overdue for the screening they just had.
  //
  // `date` is essential because `inferPreventiveSatisfactions` DROPS any record whose
  // date is not a real ISO day before the matcher ever sees it: an undated procedure
  // satisfies nothing however well it is coded.
  //
  // There is NO STATUS FACT, and the asymmetry with both specialty forms below is
  // deliberate: `procedures` has no status column and the action parses none, so a
  // status chip would make the form post a field it has never posted (the allergy
  // form's `substance_code` refusal at this address).
  procedure: facts<ProcedureFactKey>({
    code: "essential",
    date: "essential",
    provider: "optional",
    notes: "optional",
  }),

  // app/(app)/records/specialty/dental/DentalProcedureForm.tsx, ADOPTED (#5302 slice
  // 3). The procedure/finding name is rule 1's identifying field and the form's
  // required value.
  //
  // `cdt` is essential because the consumer is a SAFETY screen:
  // `isInvasiveDentalProcedure(name, cdt_code)` is the ONE gate
  // `getDentalSafetyWarnings` fires on, and #704's MRONJ / antibiotic-prophylaxis /
  // anticoagulant notes exist only behind it. It reads the code FIRST and falls back to
  // fourteen name patterns that are "deliberately conservative on the NON-invasive
  // side" so an unrecognized procedure returns false — a planned extraction typed "#17
  // exo" carries no note at all, while its D7xxx code would have caught it. The same
  // column is the preventive clock's code-first signal.
  //
  // `date` is essential because an undated record is dropped by BOTH readers:
  // `findResolvingDentalRecord` returns null on an undated source, so a "watch #14"
  // finding can never be closed by the re-exam that closes it, and
  // `inferPreventiveSatisfactions` skips it, so a logged cleaning never satisfies
  // `dental_cleaning`. `status` is essential on the same argument as the allergy's
  // above — born "completed", normalized on the server, so never absent — and it is
  // also the discriminator both engines gate on ('planned' triggers the safety check,
  // 'completed' is the preventive evidence).
  //
  // `tooth` is OPTIONAL, and the asymmetry with the skin form's `location` below is the
  // finding rather than an inconsistency. Both are "where on the body" and their
  // resolution matchers read absence in OPPOSITE directions: skin's `sameLesion` is
  // strict, so an omitted region splits one mole's track, while dental's `sameTooth`
  // returns true whenever either side is unspecified ("a general re-exam can resolve a
  // general finding"). An absent tooth is DEFINED, and a prophylaxis has none to name.
  // The tooth, its numbering system and the surface are ONE fact over one editor, read
  // back through `toothLabel`. `recheck` is optional because nothing reads the stored
  // `follow_up_interval_days` to schedule anything — `trackDentalFollowUp` takes its
  // interval from the list's own scheduler.
  "dental-procedure": facts<DentalProcedureFactKey>({
    date: "essential",
    status: "essential",
    cdt: "essential",
    tooth: "optional",
    recheck: "optional",
    finding: "optional",
    provider: "optional",
    notes: "optional",
  }),
  audiogram: fields(
    "A grid of thresholds per ear and frequency. Free numeric entry, so it fails the primitive's third precondition the way measurements does, and the family's rewrite is expected to argue it out rather than in.",
    "#3218"
  ),
  "optical-prescription": fields(
    "Sphere, cylinder, axis and add per eye — a numeric grid with the same precondition failure as the audiogram.",
    "#3218"
  ),
  // app/(app)/records/specialty/skin/SkinLesionForm.tsx, ADOPTED (#5302 slice 3). The
  // lesion's label is rule 1's identifying field.
  //
  // `location` is essential and it is the sharpest of the slice: the region and the
  // side are two of the three components of `skinLesionIdentityKey` (#482), the one
  // function every skin surface keys on, and `sameLesion` is STRICT on that tuple — so
  // a recheck recorded without the region never resolves the watch record that has one
  // and the mole's serial track silently splits in two. The form's own action already
  // treats it as load-bearing (`addSkinLesion` refuses a lesion with neither a label
  // nor a region), and when the label is the blank half `skinLesionDisplayLabel` falls
  // all the way to a bare "Skin lesion". The region and the side are ONE fact over one
  // editor, read back through `bodyMapLabel`.
  //
  // `observed` is essential because `findResolvingSkinRecord` returns null on its first
  // line for an undated source ("undated source can't order candidates") and skips
  // undated candidates, so an undated watch lesion can never be closed by the later
  // look that closes it. `status` is essential on the allergy form's argument — born
  // "active", normalized on the server, so never absent.
  //
  // `abcde` is OPTIONAL and that is the classification most likely to be got wrong
  // here: #715's scope law makes the five fields user-recorded OBSERVATIONS that are
  // never scored, so an empty set means "nothing noticed" — a complete answer, not an
  // omission — and a dashed prompt on every lesion would press for observations the app
  // has promised never to grade. Five checkboxes are ONE fact over one editor, read
  // back through `abcdeLetters`. `recheck` is optional for the dental form's reason:
  // nothing reads the stored `follow_up_interval_days`; `trackSkinFollowUp` takes its
  // interval from the list's own scheduler.
  "skin-lesion": facts<SkinLesionFactKey>({
    location: "essential",
    observed: "essential",
    status: "essential",
    size: "optional",
    abcde: "optional",
    recheck: "optional",
    finding: "optional",
    provider: "optional",
    visit: "optional",
    notes: "optional",
  }),
  // app/(app)/immunizations/ImmunizationForm.tsx, ADOPTED (#5302 slice 4). The vaccine
  // is rule 1's identifying field — the coded pick over the CVX catalog.
  //
  // `date` is the ONE essential, and both consumers drop an undated dose without saying
  // so anywhere: `buildImmunizationRecord` opens its gather with `if (!r.date) continue`
  // ("an undated dose can't be transcribed onto a form and can't be numbered"), so the
  // shot is absent from the printed record a school or travel clinic asked for; and
  // `assessSchedule`'s own gather skips it too, so it never reaches `datesByCode` and
  // the vaccine keeps reading `due` with the shot already given.
  //
  // `dose` is OPTIONAL at its own end rather than by contrast: `resolveDoseLabels`
  // numbers each dose within its vaccine's date-ordered sequence and only lets a
  // non-empty label win, so a blank field reads back as "Dose 2 of 4". `lot`, `route`
  // and `site` stay three chips rather than one grouped fact because no labeller reads
  // them back as one line — the printed record gives each its own column, and the skin
  // form's region-plus-side is one chip only because `bodyMapLabel` is the single
  // function every skin surface reads those two columns through.
  immunization: facts<ImmunizationFactKey>({
    date: "essential",
    dose: "optional",
    lot: "optional",
    route: "optional",
    site: "optional",
    reaction: "optional",
    provider: "optional",
    notes: "optional",
  }),
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
  // components/ResultForm.tsx, ADOPTED (#5302 slice 4) — the largest of the twelve. The
  // analyte name is rule 1's identifying field, and both actions already require it.
  //
  // THIS ENTRY'S PREDECESSOR WAS WRONG, and the correction is the finding worth keeping.
  // It named `fasting`, `specimen`, `result_status` and `flag` as this form's facts and
  // dismissed "the value, unit and reference range" as the least of what it asks for.
  // Read against the consumers it comes out nearly inverted, for one reason repeated
  // four times: each of those four has a module saying in its own words that ABSENCE IS
  // A REAL ANSWER — `normalizeResultStatus` refuses to invent 'final', `fasting` is a
  // tri-state whose null means "the source didn't say", the canonical vocabulary already
  // splits the analytes whose specimen changes the interpretation, and `addResult`
  // computes the flag itself on the next line (`reconcileFlags`). The READING's absence
  // is not an absence; it is a silent claim.
  //
  // `reading` is the value and its unit as ONE fact over one editor — the line
  // `revisionSummary` already prints. With no value `readingFromObservation` returns
  // null and the row joins no numeric series at all; with a NUMERIC value and no unit
  // `convertToCanonical` assumes the canonical unit (an mmol/L LDL judged against the
  // mg/dL band) or declines outright for a bare count-per-volume canonical, and
  // `reconciledFlag` returns undefined — "can't convert to the canonical unit — can't
  // judge". The unit is prompted for ONLY when the value is numeric, by the action's own
  // test: a qualitative "Reactive" has no unit to be missing.
  //
  // `date` is essential because both actions refuse a non-ISO day and `collapseReadings`
  // groups on it. `category` is essential because `reconcileFlags`'s QUALITATIVE pass is
  // gated `value_num IS NULL AND category = 'lab'`, so a "Reactive" filed elsewhere is
  // never classified — and because a blank select posts as 'lab' by server fallback.
  //
  // `panel`, `flag`, `provider` and `ordering` render only in EDIT mode, because
  // `addResult` parses none of them; the summary omits them on the add door rather than
  // let the trailing affordance name four editors that do not exist there. They keep
  // their roles here because the union is the form's, not the mode's.
  result: facts<ResultFactKey>({
    date: "essential",
    category: "essential",
    reading: "essential",
    canonical: "optional",
    reference: "optional",
    specimen: "optional",
    fasting: "optional",
    status: "optional",
    panel: "optional",
    flag: "optional",
    provider: "optional",
    ordering: "optional",
    notes: "optional",
  }),
  // app/(app)/results/imaging/ImagingStudyForm.tsx, ADOPTED (#5302 slice 4). The
  // MODALITY is rule 1's identifying field: the coded pick over `IMAGING_MODALITIES`,
  // what `studyDisplayLabel` leads with, and the key both consumers read first.
  //
  // `study_date` is the ONE essential, dropped by both: `cumulativeDose` skips an
  // undated study and `doseContributions` reports it under the named `no-date` exclusion
  // ("User-fixable"), and `findResolvingImagingStudy` returns null on its first line for
  // an undated source, so a nodule follow-up can never be closed by the scan that closes
  // it.
  //
  // `region` IS OPTIONAL, and the asymmetry with `skin-lesion.location` above is this
  // slice's sharpest — argued at THIS end rather than inherited. `sameLesion` compares a
  // STRICT region|side|label key, so an omitted region splits one mole's track;
  // `sameImagingKind` is modality-anchored and deliberately loose — "one side
  // unspecified → modality match suffices" — and bounds its looseness elsewhere instead
  // ("never cross-modality"). The dose card agrees: `resolveDoseEntry` falls back to the
  // modality's generic entry, which every modality but the unclassifiable `other` has,
  // so a region-less CT still contributes its estimate. `laterality` stays its OWN chip
  // rather than folding into the region, because imaging has no `bodyMapLabel` — nothing
  // but display reads the side, and `sameImagingKind` reads the region alone.
  //
  // `dose` is optional although this is the dose card's own record: `estimateStudyDose`
  // falls through to the curated typical estimate, which the field's helper text already
  // promises.
  "imaging-study": facts<ImagingStudyFactKey>({
    study_date: "essential",
    region: "optional",
    laterality: "optional",
    contrast: "optional",
    dose: "optional",
    indication: "optional",
    impression: "optional",
    status: "optional",
    ordering: "optional",
    radiologist: "optional",
    notes: "optional",
  }),
  // app/(app)/results/genomics/GenomicVariantForm.tsx, ADOPTED (#5302 slice 4) — the
  // last of the twelve. The GENE is rule 1's identifying field: the coded pick over
  // `PGX_GENE_SYMBOLS`, the form's own required value, and the column the cross-check
  // matches on an exact compare (#1676).
  //
  // `result_type` is essential and it is the ROUTER, not bookkeeping: `getPgxWarnings`
  // filters `result_type === "pharmacogenomic"` and `drivesHereditaryCadence` gates on
  // `"hereditary-risk"`, while the select is born `"other"` — the value
  // `normalizeResultType` says "routes to neither the PGx nor the cadence consumer". It
  // can never be blank, so it is ALWAYS stated (the allergy form's reading of a
  // born-with-a-value select).
  //
  // `call` is essential — star allele, genotype and zygosity as ONE fact over one
  // editor, read back through `variantCallLabel`. CPIC keys on phenotype, and with no
  // diplotype `derivedPhenotype` declines, `resolvePhenotype` returns null, and
  // `crossCheckPgx` skips every phenotype-keyed guidance row: a gene with nothing else
  // warns about no drug at all.
  //
  // `significance` IS OPTIONAL, and that is the one most likely to be got wrong here.
  // `drivesHereditaryCadence` tests the result type FIRST, so on the other four types —
  // including this form's default — the ACMG class reaches no consumer; and a
  // pharmacogenomic report states none, so a dashed prompt on every PGx row would press
  // for a fact the report does not make. `report_date` is optional for the asymmetry
  // with the other three forms in this slice: a genotype does not change, so no consumer
  // drops an undated variant — the column is read only by
  // `ORDER BY COALESCE(report_date, '')` and the search projection's day text.
  "genomic-variant": facts<GenomicVariantFactKey>({
    result_type: "essential",
    call: "essential",
    variant: "optional",
    significance: "optional",
    report_date: "optional",
    source_lab: "optional",
    interpretation: "optional",
    notes: "optional",
  }),

  // ── Everything else the hosts open ─────────────────────────────────────────

  // Re-derived from the form rather than from the record's shape (#5790 review). The
  // exclusion this entry used to carry does not survive that reading, and saying so is
  // the point of re-deriving it.
  cycle: fields(
    "NOT an exclusion. `CycleForm.tsx` renders four fields, not two dates: a required start, an optional end, an optional `flow` over the closed `FLOW_LEVELS` vocabulary, and an optional note. The coded vocabulary is the primitive's third precondition MET, and three optional facts against one essential is the exact split the chip row and its trailing more-line exist for. This is a pending adoption on the clinical family's terms — labelled fields today, and nothing here rules that it should stay that way.",
    "#3218"
  ),
  "tracked-substance": fields(
    "One name, which is the identifying field rule 1 already puts above the chips. There is no second fact for the row to hold.",
    "#5300"
  ),
  "substance-cap": fields("One weekly number. The form is the field.", "#5300"),
  "provider-affiliation": fields(
    "One field. The link's other end is DERIVED, not chosen — an individual affiliates with an organization and an organization with an individual, computed from the record the dialog hangs off and posted as a hidden value — so the person states nothing but the counterpart. The picker IS the whole form, and a chip row would open an editor onto the same combobox.",
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
  "document-upload": fields(
    "A file ingest, not a stated fact: the record it makes is dated by the DOCUMENT rather than by the day anyone filed it — the argument `LOG_DOMAIN_OF_LOGGABLE` already makes for the same domain.",
    "#4425"
  ),
  "food-suggestions": fields(
    "Submits a request and reports what came back. It adds no record of its own, so there is nothing for a chip row to state before saving.",
    "#5300"
  ),

  // ── Inline-hosted, declared rather than required ───────────────────────────
  //
  // These render `<form>` in their own surface with no host between, so nothing in
  // the type system reached them and the first derivation missed all of them. They
  // are here because #5790's review swept `<form>` under `app/` and `components/`.
  // Registering them does not make the sweep a mechanism: read the boundary section
  // at the head of this file before treating this list as complete.

  // app/(app)/training/EndurancePlanBar.tsx.
  "endurance-plan": fields(
    "NOT an exclusion — an unconverted CANDIDATE, said plainly because silence here would read as a ruling. The add form states an event kind over suggested words, an optional discipline over a closed three-value vocabulary, a name, a date and two targets: several independent facts, most of them optional, which is the shape the essential/optional split exists for. What it lacks is a facts module to import keys from, and building one is an adoption rather than a declaration. Registered so the next reader sees the candidacy instead of a gap.",
    "#3218"
  ),

  // app/(app)/providers/ProviderIdentityCard.tsx. Its sibling form on the same record
  // family, `provider-affiliation`, is above.
  provider: fields(
    "The provider's identity, edited in place: name, kind, NPI, identifier, specialty over the curated NUCC labels, phone, address. These are TRANSCRIBED off a card, a letterhead or a portal rather than stated by the person, so the chip row's question — which one of these do you disagree with before saving — has nothing to bite on. Seven fields is the right shape for seven transcriptions.",
    "#5300"
  ),

  // app/(app)/training/FrequencyTargets.tsx.
  "frequency-target": fields(
    "A scope and a count: which muscle region, body group, activity type or mobility region, and how many times a week. The two selects are one fact stated in two steps — the second's options are the first's — so a chip row would hold one chip and a number. The one-tap accepts that write the same record elsewhere (the mobility suggestions) post scope and count as hidden values with no field at all; those state nothing, so they are controls rather than forms and have no entry.",
    "#5300"
  ),

  // app/(app)/nutrition/WeeklyHabits.tsx, which writes the same `frequency_targets`
  // table under a `food_group` scope.
  "food-habit": fields(
    "The nutrition card's twin of the frequency target — a food group and a weekly count, into the same table. Two facts, one of them a number, on the same argument.",
    "#5300"
  ),

  // ── Settings and background ────────────────────────────────────────────────
  //
  // Family 4 of the census, and ONE argument covers all fourteen, so it is stated
  // once rather than paraphrased fourteen times. Each of these AUTOSAVES (they run
  // `useSaveStatus`, and several flush on hide), which is not an implementation
  // detail here: the chip row exists to show what a form is ABOUT TO WRITE so the
  // person can disagree with one fact before Save. A form with no Save has no before,
  // every preference always holds a value so there is no missing essential to prompt
  // for, and the row would restate a control the person is already looking at.
  //
  // What these forms DO owe this issue is rule 4: the why-it-matters copy they carry
  // (`ProfileForm` alone has nine helper lines) becomes the data-quality gap's
  // sentence. That adoption is #5287's, and it does not need fact keys.

  profile: fields(PREFERENCE, "#5287"),
  "own-profile": fields(PREFERENCE, "#5287"),
  "format-prefs": fields(PREFERENCE, "#5287"),
  "unit-prefs": fields(PREFERENCE, "#5287"),
  "training-zones": fields(PREFERENCE, "#5287"),
  "protein-goal": fields(PREFERENCE, "#5287"),
  "free-days": fields(PREFERENCE, "#5287"),
  "dietary-preferences": fields(PREFERENCE, "#5287"),
  "recommendation-cadence": fields(PREFERENCE, "#5287"),
  "anxiety-scale": fields(PREFERENCE, "#5287"),
  "mental-health-privacy": fields(PREFERENCE, "#5287"),
  "smoking-history": fields(PREFERENCE, "#5287"),
  "risk-factors": fields(PREFERENCE, "#5287"),
  // components/CrisisResourcesEditor.tsx, the fourteenth — inline-hosted, and missed
  // by the same derivation as the four above (#5790 review). Two mounts, and one of
  // them is the INSTANCE-wide default an admin sets rather than a profile's own
  // override; the argument holds for both, because neither has a Save.
  "crisis-resources": fields(PREFERENCE, "#5287"),
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
