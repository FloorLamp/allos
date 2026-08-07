// PURE row → search-result text projections for the second-generation entity
// domains (issue #1595). One function per domain: it takes the row's OWN fields and
// returns the two lines the palette (and a Q&A citation) renders — nothing computed,
// nothing interpreted, no DB. The DB fan-out in lib/queries/search.ts decides WHICH
// rows match and owns the href; this module decides how each row READS, so the
// wording is unit-tested here (lib/__tests__/search-projections.test.ts) instead of
// hiding inside a SQL mapper.
//
// Every title routes through the domain's OWN canonical one-line label — the same
// `…DisplayLabel` the list page, the passport, and the import listing use
// (studyDisplayLabel, dentalDisplayLabel, skinLesionDisplayLabel,
// variantDisplayLabel) — so a hit can never name a record differently from the page
// it links to (the one-question-one-computation rule). What this module adds is the
// SUBTITLE: the attribute that actually tells two otherwise-identical rows apart —
// two studies of the same modality and region (their dates), two lesions in the same
// place (their body-map side, size, and status), two providers with the same name
// (specialty, then NPI or locality).

import { dentalDisplayLabel, dentalStatusLabel } from "./dental";
import { modalityLabel, studyDisplayLabel } from "./imaging-study";
import {
  resultTypeLabel,
  significanceLabel,
  variantDisplayLabel,
} from "./genomic-variant";
import { practiceCadenceText } from "./practice";
import {
  bodyMapLabel,
  skinLesionDisplayLabel,
  skinLesionStatusLabel,
} from "./skin-lesion";
import type {
  DentalProcedure,
  DentalStatus,
  GenomicVariant,
  ImagingStudy,
  SkinLesion,
} from "./types";

// The two rendered lines of one hit. `subtitle` is null when the row carries nothing
// worth a second line (never an empty string — the palette tests for null).
export interface SearchHitText {
  title: string;
  subtitle: string | null;
}

// Trim a stored datetime ("2026-07-06 12:00:00") down to its ISO day. The ONE
// place that trim happens for search text; lib/queries/search.ts reuses it for a
// hit's `date` field so a subtitle and the recency tiebreak can never disagree.
export function isoDay(value: string | null | undefined): string | null {
  return value ? value.slice(0, 10) : null;
}

// Join the parts a subtitle is built from with the palette's separator, dropping
// blanks. Returns null (not "") when nothing survives.
function subtitleOf(parts: (string | null | undefined)[]): string | null {
  const joined = parts
    .map((p) => (p == null ? "" : String(p).trim()))
    .filter((p) => p !== "")
    .join(" · ");
  return joined === "" ? null : joined;
}

// Collapse a free-text clinical narrative (a radiology impression, a lesion finding,
// an interpretation) to ONE short line: whitespace normalized, capped, ellipsized.
// Verbatim as far as it goes — never summarized, never rephrased.
export function snippet(
  value: string | null | undefined,
  max = 90
): string | null {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

// A stored [start, end] window as one display string. `end` IS the last member day —
// since #2232 every stored day window (a protocol's end_date, an illness episode's
// end_date) is inclusive, and lib/date-range.ts no longer expresses any other bound.
// An open window reads "since <start>"; a start-less closed one "until <last day>".
export function rangeText(range: {
  start: string | null;
  end: string | null;
}): string | null {
  const start = isoDay(range.start);
  const lastDay = isoDay(range.end);
  if (start && lastDay)
    return start === lastDay ? start : `${start} → ${lastDay}`;
  if (start) return `since ${start}`;
  if (lastDay) return `until ${lastDay}`;
  return null;
}

// ── Providers (#1055 directory) ──────────────────────────────────────────────

// The provider's kind in words, for the rows that state no specialty. The index
// carries this as an icon (stethoscope vs hospital); a text list needs the word.
export function providerKindLabel(type: string | null | undefined): string {
  return type === "organization" ? "Organization" : "Clinician";
}

// The attribute that tells two SAME-NAMED providers apart: the NPI when the registry
// has one (the identifier the directory itself already shows and searches on), else
// the first line of the stored address (the "which Main Street clinic" answer). Null
// when the registry knows neither — two same-named, address-less, NPI-less rows are a
// merge candidate, not a labelling problem search can solve.
export function providerDisambiguator(row: {
  npi: string | null;
  address: string | null;
}): string | null {
  const npi = row.npi?.trim();
  if (npi) return `NPI ${npi}`;
  const address = row.address?.replace(/\s+/g, " ").trim();
  if (address) return snippet(address.split(",")[0]?.trim() ?? address, 40);
  return null;
}

// A provider row as a hit. `recordCount` is the ACTIVE profile's linked-record total
// (the same number the directory shows), so the second line answers "how much of my
// record is this provider in". `ambiguousName` is set by the fan-out when another
// matched provider carries the same name.
export function providerHitText(
  row: {
    name: string;
    type: string | null;
    specialty: string | null;
    npi: string | null;
    address: string | null;
    recordCount: number;
  },
  opts: { ambiguousName?: boolean } = {}
): SearchHitText {
  const specialty = row.specialty?.trim();
  const count =
    row.recordCount > 0
      ? `${row.recordCount} ${row.recordCount === 1 ? "record" : "records"}`
      : null;
  return {
    title: row.name.trim() || "Provider",
    subtitle: subtitleOf([
      specialty || providerKindLabel(row.type),
      opts.ambiguousName ? providerDisambiguator(row) : null,
      count,
    ]),
  };
}

// ── Imaging studies (#702) ───────────────────────────────────────────────────

// A study as a hit: "MRI Left Knee" over its impression and date. Two studies of the
// same modality + region are told apart by the DATE, so it always rides the subtitle.
export function imagingHitText(
  row: Pick<
    ImagingStudy,
    | "modality"
    | "body_region"
    | "laterality"
    | "study_date"
    | "impression"
    | "indication"
  >
): SearchHitText {
  return {
    title: studyDisplayLabel(row) || modalityLabel(row.modality),
    subtitle: subtitleOf([
      snippet(row.impression) ?? snippet(row.indication),
      isoDay(row.study_date),
    ]),
  };
}

// ── Genomic variants (#709) ──────────────────────────────────────────────────

// A variant as a hit: "CYP2C19 *2/*17" over its classification, lab, and report date.
// Factual only — the significance is the report's own word, never re-derived (#711).
export function genomicHitText(
  row: Pick<
    GenomicVariant,
    | "gene"
    | "variant"
    | "genotype"
    | "star_allele"
    | "zygosity"
    | "significance"
    | "result_type"
    | "source_lab"
    | "report_date"
  >
): SearchHitText {
  return {
    title: variantDisplayLabel(row),
    subtitle: subtitleOf([
      row.significance
        ? significanceLabel(row.significance)
        : resultTypeLabel(row.result_type),
      row.source_lab,
      isoDay(row.report_date),
    ]),
  };
}

// ── Dental procedures (#705) ─────────────────────────────────────────────────

// A dental record as a hit: "Composite filling · #14 MOD" over its status, finding,
// and date. The tooth is in the TITLE (via dentalDisplayLabel), which is what tells
// two fillings apart; status distinguishes a planned one from the completed history.
export function dentalHitText(
  row: Pick<
    DentalProcedure,
    "name" | "tooth" | "surface" | "status" | "procedure_date" | "finding"
  >
): SearchHitText {
  return {
    title: dentalDisplayLabel(row),
    subtitle: subtitleOf([
      dentalStatusLabel(row.status as DentalStatus),
      snippet(row.finding, 60),
      isoDay(row.procedure_date),
    ]),
  };
}

// ── Skin lesions (#715) ──────────────────────────────────────────────────────

// A lesion as a hit — one per LESION, not per observation: the fan-out groups serial
// observations by the #482 identity exactly as the Skin list does, and hands the
// NEWEST record here as the head plus how many observations the group holds. The
// body-map location, size, and status are what separate two lesions in the same
// place, so all three ride the subtitle.
export function skinHitText(
  head: Pick<
    SkinLesion,
    | "label"
    | "body_region"
    | "body_side"
    | "status"
    | "size_mm"
    | "observed_date"
  >,
  observationCount = 1
): SearchHitText {
  const size = head.size_mm != null ? `${head.size_mm} mm` : null;
  const serial =
    observationCount > 1 ? `${observationCount} observations` : null;
  return {
    title: skinLesionDisplayLabel(head),
    subtitle: subtitleOf([
      bodyMapLabel(head) || null,
      skinLesionStatusLabel(head.status),
      size,
      serial,
      isoDay(head.observed_date),
    ]),
  };
}

// ── Illness episodes (#856) ──────────────────────────────────────────────────

// An episode as a hit: the situation over its window and outcome. `end_date` is the
// inclusive last active day (#2232) — an episode last active on the 7th reads
// "→ 2026-03-07".
export function episodeHitText(row: {
  situation: string;
  start_date: string | null;
  end_date: string | null;
  outcome: string | null;
}): SearchHitText {
  const ongoing = row.end_date == null;
  return {
    title: row.situation.trim() || "Illness episode",
    subtitle: subtitleOf([
      ongoing ? "Ongoing" : null,
      rangeText({ start: row.start_date, end: row.end_date }),
      snippet(row.outcome, 60),
    ]),
  };
}

// ── Protocols (#344/#580) ────────────────────────────────────────────────────

// A protocol as a hit: its name over its window and the situation it activates. A
// protocol's `end_date` IS its last day, so the range uses the inclusive bound.
export function protocolHitText(row: {
  name: string;
  start_date: string | null;
  end_date: string | null;
  situation: string | null;
}): SearchHitText {
  const ongoing = row.end_date == null;
  return {
    title: row.name.trim() || "Protocol",
    subtitle: subtitleOf([
      ongoing ? "Ongoing" : null,
      rangeText({ start: row.start_date, end: row.end_date }),
      row.situation,
    ]),
  };
}

// ── Wellness practices (#1591/#1622) ────────────────────────────────────────

// A practice as a hit — one per practice IDENTITY (case/whitespace spellings folded
// by practiceIdentity), so "Cold plunge" and "cold  plunge" are one result. The
// weekly cadence comes from the shared practiceCadenceText, so the target reads the
// same here as on the practice card.
export function practiceHitText(row: {
  name: string;
  perWeek: number | null;
  perWeekMax: number | null;
  sessionCount: number;
  lastUsed: string | null;
}): SearchHitText {
  const cadence =
    row.perWeek != null
      ? practiceCadenceText(row.perWeek, row.perWeekMax)
      : null;
  const sessions =
    row.sessionCount > 0
      ? `${row.sessionCount} ${row.sessionCount === 1 ? "session" : "sessions"}`
      : "No sessions yet";
  return {
    title: row.name.trim() || "Practice",
    subtitle: subtitleOf([cadence, sessions, isoDay(row.lastUsed)]),
  };
}

// ── Equipment (#343) ─────────────────────────────────────────────────────────

// A piece of gear as a hit: its name over its category and retirement state. A
// retired row still labels historical sets, so it stays findable — but says so.
export function equipmentHitText(row: {
  name: string;
  category: string | null;
  retired: number;
}): SearchHitText {
  return {
    title: row.name.trim() || "Equipment",
    subtitle: subtitleOf([row.category, row.retired === 1 ? "Retired" : null]),
  };
}

// ── Shared SQL text-matching (#1595, reused by #1634) ────────────────────────

// Escape LIKE wildcards so a literal % or _ (or \) in the query matches itself,
// then wrap for a substring match. Paired with `ESCAPE '\'` in the SQL. Lives here
// rather than inside the palette fan-out because the Journal's server-side feed
// filter (lib/queries/training/activities.ts) runs the SAME kind of substring scan —
// two text searches over the user's own words must escape them one way.
export function likePattern(query: string): string {
  const escaped = query.replace(/[\\%_]/g, (c) => "\\" + c);
  return `%${escaped}%`;
}
