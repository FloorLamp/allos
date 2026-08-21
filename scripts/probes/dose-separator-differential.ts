// #3451 — the differential behind the PR's safety claim, committed so it can be re-run.
//
//   npx tsx scripts/probes/dose-separator-differential.ts > new.txt
//   git stash-free: check out a control worktree, run it there, diff the two files.
//
// It prints one line per input: the dose reading, the ingredient reading, the grouping
// name and the strength. The claim it exists to check is NOT "these values are right" —
// it is "no input gains a confident number it did not have on the control".
//
// AND THAT HEADLINE METRIC HAS A BLIND SPOT, WRITTEN HERE BECAUSE IT COST FOUR ROUNDS.
// "NEW CONFIDENT DOSE VALUE: 0" counts inputs that went from NO number to a number. The
// hyphen-binder defect was number -> WRONG number: "Omega-3<NBSP>500 mg" read 500 on main
// and 3500 here, a sevenfold overstatement the headline count cannot see. The secondary
// filter missed it too, for an instructive reason — it asked "is there a read separator
// between two digits", and there IS one; the left digit just belongs to the name. So the
// number that matters for THIS class is the CHANGED-VALUE count, and a changed value is
// benign only once you have checked which side of the separator its left digit came from.
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
// THE SURFACE IS TWO-DIMENSIONAL: binder x separator.
//
// Four rounds of this work swept ONE of those dimensions. Every prefix in the old list
// ended in a plain space or "(", so "Omega-3" appeared 12,341 times in the corpus and was
// never once followed by anything but U+0020 — which is exactly why a hyphen-bound name
// digit against an NBSP ("Omega-3<NBSP>500 mg" -> a confident 3500 mg) survived three
// lenses. A one-dimensional sweep over a two-dimensional surface cannot see the cells
// where both vary, and those are where the defects were.
//
// So the name STEM and the character that BINDS its trailing digit are separate axes now,
// and the cross-product is generated rather than listed.
const NAME_STEMS = [
  "Omega",
  "Vitamin B",
  "Folic Acid B",
  "Coenzyme Q",
  "B",
  "Sinemet",
  "Vitamin D",
];
const BINDERS = ["-", "\u2013", "_", "/", "", " "];
const DIGIT_TAILS = ["3", "12", "9", "10", "2", "6"];

const PREFIXES = [
  "",
  "Niacin ",
  "Vitamin C ",
  "Take ",
  "Metformin ",
  "1/2 ",
  "2 capsules (",
  "B12 ",
  "CoQ10 ",
  "Omega-3 ",
  "Vitamin B 12 ",
  "Sinemet 25 ",
  "PreserVision AREDS 2 ",
];
const LEFT = ["1", "12", "0", "100", "2", "5"];
const RIGHT = ["000", "00", "0000", "5", "500", "125", "1000"];
const TAIL = [" mg", " mcg", " IU", " g", " mg tablet", " mg tablets", " mg)"];

const seen = new Set<string>();
let count = 0;
let buffer: string[] = [];
const emit = (s: string) => {
  if (seen.has(s)) return;
  seen.add(s);
  count++;
  buffer.push(
    [
      JSON.stringify(s),
      JSON.stringify(readDoseQuantity(s)),
      JSON.stringify(readIngredientAmount(s)),
      JSON.stringify(cleanMedicationName(s)),
      JSON.stringify(strengthFromName(s)),
    ].join("\t")
  );
  if (buffer.length >= 5000) {
    process.stdout.write(buffer.join("\n") + "\n");
    buffer = [];
  }
};

// GRID A — prefix x leading run x separator x trailing run x unit tail.
for (const p of PREFIXES)
  for (const l of LEFT)
    for (const sep of SEPARATORS)
      for (const r of RIGHT)
        for (const t of TAIL) emit(`${p}${l}${sep}${r}${t}`);

// GRID B — THE BINDER AXIS, crossed with the separator axis. This is the grid whose
// absence hid the hyphen-binder defect through three lenses: the name's trailing digit is
// bound by something other than a plain space, and the separator after it varies
// independently.
for (const stem of NAME_STEMS)
  for (const b of BINDERS)
    for (const d of DIGIT_TAILS)
      for (const sep of SEPARATORS)
        for (const v of ["500", "1000", "400"])
          for (const t of [" mg", " mcg", " IU"])
            emit(`${stem}${b}${d}${sep}${v}${t}`);

// GRID C — EVERY code point in the BMP between two digit runs, so the separator claim is
// checked rather than asserted. Surrogates skipped.
for (let c = 0; c < 0x10000; c++) {
  if (c >= 0xd800 && c <= 0xdfff) continue;
  emit(`1${String.fromCodePoint(c)}000 mg`);
}

if (buffer.length) process.stdout.write(buffer.join("\n") + "\n");
console.error(`${count} inputs`);
