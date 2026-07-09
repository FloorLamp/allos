import type { Sex } from "./types";

// Curated vaccine catalog + a practical encoding of the CDC/ACIP recommended
// immunization schedule (2025 child/adolescent + adult). This is a SIMPLIFIED
// subset for personal tracking — it is not clinical software and does not model
// every risk-condition, pregnancy, or shared-decision case. The catalog is the
// single source the schedule grid rows, the manual add-form combobox, and the
// document-extraction matcher all read from. Unlike biomarkers (an open,
// AI-grown vocabulary), the vaccine set is bounded by the schedule, so it is
// static and curated here rather than discovered.
//
// Ages are expressed in MONTHS so the same rule engine covers infants (dose at
// 2mo) and adults (booster at age 50). 1 year = 12 months.

const Y = 12; // months per year, for readability in the tables below

export type VaccineGroup =
  "routine_child" | "routine_adult" | "seasonal" | "risk_based" | "travel";

// One dose milestone in a childhood primary series. `recommendedMonths` is the
// target age; `minMonths` is the earliest valid age (used to decide "due" vs
// "not yet"). `label` is a human age band for the grid/status text.
export interface SeriesDose {
  recommendedMonths: number;
  minMonths: number;
  label: string;
}

// Conservative minimum interval between consecutive doses of a multi-dose series,
// in days. SIMPLIFIED single-number stand-ins for the ACIP minimum-interval tables
// (which vary per dose pair): 4 weeks (28 d) is the floor for most childhood
// primary-series doses; Hep A / HPV use their longer routine spacing. Doses logged
// closer than this are treated as ONE credited dose (see assessOne), so two
// same-week entries don't read as a finished series. NOT clinical guidance.
export const MIN_INTERVAL_4WK = 28;
export const MIN_INTERVAL_8WK = 56;
export const MIN_INTERVAL_6MO = 168; // Hep A second dose (≥6 months)
export const MIN_INTERVAL_HPV_2DOSE = 150; // HPV 2-dose ≥5 months (ACIP)

// A discriminated schedule rule so the pure status engine stays generic.
export type VaccineSchedule =
  // Fixed-count primary series (HepB, DTaP, MMR, …). `minIntervalDays` is the
  // conservative minimum spacing between consecutive doses (see above).
  | { kind: "series"; doses: SeriesDose[]; minIntervalDays?: number }
  // Recurring booster every `intervalYears`, starting at `startAgeYears` (Td/Tdap).
  | { kind: "booster"; intervalYears: number; startAgeYears: number }
  // Every year (influenza, COVID-19 — recommended from 6 months, then annually).
  | { kind: "annual" }
  // Recommended once within an age window (Zoster ≥50, Pneumococcal ≥65, HPV
  // routine through 26), optionally sex-restricted. `endAgeYears` bounds the
  // routine window above; omitted means open-ended (recommended from the start
  // age onward). `minIntervalDays` spaces a multi-dose one_time (HPV, Zoster).
  | {
      kind: "one_time";
      startAgeYears: number;
      endAgeYears?: number;
      doses: number;
      sex?: Sex;
      minIntervalDays?: number;
    }
  // No US age-based recommendation — travel / risk-based / non-routine. Tracked
  // and displayed, but never flagged due/overdue by age (BCG, Yellow Fever, …).
  | { kind: "record_only" };

export interface VaccineEntry {
  code: string; // stable catalog key stored in immunizations.vaccine
  name: string; // full display name
  abbrev: string; // short label for the grid
  group: VaccineGroup;
  // Brand names and spellings the extractor / combobox map onto this code. The
  // `name` and `abbrev` are matched implicitly too.
  aliases: string[];
  // Canonical/free-text antibody-titer names that evidence immunity to this
  // vaccine's target (matched case-insensitively against medical_records).
  antibodyMarkers: string[];
  schedule: VaccineSchedule;
}

// A combination shot: one physical dose that covers several component vaccines.
// Stored under the combo `code` (so history preserves "got Vaxelis"), and the
// status engine expands it to `components` when crediting each component's
// series. Components must be `code`s present in CATALOG.
export interface Combination {
  code: string;
  name: string;
  aliases: string[];
  components: string[];
}

export const CATALOG: VaccineEntry[] = [
  // ---- Routine childhood primary series ----
  {
    code: "hepb",
    name: "Hepatitis B",
    abbrev: "HepB",
    group: "routine_child",
    aliases: ["hep b", "hbv", "engerix", "engerix-b", "recombivax", "heplisav"],
    antibodyMarkers: [
      "Hepatitis B Surface Antibody",
      "Anti-HBs",
      "HBsAb",
      "Hepatitis B Surface Ab",
    ],
    schedule: {
      kind: "series",
      minIntervalDays: MIN_INTERVAL_4WK,
      doses: [
        { recommendedMonths: 0, minMonths: 0, label: "Birth" },
        { recommendedMonths: 2, minMonths: 1, label: "1–2 mo" },
        { recommendedMonths: 12, minMonths: 6, label: "6–18 mo" },
      ],
    },
  },
  {
    code: "rv",
    name: "Rotavirus",
    abbrev: "RV",
    group: "routine_child",
    aliases: ["rotateq", "rotarix", "rota"],
    antibodyMarkers: [],
    schedule: {
      kind: "series",
      minIntervalDays: MIN_INTERVAL_4WK,
      doses: [
        { recommendedMonths: 2, minMonths: 2, label: "2 mo" },
        { recommendedMonths: 4, minMonths: 4, label: "4 mo" },
        { recommendedMonths: 6, minMonths: 6, label: "6 mo" },
      ],
    },
  },
  {
    code: "dtap",
    name: "Diphtheria, Tetanus & Pertussis (DTaP)",
    abbrev: "DTaP",
    group: "routine_child",
    aliases: ["dtap", "daptacel", "infanrix", "dt", "diphtheria tetanus"],
    antibodyMarkers: ["Tetanus Antibody", "Tetanus IgG", "Diphtheria Antibody"],
    schedule: {
      kind: "series",
      minIntervalDays: MIN_INTERVAL_4WK,
      doses: [
        { recommendedMonths: 2, minMonths: 2, label: "2 mo" },
        { recommendedMonths: 4, minMonths: 4, label: "4 mo" },
        { recommendedMonths: 6, minMonths: 6, label: "6 mo" },
        { recommendedMonths: 15, minMonths: 12, label: "15–18 mo" },
        { recommendedMonths: 4 * Y, minMonths: 4 * Y, label: "4–6 y" },
      ],
    },
  },
  {
    code: "hib",
    name: "Haemophilus influenzae type b (Hib)",
    abbrev: "Hib",
    group: "routine_child",
    aliases: ["hib", "acthib", "hiberix", "pedvaxhib"],
    antibodyMarkers: [],
    schedule: {
      kind: "series",
      minIntervalDays: MIN_INTERVAL_4WK,
      doses: [
        { recommendedMonths: 2, minMonths: 2, label: "2 mo" },
        { recommendedMonths: 4, minMonths: 4, label: "4 mo" },
        { recommendedMonths: 12, minMonths: 12, label: "12–15 mo" },
      ],
    },
  },
  {
    code: "pcv",
    name: "Pneumococcal conjugate (PCV)",
    abbrev: "PCV",
    group: "routine_child",
    aliases: ["pcv13", "pcv15", "pcv20", "prevnar", "prevnar 13", "prevnar 20"],
    antibodyMarkers: [],
    schedule: {
      kind: "series",
      minIntervalDays: MIN_INTERVAL_4WK,
      doses: [
        { recommendedMonths: 2, minMonths: 2, label: "2 mo" },
        { recommendedMonths: 4, minMonths: 4, label: "4 mo" },
        { recommendedMonths: 6, minMonths: 6, label: "6 mo" },
        { recommendedMonths: 12, minMonths: 12, label: "12–15 mo" },
      ],
    },
  },
  {
    code: "ipv",
    name: "Polio (IPV)",
    abbrev: "IPV",
    group: "routine_child",
    aliases: ["ipv", "polio", "ipol"],
    antibodyMarkers: ["Polio Antibody", "Poliovirus Antibody"],
    schedule: {
      kind: "series",
      minIntervalDays: MIN_INTERVAL_4WK,
      doses: [
        { recommendedMonths: 2, minMonths: 2, label: "2 mo" },
        { recommendedMonths: 4, minMonths: 4, label: "4 mo" },
        { recommendedMonths: 12, minMonths: 6, label: "6–18 mo" },
        { recommendedMonths: 4 * Y, minMonths: 4 * Y, label: "4–6 y" },
      ],
    },
  },
  {
    code: "mmr",
    name: "Measles, Mumps & Rubella (MMR)",
    abbrev: "MMR",
    group: "routine_child",
    aliases: ["mmr", "m-m-r", "measles mumps rubella", "priorix"],
    antibodyMarkers: [
      "Measles IgG",
      "Mumps IgG",
      "Rubella IgG",
      "Measles Antibody",
      "Rubella Antibody",
    ],
    schedule: {
      kind: "series",
      minIntervalDays: MIN_INTERVAL_4WK,
      doses: [
        { recommendedMonths: 12, minMonths: 12, label: "12–15 mo" },
        { recommendedMonths: 4 * Y, minMonths: 4 * Y, label: "4–6 y" },
      ],
    },
  },
  {
    code: "varicella",
    name: "Varicella (Chickenpox)",
    abbrev: "VAR",
    group: "routine_child",
    aliases: ["varicella", "chickenpox", "varivax", "vzv"],
    antibodyMarkers: [
      "Varicella IgG",
      "Varicella-Zoster IgG",
      "VZV IgG",
      "Varicella Antibody",
    ],
    schedule: {
      kind: "series",
      minIntervalDays: MIN_INTERVAL_4WK,
      doses: [
        { recommendedMonths: 12, minMonths: 12, label: "12–15 mo" },
        { recommendedMonths: 4 * Y, minMonths: 4 * Y, label: "4–6 y" },
      ],
    },
  },
  {
    code: "hepa",
    name: "Hepatitis A",
    abbrev: "HepA",
    group: "routine_child",
    aliases: ["hep a", "hav", "havrix", "vaqta"],
    antibodyMarkers: ["Hepatitis A IgG", "Hepatitis A Antibody", "Anti-HAV"],
    schedule: {
      kind: "series",
      minIntervalDays: MIN_INTERVAL_6MO,
      doses: [
        { recommendedMonths: 12, minMonths: 12, label: "12–23 mo" },
        { recommendedMonths: 18, minMonths: 18, label: "+6 mo" },
      ],
    },
  },
  // ---- Adolescent ----
  {
    code: "menacwy",
    name: "Meningococcal ACWY",
    abbrev: "MenACWY",
    group: "routine_child",
    aliases: ["menacwy", "menactra", "menveo", "meningococcal", "mcv4"],
    antibodyMarkers: [],
    schedule: {
      kind: "series",
      minIntervalDays: MIN_INTERVAL_8WK,
      doses: [
        { recommendedMonths: 11 * Y, minMonths: 11 * Y, label: "11–12 y" },
        { recommendedMonths: 16 * Y, minMonths: 16 * Y, label: "16 y" },
      ],
    },
  },
  {
    code: "menb",
    name: "Meningococcal B",
    abbrev: "MenB",
    group: "risk_based",
    aliases: ["menb", "bexsero", "trumenba"],
    antibodyMarkers: [],
    schedule: { kind: "record_only" },
  },
  {
    code: "hpv",
    name: "Human Papillomavirus (HPV)",
    abbrev: "HPV",
    group: "routine_child",
    aliases: ["hpv", "gardasil", "gardasil 9", "gardasil-9"],
    antibodyMarkers: [],
    // Routine at 11–12 (from age 9); catch-up through 26 (shared decision to 45).
    schedule: {
      kind: "one_time",
      startAgeYears: 9,
      endAgeYears: 26,
      doses: 2,
      minIntervalDays: MIN_INTERVAL_HPV_2DOSE,
    },
  },
  // ---- Routine adult / all-ages ----
  {
    code: "tdap",
    name: "Tetanus, Diphtheria & Pertussis booster (Tdap/Td)",
    abbrev: "Tdap",
    group: "routine_adult",
    aliases: ["tdap", "td", "boostrix", "adacel", "tenivac", "tetanus booster"],
    antibodyMarkers: ["Tetanus Antibody", "Tetanus IgG"],
    // Adolescent Tdap at 11–12, then a Td/Tdap booster every 10 years.
    schedule: { kind: "booster", intervalYears: 10, startAgeYears: 11 },
  },
  {
    code: "influenza",
    name: "Influenza (Flu)",
    abbrev: "Flu",
    group: "seasonal",
    aliases: ["influenza", "flu", "fluzone", "flublok", "fluarix", "flumist"],
    antibodyMarkers: [],
    schedule: { kind: "annual" },
  },
  {
    code: "covid",
    name: "COVID-19",
    abbrev: "COVID",
    group: "seasonal",
    aliases: [
      "covid",
      "covid-19",
      "sars-cov-2",
      "comirnaty",
      "spikevax",
      "pfizer",
      "moderna",
      "novavax",
    ],
    antibodyMarkers: ["SARS-CoV-2 Spike Antibody", "COVID-19 Antibody"],
    schedule: { kind: "annual" },
  },
  {
    code: "zoster",
    name: "Shingles (Zoster)",
    abbrev: "RZV",
    group: "routine_adult",
    aliases: ["zoster", "shingles", "shingrix", "rzv"],
    antibodyMarkers: [],
    schedule: {
      kind: "one_time",
      startAgeYears: 50,
      doses: 2,
      minIntervalDays: MIN_INTERVAL_8WK,
    },
  },
  {
    code: "pneumo_adult",
    name: "Pneumococcal (adult)",
    abbrev: "PPSV/PCV",
    group: "routine_adult",
    aliases: ["ppsv23", "pneumovax", "pcv20 adult", "pneumococcal adult"],
    antibodyMarkers: [],
    schedule: { kind: "one_time", startAgeYears: 65, doses: 1 },
  },
  {
    code: "rsv",
    name: "RSV (older adult)",
    abbrev: "RSV",
    group: "routine_adult",
    aliases: ["rsv", "arexvy", "abrysvo"],
    antibodyMarkers: [],
    schedule: { kind: "one_time", startAgeYears: 75, doses: 1 },
  },
  // ---- Travel / non-CDC-routine (record-only) ----
  {
    code: "bcg",
    name: "BCG (Tuberculosis)",
    abbrev: "BCG",
    group: "travel",
    aliases: ["bcg", "tuberculosis", "tb vaccine"],
    antibodyMarkers: [],
    schedule: { kind: "record_only" },
  },
  {
    code: "yellow_fever",
    name: "Yellow Fever",
    abbrev: "YF",
    group: "travel",
    aliases: ["yellow fever", "yf-vax", "yfvax", "stamaril"],
    antibodyMarkers: [],
    schedule: { kind: "record_only" },
  },
  {
    code: "typhoid",
    name: "Typhoid",
    abbrev: "Typhoid",
    group: "travel",
    aliases: ["typhoid", "typhim vi", "vivotif", "typbar"],
    antibodyMarkers: [],
    schedule: { kind: "record_only" },
  },
  {
    code: "rabies",
    name: "Rabies",
    abbrev: "Rabies",
    group: "travel",
    aliases: ["rabies", "imovax", "rabavert", "verorab"],
    antibodyMarkers: ["Rabies Antibody", "Rabies Titer"],
    schedule: { kind: "record_only" },
  },
  {
    code: "je",
    name: "Japanese Encephalitis",
    abbrev: "JE",
    group: "travel",
    aliases: ["japanese encephalitis", "ixiaro", "je-vc"],
    antibodyMarkers: [],
    schedule: { kind: "record_only" },
  },
  {
    code: "cholera",
    name: "Cholera",
    abbrev: "Cholera",
    group: "travel",
    aliases: ["cholera", "vaxchora", "dukoral"],
    antibodyMarkers: [],
    schedule: { kind: "record_only" },
  },
  {
    code: "tbe",
    name: "Tick-borne Encephalitis",
    abbrev: "TBE",
    group: "travel",
    aliases: ["tick-borne encephalitis", "tbe", "ticovac", "fsme"],
    antibodyMarkers: [],
    schedule: { kind: "record_only" },
  },
  {
    code: "mpox",
    name: "Mpox",
    abbrev: "Mpox",
    group: "risk_based",
    aliases: ["mpox", "monkeypox", "jynneos", "imvamune"],
    antibodyMarkers: [],
    schedule: { kind: "record_only" },
  },
];

// Combination shots → their component catalog codes. Stored as the combo code;
// expanded to components by the status engine so a single Vaxelis dose advances
// the DTaP, IPV, Hib, and HepB series together.
// Each combo also lists its component-string spellings as aliases (in common
// printed orders) so a card that prints "DTaP-IPV-Hib-HepB" instead of the brand
// still resolves to the combo (exact-match beats the single-component
// containment fallback), and the combo→components crediting fires.
export const COMBINATIONS: Combination[] = [
  {
    code: "vaxelis",
    name: "Vaxelis (DTaP-IPV-Hib-HepB)",
    aliases: ["vaxelis", "dtap-ipv-hib-hepb", "dtap-hib-ipv-hepb"],
    components: ["dtap", "ipv", "hib", "hepb"],
  },
  {
    code: "pediarix",
    name: "Pediarix (DTaP-IPV-HepB)",
    aliases: ["pediarix", "dtap-hepb-ipv", "dtap-ipv-hepb"],
    components: ["dtap", "ipv", "hepb"],
  },
  {
    code: "pentacel",
    name: "Pentacel (DTaP-IPV-Hib)",
    aliases: ["pentacel", "dtap-ipv-hib"],
    components: ["dtap", "ipv", "hib"],
  },
  {
    code: "kinrix",
    name: "Kinrix (DTaP-IPV)",
    aliases: ["kinrix", "quadracel", "dtap-ipv"],
    components: ["dtap", "ipv"],
  },
  {
    code: "proquad",
    name: "ProQuad (MMR-Varicella)",
    aliases: ["proquad", "mmrv", "mmr-varicella", "mmr-var"],
    components: ["mmr", "varicella"],
  },
  {
    code: "twinrix",
    name: "Twinrix (HepA-HepB)",
    aliases: ["twinrix", "hepa-hepb", "hepab"],
    components: ["hepa", "hepb"],
  },
];

const BY_CODE = new Map<string, VaccineEntry>(CATALOG.map((v) => [v.code, v]));
const COMBO_BY_CODE = new Map<string, Combination>(
  COMBINATIONS.map((c) => [c.code, c])
);

// A stored vaccine code expanded to the component catalog codes it credits:
// a combo → its components; a plain catalog code → itself; an unrecognized
// slug → nothing (it still shows in history, just credits no series).
export function expandToComponents(code: string): string[] {
  const combo = COMBO_BY_CODE.get(code);
  if (combo) return combo.components;
  return BY_CODE.has(code) ? [code] : [];
}

// The catalog entry for a plain vaccine code, or undefined for a combo/unknown
// slug (combos have no schedule of their own — they credit their components).
export function vaccineByCode(code: string): VaccineEntry | undefined {
  return BY_CODE.get(code);
}

// Display name for a stored code (catalog, combo, or unknown slug).
export function vaccineDisplayName(code: string): string {
  return (
    BY_CODE.get(code)?.name ??
    COMBO_BY_CODE.get(code)?.name ??
    // Unknown slug: de-slugify for a readable-ish label.
    code.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

// Slugify a printed vaccine name into a stable fallback code. Used when no
// alias matches so an extracted/typed dose is never dropped — it just lands
// under its own slug (uncredited in the grid until an alias is added).
export function slugifyVaccine(printed: string): string {
  return (
    printed
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "unknown"
  );
}

// Normalize a comparison key: lowercase, strip non-alphanumerics.
function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Build the alias → code index once (catalog + combos). Each entry contributes
// its code, name, abbrev, and aliases.
const ALIAS_INDEX: Map<string, string> = (() => {
  const idx = new Map<string, string>();
  const add = (text: string, code: string) => {
    const k = normKey(text);
    if (k && !idx.has(k)) idx.set(k, code);
  };
  for (const v of CATALOG) {
    add(v.code, v.code);
    add(v.name, v.code);
    add(v.abbrev, v.code);
    for (const a of v.aliases) add(a, v.code);
  }
  for (const c of COMBINATIONS) {
    add(c.code, c.code);
    add(c.name, c.code);
    for (const a of c.aliases) add(a, c.code);
  }
  return idx;
})();

// Match a printed vaccine/brand name onto a catalog or combo code. Tries an
// exact normalized-key hit, then a token-containment pass so "Boostrix (Tdap)"
// or "MMR II" still resolve. Returns null when nothing matches — callers then
// fall back to a slug (see slugifyVaccine) rather than dropping the dose.
export function normalizeVaccineName(printed: string | null): string | null {
  if (!printed) return null;
  const key = normKey(printed);
  if (!key) return null;
  const exact = ALIAS_INDEX.get(key);
  if (exact) return exact;
  // Containment pass: longest alias key that appears within the printed key
  // wins (avoids "hepa" matching inside "hepatitisb" incorrectly by preferring
  // the longer/more specific alias).
  let best: string | null = null;
  let bestLen = 0;
  for (const [alias, code] of ALIAS_INDEX) {
    if (alias.length >= 3 && key.includes(alias) && alias.length > bestLen) {
      best = code;
      bestLen = alias.length;
    }
  }
  return best;
}

// The full set of antibody-titer names across the catalog, for the query that
// aggregates immunity biomarkers.
export const IMMUNITY_ANTIBODY_MARKERS: string[] = Array.from(
  new Set(CATALOG.flatMap((v) => v.antibodyMarkers))
);

// Display names for the manual add form's combobox: catalog vaccines +
// combination shots. The form submits a printed name, which the write path
// re-normalizes to a code, so only the labels are needed here.
export const PICKER_NAMES: string[] = [
  ...CATALOG.map((v) => v.name),
  ...COMBINATIONS.map((c) => c.name),
];

// One-line "what it protects against" descriptions, shown in the schedule
// tooltip. Plain-language, not clinical advice.
export const VACCINE_DESCRIPTIONS: Record<string, string> = {
  hepb: "Hepatitis B — a liver infection spread through blood and body fluids.",
  rv: "Rotavirus — a common cause of severe diarrhea in infants.",
  dtap: "Diphtheria, tetanus, and whooping cough (pertussis).",
  hib: "Haemophilus influenzae type b — can cause meningitis in young children.",
  pcv: "Pneumococcal disease — pneumonia, meningitis, and bloodstream infections.",
  ipv: "Polio — a virus that can cause paralysis.",
  mmr: "Measles, mumps, and rubella.",
  varicella: "Varicella (chickenpox).",
  hepa: "Hepatitis A — a liver infection spread through contaminated food/water.",
  menacwy: "Meningococcal disease (serogroups A, C, W, Y) — meningitis/sepsis.",
  menb: "Meningococcal disease serogroup B.",
  hpv: "Human papillomavirus — prevents several HPV-related cancers.",
  tdap: "Tetanus, diphtheria, and pertussis booster for adolescents/adults.",
  influenza: "Seasonal influenza (flu).",
  covid: "COVID-19 (SARS-CoV-2).",
  zoster: "Shingles (herpes zoster) — reactivation of the chickenpox virus.",
  pneumo_adult: "Pneumococcal disease in older adults.",
  rsv: "Respiratory syncytial virus in older adults.",
  bcg: "Tuberculosis (BCG) — routine in many countries outside the US.",
  yellow_fever:
    "Yellow fever — a mosquito-borne virus in parts of Africa/S. America.",
  typhoid: "Typhoid fever — from contaminated food/water while traveling.",
  rabies: "Rabies — a fatal virus from animal bites; pre-/post-exposure.",
  je: "Japanese encephalitis — a mosquito-borne virus in parts of Asia.",
  cholera: "Cholera — a diarrheal disease from contaminated water.",
  tbe: "Tick-borne encephalitis — from tick bites in parts of Europe/Asia.",
  mpox: "Mpox (monkeypox).",
};

export function vaccineDescription(code: string): string | null {
  return VACCINE_DESCRIPTIONS[code] ?? null;
}

// A short human summary of a vaccine's dosing schedule, for the tooltip.
export function scheduleSummary(entry: VaccineEntry): string {
  const s = entry.schedule;
  switch (s.kind) {
    case "series":
      return `${s.doses.length}-dose series: ${s.doses.map((d) => d.label).join(", ")}`;
    case "booster":
      return `Booster every ${s.intervalYears} years, from age ${s.startAgeYears}`;
    case "annual":
      return "Recommended every year";
    case "one_time":
      return `${s.doses} dose${s.doses > 1 ? "s" : ""} once, from age ${s.startAgeYears}${
        s.endAgeYears ? `–${s.endAgeYears}` : "+"
      }${s.sex ? ` (${s.sex} only)` : ""}`;
    case "record_only":
      return "Travel / risk-based — no routine age schedule";
  }
}
