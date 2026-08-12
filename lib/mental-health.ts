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

// The supported instruments. Kept as a runtime const array so the set is enumerable
// (dropdowns, the seed, and the exemption guard all read it).
export const INSTRUMENTS = ["PHQ-9", "GAD-7", "EPDS"] as const;
export type Instrument = (typeof INSTRUMENTS)[number];

export function isInstrument(v: unknown): v is Instrument {
  return (
    typeof v === "string" && (INSTRUMENTS as readonly string[]).includes(v)
  );
}

// One answerable option: the score it contributes and the published wording.
export interface InstrumentOption {
  value: number;
  label: string;
}

// The shared 4-point response scale PHQ-9 and GAD-7 use for every item ("Over the last
// 2 weeks, how often have you been bothered by …"). Value 0..3.
export const INSTRUMENT_OPTIONS: readonly InstrumentOption[] = [
  { value: 0, label: "Not at all" },
  { value: 1, label: "Several days" },
  { value: 2, label: "More than half the days" },
  { value: 3, label: "Nearly every day" },
];

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
  // The lead-in the published instrument prints above its items ("Over the last 2
  // weeks, how often have you been bothered by the following?"). Per instrument
  // because the recall window and the framing are part of the instrument, not chrome.
  prompt: string;
  // The public-domain item prompts (in order).
  items: readonly string[];
  // Per-item answer options, when the instrument does NOT use one shared scale for
  // every item. EPDS is the case that forces this: its options are worded per item AND
  // seven of its ten items are REVERSE-scored, so "which option is worth 3" is an
  // item-level fact. Omitted → every item answers on INSTRUMENT_OPTIONS. Read through
  // `instrumentItemOptions`, never directly, so no surface has to know which shape a
  // given instrument uses.
  itemOptions?: readonly (readonly InstrumentOption[])[];
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
  prompt:
    "Over the last 2 weeks, how often have you been bothered by the following?",
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
  prompt:
    "Over the last 2 weeks, how often have you been bothered by the following?",
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

// EPDS (Edinburgh Postnatal Depression Scale). Public domain: Cox JL, Holden JM,
// Sagovsky R, "Detection of postnatal depression: development of the 10-item Edinburgh
// Postnatal Depression Scale", Br J Psychiatry 1987;150:782-6. The authors permit
// reproduction provided the scale is quoted with their names, the title and the
// source, which is what this comment does.
//
// Two things about EPDS that PHQ-9 and GAD-7 do not have, and that this definition must
// get exactly right (#2321):
//
//   • ORIENTATION. Items 1, 2 and 4 are scored 0→3 down the printed list; items 3 and
//     5-10 are REVERSE-scored, 3→0. An inverted item is a silent, plausible-looking
//     scoring error — the total still lands in a band, it is just the wrong band — so
//     every item's orientation is unit-tested individually rather than as a total.
//   • SELF-HARM. Item 10 ("The thought of harming myself has occurred to me") plays
//     exactly the role PHQ-9 item 9 plays, so it is DECLARED below. Leaving
//     selfHarmItemIndex null would still import and still score, and a positive
//     self-harm answer on a non-severe total would silently fail to escalate.
//
// Bands are anchored on the two published cut-offs, ≥10 (possible depression) and ≥13
// (probable depression, the screen-positive threshold in the original validation), with
// ≥20 as the severe band perinatal guidance uses. Screening only, never a diagnosis.
const EPDS: InstrumentDef = {
  key: "EPDS",
  canonicalName: "EPDS",
  title: "EPDS",
  measures: "perinatal depression",
  prompt:
    "In the past 7 days — not just how you feel today — which answer comes closest to how you have felt?",
  items: [
    "I have been able to laugh and see the funny side of things",
    "I have looked forward with enjoyment to things",
    "I have blamed myself unnecessarily when things went wrong",
    "I have been anxious or worried for no good reason",
    "I have felt scared or panicky for no very good reason",
    "Things have been getting on top of me",
    "I have been so unhappy that I have had difficulty sleeping",
    "I have felt sad or miserable",
    "I have been so unhappy that I have been crying",
    "The thought of harming myself has occurred to me",
  ],
  // Printed order per item, with the published score each option carries. Items 1, 2
  // and 4 (indexes 0, 1, 3) run 0→3; the other seven run 3→0.
  itemOptions: [
    [
      { value: 0, label: "As much as I always could" },
      { value: 1, label: "Not quite so much now" },
      { value: 2, label: "Definitely not so much now" },
      { value: 3, label: "Not at all" },
    ],
    [
      { value: 0, label: "As much as I ever did" },
      { value: 1, label: "Rather less than I used to" },
      { value: 2, label: "Definitely less than I used to" },
      { value: 3, label: "Hardly at all" },
    ],
    [
      { value: 3, label: "Yes, most of the time" },
      { value: 2, label: "Yes, some of the time" },
      { value: 1, label: "Not very often" },
      { value: 0, label: "No, never" },
    ],
    [
      { value: 0, label: "No, not at all" },
      { value: 1, label: "Hardly ever" },
      { value: 2, label: "Yes, sometimes" },
      { value: 3, label: "Yes, very often" },
    ],
    [
      { value: 3, label: "Yes, quite a lot" },
      { value: 2, label: "Yes, sometimes" },
      { value: 1, label: "No, not much" },
      { value: 0, label: "No, not at all" },
    ],
    [
      {
        value: 3,
        label: "Yes, most of the time I haven't been able to cope at all",
      },
      {
        value: 2,
        label: "Yes, sometimes I haven't been coping as well as usual",
      },
      { value: 1, label: "No, most of the time I have coped quite well" },
      { value: 0, label: "No, I have been coping as well as ever" },
    ],
    [
      { value: 3, label: "Yes, most of the time" },
      { value: 2, label: "Yes, sometimes" },
      { value: 1, label: "Not very often" },
      { value: 0, label: "No, not at all" },
    ],
    [
      { value: 3, label: "Yes, most of the time" },
      { value: 2, label: "Yes, quite often" },
      { value: 1, label: "Not very often" },
      { value: 0, label: "No, not at all" },
    ],
    [
      { value: 3, label: "Yes, most of the time" },
      { value: 2, label: "Yes, quite often" },
      { value: 1, label: "Only occasionally" },
      { value: 0, label: "No, never" },
    ],
    [
      { value: 3, label: "Yes, quite often" },
      { value: 2, label: "Sometimes" },
      { value: 1, label: "Hardly ever" },
      { value: 0, label: "Never" },
    ],
  ],
  maxTotal: 30,
  satisfiesScreening: "depression_screening",
  bands: [
    { level: 0, label: "Minimal", min: 0, max: 9 },
    { level: 1, label: "Possible depression", min: 10, max: 12 },
    { level: 2, label: "Probable depression", min: 13, max: 19 },
    { level: 3, label: "Severe", min: 20, max: null },
  ],
  selfHarmItemIndex: 9,
};

const DEFS: Record<Instrument, InstrumentDef> = {
  "PHQ-9": PHQ9,
  "GAD-7": GAD7,
  EPDS: EPDS,
};

// The options ONE item answers on. The single place a surface asks — an instrument
// with one shared scale and one with per-item scales answer the same question here, so
// no caller has to know which kind it is holding.
export function instrumentItemOptions(
  instrument: Instrument,
  itemIndex: number
): readonly InstrumentOption[] {
  return DEFS[instrument].itemOptions?.[itemIndex] ?? INSTRUMENT_OPTIONS;
}

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
