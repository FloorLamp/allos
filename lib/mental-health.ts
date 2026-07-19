// Mental-health instrument definitions + severity banding (issue #716). PURE — no
// DB/network, client-safe, unit-tested in lib/__tests__/mental-health.test.ts.
//
// The app tracks validated mental-health screening instruments — PHQ-9 (depression),
// GAD-7 (anxiety) — as NUMERIC, SEVERITY-BANDED scores, the app's measurement DNA,
// NOT a subjective mood diary. A score is stored as a biomarker-shaped `medical_records`
// row (canonical_name "PHQ-9"/"GAD-7", value_num = total), so trending/flagging/series
// come for free from the observation substrate (#860/#944). This module holds the ONLY
// things no store carries: the instrument catalog (items + answer options, for in-app
// administration), the ONE pure severity-band function every surface keys on (#221 "one
// question, one computation"), and the crisis-escalation decision.
//
// SENSITIVITY (decided, #716 — these are LAW):
//   • NEVER gamify. No streaks, no milestones, no "improve your score" nudge, no
//     celebratory copy. This domain is exempt from the milestone/streak machinery.
//   • Informational, never diagnostic. A score is a SCREENING instrument, not a diagnosis.
//   • A SEVERE total (or a positive PHQ-9 item 9 — suicidal ideation — from in-app
//     administration) escalates to a NON-DISMISSIBLE crisis-resources line + a gentle
//     discuss-with-a-clinician note, care-tier on-screen (Upcoming + hero) for the
//     profile's OWN view — and NEVER a notification on any channel. The app informs
//     on-screen; it does not intervene or push.
//
// These instruments are public domain (PHQ-9, GAD-7), so the item wording lives here.

// The two supported instruments. Kept as a runtime const array so the set is enumerable
// (dropdowns, the seed, and the exemption guard all read it).
export const INSTRUMENTS = ["PHQ-9", "GAD-7"] as const;
export type Instrument = (typeof INSTRUMENTS)[number];

export function isInstrument(v: unknown): v is Instrument {
  return (
    typeof v === "string" && (INSTRUMENTS as readonly string[]).includes(v)
  );
}

// The shared 4-point response scale for both instruments ("Over the last 2 weeks, how
// often have you been bothered by …"). Value 0..3.
export const INSTRUMENT_OPTIONS = [
  { value: 0, label: "Not at all" },
  { value: 1, label: "Several days" },
  { value: 2, label: "More than half the days" },
  { value: 3, label: "Nearly every day" },
] as const;

// One ordinal severity band. `level` is a monotonic 0-based rank (higher = worse) so a
// surface can compare/sort without parsing labels; `label` is the published band name.
export interface SeverityBand {
  level: number;
  label: string;
  // Inclusive lower/upper total bounds for the band (upper null = open-ended top band).
  min: number;
  max: number | null;
}

export interface InstrumentDef {
  key: Instrument;
  // The canonical_name the score is stored under in medical_records (#482 one identity).
  canonicalName: string;
  // Human title + what it screens.
  title: string;
  measures: string;
  // The public-domain item prompts (in order). Answered on INSTRUMENT_OPTIONS (0..3).
  items: readonly string[];
  // The maximum possible total (items.length * 3), for the coverage/progress display.
  maxTotal: number;
  // The preventive screening this instrument's score satisfies (lib/datasets screenings).
  satisfiesScreening: string;
  // Published severity bands, ordered lowest→highest, contiguous, covering 0..maxTotal.
  bands: readonly SeverityBand[];
  // The 0-based index of the SELF-HARM / suicidal-ideation item, when the instrument has
  // one (PHQ-9 item 9). null for instruments without one (GAD-7). A NON-zero answer here
  // is the item-level escalation trigger (#716), regardless of the total.
  selfHarmItemIndex: number | null;
}

// PHQ-9 (Patient Health Questionnaire-9). Public domain (Spitzer/Williams/Kroenke, Pfizer).
const PHQ9: InstrumentDef = {
  key: "PHQ-9",
  canonicalName: "PHQ-9",
  title: "PHQ-9",
  measures: "depression",
  items: [
    "Little interest or pleasure in doing things",
    "Feeling down, depressed, or hopeless",
    "Trouble falling or staying asleep, or sleeping too much",
    "Feeling tired or having little energy",
    "Poor appetite or overeating",
    "Feeling bad about yourself — or that you are a failure or have let yourself or your family down",
    "Trouble concentrating on things, such as reading the newspaper or watching television",
    "Moving or speaking so slowly that other people could have noticed — or the opposite, being so fidgety or restless that you have been moving around a lot more than usual",
    "Thoughts that you would be better off dead, or of hurting yourself in some way",
  ],
  maxTotal: 27,
  satisfiesScreening: "depression_screening",
  bands: [
    { level: 0, label: "Minimal", min: 0, max: 4 },
    { level: 1, label: "Mild", min: 5, max: 9 },
    { level: 2, label: "Moderate", min: 10, max: 14 },
    { level: 3, label: "Moderately severe", min: 15, max: 19 },
    { level: 4, label: "Severe", min: 20, max: null },
  ],
  selfHarmItemIndex: 8,
};

// GAD-7 (Generalized Anxiety Disorder-7). Public domain (Spitzer/Kroenke/Williams/Löwe).
const GAD7: InstrumentDef = {
  key: "GAD-7",
  canonicalName: "GAD-7",
  title: "GAD-7",
  measures: "anxiety",
  items: [
    "Feeling nervous, anxious, or on edge",
    "Not being able to stop or control worrying",
    "Worrying too much about different things",
    "Trouble relaxing",
    "Being so restless that it is hard to sit still",
    "Becoming easily annoyed or irritable",
    "Feeling afraid, as if something awful might happen",
  ],
  maxTotal: 21,
  satisfiesScreening: "anxiety_screening",
  bands: [
    { level: 0, label: "Minimal", min: 0, max: 4 },
    { level: 1, label: "Mild", min: 5, max: 9 },
    { level: 2, label: "Moderate", min: 10, max: 14 },
    { level: 3, label: "Severe", min: 15, max: null },
  ],
  selfHarmItemIndex: null,
};

const DEFS: Record<Instrument, InstrumentDef> = {
  "PHQ-9": PHQ9,
  "GAD-7": GAD7,
};

export function instrumentDef(instrument: Instrument): InstrumentDef {
  return DEFS[instrument];
}

export function allInstrumentDefs(): readonly InstrumentDef[] {
  return INSTRUMENTS.map((k) => DEFS[k]);
}

// The canonical_name → instrument lookup, for reading a stored biomarker record back as an
// instrument score (#482: the canonical_name IS the instrument identity).
export function instrumentForCanonicalName(
  name: string | null | undefined
): Instrument | null {
  if (!name) return null;
  const norm = name.trim().toLowerCase();
  for (const def of allInstrumentDefs()) {
    if (def.canonicalName.toLowerCase() === norm) return def.key;
  }
  return null;
}

// The severity band a total falls in. Clamps out-of-range totals to the nearest band
// (a negative to the lowest, an over-max to the highest) so a bad extraction never throws.
export function severityBand(
  instrument: Instrument,
  total: number
): SeverityBand {
  const def = DEFS[instrument];
  const t = Math.round(total);
  for (const b of def.bands) {
    if (t >= b.min && (b.max == null || t <= b.max)) return b;
  }
  // Below the first band's min (negative) → lowest; above the last → highest.
  return t < def.bands[0].min ? def.bands[0] : def.bands[def.bands.length - 1];
}

// Whether a total sits in the instrument's TOP (most severe) band.
export function isSevereTotal(instrument: Instrument, total: number): boolean {
  const def = DEFS[instrument];
  return (
    severityBand(instrument, total).level ===
    def.bands[def.bands.length - 1].level
  );
}

// Whether the item-level answers show a POSITIVE self-harm item (PHQ-9 item 9 answered
// above 0). `answersByIndex` maps 0-based item index → answer (0..3); a missing item
// (outside/total-only score) reads as absent, so this degrades to false — the escalation
// then rests on the total alone (isSevereTotal). GAD-7 has no self-harm item → always false.
export function selfHarmPositive(
  instrument: Instrument,
  answersByIndex: Record<number, number> | ReadonlyMap<number, number>
): boolean {
  const idx = DEFS[instrument].selfHarmItemIndex;
  if (idx == null) return false;
  const a =
    answersByIndex instanceof Map
      ? answersByIndex.get(idx)
      : (answersByIndex as Record<number, number>)[idx];
  return typeof a === "number" && a > 0;
}

// The ONE crisis-escalation decision (#716). A score escalates when its total is SEVERE
// or its self-harm item is positive. `escalate` drives the non-dismissible crisis line +
// the care-tier finding; NEVER a notification (enforced separately in the notify tick).
export interface CrisisDecision {
  escalate: boolean;
  // Which trigger(s) fired — for the finding's evidence line (no diagnosis, just the fact).
  severe: boolean;
  selfHarm: boolean;
}

export function crisisDecision(
  instrument: Instrument,
  total: number,
  answersByIndex: Record<number, number> | ReadonlyMap<number, number> = {}
): CrisisDecision {
  const severe = isSevereTotal(instrument, total);
  const selfHarm = selfHarmPositive(instrument, answersByIndex);
  return { escalate: severe || selfHarm, severe, selfHarm };
}

// The dedupeKey namespace the mental-health CARE finding keys under (registered in
// lib/rule-finding-prefixes.ts; the #448 reflection guard enforces it). The crisis
// finding is NON-DISMISSIBLE (safety-ungated), so its key is not written to the bus by a
// dismiss — but it still carries a stable prefix so the registry/guards recognize it.
export const MENTAL_HEALTH_PREFIX = "mental-health:";

// The crisis finding's dedupeKey, RE-KEYED by the record date (#203/#482 discipline): a
// newer score is a distinct signal, so the key follows the latest reading.
export function mentalHealthCrisisKey(
  instrument: Instrument,
  dateISO: string
): string {
  return `${MENTAL_HEALTH_PREFIX}crisis:${instrument}:${dateISO}`;
}

// The crisis-resources copy is no longer a hardcoded constant here (it used to name a
// US-only 988 line). The resource list is now OPERATOR-CONFIGURED (issue #996) — see
// lib/crisis-resources.ts for the pure formatting (crisisFindingLine) and
// lib/settings/crisis.ts for the global + per-profile resolution — so a self-hosted
// instance shows its own region's line, or a neutral "contact local emergency
// services" fallback when unconfigured, never a fabricated number.
