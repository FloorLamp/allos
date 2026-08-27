// Substance-use screening instruments + consumption/reduction-target logic (issue
// #998). PURE — no DB/network, client-safe, unit-tested in
// lib/__tests__/substance-use.test.ts. The #716 mental-health instrument pattern
// re-instantiated for behavioral health's other half: screen → track → support
// reduction, with the SAME no-gamification contract.
//
// INSTRUMENT LICENSING (determined per instrument — reviewed by the repo owner;
// the #716 rule is that FULL ITEM TEXT is baked only when reproduction is clearly
// permitted, while scoring thresholds and severity bands are uncopyrightable facts
// and are always baked):
//   • AUDIT-C (3 items) — IN-APP administration with baked item text. Developed by
//     Bush, Kivlahan, McDonell, Fihn & Bradley (Arch Intern Med 1998) within the US
//     Department of Veterans Affairs ACQUIP study; the VA and US federal health
//     agencies (e.g. HIV.gov, CDC) state and treat the AUDIT-C as available for use
//     in the public domain, and distribute the item text freely without a licensing
//     step. Confidence: high → item text baked, with citation.
//   • AUDIT (full 10-item, WHO) — TOTAL-SCORE ENTRY ONLY, no item text. The WHO
//     AUDIT manual (Babor et al., WHO/MSD/MSB/01.6a) permits reproduction for
//     non-commercial clinical/educational use, but that grant is narrower than this
//     repo's redistribution surface (self-hosted, license-unconstrained deploys), so
//     the CONSERVATIVE path applies: the app records an outside-administered total
//     (0–40) and bakes only the WHO risk-zone thresholds (facts).
//   • DAST-10 — IN-APP administration with baked item text (#1085, a deliberate
//     REVERSAL of the #998 total-only determination by repo-owner decision). Item
//     text © 1982 Harvey A. Skinner / CAMH; the owner-recorded permission basis is
//     CAMH's standing grant of clinical/educational reproduction with attribution
//     (recorded in the citation below per #1085). Outside total entry keeps working
//     unchanged — an imported/outside total and an in-app administration land in the
//     SAME canonical_name series.
//
// NEUTRAL OBSERVATION (decided, #3279 ruling 1 — the doctrine this file now leads with):
//   Substance consumption is data like food or mood. The LEDGER is the subject; the
//   screening instruments above and the weekly reduction cap below are OPT-IN TOOLS a
//   person reaches for, never the page's default framing. This is #2380's
//   "an observation, never a target" applied to the one domain that never got it.
//
//   THE BOUNDARY, AND IT IS STRUCTURAL RATHER THAN COSMETIC. There is no cap-shaped
//   value to render unless a target row exists: substanceCapStatus() is the only
//   producer of a SubstanceCapStatus, capProgressLine() is the only consumer, and
//   lib/queries/substance.ts calls the former ONLY when getSubstanceTarget() returned a
//   row (`status: target ? … : null`). A surface therefore cannot render cap framing for
//   a profile that never opted in — not because it remembers to check a flag, but
//   because it holds nothing to render. Keep it that way: a helper that manufactures a
//   status from a count and a default cap would make the opt-in cosmetic again.
//
//   `cap: 0` IS NOT "NO CAP". A zero cap is an OPTED-IN target — a substance-free week
//   ("Dry January", a quit target) — and it renders its own line. The absence of a
//   target is a DIFFERENT state and renders nothing at all. Every reader that has ever
//   conflated the two has produced reduction framing for someone who asked for none;
//   the two states are `status === null` vs `status.cap === 0`.
//
// SENSITIVITY (decided, #998 — these are LAW):
//   • NEVER gamify. No streaks, no badges, no "X days sober" milestones, no
//     celebratory copy. Reduction support is a user-set target + progress toward it
//     + a calm coaching observation — a harm-reduction tracker, not a chip-counter.
//     The write paths never touch `activities`, so the milestone/streak machinery is
//     structurally blind to this domain (the #716 exemption-by-construction, pinned
//     by lib/__db_tests__/substance-use.test.ts).
//   • Non-judgmental, informational framing: "what your intake is", never "you
//     drink too much". Absence of a flag is not clearance. Not a diagnosis.
//   • A severe AUDIT/AUDIT-C/DAST score gets the calm "worth discussing with a
//     clinician" note the other instruments carry — it is NOT wired to the crisis
//     surface (#996 is explicit/item-9 only) and NEVER a notification.
//   • Private by default: standard per-profile grants; the only cross-surface reach
//     is the coaching tier (#449 — hideable rollup, never a push, never the hero).

import type { SeverityBand } from "./mental-health";
import { matchFoldedVocabulary } from "./vocabulary-fold";

// ---- Screening instruments -------------------------------------------------

export const SUBSTANCE_INSTRUMENTS = ["AUDIT-C", "AUDIT", "DAST-10"] as const;
export type SubstanceInstrument = (typeof SUBSTANCE_INSTRUMENTS)[number];

export function isSubstanceInstrument(v: unknown): v is SubstanceInstrument {
  return (
    typeof v === "string" &&
    (SUBSTANCE_INSTRUMENTS as readonly string[]).includes(v)
  );
}

// One in-app item: its prompt plus its OWN answer options. Unlike PHQ-9/GAD-7
// (one shared 0..3 scale), the AUDIT-C items each carry distinct 0..4 option labels,
// so options ride per-item.
export interface SubstanceInstrumentItem {
  prompt: string;
  options: readonly { value: number; label: string }[];
}

// A yes/no item scored 0/1 (DAST-10). The reverse-scored item is encoded purely by
// FLIPPING the option values — the scorer just sums chosen option values (same as
// AUDIT-C), so no special reverse-score logic exists anywhere (#1085).
const YES_NO: readonly { value: number; label: string }[] = [
  { value: 1, label: "Yes" },
  { value: 0, label: "No" },
];
const YES_NO_REVERSED: readonly { value: number; label: string }[] = [
  { value: 0, label: "Yes" },
  { value: 1, label: "No" },
];

export interface SubstanceInstrumentDef {
  key: SubstanceInstrument;
  // The canonical_name the score is stored under in medical_records (#482 one
  // identity) — the observation substrate, same as PHQ-9/GAD-7.
  canonicalName: string;
  title: string;
  measures: string;
  // How the score is captured: "in-app" ships baked item text (licensing above);
  // "total-only" records an outside-administered total with NO reproduced items.
  entry: "in-app" | "total-only";
  // The baked items (in-app instruments only; empty for total-only).
  items: readonly SubstanceInstrumentItem[];
  // Instrument-level instructions shown above the items when administering in-app
  // (the DAST-10's past-12-months / "drug abuse" framing is part of the validated
  // instrument, so it travels with the item text).
  instructions?: string;
  maxTotal: number;
  // The preventive screening this instrument's score satisfies (screenings dataset).
  satisfiesScreening: string;
  // Published severity bands, ordered lowest→highest, contiguous over 0..maxTotal.
  bands: readonly SeverityBand[];
  // The band LEVEL from which the calm "worth discussing with a clinician" note
  // shows. Never a crisis trigger, never a notification.
  discussBandLevel: number;
  // Plain-language source line for the bands/thresholds (facts, always shown).
  citation: string;
}

// AUDIT-C — alcohol screen, items 1–3 of the AUDIT. Public domain (see header).
// Bands follow the published UK Public Health England / NHS AUDIT-C banding
// (0–4 lower risk, 5–7 increasing, 8–10 higher, 11–12 possible dependence). The
// commonly used positive-screen thresholds differ by sex (≥3 women / ≥4 men); that
// nuance stays in UI copy, not the band table (bands are sex-independent facts).
const AUDIT_C: SubstanceInstrumentDef = {
  key: "AUDIT-C",
  canonicalName: "AUDIT-C",
  title: "AUDIT-C",
  measures: "alcohol use",
  entry: "in-app",
  items: [
    {
      prompt: "How often do you have a drink containing alcohol?",
      options: [
        { value: 0, label: "Never" },
        { value: 1, label: "Monthly or less" },
        { value: 2, label: "2–4 times a month" },
        { value: 3, label: "2–3 times a week" },
        { value: 4, label: "4 or more times a week" },
      ],
    },
    {
      prompt:
        "How many standard drinks containing alcohol do you have on a typical day when you are drinking?",
      options: [
        { value: 0, label: "1 or 2" },
        { value: 1, label: "3 or 4" },
        { value: 2, label: "5 or 6" },
        { value: 3, label: "7 to 9" },
        { value: 4, label: "10 or more" },
      ],
    },
    {
      prompt: "How often do you have six or more drinks on one occasion?",
      options: [
        { value: 0, label: "Never" },
        { value: 1, label: "Less than monthly" },
        { value: 2, label: "Monthly" },
        { value: 3, label: "Weekly" },
        { value: 4, label: "Daily or almost daily" },
      ],
    },
  ],
  maxTotal: 12,
  satisfiesScreening: "alcohol_screening",
  bands: [
    { level: 0, label: "Lower risk", min: 0, max: 4 },
    { level: 1, label: "Increasing risk", min: 5, max: 7 },
    { level: 2, label: "Higher risk", min: 8, max: 10 },
    { level: 3, label: "Possible dependence", min: 11, max: null },
  ],
  discussBandLevel: 2,
  citation:
    "Bush et al. 1998 (VA ACQIP); bands per the published UK PHE/NHS AUDIT-C scoring.",
};

// AUDIT — the full WHO 10-item alcohol screen. Total-only (see header). Bands are
// the WHO manual's risk zones (facts).
const AUDIT: SubstanceInstrumentDef = {
  key: "AUDIT",
  canonicalName: "AUDIT",
  title: "AUDIT",
  measures: "alcohol use",
  entry: "total-only",
  items: [],
  maxTotal: 40,
  satisfiesScreening: "alcohol_screening",
  bands: [
    { level: 0, label: "Lower risk", min: 0, max: 7 },
    { level: 1, label: "Increasing risk", min: 8, max: 15 },
    { level: 2, label: "Higher risk", min: 16, max: 19 },
    { level: 3, label: "Possible dependence", min: 20, max: null },
  ],
  discussBandLevel: 2,
  citation:
    "WHO AUDIT manual (Babor et al.), risk zones I–IV. Item text is not reproduced in-app.",
};

// DAST-10 — general drug-use screen (past 12 months, non-alcohol). IN-APP since
// #1085 (see the licensing header): ten yes/no items scored 0/1, one point per
// drug-use-indicating answer. Item 3 ("Are you always able to stop…") is the ONE
// reverse-scored item — "No" earns the point — encoded by flipping its option
// values, so the shared sum-the-chosen-values scorer needs no special case. Bands
// are Skinner's published interpretation levels (facts, unchanged from #998).
const DAST_10: SubstanceInstrumentDef = {
  key: "DAST-10",
  canonicalName: "DAST-10",
  title: "DAST-10",
  measures: "drug use",
  entry: "in-app",
  instructions:
    "The following questions concern your possible involvement with drugs, not " +
    "including alcoholic beverages, during the past 12 months. “Drug abuse” " +
    "refers to the use of prescribed or over-the-counter medications in excess of " +
    "the directions, and any non-medical use of drugs.",
  items: [
    {
      prompt:
        "Have you used drugs other than those required for medical reasons?",
      options: YES_NO,
    },
    {
      prompt: "Do you abuse more than one drug at a time?",
      options: YES_NO,
    },
    {
      // The reverse-scored item: "No" earns the point (flipped option values).
      prompt:
        "Are you always able to stop using drugs when you want to? (If you never use drugs, answer “Yes.”)",
      options: YES_NO_REVERSED,
    },
    {
      prompt:
        "Have you had “blackouts” or “flashbacks” as a result of drug use?",
      options: YES_NO,
    },
    {
      prompt: "Do you ever feel bad or guilty about your drug use?",
      options: YES_NO,
    },
    {
      prompt:
        "Does your spouse (or parents) ever complain about your involvement with drugs?",
      options: YES_NO,
    },
    {
      prompt: "Have you neglected your family because of your use of drugs?",
      options: YES_NO,
    },
    {
      prompt:
        "Have you engaged in illegal activities in order to obtain drugs?",
      options: YES_NO,
    },
    {
      prompt:
        "Have you ever experienced withdrawal symptoms (felt sick) when you stopped taking drugs?",
      options: YES_NO,
    },
    {
      prompt:
        "Have you had medical problems as a result of your drug use (e.g. memory loss, hepatitis, convulsions, bleeding, etc.)?",
      options: YES_NO,
    },
  ],
  maxTotal: 10,
  satisfiesScreening: "drug_use_screening",
  bands: [
    { level: 0, label: "None reported", min: 0, max: 0 },
    { level: 1, label: "Low", min: 1, max: 2 },
    { level: 2, label: "Moderate", min: 3, max: 5 },
    { level: 3, label: "Substantial", min: 6, max: 8 },
    { level: 4, label: "Severe", min: 9, max: null },
  ],
  discussBandLevel: 3,
  citation:
    "Skinner HA (1982), the Drug Abuse Screening Test (Addictive Behaviors 7:363–371); " +
    "DAST-10 item text © 1982 Harvey A. Skinner / CAMH, reproduced with attribution " +
    "under CAMH's clinical/educational reproduction permission (owner-recorded, #1085); " +
    "published DAST-10 interpretation bands.",
};

const DEFS: Record<SubstanceInstrument, SubstanceInstrumentDef> = {
  "AUDIT-C": AUDIT_C,
  AUDIT: AUDIT,
  "DAST-10": DAST_10,
};

export function substanceInstrumentDef(
  key: SubstanceInstrument
): SubstanceInstrumentDef {
  return DEFS[key];
}

export function allSubstanceInstrumentDefs(): readonly SubstanceInstrumentDef[] {
  return SUBSTANCE_INSTRUMENTS.map((k) => DEFS[k]);
}

// canonical_name → instrument, for reading a stored biomarker row back as a
// substance-instrument score (#482: the canonical_name IS the identity).
export function substanceInstrumentForCanonicalName(
  name: string | null | undefined
): SubstanceInstrument | null {
  if (!name) return null;
  const norm = name.trim().toLowerCase();
  for (const def of allSubstanceInstrumentDefs()) {
    if (def.canonicalName.toLowerCase() === norm) return def.key;
  }
  return null;
}

// The severity band a total falls in — same clamping contract as the mental-health
// severityBand (a bad extraction never throws).
export function substanceSeverityBand(
  instrument: SubstanceInstrument,
  total: number
): SeverityBand {
  const def = DEFS[instrument];
  const t = Math.round(total);
  for (const b of def.bands) {
    if (t >= b.min && (b.max == null || t <= b.max)) return b;
  }
  return t < def.bands[0].min ? def.bands[0] : def.bands[def.bands.length - 1];
}

// Whether a total sits at/above the instrument's discuss-with-a-clinician band.
// Drives ONLY the calm on-surface note — never the crisis surface (#996 is
// item-9/explicit only), never a finding, never a notification.
export function shouldSuggestClinicianDiscussion(
  instrument: SubstanceInstrument,
  total: number
): boolean {
  return (
    substanceSeverityBand(instrument, total).level >=
    DEFS[instrument].discussBandLevel
  );
}

// ---- Consumption + reduction target (per-substance ledgers) ----------------

// The tracked substances (#998 alcohol; #1078 adds nicotine + cannabis). Each has
// a consumption ledger + an optional weekly-cap reduction target; WHICH ledger a
// substance rides is a per-substance fact (see SubstanceDef.ledger below).
export const SUBSTANCES = ["alcohol", "nicotine", "cannabis"] as const;
export type Substance = (typeof SUBSTANCES)[number];

export function isSubstance(v: unknown): v is Substance {
  return typeof v === "string" && (SUBSTANCES as readonly string[]).includes(v);
}

// Per-substance display + ledger facts. The LEDGER split (#1078, the #860/#944
// reconciliation): a standard drink IS one serving of the curated `alcohol` food
// group (its dataset serving line is literally "One standard drink…"), so alcohol
// consumption rides the EXISTING food_daily_totals / food_log_events observation store —
// one store, two surfaces with Nutrition. Nicotine and cannabis are NOT foods:
// overloading food_daily_totals/food_groups with them would pollute the nutrition ledger
// and the one-tap bar, and none of the other observation stores carries a
// per-day tap-count semantic (symptom_logs is severity-per-day, metric_samples/
// body_metrics are measured values, medical_records is result-shaped) — so they
// ride the dedicated `substance_daily_totals` counter ledger (migration 096), the food_daily_totals
// shape re-instantiated for non-food substances. Units are deliberately plain
// per-use counts (no mg-nicotine normalization across product types — out of
// scope, low fidelity).
export interface SubstanceDef {
  key: SubstanceKey; // curated key or a profile's own name (see the vocabulary below)
  label: string; // section heading noun — "Alcohol"
  ledger: "food-log" | "substance-log";
  unitSingular: string; // cap phrasing — "7-drink weekly cap" / "7-use weekly cap"
  unitPlural: string;
  countSingular: string; // the week-count line — "1 standard drink logged…"
  countPlural: string;
  logLabel: string; // the one-tap button
  freeWeekPhrase: string; // the cap-0 target, article included
  unitNote: string; // the plain unit explainer under the one-tap bar
}

// The unit explainer for a substance counted in plain sessions. Cannabis authors it
// and every CUSTOM substance derives it, and the sentence is true of both — so it is
// written ONCE (#3333). Two copies drift the first time one is edited, and the drift
// is invisible: both surfaces keep rendering something plausible.
const SESSION_UNIT_NOTE = "One use = one session, whatever the form.";

const SUBSTANCE_DEFS: Record<Substance, SubstanceDef> = {
  alcohol: {
    key: "alcohol",
    label: "Alcohol",
    ledger: "food-log",
    unitSingular: "drink",
    unitPlural: "drinks",
    countSingular: "standard drink",
    countPlural: "standard drinks",
    logLabel: "Log a standard drink",
    freeWeekPhrase: "an alcohol-free week",
    unitNote:
      "One standard drink ≈ 12 oz beer, 5 oz wine, or 1.5 oz spirits. Drinks log " +
      "into the same ledger as Nutrition’s alcohol group — logging in either place " +
      "counts once.",
  },
  nicotine: {
    key: "nicotine",
    label: "Nicotine",
    ledger: "substance-log",
    unitSingular: "use",
    unitPlural: "uses",
    countSingular: "use",
    countPlural: "uses",
    logLabel: "Log a use",
    freeWeekPhrase: "a nicotine-free week",
    unitNote:
      "One use = one cigarette, pouch, or vape session — count whatever matches " +
      "your products. Uses aren’t converted to milligrams of nicotine across " +
      "product types.",
  },
  cannabis: {
    key: "cannabis",
    label: "Cannabis",
    ledger: "substance-log",
    unitSingular: "use",
    unitPlural: "uses",
    countSingular: "use",
    countPlural: "uses",
    logLabel: "Log a use",
    freeWeekPhrase: "a cannabis-free week",
    unitNote: SESSION_UNIT_NOTE,
  },
};

// ---- Substance VOCABULARY: the curated keys, plus a profile's own (#3279) ---
//
// #3279 ruling 2 — "curate the common ones AND allow custom". The curated three
// above stay and may grow modestly where good defaults exist; beyond that a profile
// names its own substances, the way intake items are already free text.
//
// BORROWED, NOT INVENTED. This is lib/symptoms.ts's curated+custom vocabulary
// re-instantiated for the substance ledger — the SAME question ("which entries exist
// for this profile, and what is each one called?"), so the same four terms answer it
// and the identity registry lists them side by side:
//
//   symptoms.ts                       substance-use.ts (here)
//   ───────────────────────────────   ────────────────────────────────────
//   normalizeSymptomName()            normalizeSubstanceName()
//   resolveSymptomKey()               resolveSubstanceKey()
//   isCuratedSymptom()                isCuratedSubstance()  (=== isSubstance)
//   isCustomSymptomKey()              isCustomSubstanceKey()
//   symptomLabel()                    substanceLabel()
//
// The borrow is exact on purpose: a reader who knows one knows the other, and a
// second normalization rule for the same shape of user text is the "one question,
// one computation" disease at the identity layer (docs/internals/identity-registry.md).
//
// ONE THING IS NO LONGER BORROWED — IT IS SHARED (#3325). Case-folding for matching is
// not re-instantiated on this side: both resolvers call `matchFoldedVocabulary()` from
// lib/vocabulary-fold.ts, and both are handed the profile's spellings by
// `resolveProfileVocabularyKey()` in lib/vocabulary-store.ts. Two parallel copies of a
// fold would drift the moment one domain's rule changed, and the whole reason #3279's
// lane left the case defect ALONE was that fixing one vocabulary alone re-forks them.
// The two rows in docs/internals/identity-registry.md now name the same shared fold.
//
// NO NEW TABLE, AND NO MIGRATION. A custom substance is not registered anywhere before
// it is used: its identity IS its normalized name in the ledger, exactly as a custom
// symptom's is in `symptom_logs.symptom`. Migration 096 declared this on day one —
// "`substance` holds a … key … validated in the write core against the catalog (the
// food_log group_key discipline: no CHECK, so a future substance needs no rebuild)".
// The catalog is what widens here; the column never had to.
//
// WHICH LEDGER A CUSTOM SUBSTANCE RIDES is not a choice — it is
// `substance_daily_totals` with count semantics, always. The food-log ledger is a
// CURATED fact about alcohol specifically (a standard drink IS one serving of the
// curated `alcohol` food group, #860/#944); nothing a person types can be shown to be
// a food, so nothing typed may pollute the nutrition ledger.
//
// THE BOUNDARY THIS VOCABULARY DOES NOT CROSS — episodic vs regimen (#3279).
// A substance key names EPISODIC consumption: countable uses, one per-day total, no
// dose. A DOSED REGIMEN (10 µg every 3 days) is NOT a substance key and must never
// become one — it is an INTAKE ITEM (free-text name, µg-capable amount, interval
// cadence, situational holds), linked to a protocol through the shipped
// intake-linked N-of-1 tally. The two shapes have two existing stores and this issue
// adds no third engine. The practical test, for anyone tempted to widen this file:
// if the thing being logged carries an AMOUNT PER ADMINISTRATION, it is an intake
// item; if it carries a COUNT PER DAY, it is a substance key. See
// docs/internals/substances.md.

// A stored substance identity: either a curated key (`Substance`) or a profile's own
// normalized name. This is the type of `substance_daily_totals.substance` and of
// `frequency_targets.scope_value` for the 'substance' scope. It is deliberately a bare
// string — the curated set is a subset of the key space, not a gate on it.
export type SubstanceKey = string;

// Cap on a custom substance name, so a pasted paragraph can't bloat the column.
// Shorter than the symptom cap (80) because a substance name is a noun, not a phrase,
// and this string is also a card heading.
export const MAX_SUBSTANCE_NAME_LENGTH = 60;

// Canonicalize a custom substance name: trim + collapse internal whitespace, capped.
// Paired with substance_daily_totals' UNIQUE (profile_id, date, substance), this makes
// "  Kratom " and "Kratom" resolve to one per-day row. Case is PRESERVED — the person's
// own capitalization is their label (the symptoms rule), and #3325 kept it that way:
// what that issue removed was case DECIDING identity, not case being stored. The fold
// lives in `resolveSubstanceKey` below, where names are MATCHED; it never reaches here,
// so no normalizer can ever hand back "Mdma".
export function normalizeSubstanceName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, MAX_SUBSTANCE_NAME_LENGTH);
}

// Whether a value is one of the CURATED keys. The same predicate as isSubstance, named
// for the vocabulary axis so a reader asking "curated or custom?" finds both halves.
export function isCuratedSubstance(v: unknown): v is Substance {
  return isSubstance(v);
}

// Whether a stored key is a profile's own name rather than a curated key. A key that is
// empty or not in canonical stored form is neither — it is not a key at all.
export function isCustomSubstanceKey(key: string): boolean {
  return (
    !isSubstance(key) && key.length > 0 && normalizeSubstanceName(key) === key
  );
}

// Resolve user-entered text (a curated key, a curated LABEL, or a free-text name) to the
// key it is STORED under. A typed "Alcohol" collapses onto the curated `alcohol` so it
// can never shadow the catalog with a second ledger; anything else is a normalized custom
// name. Empty input -> null (nothing to log). Every write boundary goes through this, so
// normalization happens once, at the edge (AGENTS.md).
//
// `known` is this profile's OWN spellings, first-seen first (#3325). When it is given and
// one of them folds equal to the typed name, that STORED spelling comes back, so a typed
// "kratom" joins the existing "Kratom" card rather than opening a second ledger beside
// it. Nothing is ever folded INTO storage — the key returned is always a curated key or a
// verbatim spelling — so "MDMA" keeps its capitals. The symptom twin takes the same
// argument, from the same shared matcher (lib/vocabulary-fold.ts).
//
// The parameter is OPTIONAL because this also runs client-side, where the profile's
// ledger isn't reachable. Every WRITE path resolves through
// `resolveProfileVocabularyKey()` (lib/vocabulary-store.ts), which supplies it.
export function resolveSubstanceKey(
  input: string,
  known?: readonly SubstanceKey[]
): SubstanceKey | null {
  const raw = input.trim();
  if (!raw) return null;
  if (isSubstance(raw)) return raw;
  const lower = raw.toLowerCase();
  for (const s of SUBSTANCES) {
    if (s === lower || SUBSTANCE_DEFS[s].label.toLowerCase() === lower)
      return s;
  }
  const norm = normalizeSubstanceName(raw);
  if (!norm) return null;
  return known ? (matchFoldedVocabulary(norm, known) ?? norm) : norm;
}

// ---- Naming one at a SURFACE (#3326) ---------------------------------------
//
// `resolveSubstanceKey` normalizes-and-TRUNCATES, which is right for a stored key and
// wrong for a person typing: 61 characters would become 60 with nothing said, and the
// substance they meant is not the substance they got. So the surface asks a different
// question first — "is this name usable exactly as typed?" — and only then resolves,
// through the same one normalizer. There is still ONE normalization; this adds a gate
// in front of it, not a second rule.
//
// Deliberately NOT a `maxLength` on the input either: the browser would silently
// swallow the 61st keystroke and quietly clip a paste, which is the same defect wearing
// a nicer hat. The name is refused with a sentence instead.
export type SubstanceNameRejection = "empty" | "too-long";

export type SubstanceNameResult =
  | { ok: true; key: SubstanceKey }
  | { ok: false; reason: SubstanceNameRejection };

export function validateSubstanceName(
  input: string,
  known?: readonly SubstanceKey[]
): SubstanceNameResult {
  // Collapse FIRST, so "  Kratom  " is measured at 6 characters rather than 10 — the
  // length that is refused has to be the length that would be stored.
  const collapsed = input.trim().replace(/\s+/g, " ");
  if (collapsed.length > MAX_SUBSTANCE_NAME_LENGTH)
    return { ok: false, reason: "too-long" };
  const key = resolveSubstanceKey(collapsed, known);
  if (key === null) return { ok: false, reason: "empty" };
  return { ok: true, key };
}

// The one wording for each rejection, so the client's pre-flight check and the Server
// Action's own re-check say the same sentence rather than two near-misses.
export function substanceNameError(reason: SubstanceNameRejection): string {
  return reason === "too-long"
    ? `That name is too long — use ${MAX_SUBSTANCE_NAME_LENGTH} characters or fewer.`
    : "Type a name to track.";
}

// The display name for a stored key: the curated label, else the custom key verbatim.
// Never throws on an unknown key — a row logged under a key this build doesn't curate
// still renders (the #203 name-keyed discipline, as symptomLabel).
export function substanceLabel(key: SubstanceKey): string {
  return isSubstance(key) ? SUBSTANCE_DEFS[key].label : key;
}

// The derived def for a custom substance. Everything a curated def AUTHORS, this
// computes: count semantics ("use"/"uses"), the substance-log ledger, and the person's
// own name as the label. It shares cannabis's unit note rather than re-wording it.
//
// THE FREE-WEEK PHRASE PUTS THE ARTICLE BEFORE "week", NOT BEFORE THE NAME (#3333).
// A custom name is arbitrary user text, so "a"/"an" in front of it cannot be chosen
// correctly by any rule — "an hour", "a unicorn", "an MRI" go wrong in both
// directions, and a better heuristic is only a wrong answer that is harder to notice.
// Phrasing it as "a week free of X" removes the choice instead of shrinking it: the
// article now agrees with "week" for every name anybody types. The curated three keep
// their authored "an alcohol-free week" wording — their articles were written by hand
// and are right, and nothing a person reads today should move for this.
function customSubstanceDef(key: SubstanceKey): SubstanceDef {
  return {
    key,
    label: key,
    ledger: "substance-log",
    unitSingular: "use",
    unitPlural: "uses",
    countSingular: "use",
    countPlural: "uses",
    logLabel: "Log a use",
    freeWeekPhrase: `a week free of ${key}`,
    unitNote: SESSION_UNIT_NOTE,
  };
}

// The def for ANY stored key: the authored def for a curated key, else the derived
// custom def above. TOTAL by construction — an unknown key renders as itself rather
// than throwing, so a ledger row always has a card to live in (#203, #3279).
export function substanceDef(key: SubstanceKey): SubstanceDef {
  return isSubstance(key) ? SUBSTANCE_DEFS[key] : customSubstanceDef(key);
}

// Whether a value names a substance whose ledger is the dedicated substance_daily_totals
// table — nicotine/cannabis and EVERY custom substance (only alcohol is on
// food_daily_totals, and only because a standard drink is a curated food serving). The
// write core validates through this so a forged/stale key lands nothing: the key must
// already be in canonical stored form, so a caller that skipped resolveSubstanceKey()
// is refused rather than silently minting a near-miss neighbour of an existing row.
export function isSubstanceLogged(v: unknown): v is SubstanceKey {
  return (
    typeof v === "string" &&
    resolveSubstanceKey(v) === v &&
    substanceDef(v).ledger === "substance-log"
  );
}

// The food_daily_totals group_key alcohol consumption is stored under — the ledger identity
// shared with Nutrition's one-tap bar (one store, two surfaces, one computation).
export const ALCOHOL_FOOD_GROUP = "alcohol";

// The largest sane weekly cap for any substance (mirrors the food-habit
// MAX_PER_WEEK clamp scale).
export const MAX_WEEKLY_CAP = 70;

// Historical consumption rows use the same upper bound as the weekly cap. Kept
// in this pure/client-safe catalog module so forms never import a DB write core.
export const MAX_SUBSTANCE_ENTRY_AMOUNT = 70;

// A reduction target's weekly state: this week's logged units vs the user-set
// cap. `cap` 0 is a valid target (a substance-free week — "Dry January", a quit
// target).
// Semantics are INVERTED from every other frequency target (a ceiling, not a
// floor), which is exactly why substance targets are EXCLUDED from
// getFrequencyTargetProgress — a floor-semantics reader would nag toward MORE.
export interface SubstanceCapStatus {
  count: number; // units logged this week (standard drinks / uses)
  cap: number; // the user-set weekly cap
  over: boolean; // count > cap
  atCap: boolean; // positive cap reached exactly (attention, not an over-cap finding)
  remaining: number; // units left under the cap (0 when at/over)
}

export function substanceCapStatus(
  count: number,
  cap: number
): SubstanceCapStatus {
  const c = Math.max(0, Math.round(count));
  const k = Math.max(0, Math.round(cap));
  return {
    count: c,
    cap: k,
    over: c > k,
    // A zero cap with zero logged is the quiet substance-free state, not an
    // attention boundary. Once something is logged, the existing over path owns it.
    atCap: k > 0 && c === k,
    remaining: Math.max(0, k - c),
  };
}

// The substance's unit word for a count ("drink"/"drinks", "use"/"uses").
export function substanceUnitWord(substance: SubstanceKey, n: number): string {
  const def = substanceDef(substance);
  return n === 1 ? def.unitSingular : def.unitPlural;
}

// The ONE progress line every surface renders ("one question, one computation"):
// the substance page, the coaching finding detail, and any future formatter all
// share this, per substance (#1078 generalized the wording; the alcohol strings
// are byte-identical to #998's). Calm and factual — never celebratory, never
// judgmental.
export function capProgressLine(
  s: SubstanceCapStatus,
  substance: SubstanceKey = "alcohol"
): string {
  const def = substanceDef(substance);
  if (s.cap === 0) {
    return s.count === 0
      ? `No ${def.unitPlural} logged this week — your target is ${def.freeWeekPhrase}.`
      : `${s.count} ${substanceUnitWord(substance, s.count)} logged this week — your target is ${def.freeWeekPhrase}.`;
  }
  if (s.over) {
    return `${s.count} ${substanceUnitWord(substance, s.count)} logged this week — ${s.count - s.cap} over your ${s.cap}-${def.unitSingular} weekly cap.`;
  }
  if (s.atCap) {
    return `${s.count} of ${s.cap} this week — at your ${s.cap}-${def.unitSingular} weekly cap.`;
  }
  return `${s.count} of ${s.cap} this week.`;
}

// ---- Coaching-finding identity (#448/#449) ---------------------------------

// The findings-bus namespace for the over-target observation. Keyed on the
// substance (a stable #203 key), so a dismiss follows the target regardless of
// which week is current.
export const SUBSTANCE_USE_PREFIX = "substance-use:";

export function substanceTargetSignalKey(substance: SubstanceKey): string {
  return `${SUBSTANCE_USE_PREFIX}over-target:${substance}`;
}
