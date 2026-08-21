// #3451 — the differential behind the PR's safety claim, committed so it can be re-run.
//
//   npx tsx scripts/probes/dose-separator-differential.ts > new.txt
//   git stash-free: check out a control worktree, run it there, diff the two files.
//
// It prints one line per input: the dose reading, the ingredient reading, the grouping
// name and the strength. The claim it exists to check is NOT "these values are right" —
// it is "no input gains a confident number it did not have on the control".
import { readDoseQuantity } from "../../lib/dri";
import { readIngredientAmount } from "../../lib/intake-ingredients";
import {
  cleanMedicationName,
  strengthFromName,
} from "../../lib/prescription-parse";

const cp = (n: number) => String.fromCodePoint(n);

// Every separator class the rule distinguishes, plus the ones it deliberately does not.
const SEPARATORS = [
  " ",
  "  ",
  "\t",
  " \t",
  ",",
  ".",
  "-",
  "/",
  "_",
  "",
  " -",
  "- ",
  " _",
  " /",
  ", ",
  cp(0xa0),
  cp(0x202f),
  cp(0x2009),
  cp(0x2007),
  cp(0x2019),
  "'",
  cp(0x66c),
  cp(0x2032),
  cp(0x2bc),
  cp(0xa0) + cp(0xa0),
  cp(0xa0) + " ",
  cp(0xad),
  cp(0x200b),
  cp(0x200c),
  cp(0x200d),
  cp(0x2060),
  cp(0xfeff),
  cp(0x1680),
  cp(0x200e),
  cp(0x85),
  cp(0x2066),
  cp(0x2003),
  cp(0x205f),
  cp(0x3000),
  cp(0x2013),
  "×",
  " × ",
];
// Real product-name prefixes, including every shape that ends in a digit.
const PREFIXES = [
  "",
  "Niacin ",
  "Vitamin C ",
  "Take ",
  "Metformin ",
  "B12 ",
  "CoQ10 ",
  "Vitamin D3 ",
  "Omega-3 ",
  "Omega 3 ",
  "Vitamin B 12 ",
  "Vitamin B 6 ",
  "Sinemet 25 ",
  "Humulin 70 30 ",
  "PreserVision AREDS 2 ",
  "Coenzyme Q 10 ",
  "1/2 ",
  "2 capsules (",
];
const LEFT = ["1", "12", "0", "100", "2", "5"];
const RIGHT = ["000", "00", "0000", "5", "500", "125", "1000"];
const TAIL = [" mg", " mcg", " IU", " g", " mg tablet", " mg tablets", " mg)"];

const seen = new Set<string>();
const rows: string[] = [];
const emit = (s: string) => {
  if (seen.has(s)) return;
  seen.add(s);
  rows.push(
    [
      JSON.stringify(s),
      JSON.stringify(readDoseQuantity(s)),
      JSON.stringify(readIngredientAmount(s)),
      JSON.stringify(cleanMedicationName(s)),
      JSON.stringify(strengthFromName(s)),
    ].join("\t")
  );
};
for (const p of PREFIXES)
  for (const l of LEFT)
    for (const sep of SEPARATORS)
      for (const r of RIGHT)
        for (const t of TAIL) emit(`${p}${l}${sep}${r}${t}`);

// EVERY code point that could sit between two digit runs, so the claim about the
// separator class is checked rather than asserted. Surrogates skipped.
for (let c = 0; c < 0x10000; c++) {
  if (c >= 0xd800 && c <= 0xdfff) continue;
  emit(`1${String.fromCodePoint(c)}000 mg`);
}

console.log(rows.join("\n"));
console.error(`${rows.length} inputs`);
