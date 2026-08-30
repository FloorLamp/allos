// The dose-amount census (#3320). PURE, no DB — `scripts/dose-amount-census.ts` is the
// CLI that feeds it rows.
//
// WHAT IT MEASURES. Before #3153's write-path fix (`fbd72cf5`), the dose scan read
// `\d+(?:\.\d+)?`, which cannot span a comma: on "1,000 mg" it matched the "000" and
// returned a confident ZERO. Rows typed under that scan are still stored — and, because
// a dose row keeps ONLY the text that was typed (`intake_item_doses.amount TEXT`, and
// no migration has ever added a numeric column beside it), nothing wrong was ever
// written to disk. The fabricated zero was computed fresh on every read. So the fix
// repaired every recoverable row the moment it merged, and what remains is the set of
// amounts that read as ABSENT today — honest, but silent, which is what the census
// counts and what the `dose-amount-unreadable` data-quality gap surfaces.
//
// THE RULE IS IMPORTED, NEVER RESTATED. Every classification calls the shipped
// `readDoseQuantity` / `readGroupedNumber`. A SQL or regex copy would be a second
// version of the rule #3153 finished unifying, and a census that disagrees with the
// engine it describes is worse than no census.
//
// WHAT IT MEASURES IS THE STORED STRING, AND THAT IS ITS WHOLE SCOPE (#3444).
//
// Worth stating, because this census once reported a clean population over rows where a
// number had been fabricated. It was not misclassifying them: it was reading a string
// that had ALREADY been rewritten before it reached the column. The medication import
// parsed "Bisoprolol 2,5 mg" with a grammar that could not span a comma, stored "5 mg",
// and `classifyDoseAmount("5 mg")` correctly answered `always-correct` — because "5 mg"
// IS read the same before and after #3153. Both halves of that are true and the
// population was still wrong.
//
// The moral is about SCOPE, not accuracy. This census answers "what does the text in
// this column read as, before the fix and after". It cannot answer "does that text say
// what the document said", because the document is not in its hand. That question lives
// on the write path and is guarded there now (lib/prescription-parse.ts, swept by
// lib/__tests__/dose-number-readers.test.ts).
//
// ROWS IMPORTED BEFORE #3444 STILL CARRY THE REWRITE, and this census will go on
// calling them `always-correct` — honestly, because as strings they are. They are not
// unfindable, though: the item kept the NAME the strength was taken from, so running
// the corrected `strengthFromName` over `intake_items.name` and comparing it with the
// dose row's `amount` identifies them exactly. Nothing here does that, and no repair is
// implied by it. A comma decimal is the shape this file's own rule refuses to resolve,
// so the fix is a person confirming their own label — never a migration guessing one.
import { readDoseQuantity, readGroupedNumber, DOSE_NUMBER_SCAN } from "./dri";

export type DoseAmountCensusBucket =
  // No number+unit in the string at all ("1 capsule") — never affected, then or now.
  | "no-quantity"
  // Reads the same before and after the fix — the overwhelming majority.
  | "always-correct"
  // Both readers agree, but the shipped scan restarted inside a written token.
  | "agreement-without-certificate"
  // Read as ZERO before the fix, correct now. The alarming bucket, and already
  // repaired: "1,000 mg" of niacin contributed nothing to a total 28x over the UL.
  | "recovered-from-zero"
  // Read as some OTHER wrong number before the fix, correct now.
  | "recovered-from-wrong"
  // Unreadable now, but the string restates its own dose somewhere ("2,5 g (2500 mg)")
  // — a candidate a person can CONFIRM. Never auto-applied: a second string in the
  // same field is not a second opinion.
  | "unreadable-recoverable"
  // Unreadable, with no recoverable original anywhere in the row. Only the person who
  // typed it can repair it, and nothing may guess which reading was meant.
  | "unreadable-unrecoverable";

// The pattern the dose scan used BEFORE `fbd72cf5` — kept here, and ONLY here, to
// answer "what did this row read as yesterday". It is the artifact being measured, not
// a rule anything else may reach for.
const PRE_FIX_DOSE_RE = /(\d+(?:\.\d+)?)\s*(mcg|µg|ug|mg|g|iu)\b/i;

export function preFixDoseReading(
  amount: string | null
): { value: number; unit: string } | null {
  if (!amount) return null;
  const m = amount.match(PRE_FIX_DOSE_RE);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const u = m[2].toLowerCase();
  return { value, unit: u === "µg" || u === "ug" ? "mcg" : u };
}

// Every unambiguous number+unit anywhere in the string, in order. An unreadable amount
// whose parenthetical restates the dose has a recoverable original sitting in the row;
// one that does not is a row only a person can repair.
//
// GUARDED WITH THE SHARED SCAN, and this one is not decoration (#3444). What this
// function returns is offered to a PERSON as the reading they might confirm, so a
// fabricated candidate is worse than no candidate at all — it is a wrong dose with a
// button next to it. Spelled with its own unguarded scan, it read ".125 mg" as a
// recoverable "125 mg": the census would have looked at a naked decimal, declared the
// row repairable, and proposed the exact thousandfold number the guard exists to
// prevent. Caught by the DB tier when the naked-decimal rows were added, not by
// inspection. `PRE_FIX_DOSE_RE` above stays unguarded on purpose — it answers what the
// row read as YESTERDAY, and yesterday had no guard.
const EVERY_QUANTITY_RE = new RegExp(
  String.raw`(${DOSE_NUMBER_SCAN})\s*(mcg|µg|ug|mg|g|iu)\b`,
  "gi"
);

export function recoverableCandidates(amount: string | null): string[] {
  if (!amount) return [];
  const out: string[] = [];
  for (const m of amount.matchAll(EVERY_QUANTITY_RE)) {
    if (readGroupedNumber(m[1]) != null) out.push(m[0].trim());
  }
  return out;
}

export function classifyDoseAmount(
  amount: string | null
): DoseAmountCensusBucket {
  const now = readDoseQuantity(amount, { structuralSoundness: true });
  if (now.kind === "none") return "no-quantity";
  if (now.kind === "unreadable") {
    return recoverableCandidates(amount).length > 0
      ? "unreadable-recoverable"
      : "unreadable-unrecoverable";
  }
  const before = preFixDoseReading(amount);
  if (before && before.value === now.value && before.unit === now.unit) {
    return now.structurallySound
      ? "always-correct"
      : "agreement-without-certificate";
  }
  return before && before.value === 0
    ? "recovered-from-zero"
    : "recovered-from-wrong";
}

export interface DoseAmountCensusRow {
  amount: string | null;
  // Retired rows are split out because only LIVE rows reach the nutrient totals — a
  // retired unreadable dose is a history-display concern, not a safety one, and the
  // two are different severities.
  retired: boolean;
}

export interface DoseAmountCensus {
  rows: number;
  buckets: Record<DoseAmountCensusBucket, { live: number; retired: number }>;
  // Distinct amount strings per bucket with their row counts, commonest first.
  // AMOUNT STRINGS AND COUNTS ONLY — never an item name or a profile id. A dose
  // amount is a label quantity; a product name beside a person is not this census's
  // business.
  samples: Record<DoseAmountCensusBucket, { amount: string; rows: number }[]>;
}

export const DOSE_AMOUNT_CENSUS_BUCKETS: DoseAmountCensusBucket[] = [
  "always-correct",
  "agreement-without-certificate",
  "no-quantity",
  "recovered-from-zero",
  "recovered-from-wrong",
  "unreadable-recoverable",
  "unreadable-unrecoverable",
];

export const DOSE_AMOUNT_CENSUS_LABELS: Record<DoseAmountCensusBucket, string> =
  {
    "always-correct": "read the same before and after — untouched",
    "agreement-without-certificate":
      "read the same, but from a number fragment — inspect before trusting",
    "no-quantity": 'no number+unit at all ("1 capsule") — never affected',
    "recovered-from-zero":
      "was read as ZERO, now correct — repaired by the write-path fix",
    "recovered-from-wrong":
      "was read WRONG (non-zero), now correct — repaired by the write-path fix",
    "unreadable-recoverable":
      "unreadable, but the row restates a usable amount",
    "unreadable-unrecoverable":
      "unreadable, NO recoverable original — only the person can repair it",
  };

export function censusDoseAmounts(
  rows: readonly DoseAmountCensusRow[]
): DoseAmountCensus {
  const buckets = Object.fromEntries(
    DOSE_AMOUNT_CENSUS_BUCKETS.map((b) => [b, { live: 0, retired: 0 }])
  ) as DoseAmountCensus["buckets"];
  const seen = new Map<DoseAmountCensusBucket, Map<string, number>>();
  for (const row of rows) {
    const bucket = classifyDoseAmount(row.amount);
    if (row.retired) buckets[bucket].retired++;
    else buckets[bucket].live++;
    const byText = seen.get(bucket) ?? new Map<string, number>();
    const key = row.amount ?? "(null)";
    byText.set(key, (byText.get(key) ?? 0) + 1);
    seen.set(bucket, byText);
  }
  const samples = Object.fromEntries(
    DOSE_AMOUNT_CENSUS_BUCKETS.map((b) => [
      b,
      [...(seen.get(b) ?? new Map<string, number>())]
        .map(([amount, n]) => ({ amount, rows: n }))
        .sort((x, y) => y.rows - x.rows || x.amount.localeCompare(y.amount)),
    ])
  ) as DoseAmountCensus["samples"];
  return { rows: rows.length, buckets, samples };
}
