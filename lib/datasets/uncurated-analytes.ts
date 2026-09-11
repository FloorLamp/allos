// The DELIBERATELY-UNCURATED ANALYTE REGISTRY (#2313), loaded onto the curated-dataset
// framework (issue #860 Track B, moved here from lib/canonical-name.ts by #5175).
// Copies the nutrient-food-map.ts shape: import the envelope JSON, validate it once
// with loadDataset(), build the key index, and expose `uncuratedAnalyte` /
// `uncuratedAnalytes`. The registry lists this dataset for the linter. Pure — no DB,
// no network.
//
// THE SPLIT (the same one lib/datasets/lifts.ts uses for the variant product): the
// JSON declares the DEXA regions, compartments and scan-level rows; the code below
// declares the PRODUCT. A (prefix × region) grid is a generator, not a table — writing
// ~130 composed rows out by hand is how one region quietly goes missing.
//
// CANONICAL_ALIASES (in lib/canonical-name.ts) declares the names we DO route. This
// declares the other half: names we have decided NOT to curate, and why. That decision
// already existed — it is the "NOT aliased, on purpose" prose in that module — but only
// as a source comment, so every surface that meets one of these names had to guess. The
// import debugger guessed wrong in the way that costs somebody something: it counted a
// settled question as outstanding work and offered a "Report unresolved analyte" link
// that files a public duplicate of a decision this repo already made.
//
// Two rules from elsewhere in the codebase, applied here:
//
//   • MetricKnowledge's `{ source: "none"; reason: string }` — the reason is
//     MANDATORY, because saying it out loud is the point. A reader who sees an
//     eGFR variant listed as "unresolved" reasonably concludes their kidney
//     function is untracked. It isn't; it is tracked better. Only the reason can
//     say so, and a declaration without one would silently inherit "unjudged".
//   • FreshnessState's `not-applicable`, which must never fold into `due`. A
//     deliberately-uncurated analyte is not a to-do, and counting it as one
//     overstates the work outstanding.
//
// Keyed by normalizeCanonicalKey, exactly like the aliases, so spelling, casing
// and word-order variants of a declared name collapse onto one declaration.
//
// This registry is NOT the debugger's: it answers "has this repo decided not to
// curate this analyte?", which is a question about the analyte. Any surface that
// would otherwise present one of these names as an open gap reads it through
// `uncuratedAnalyte` — no per-surface copy of the list, and no per-surface
// opinion about what the decision means.
//
// ── Curation rationale ───────────────────────────────────────────────────────
// The reasoning that used to sit as comments beside the literals. JSON carries no
// comments, so it lives here, next to the loader that owns the data. Nothing below is
// new; #5175 moved the table, not a single decision.
//
// `egfr-race-branched` — the three race/ethnicity-branched eGFR equations share ONE
//   declaration: they are the same decision, made once. The reason is written FOR A
//   USER, not for a maintainer — it is the sentence that turns "your kidney function is
//   unresolved" into "your kidney function is measured a better way". Its `instead` is
//   the CURATED name, not the bare spelling (#2335 renamed it): `instead` is the one
//   field here that must resolve against the dataset — the completeness guard checks
//   it, and the debugger LINKS to it — so it cannot ride the retired-spelling alias the
//   way an incoming document may. A bare "eGFR" would have dangled.
//
// `toxicology-screen` — not a thing this app models as a biomarker at all.
//
// `dexa-decomposition` — a DEXA scan's own decomposition (#2319), the largest single
//   family of uncatalogued items in a real profile, on the order of fifty distinct
//   labels from one machine. One scan prints a fat percentage, a bone mineral density
//   and a compartment mass for every region it segments the body into; those rows are
//   the SCAN's output, not fifty analytes anybody draws independently. There is no
//   population reference band for left-arm fat percentage and there never will be, so
//   "curating" them would mean inventing ranges — and until this declaration existed,
//   every one of them was presented as something the user might track or ask to have
//   catalogued, which is a standing invitation to request work that must never happen.
//
//   `out-of-scope`, not `covered-elsewhere`: the whole-body totals ARE curated ("Body
//   Fat Percentage", "Bone Mineral Density T-Score"), but a region is not its total, so
//   pointing a reader at the total would claim their left arm is tracked when it isn't.
//   Nothing here is a to-do; the rows are imported and stay visible on the scan's own
//   document.
//
// `meta.dexa.fatRegions` — the regions a DEXA report segments for FAT distribution.
//   Android/Gynoid are the abdominal and hip depots; Subtotal is whole-body-minus-head.
//   "Total" is absent on purpose — the whole-body number IS the curated "Body Fat
//   Percentage".
//
// `meta.dexa.boneRegions` — the skeletal sites a DEXA report prints a density and a
//   mineral content for. "Total" is absent for the same reason as above: whole-body
//   bone density is what the curated T-score expresses, and a site is not the skeleton.
//   That is a statement about which LIST the total belongs in, not permission to leave
//   the name undeclared — see `dexa-total-bmd`, and "Bone Mineral Content, Total" in
//   `meta.dexa.scanLevel`.
//
//   The two rows a site prints take DIFFERENT declarations (#2765). The mineral CONTENT
//   rides `dexa-decomposition` with the rest of the grid; the DENSITY rows take
//   `dexa-site-bmd`. See that declaration for why, and for the audit that separated them.
//
// `meta.dexa.massRegions` / `massCompartments` — the compartment-mass grid: a region ×
//   a tissue compartment, in grams. Reports print the unit inside the name as often as
//   not, and normalizeCanonicalKey keeps "(g)" as a token, so both spellings are
//   declared rather than guessed at.
//
//   The LIMBS were missing here until #2643, while both sibling lists carried them —
//   which is exactly the failure the cross product was built to prevent, arriving in
//   the one list nobody re-read. `Body Fat Percentage, Left Arm` and `Bone Mineral
//   Density, Left Arm` were declared, `Fat Mass, Left Arm` was not, so one third of a
//   scan's limb rows sat under Data → Coverage → Uncatalogued items forever. A limb's
//   compartment mass is the same decision as its fat percentage, made in the same
//   machine's same table. The `Arms`/`Legs` pair-totals come with them for the same
//   reason they are in the fat and bone lists: a report prints the pair as a row.
//
// `meta.dexa.scanLevel` — the scan-level rows that aren't per-region: whole-scan mass
//   compartments and the remaining derived depot ratios. Same decision, same reason —
//   each is arithmetic over one scan's segments, and none has a population band of its
//   own.
//
//   "Fat Mass Index" and "Lean Mass Index" USED to be listed here and are not any more
//   (#2322). They failed this declaration's own test: they are not arithmetic over a
//   scan's SEGMENTS but over the whole body and the subject's HEIGHT, which is what
//   makes them comparable between people — and both have published population
//   references (Schutz 2002 / NHANES DXA, Kelly 2009), which "no population reference
//   range exists for them" flatly denied. The dataset was already carrying the proof:
//   "Appendicular Lean Mass Index" has been a curated kg/m2 entry all along. They are
//   curated entries now, so the completeness guard would fail if either name were left
//   declared here as well.
//
//   "Trunk to Limb Fat Mass Ratio" joined in #2643. It is a second depot ratio beside
//   "Trunk to Legs Fat Ratio" — a different denominator (all four limbs rather than the
//   legs), the same arithmetic over the same scan's segments — and a report that prints
//   one often prints both.
//
//   "Bone Mineral Density Z-Score" left in #2679 — the THIRD time this one sentence was
//   found false of a member (#2322 for the two mass indices, #2675 declining to extend
//   it to "Bone Mineral Density, Total"). A Z-score IS an age- and sex-matched
//   population reference; "no population reference range exists for them" states the
//   opposite of what the value is, and the reason is shown to the reader as why their
//   marker isn't curated. See `dexa-bmd-z-score`. Every remaining member of this list
//   was re-read against both clauses of that sentence in the same pass.
//
// `dexa-android-gynoid-ratio` — arithmetic over two regions of one scan, not an
//   independently measured analyte.
//
// `dexa-total-bmd` — the whole-body BONE DENSITY a DEXA prints in g/cm², which #2643
//   found stranded beside the mass limbs — but which is NOT the same decision, and
//   putting it on `dexa-decomposition` would have repeated #2322 word for word. That
//   declaration's reason says "no population reference range exists for them";
//   whole-body bone density is the ONE DEXA number that has nothing BUT a population
//   reference, because the T-score IS that comparison. The absolute g/cm² is not
//   comparable between scanners, which is why the standardized score is what the app
//   curates and what a clinician reads — so the quantity is tracked, under the other
//   identity. That is precisely what `boneRegions`' note already said ("whole-body bone
//   density is what the curated T-score expresses"); the list simply never emitted a
//   declaration for the name, so the comment protected nothing.
//
// `dexa-bmd-z-score` — the OTHER standardization of that same whole-body density
//   (#2679), and the third time `dexa-decomposition`'s sentence was found false of a
//   member it was covering. The curation call is written out here because the next
//   reader will ask it again.
//
//   A DEXA measures one bone mineral density and prints two standardizations of it. The
//   T-score counts standard deviations from PEAK YOUNG-ADULT bone; the Z-score counts
//   them from AGE- AND SEX-MATCHED PEERS. One measurement, two reference populations,
//   diverging with age by construction: at seventy a T-score of -2.5 and a Z-score of
//   0.0 can describe the same skeleton.
//
//   `covered-elsewhere` → the T-score, on exactly the argument #2675 made for the
//   absolute g/cm²: all three are the same measurement, so the quantity IS tracked and
//   there is something real to point at. This is not the `stress-test-peak-vitals` false
//   promise, where a peak reading has no resting series it could belong to — a reader
//   who follows this link lands on their own bone density from their own scan. An
//   `out-of-scope` declaration whose reason then named the T-score would be this shape
//   wearing the other one's clothes, and would drop the link the reader wants.
//
//   NOT curated as a second entry — the alternative shape — and the reason is a property
//   of this app rather than of the clinic: a Z-score is age-adjusted, so it holds steady
//   while you lose bone at the population rate. A longitudinal tracker that plotted it
//   would draw a flat line straight through the decline it exists to surface. The
//   T-score's reference is fixed, so it moves when the bones do, and it is the score the
//   WHO thresholds (−1.0 osteopenia, −2.5 osteoporosis) in the curated entry's band are
//   defined on. Curating both would also put two lines on one measurement that separate
//   for a reason that is not bone.
//
//   The wrinkle, recorded rather than buried: the ISCD reads bone density by Z-score
//   rather than T-score below age 50 and before menopause, where Z ≤ −2.0 ("below the
//   expected range for age") prompts a workup for secondary causes. That is an argument
//   about whether the CURATED T-score entry's band should be life-stage aware, not about
//   this name deserving its own series, and it is left open rather than settled here.
//
// `dexa-site-bmd` — the PER-SITE bone densities (#2765), and the fourth member
//   `dexa-decomposition`'s sentence was found wrong of. Its second clause — "no
//   population reference range exists for them" — is the one that fails: bone density is
//   the quantity population references are BUILT for, and the lumbar spine is the site
//   the WHO thresholds are most often read at. Telling a reader no reference exists for
//   their spine density is the #2322 / #2675 / #2679 mistake in its fourth costume.
//
//   THE AUDIT, passes included, because a list of only its hits cannot be told from one
//   that stopped early. Each site prints TWO rows, and they are not the same decision:
//
//     • "Bone Mineral Density, <site>" — 18 rows, ALL MOVED HERE. g/cm² is what a
//       T- and Z-score standardize; a reason may not deny that standard exists.
//     • "Bone Mineral Content, <site>" — 18 rows, ALL PASS, left on `dexa-decomposition`.
//       Grams of mineral in one region is a compartment mass like "Trunk Fat Mass", and
//       both of that sentence's clauses are true of it: it is a per-region decomposition
//       output, and there is no population band for pelvic mineral content. Nothing
//       standardizes it, so nothing is being denied.
//
//   Moved as ONE block rather than site by site. "Head" and "Left Ribs" have no
//   standardized score either, so a per-site taxonomy of which sites are clinical would
//   be a second judgement on top of the one this fixes — and the sentence in the reason
//   is true of every site in the grid, which is the property that matters.
//
//   `out-of-scope`, NOT `covered-elsewhere` → the curated T-score. That is the line
//   `dexa-decomposition`'s own note already draws: a region is not its total, so an
//   `instead` here would promise the reader their spine is tracked when the score Allos
//   trends is the whole skeleton's. The reason may NAME the T-score — that is where
//   their bone density is read — without claiming this row routes to it.
//
//   LEFT OPEN, deliberately, and not decided here: whether Allos should curate
//   SITE-SPECIFIC T- and Z-scores (spine and hip diverge, and a whole-body number can
//   hide a hip that has crossed a threshold). If it ever does, these rows become
//   `covered-elsewhere` pointing at them and this declaration goes away. Repairing the
//   sentence does not foreclose that.
//
// `dexa-vat-alternate-unit` — VAT area (cm²) and VAT volume (cm³) are the SAME
//   visceral-fat estimate the curated "Visceral Adipose Tissue" entry carries as a mass
//   — one scan-derived number a report prints in three units, related by an assumed
//   tissue density. So this is the `covered-elsewhere` shape, not the out-of-scope one:
//   there is a real series to point at, and the reason states the unit difference rather
//   than implying the numbers can be compared.
//
// `stress-test-resting-systolic` / `stress-test-resting-diastolic` /
// `stress-test-peak-vitals` — the stress test's own vitals (#2322 Group 1). A treadmill
//   report prints a blood pressure and a heart rate twice — once at rest before the
//   test, once at peak effort — and both halves arrive with a "Stress Test" prefix in
//   exactly the units the curated vitals already use. Curating either half would FORK
//   the blood-pressure and heart-rate series, which is the trap `Neutrophils Relative`
//   fell into, so neither is curated. But the two halves are declined for OPPOSITE
//   reasons, and collapsing them into one declaration is what would make the promise
//   false.
//
//   The RESTING half genuinely IS the resting series: the prefix names the VISIT, not a
//   different measurement, so it points at the entry that carries it. Systolic and
//   diastolic are two declarations because they point at two different curated entries;
//   the sentence they share is one sentence, written once in the data.
//
//   The PEAK half is NOT the resting series, and pointing it at one would be a false
//   promise — the specific failure `instead` is guarded against. A peak-exercise blood
//   pressure belongs beside no resting reading, and the highest heart rate you reached
//   on a treadmill is the opposite of a resting heart rate. Whether peak-exercise vitals
//   deserve a series of their own is a design question about what the app models, not a
//   name the catalog can settle, so they are `out-of-scope` — the shape that says
//   "nothing to point at" instead of inventing a target.

import rawUncurated from "./data/uncurated-analytes.json";
import { loadDataset } from "./loader";
import { fieldStrategy } from "./matcher";
import { normalizeCanonicalKey } from "@/lib/canonical-name";

// A decision NOT to curate an analyte. The shape the three consumers read; it stays
// exactly what lib/canonical-name.ts exported before #5175.
export type UncuratedAnalyte =
  // The quantity IS tracked — under a different identity. `instead` names the
  // canonical entry that carries it, so a surface can point at the real series
  // rather than leaving the reader to deduce that one exists. The completeness
  // guard pins that the target is a real curated entry: a dangling `instead`
  // promises a series that doesn't exist.
  | { kind: "covered-elsewhere"; instead: string; reason: string }
  // Not a thing this app models as a biomarker at all.
  | { kind: "out-of-scope"; reason: string };

// One dataset entry: a DECISION, its user-facing reason, and the print spellings it
// covers directly (`names`). An entry with no `names` is fed by the DEXA generator
// below instead — its spellings are minted from `meta.dexa`, not listed.
export interface UncuratedAnalyteEntry {
  id: string;
  kind: UncuratedAnalyte["kind"];
  instead?: string;
  reason: string;
  names?: string[];
}

// The DEXA tables the generator expands. `Record<keyof …, string[]>` below is the
// COMPILE-TIME TOTALITY check the in-code `const DEXA_* = [...]` declarations used to
// buy: TypeScript infers the imported JSON's exact key set, so a list added here but
// not to the JSON (or renamed in one place only) fails to typecheck AT THE BOUNDARY
// rather than resolving to `undefined` and silently minting nothing.
export interface DexaGrid {
  fatRegions: string[];
  boneRegions: string[];
  massRegions: string[];
  massCompartments: string[];
  scanLevel: string[];
}

export interface UncuratedAnalytesMeta {
  dexa: DexaGrid;
}

// The validated dataset (envelope + guarantees). Throws at module load if the committed
// JSON ever violates the contract — a loud, early failure.
export const uncuratedAnalytesDataset = loadDataset<
  UncuratedAnalyteEntry,
  UncuratedAnalytesMeta
>(rawUncurated);

// Identity strategy: the decision's stable `id`, case-folded.
export const uncuratedAnalyteIdStrategy = fieldStrategy("id");

// The DEXA tables, read off the raw import so the `satisfies` sees the JSON's own key
// set (a cast on the loaded dataset would erase it). See DexaGrid above.
const DEXA: DexaGrid = rawUncurated.meta.dexa satisfies Record<
  keyof DexaGrid,
  string[]
>;

// The declaration objects, ONE per entry and SHARED by every name it covers: the three
// race-branched eGFR equations are one decision, so they must be one object — surfaces
// and tests compare declarations by identity to say "same decision".
const DECLARATIONS = new Map<string, UncuratedAnalyte>(
  uncuratedAnalytesDataset.entries.map((e) => [
    e.id,
    e.kind === "covered-elsewhere"
      ? { kind: e.kind, instead: e.instead ?? "", reason: e.reason }
      : { kind: e.kind, reason: e.reason },
  ])
);

// A generator-fed declaration by id. Throws rather than minting rows against
// `undefined`: an id the JSON no longer carries must fail loudly at module load.
function declaration(id: string): UncuratedAnalyte {
  const d = DECLARATIONS.get(id);
  if (!d) {
    throw new Error(`uncurated-analytes: no entry with id "${id}"`);
  }
  return d;
}

const DEXA_DECOMPOSITION = declaration("dexa-decomposition");
const DEXA_SITE_BMD = declaration("dexa-site-bmd");

// Expanded rather than hand-listed: the family is a cross product, and writing ~80
// literal rows is how one region quietly goes missing. The expansion emits the same
// `[name, declaration]` pairs the dataset's own `names` are read into, so the
// completeness guard walks every generated name exactly as it walks a declared one.
//
// It emits TWO declarations, not one (#2765): the per-site bone DENSITY rows carry
// `dexa-site-bmd`, everything else carries `dexa-decomposition`. The cross product is
// still what mints the names — which row gets which sentence is the only thing that
// varies, so a site added to `meta.dexa.boneRegions` still cannot go undeclared.
function dexaDecompositionRows(): [string, UncuratedAnalyte][] {
  const rows: [string, UncuratedAnalyte][] = [];
  const decomposed = (name: string) => rows.push([name, DEXA_DECOMPOSITION]);
  for (const region of DEXA.fatRegions)
    decomposed(`Body Fat Percentage, ${region}`);
  for (const region of DEXA.boneRegions) {
    rows.push([`Bone Mineral Density, ${region}`, DEXA_SITE_BMD]);
    decomposed(`Bone Mineral Content, ${region}`);
  }
  for (const region of DEXA.massRegions)
    for (const compartment of DEXA.massCompartments)
      decomposed(`${region} ${compartment} Mass`);
  for (const name of DEXA.scanLevel) decomposed(name);
  // The gram-suffixed print form of every mass row, carrying its own row's
  // declaration. A ratio, an index, a percentage and a density are not masses, so
  // they get no "(g)" twin.
  const withUnits: [string, UncuratedAnalyte][] = [
    ...rows,
    ...rows
      .filter(([name]) => name.endsWith(" Mass"))
      .map(([name, d]): [string, UncuratedAnalyte] => [`${name} (g)`, d]),
  ];
  // De-duped by the key the registry is keyed on, so an overlap between the cross
  // product and the scan-level list can never mint two rows for one decision.
  const byKey = new Map(
    withUnits.map((row) => [normalizeCanonicalKey(row[0]), row] as const)
  );
  return [...byKey.values()];
}

// Every declared spelling with its decision: the dataset's own `names`, in entry order,
// then the DEXA cross product.
const UNCURATED_ANALYTES: [string, UncuratedAnalyte][] = [
  ...uncuratedAnalytesDataset.entries.flatMap(
    (e): [string, UncuratedAnalyte][] =>
      (e.names ?? []).map((name) => [name, declaration(e.id)])
  ),
  ...dexaDecompositionRows(),
];

const UNCURATED_BY_KEY = new Map<string, UncuratedAnalyte>(
  UNCURATED_ANALYTES.map(([name, decl]) => [normalizeCanonicalKey(name), decl])
);

// THE lookup. "Have we decided not to curate this analyte?" — null means no such
// decision exists, which is genuinely-not-curated-yet and stays actionable.
export function uncuratedAnalyte(
  name: string | null | undefined
): UncuratedAnalyte | null {
  const key = name ? normalizeCanonicalKey(name) : "";
  return (key && UNCURATED_BY_KEY.get(key)) || null;
}

// The declarations with their declared spellings, for the completeness guard
// (mirrors canonicalAliases() — same shape, same purpose).
export function uncuratedAnalytes(): readonly (readonly [
  string,
  UncuratedAnalyte,
])[] {
  return UNCURATED_ANALYTES;
}
