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
import { readDoseQuantity, readGroupedNumber } from "./dri";

export type DoseAmountCensusBucket =
  // No number+unit in the string at all ("1 capsule") — never affected, then or now.
  | "no-quantity"
  // Reads the same before and after the fix — the overwhelming majority.
  | "always-correct"
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
const EVERY_QUANTITY_RE = /(\d+(?:[.,]\d+)*)\s*(mcg|µg|ug|mg|g|iu)\b/gi;

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
  const now = readDoseQuantity(amount);
  if (now.kind === "none") return "no-quantity";
  if (now.kind === "unreadable") {
    return recoverableCandidates(amount).length > 0
      ? "unreadable-recoverable"
      : "unreadable-unrecoverable";
  }
  const before = preFixDoseReading(amount);
  if (before && before.value === now.value && before.unit === now.unit) {
    return "always-correct";
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
  "no-quantity",
  "recovered-from-zero",
  "recovered-from-wrong",
  "unreadable-recoverable",
  "unreadable-unrecoverable",
];

export const DOSE_AMOUNT_CENSUS_LABELS: Record<DoseAmountCensusBucket, string> =
  {
    "always-correct": "read the same before and after — untouched",
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
