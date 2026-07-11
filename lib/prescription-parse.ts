// Pure parsing of an extracted `prescription`-category record into the fields a
// structured `kind='medication'` intake_items row needs. No DB
// access, so it's unit-tested in lib/__tests__/prescription-parse.test.ts.
//
// The extraction pipeline (lib/medical-extract) emits a prescription as a loose
// record: `name` (the drug), and free text spread across `value`/`unit`/`notes`
// (a strength like "10 mg" and/or a sig/directions like "1 tab PO daily"). We
// turn that into: a clean drug name, a per-dose strength, a schedule (how many
// times a day + which time buckets), whether it's PRN (as-needed), and any
// prescriber/pharmacy/Rx that a labelled note happens to carry.
//
// The guiding rule is CONSERVATIVE: only schedule a med when the sig clearly
// states a frequency. An unparseable/absent sig yields an as-needed med (which
// the schedule machinery never marks due — no reminders/escalation) rather than
// a fabricated daily reminder the document never actually prescribed.

import { parseDosage, spreadDoseTimes } from "./supplement-schedule";

// "as needed", "as required", "when needed", "prn" — a PRN med is taken on
// demand, so it carries no schedule.
const PRN_RE =
  /\b(as[\s-]+needed|as[\s-]+required|when[\s-]+needed|p\.?r\.?n\.?)\b/i;

// "every 8 hours" / "q8h" style interval dosing → doses per day = round(24 / n).
const EVERY_HOURS_RE = /\b(?:every|q)\s*(\d+)\s*(?:hours?|hrs?|h)\b/i;

// Route-of-administration abbreviations stripped from a parsed dose amount so a
// strength reads "1 tab", not "1 tab PO".
const ROUTE_RE =
  /\b(po|iv|im|sq|sc|sl|pr|top|inh|ophth|otic|nasal|by[\s-]+mouth|per[\s-]+os|orally|subcutaneous(?:ly)?|intramuscular(?:ly)?)\b/gi;

// A leading imperative verb ("take", "give", "apply", "inject", "use") that
// precedes the actual dose in a sig.
const LEAD_VERB_RE = /^\s*(take|takes|taking|give|apply|inject|use|instill)\b/i;

// A trailing strength/form segment on a drug NAME, e.g. the "10 mg" in
// "Lisinopril 10 mg" or "Metformin 500mg tablet". Used to derive a clean
// grouping name (so an extracted "Lisinopril 10 mg" dedups against a manual
// "Lisinopril") and to recover a strength when no separate value was extracted.
// The `\b` guards only the LETTER units (so "g" can't eat a "g..." word
// prefix); `%` sits outside it — `%` is a non-word char, so `%\b` would only
// match when a letter follows immediately ("2.5%cream"), never in a real
// percent strength like "Hydrocortisone 2.5%".
const NAME_STRENGTH_RE =
  /\s+\d+(?:\.\d+)?\s*(?:(?:mg|mcg|µg|ug|g|ml|iu|units?|meq)\b|%).*$/i;
const NAME_FORM_TAIL_RE =
  /\s+(tablets?|tabs?|capsules?|caps?|pills?|softgels?|lozenges?|patches?|sprays?|drops?|solution|suspension|injection|cream|ointment|gel|elixir|syrup)\b.*$/i;

// A frequency/timing token that makes a sig schedulable. Its ABSENCE (together
// with no interval and no PRN marker) is what flags a sig as unparseable, so we
// don't invent a daily schedule.
function hasFrequencyToken(text: string): boolean {
  return (
    /\b\d+\s*(?:x|times)\b/i.test(text) ||
    /\b(once|twice|thrice|three\s+times|four\s+times)\b/i.test(text) ||
    /\b(qd|bid|tid|qid|qhs|qam|qpm|od|hs|q\.?d\.?|b\.?i\.?d\.?|t\.?i\.?d\.?|q\.?i\.?d\.?)\b/i.test(
      text
    ) ||
    /\b(daily|nightly|every\s+day|per\s+day|a\s+day|each\s+day)\b/i.test(
      text
    ) ||
    /\b(morning|midday|noon|evening|night|bedtime|breakfast|lunch|dinner)\b/i.test(
      text
    )
  );
}

// A candidate amount is a real dose only when it pairs a number with a unit or a
// dosage form ("10 mg", "1 tab", "2 tablets", "5 mL"). Frequency prose ("every",
// "as needed for pain") has no such pairing and is discarded so it never lands
// in the strength field.
export function looksLikeDose(s: string | null | undefined): boolean {
  if (!s) return false;
  return (
    /\d/.test(s) &&
    /(mg|mcg|µg|ug|\bg\b|ml|iu|units?|meq|%|tab(?:let)?s?|caps?(?:ule)?s?|pills?|softgels?|lozenges?|puffs?|drops?|patch(?:es)?|sprays?|units?)/i.test(
      s
    )
  );
}

// Clean a parsed dose amount: strip route abbreviations and a leading verb, then
// keep it only if it still reads as a dose.
function cleanAmount(amount: string | null): string | null {
  if (!amount) return null;
  const cleaned = amount
    .replace(LEAD_VERB_RE, "")
    .replace(ROUTE_RE, " ")
    .replace(/[,;]+\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return looksLikeDose(cleaned) ? cleaned : null;
}

// Strip a trailing strength/form off a drug name to get a stable grouping name.
// Used for both the stored med name and for de-duping an extracted med against a
// manually-entered one (so "Lisinopril 10 mg" and "Lisinopril" are one med).
export function cleanMedicationName(raw: string): string {
  const name = (raw ?? "").trim();
  const stripped = name
    .replace(NAME_STRENGTH_RE, "")
    .replace(NAME_FORM_TAIL_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Never strip the name down to nothing — fall back to the original.
  return stripped || name;
}

// Pull the strength out of a drug name ("Lisinopril 10 mg" → "10 mg"), when the
// extractor packed it into the name instead of a separate value/unit. Same
// unit alternation as NAME_STRENGTH_RE: `%` lives outside the `\b`-terminated
// letter-unit group (see the comment there).
function strengthFromName(raw: string): string | null {
  const m = raw.match(
    /\b\d+(?:\.\d+)?\s*(?:(?:mg|mcg|µg|ug|g|ml|iu|units?|meq)\b|%)/i
  );
  return m ? m[0].replace(/\s{2,}/g, " ").trim() : null;
}

export interface ParsedSig {
  asNeeded: boolean;
  // Doses per day when the sig states a clear frequency; null when the frequency
  // couldn't be parsed (the med is then treated as as-needed / unscheduled).
  timesPerDay: number | null;
  amount: string | null; // per-dose amount embedded in the sig, if any
  timeBuckets: (string | null)[]; // one bucket per scheduled dose
}

// Parse a sig / directions string ("1 tab PO daily", "take 2 tablets twice
// daily", "as needed for pain", "every 8 hours") into a schedule. Reuses the
// dosage parser for the amount + per-day count, adds interval ("every N hours")
// and PRN handling, and — crucially — returns `timesPerDay: null` (unscheduled)
// when no frequency signal is present rather than defaulting to daily.
export function parseSig(sig: string | null | undefined): ParsedSig {
  const text = (sig ?? "").trim();
  if (!text) {
    return { asNeeded: true, timesPerDay: null, amount: null, timeBuckets: [] };
  }

  if (PRN_RE.test(text)) {
    return {
      asNeeded: true,
      timesPerDay: null,
      amount: cleanAmount(parseDosage(text).amount),
      timeBuckets: [],
    };
  }

  const d = parseDosage(text);
  const amount = cleanAmount(d.amount);

  let perDay: number | null = null;
  const everyH = text.match(EVERY_HOURS_RE);
  if (everyH) {
    const hrs = Number(everyH[1]);
    perDay = hrs > 0 ? Math.max(1, Math.round(24 / hrs)) : null;
  } else if (hasFrequencyToken(text)) {
    perDay = d.perDay; // parseDosage's per-day (defaults to 1 for "daily")
  }

  if (perDay == null) {
    // No parseable frequency — don't fabricate a schedule. Unscheduled/as-needed.
    return { asNeeded: true, timesPerDay: null, amount, timeBuckets: [] };
  }

  return {
    asNeeded: false,
    timesPerDay: perDay,
    amount,
    timeBuckets: spreadDoseTimes(perDay, d.timeOfDay),
  };
}

// Labelled provenance pulled from a note when clearly present. All optional and
// conservative — an unlabelled note yields nulls rather than a guess.
function matchLabelled(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*[:#]?\\s*([^;,\\n]+)`, "i");
    const m = text.match(re);
    if (m) {
      const v = m[1].trim().replace(/\s{2,}/g, " ");
      if (v) return v;
    }
  }
  return null;
}

function rxNumberFrom(text: string): string | null {
  const m = text.match(
    /\b(?:rx|prescription)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Za-z0-9-]{4,})\b/i
  );
  return m ? m[1].trim() : null;
}

function prescriberFrom(text: string): string | null {
  const labelled = matchLabelled(text, [
    "prescriber",
    "prescribed by",
    "ordered by",
    "provider",
    "physician",
    "doctor",
  ]);
  if (labelled) return labelled;
  const dr = text.match(
    /\bDr\.?\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})/
  );
  return dr ? `Dr. ${dr[1].trim()}` : null;
}

function pharmacyFrom(text: string): string | null {
  return matchLabelled(text, ["pharmacy", "filled at", "dispensed by"]);
}

export interface PrescriptionRecordInput {
  name: string;
  value?: string | null;
  unit?: string | null;
  notes?: string | null;
}

export interface ParsedPrescription {
  name: string; // cleaned drug/grouping name (never empty)
  strength: string | null; // per-dose strength for the dose row's `amount`
  asNeeded: boolean;
  timesPerDay: number | null;
  timeBuckets: (string | null)[];
  prescriber: string | null;
  pharmacy: string | null;
  rxNumber: string | null;
  sig: string | null; // the directions text we parsed (kept for the row's notes)
}

// Reduce an extracted prescription record to structured medication fields. The
// extractor doesn't have dedicated strength/sig/prescriber slots, so we treat the
// fields heuristically: a dose-shaped `value` is the strength; anything else in
// `value`/`notes` is the sig (and the source of prescriber/pharmacy/Rx labels).
export function parsePrescription(
  rec: PrescriptionRecordInput
): ParsedPrescription {
  const rawName = (rec.name ?? "").trim();
  const value = (rec.value ?? "").trim() || null;
  const unit = (rec.unit ?? "").trim() || null;
  const notes = (rec.notes ?? "").trim() || null;

  // Strength: an explicit dose-shaped value (+unit) wins; else recover it from
  // the drug name ("Lisinopril 10 mg").
  // Append the unit only when `value` doesn't already carry it. `unit` is
  // untrusted extracted text, so use a plain suffix check rather than building a
  // RegExp from it — a stray metacharacter (e.g. an unmatched ")") would throw
  // and abort the whole import transaction.
  const valueEndsWithUnit =
    !!unit &&
    value != null &&
    value.trimEnd().toLowerCase().endsWith(unit.toLowerCase());
  const valueWithUnit = value
    ? unit && !valueEndsWithUnit
      ? `${value} ${unit}`
      : value
    : null;
  const explicitStrength =
    valueWithUnit && looksLikeDose(valueWithUnit) ? valueWithUnit : null;

  // Sig: free-text directions. A dose-shaped value is a strength, not a sig, so
  // it's excluded; notes and a non-dose value are joined into the sig text.
  const sigParts: string[] = [];
  if (notes) sigParts.push(notes);
  if (value && !looksLikeDose(value)) sigParts.push(value);
  const sig = sigParts.join("; ") || null;

  const parsed = parseSig(sig);
  const strength =
    explicitStrength ?? strengthFromName(rawName) ?? parsed.amount ?? null;

  const provText = [notes, value].filter(Boolean).join("; ");

  return {
    name: cleanMedicationName(rawName),
    strength,
    asNeeded: parsed.asNeeded,
    timesPerDay: parsed.timesPerDay,
    timeBuckets: parsed.timeBuckets,
    prescriber: provText ? prescriberFrom(provText) : null,
    pharmacy: provText ? pharmacyFrom(provText) : null,
    rxNumber: provText ? rxNumberFrom(provText) : null,
    sig,
  };
}
