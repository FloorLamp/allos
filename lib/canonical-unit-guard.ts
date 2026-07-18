// Unit-aware guard on canonical-name resolution (#918 §1).
//
// The AI import path resolves a reading's identity from a NAME alone — there is no
// LOINC to fall back on. When the model's canonical_name (or the printed name)
// snaps onto an entry whose UNIT contradicts the reading's unit, the reading is
// mis-grouped: a "%" value trends and dedups with a "cells/uL" series (the
// #549/#482 collision), silently never gets a reference band, and never flags. The
// unit is the arbiter — not the model's name, not the printed name. Distrust any
// snap whose entry unit is provably incompatible with the reading's, and prefer the
// same-analyte sibling whose unit fits.
//
// Gated on a PROVABLE contradiction (both units present and sameUnit false), so a
// qualitative row with no unit — urine glucose reported "NEGATIVE" — is never
// touched, keeping the model's correct "Glucose, Urine" and never snapping the
// ambiguous printed "GLUCOSE" onto the serum entry (#918 §2).

import canonicalSeed from "./canonical-biomarkers.json";
import { normalizeCanonicalKey, snapCanonicalName } from "./canonical-name";
import { sameUnit } from "./unit-conversions";

type SeedEntry = { name: string; unit?: string | null };

// Fold the ", Relative" (%) and ", Absolute" (count) differential forms onto a
// shared key so the two members of a %/count pair find each other. ONLY those two
// suffixes are stripped, so an unrelated comma name ("Vitamin D, 25-Hydroxy") keeps
// its own singleton stem and can never be mistaken for a sibling.
function stemKey(name: string): string {
  return normalizeCanonicalKey(
    name.replace(/,\s*(relative|absolute)\s*$/i, "")
  );
}

const UNIT_BY_KEY = new Map<string, string>();
const SIBLINGS_BY_STEM = new Map<string, { name: string; unit: string }[]>();
for (const b of (canonicalSeed as { biomarkers?: SeedEntry[] }).biomarkers ??
  []) {
  if (!b?.name || !b.unit) continue;
  const key = normalizeCanonicalKey(b.name);
  if (key && !UNIT_BY_KEY.has(key)) UNIT_BY_KEY.set(key, b.unit);
  const stem = stemKey(b.name);
  const list = SIBLINGS_BY_STEM.get(stem) ?? [];
  list.push({ name: b.name, unit: b.unit });
  SIBLINGS_BY_STEM.set(stem, list);
}

// The curated unit for a resolved name, or null when the name is not a seeded entry
// (an ai-coined name has no curated unit to judge against).
export function seededUnitFor(name: string): string | null {
  return UNIT_BY_KEY.get(normalizeCanonicalKey(name)) ?? null;
}

// Specimen counterparts that do NOT share a stem: the blood cell counts and their
// urine-sediment namesakes (#918). "WBC"/"RBC" print in both a CBC (a blood count,
// 10^3/uL) and a urinalysis (sediment, /HPF); the bare-abbreviation aliases route to
// the blood count, so when the reading's unit is the microscopy /HPF the guard must
// send it to the urine entry instead. Keyed by normalized name, both directions.
const SPECIMEN_COUNTERPART = new Map<string, string>();
for (const [a, b] of [
  ["White Blood Cell Count", "White Blood Cells, Urine"],
  ["Red Blood Cell Count", "Red Blood Cells, Urine"],
] as const) {
  SPECIMEN_COUNTERPART.set(normalizeCanonicalKey(a), b);
  SPECIMEN_COUNTERPART.set(normalizeCanonicalKey(b), a);
}

// Re-resolve `snapped` (the model's canonical_name AFTER snapping) when its seeded
// entry's unit provably contradicts the reading's unit. Returns a better canonical
// name, or `snapped` unchanged when there is no proven contradiction or no
// trustworthy alternative (the residual mismatch is surfaced separately, #918 §4).
export function unitAwareCanonical(
  snapped: string,
  printedName: string,
  readingUnit: string | null | undefined,
  vocabularyIndex: Map<string, string>
): string {
  if (!readingUnit) return snapped; // no unit → nothing to contradict
  const entryUnit = seededUnitFor(snapped);
  if (!entryUnit || sameUnit(readingUnit, entryUnit)) return snapped;

  // The snap lands on a seeded entry whose unit is incompatible with the reading.
  // 1) The same-analyte sibling whose unit fits (the %↔count collision). Each stem
  //    holds exactly one "%" and one count member, so at most one can fit.
  const inVocab = (n: string) => snapCanonicalName(n, vocabularyIndex) === n;
  const siblings = SIBLINGS_BY_STEM.get(stemKey(snapped)) ?? [];
  const fits = siblings.filter(
    (s) =>
      s.name !== snapped && sameUnit(readingUnit, s.unit) && inVocab(s.name)
  );
  if (fits.length === 1) return fits[0].name;

  // 1b) A cross-specimen counterpart (blood count ↔ urine sediment) whose unit fits —
  //     for pairs that don't share a stem (WBC/RBC).
  const counterpart = SPECIMEN_COUNTERPART.get(normalizeCanonicalKey(snapped));
  if (
    counterpart &&
    sameUnit(readingUnit, seededUnitFor(counterpart)) &&
    inVocab(counterpart)
  ) {
    return counterpart;
  }

  // 2) The printed name, ONLY if it snaps to a unit-compatible entry — a narrow,
  //    explicit rescue, never a blanket printed-name fallback (#918 §2).
  const alt = snapCanonicalName(printedName, vocabularyIndex);
  if (alt !== snapped) {
    const altUnit = seededUnitFor(alt);
    if (altUnit && sameUnit(readingUnit, altUnit)) return alt;
  }

  // 3) No trustworthy target — keep the model's resolution rather than guessing.
  return snapped;
}
