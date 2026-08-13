import { describe, it, expect } from "vitest";
import {
  METRIC_DOCUMENT_REACH,
  STATISTIC_SIGNIFIERS,
  derivedInputsMetricFor,
  registryNamesFor,
  trendMetricHomeFor,
  hasTrendMetricHome,
  listedInResultsCatalog,
} from "../trend-metric-analytes";
import { acronymNameForms } from "../canonical-name";
import { readingDetailHref } from "../hrefs";
import { CANONICAL_BIOMARKERS } from "../datasets/canonical-biomarkers";
import {
  METRIC_KNOWLEDGE,
  metricIdentity,
  metricObservationFoldIdentity,
} from "../metric-judgment";
import { bodyMetricKind } from "../body-metric-extract";
import { isHeightReading } from "../height-extract";
import { isHeadCircReading } from "../head-circ-extract";
import { isWaistCircReading } from "../waist-circ-extract";
import {
  TREND_METRIC_META,
  TREND_METRIC_SLUGS,
  type TrendMetricSlug,
} from "../trend-metrics";

// #2365 — a `vitals` analyte with a body-metric home is not listed in the flat
// Biomarkers browser; one without a home stays. BOTH directions are asserted, over the
// REAL registries rather than a fixture list: a test that only proves the slugged
// analytes left is half a test, and the removing direction is the expensive one — a
// domain vital with no other home would disappear from the app.
//
// PHI: every name here is a controlled-vocabulary analyte name or an invented spelling;
// no values, no subjects.

// The projector each `import-projection` slug names, bound to the recognizer that
// actually decides at ingest. Kept HERE rather than in the module so the declaration
// stays pure — and so the check is real code, not a string compared to a string.
// The slugs entitled to claim an analyte name: those a document-imported reading can
// actually reach. DERIVED from the declaration, never listed.
const REACHABLE_SLUGS = TREND_METRIC_SLUGS.filter(
  (slug) => METRIC_DOCUMENT_REACH[slug].reaches !== false
);

const PROJECTION_RECOGNIZERS: Partial<
  Record<TrendMetricSlug, (name: string) => boolean>
> = {
  weight: (name) => bodyMetricKind(name, null) === "weight",
  height: (name) => isHeightReading(name, null),
  "head-circ": (name) => isHeadCircReading(name, null),
  "waist-circ": (name) => isWaistCircReading(name, null),
};

describe("document reachability is DECLARED and CHECKED (#2365)", () => {
  // The hole this registry closes: `hrv` and `bmr` have a slug, a tile and a detail
  // page, and both charts are fed exclusively by integration streams — so dropping
  // their analytes on the strength of "a chart exists" would land a cardiology HRV or
  // a calorimetry BMR on NO surface. Reachability is a different question from chart
  // existence, and this suite is what keeps the two from being confused again.

  it("every slug declares, and every refusal states a reason", () => {
    for (const slug of TREND_METRIC_SLUGS) {
      const reach = METRIC_DOCUMENT_REACH[slug];
      expect(reach, `${slug} must declare document reachability`).toBeDefined();
      if (reach.reaches === false)
        expect(reach.reason.length, `${slug} must say WHY not`).toBeGreaterThan(
          30
        );
    }
  });

  it("`observations` matches the reading model — a canonical identity with no stream", () => {
    // A metric whose identity has NO stream source charts its `medical_records` rows
    // directly (that is exactly why metricObservationFoldIdentity returns null for it —
    // folding would list every reading twice). Asked of the pure reading model rather
    // than METRIC_READING_STORE, which lives in a module that opens the database; the
    // DB tier cross-checks the two agree.
    for (const slug of TREND_METRIC_SLUGS) {
      const claimed = METRIC_DOCUMENT_REACH[slug].reaches === "observations";
      const chartsObservations =
        metricIdentity(slug) !== null &&
        metricObservationFoldIdentity(slug) === null;
      expect(chartsObservations, slug).toBe(claimed);
    }
  });

  it("`observation-fold` matches metricObservationFoldIdentity", () => {
    for (const slug of TREND_METRIC_SLUGS) {
      const claimed =
        METRIC_DOCUMENT_REACH[slug].reaches === "observation-fold";
      expect(metricObservationFoldIdentity(slug) !== null, slug).toBe(claimed);
    }
  });

  it("`import-projection` is confirmed by the projector's own recognizer", () => {
    // The strong form: the projector must accept every NAME the slug claims, asked the
    // way ingest asks it. If a recognizer's vocabulary ever narrows, the analyte stops
    // being safely removable and this fails.
    for (const slug of TREND_METRIC_SLUGS) {
      const reach = METRIC_DOCUMENT_REACH[slug];
      if (reach.reaches !== "import-projection") continue;
      const recognizer = PROJECTION_RECOGNIZERS[slug];
      expect(
        recognizer,
        `${slug} names a projector but binds no recognizer`
      ).toBeDefined();
      for (const name of [
        TREND_METRIC_META[slug].title,
        ...(trendMetricHomeFor(TREND_METRIC_META[slug].label) === slug
          ? [TREND_METRIC_META[slug].label]
          : []),
      ])
        expect(
          recognizer?.(name),
          `${slug} projector must accept "${name}"`
        ).toBe(true);
    }
  });

  it("an unreachable metric claims NO analyte name — the stranding guard", () => {
    // The whole point, stated as an assertion: a quantity whose imported reading has
    // nowhere to land keeps the flat catalog as its home.
    for (const slug of TREND_METRIC_SLUGS) {
      if (METRIC_DOCUMENT_REACH[slug].reaches !== false) continue;
      const meta = TREND_METRIC_META[slug];
      expect(trendMetricHomeFor(meta.title), `${slug} title`).not.toBe(slug);
      expect(trendMetricHomeFor(meta.label), `${slug} label`).not.toBe(slug);
    }
  });

  it("HRV and BMR stay browsable, by name and through the row predicate", () => {
    // Named explicitly because these two are the regression: both are quantities a real
    // clinical document prints, and neither chart can receive the reading.
    expect(METRIC_DOCUMENT_REACH.hrv.reaches).toBe(false);
    expect(METRIC_DOCUMENT_REACH.bmr.reaches).toBe(false);
    for (const name of [
      "Heart Rate Variability",
      "HRV",
      "Basal Metabolic Rate",
      "BMR",
      "Resting Metabolic Rate",
    ])
      expect(trendMetricHomeFor(name), name).toBeNull();
    expect(
      listedInResultsCatalog({
        category: "vitals",
        name: "Heart Rate Variability",
        canonical_name: "Heart Rate Variability",
      })
    ).toBe(true);
  });

  it("a DEPARTING analyte keeps a detail page — so a star stays un-starrable", () => {
    // `StarredBiomarkers` reads `getSavedBiomarkers` straight from `saved_items`,
    // independently of the browser gather, so a starred analyte still renders its tile
    // after leaving the catalog — and the tile links through `readingDetailHref`. Both
    // branches of that helper land on a page that carries a StarButton (the metric
    // detail page for a continuous vital, `/results/readings/view` otherwise), so the un-star
    // path can never be orphaned by this change. Pinned because the failure mode would
    // be a tile you cannot remove.
    for (const name of [
      "Blood Pressure Systolic",
      "Oxygen Saturation",
      "Body Temperature",
      "Resting Heart Rate",
      "Peak Expiratory Flow",
      "Body Mass Index (BMI)",
    ]) {
      expect(hasTrendMetricHome(name), name).toBe(true);
      const href = readingDetailHref(name);
      expect(
        href.startsWith("/trends/metric/") ||
          href.startsWith("/results/readings/view"),
        `${name} → ${href}`
      ).toBe(true);
    }
  });

  it("the bare single-word check-in and count titles claim nothing", () => {
    // Mood / Energy / Calm / Hydration / Steps and friends have bare titles that would
    // otherwise match an unrelated imported analyte outright. Unreachable, so they
    // claim nothing at all — the loose-match surface is gone rather than argued about.
    for (const name of [
      "Mood",
      "Energy",
      "Calm",
      "Hydration",
      "Daily Steps",
      "Lean Body Mass",
      "Bone Mass",
      "Skin Temperature Variation",
    ])
      expect(trendMetricHomeFor(name), name).toBeNull();
  });
});

describe("the derivation is the registries, not a list (#2365)", () => {
  it("every canonical name METRIC_KNOWLEDGE declares resolves to its own slug", () => {
    // The curated half: a slug whose knowledge names a canonical entry must claim that
    // exact name. This is what makes the mapping fall out of the registry instead of
    // being restated — and what breaks if METRIC_KNOWLEDGE is re-pointed.
    const declared: [TrendMetricSlug, string][] = [];
    for (const slug of REACHABLE_SLUGS) {
      const k = METRIC_KNOWLEDGE[slug];
      if ("canonical" in k) declared.push([slug, k.canonical]);
    }
    // Non-empty, or the assertion below proves nothing.
    expect(declared.length).toBeGreaterThan(4);
    for (const [slug, canonical] of declared)
      expect(trendMetricHomeFor(canonical)).toBe(slug);
  });

  it("every REACHABLE metric's own title resolves to it", () => {
    // The other half: a metric can be reachable and have no curated band (bmi's
    // knowledge is honestly `none`), so the registry title has to carry the name.
    // Derived from the slug enum minus the reachability declaration, so a metric added
    // tomorrow is covered without a second edit — and an unreachable one is covered by
    // the stranding guard above instead.
    expect(REACHABLE_SLUGS.length).toBeGreaterThan(4);
    for (const slug of REACHABLE_SLUGS)
      expect(trendMetricHomeFor(TREND_METRIC_META[slug].title)).toBe(slug);
  });

  it("no name key is claimed by two different slugs", () => {
    // The map takes first-registration-wins; this is what keeps that from being a
    // silent tie-break when a future metric's title collides with another's.
    const owners = new Map<string, TrendMetricSlug>();
    for (const slug of REACHABLE_SLUGS) {
      const meta = TREND_METRIC_META[slug];
      const k = METRIC_KNOWLEDGE[slug];
      const names = [meta.title, ...("canonical" in k ? [k.canonical] : [])];
      for (const name of names) {
        const home = trendMetricHomeFor(name);
        const prior = owners.get(name);
        expect(prior ?? slug).toBe(slug);
        owners.set(name, slug);
        expect(home).toBe(slug);
      }
    }
  });
});

describe("what LEAVES the browser (#2365)", () => {
  // The whole `vitals` half of the controlled vocabulary, partitioned by the rule. Kept
  // as an exact list on both sides so a vocabulary change that moves an analyte across
  // the line has to be looked at.
  const vitalsEntries = CANONICAL_BIOMARKERS.filter(
    (e) => e.category === "vitals"
  );

  it("exactly the seven canonical vitals with a metric chart", () => {
    const leaving = vitalsEntries
      .filter((e) => hasTrendMetricHome(e.name))
      .map((e) => e.name);
    expect(leaving.sort()).toEqual(
      [
        "Blood Pressure Diastolic",
        "Blood Pressure Systolic",
        "Body Temperature",
        "Oxygen Saturation",
        "Peak Expiratory Flow",
        "Resting Heart Rate",
        "Respiratory Rate",
      ].sort()
    );
  });

  it("BMI, however the document spelled it", () => {
    // #2318's misplaced row. It stops being browsable for the RIGHT reason — the
    // quantity has a home — whatever the placement bug does next. The parenthetical
    // form is the one a real import produced.
    for (const spelling of [
      "Body Mass Index (BMI)",
      "Body Mass Index",
      "BMI",
      "body mass index",
    ])
      expect(trendMetricHomeFor(spelling)).toBe("bmi");
  });

  it("the body measurements a document import already streams elsewhere", () => {
    // Weight / body fat / resting HR are projected into body_metrics and height / head
    // circumference into metric_samples by the import path, so the same reading is on
    // its chart: removing the catalog copy hides nothing.
    expect(trendMetricHomeFor("Weight")).toBe("weight");
    expect(trendMetricHomeFor("Height")).toBe("height");
    expect(trendMetricHomeFor("Head Circumference")).toBe("head-circ");
  });
});

describe("what STAYS in the browser (#2365)", () => {
  it("every canonical `vitals` analyte with no metric chart", () => {
    const staying = CANONICAL_BIOMARKERS.filter(
      (e) => e.category === "vitals" && !hasTrendMetricHome(e.name)
    ).map((e) => e.name);
    // The specialty domains #1076 was protecting, in full.
    for (const name of [
      "Intraocular Pressure, Right Eye",
      "Intraocular Pressure, Left Eye",
      "Visual Acuity, Right Eye",
      "Visual Acuity, Left Eye",
      "Periodontal Probing Depth",
      "Bleeding on Probing",
      "Clinical Attachment Loss",
      "Hearing Threshold, Right Ear 4 kHz",
      "Hearing Threshold, Left Ear 8 kHz",
      "Forced Expiratory Volume in 1 Second (FEV1)",
      "Forced Vital Capacity (FVC)",
      "FEV1/FVC Ratio",
      "VO2 Max",
      "Grip Strength",
      "30-Second Chair Stand",
      "Single-Leg Balance",
    ])
      expect(staying).toContain(name);
    // Every hearing threshold, not just the two spot-checked above.
    expect(
      staying.filter((n) => n.startsWith("Hearing Threshold")).length
    ).toBe(12);
  });

  it("the un-canonicalized domain vitals the issue counted", () => {
    // The 14 rows the flat catalog exists to rescue. None of them is a body metric, and
    // none may be dragged out by a loose match.
    for (const name of [
      "Pure Tone Average",
      "Pure Tone Average, Right Ear",
      "Pure Tone Average, Left Ear",
      "Visual Acuity",
      "Color Vision",
      "Ankle-Brachial Index",
      "Ankle-Brachial Index, Left",
      "Ankle-Brachial Index, Right",
      "Cardio-Ankle Vascular Index, Left",
      "Cardio-Ankle Vascular Index, Right",
    ])
      expect(trendMetricHomeFor(name)).toBeNull();
  });

  it("the #2322 catalog slice lands on the STAYS side, as both issues intend", () => {
    // Written down rather than rediscovered: the open #2322 curation
    // (claude/2322-catalog-curation) adds these as curated `vitals` entries. None has a
    // metric home, so every one stays browsable under this rule with no edit on either
    // side — which is the outcome both issues want. Asserted HERE so that if a later
    // change to the metric registry would start swallowing one of them, it fails in
    // this PR's own suite instead of surfacing as a surprise in that one.
    for (const name of [
      "PR Interval",
      "QRS Duration",
      "QT Interval",
      "QTc Interval",
      "Ventricular Rate",
      "Electrocardiogram (ECG) Interpretation",
      "Ankle-Brachial Index (ABI), Left",
      "Cardio-Ankle Vascular Index (CAVI), Right",
      "Fat Mass Index",
      "Lean Mass Index",
      "Metabolic Equivalents (METs)",
      "Exercise Stress Test Result",
      "Color Vision",
      "Audiologic Diagnosis",
    ])
      expect(trendMetricHomeFor(name), name).toBeNull();
    // "Lean Mass Index" is the one worth naming: `lean-mass` is titled "Lean Body Mass",
    // a different token set — AND it is unreachable, so it claims no name at all. The
    // near-miss has two independent reasons not to fire.
    expect(TREND_METRIC_META["lean-mass"].title).toBe("Lean Body Mass");
    expect(METRIC_DOCUMENT_REACH["lean-mass"].reaches).toBe(false);
  });

  it("Waist Circumference LEFT, because the slug and its projector landed (#2322)", () => {
    // This assertion used to live on the STAYS side, pinned there with a comment
    // saying it "leaves on its own the day the slug lands". It did — and this is the
    // other end of that prediction, kept in the same suite so the property is visible
    // rather than merely claimed.
    //
    // It left for the RIGHT reason, which is the whole discipline of this module: not
    // "a chart now exists" but "an imported reading can reach it". The projector is
    // what earns the removal, and the `import-projection` check above proves the
    // recognizer accepts the very name being claimed.
    expect(trendMetricHomeFor("Waist Circumference")).toBe("waist-circ");
    expect(METRIC_DOCUMENT_REACH["waist-circ"].reaches).toBe(
      "import-projection"
    );
    expect(
      listedInResultsCatalog({
        category: "vitals",
        name: "Waist Circumference",
        canonical_name: "Waist Circumference",
      })
    ).toBe(false);
    // The NEIGHBOURS it must not drag out with it. "Head Circumference" is the near
    // token-set miss the module's header calls out by name; the waist-to-hip RATIO and
    // the abdominal circumference are different quantities that keep the catalog.
    expect(trendMetricHomeFor("Head Circumference")).toBe("head-circ");
    expect(trendMetricHomeFor("Waist-Hip Ratio")).toBeNull();
    expect(trendMetricHomeFor("Abdominal Circumference")).toBeNull();
    // Its LABEL claims nothing: "Waist" is not an acronym by the shared gate, so a
    // bare-word match surface never opens.
    expect(trendMetricHomeFor("Waist")).toBeNull();
  });

  it("stress-test vitals — a qualified quantity is not the resting one", () => {
    // The #482 trap, and the reason the stored name is only ever stripped of a trailing
    // ACRONYM: dropping a word parenthetical would turn a peak-exercise blood pressure
    // into resting blood pressure and delete it from the only surface that shows it.
    for (const name of [
      "Blood Pressure Systolic (Peak Exercise)",
      "Blood Pressure Diastolic (Peak Exercise)",
      "Peak Heart Rate (Stress Test)",
      "Heart Rate Recovery",
      "Exercise Duration",
      "Metabolic Equivalents (METs)",
    ])
      expect(trendMetricHomeFor(name)).toBeNull();
    expect(acronymNameForms("Blood Pressure Systolic (Peak Exercise)")).toEqual(
      []
    );
    expect(acronymNameForms("Body Mass Index (BMI)")).toEqual([
      "Body Mass Index",
      "BMI",
    ]);
  });

  it("a clinic pulse is not the daily-average heart-rate metric", () => {
    // `hr` is an aggregate over hr_minutes — a different quantity from a single
    // measured pulse, and METRIC_KNOWLEDGE says so. Matching them would strand the
    // measured one. It is doubly safe now: `hr` is also unreachable (it has no reading
    // rows at all), so it claims no name to be matched against.
    expect(trendMetricHomeFor("Heart Rate")).toBeNull();
    expect(trendMetricHomeFor("Pulse")).toBeNull();
    expect(trendMetricHomeFor("Heart Rate (Daily Avg)")).toBeNull();
    expect(METRIC_DOCUMENT_REACH.hr.reaches).toBe(false);
  });
});

// #2678 Tier 1 — the STRUCTURAL rule at the shared recognizer, and the one that fixes
// the pre-existing cosmetic bug too: `listedInResultsCatalog` reads the same function,
// so a stored BMI percentile stops being hidden from the Results browser by a chart
// that does not plot percentiles.
describe("an acronym may corroborate, never overrule (#2678)", () => {
  it("REFUSES the acronym when a registered key is a proper subset of the full half", () => {
    // `{body, index, mass}` ⊂ `{body, index, mass, percentile}`: the full half is
    // naming a statistic OF bmi and the leftover token says which. The compression
    // does not get to outvote its own expansion.
    expect(trendMetricHomeFor("Body Mass Index Percentile (BMI)")).toBeNull();
    expect(trendMetricHomeFor("Body Mass Index Percentile (BMI%)")).toBeNull();
    // `{bmi}` ⊂ `{bmi, percentile}` — the same refusal, reached through the LABEL key
    // rather than the title key, so the rule is over every registered name of the slug.
    expect(trendMetricHomeFor("BMI Percentile (BMI%)")).toBeNull();
    // Not a BMI-only property: a statistic of any homed quantity is refused the same
    // way, whatever arm the slug's reach declares.
    expect(
      trendMetricHomeFor("Resting Heart Rate Percentile (RHR)")
    ).toBeNull();
  });

  it("ACCEPTS the acronym when the full half is DISJOINT from the slug's keys", () => {
    // The corroborating case, and the direction a denylist would have got wrong. A
    // spelling the registry has never seen states no contradiction — nothing of the
    // slug's vocabulary is in it — so the acronym is the only evidence there is, and it
    // still matches. This is what "fails in the safe direction" means here.
    expect(trendMetricHomeFor("Índice de Masa Corporal (BMI)")).toBe("bmi");
    expect(trendMetricHomeFor("Indice de Masa Corporal (BMI)")).toBe("bmi");
    // And the everyday shape that must not regress: "Resting HR" shares `resting` with
    // nothing registered as a whole key, so RHR still vouches for it.
    expect(trendMetricHomeFor("Resting HR (RHR)")).toBe("resting-hr");
    expect(trendMetricHomeFor("Body Mass Index (BMI)")).toBe("bmi");
  });

  it("EQUALITY is not a subset — the ordinary print form is untouched", () => {
    // "Body Mass Index (BMI)" has a full half whose token set EQUALS a registered key.
    // Proper-subset is what keeps that the ordinary case (it matches on the full half
    // before the acronym is consulted at all), and the refusal narrow.
    for (const spelling of [
      "Body Mass Index (BMI)",
      "body mass index (BMI)",
      "Waist Circumference (WC)",
    ])
      expect(trendMetricHomeFor(spelling), spelling).not.toBeNull();
  });

  it("the percentile stops being hidden from the Results browser", () => {
    // The pre-existing COSMETIC half of the same defect, from before the drop existed:
    // a stored percentile row was matched to the `bmi` home and dropped from the flat
    // catalog by `listedInResultsCatalog` — hidden behind a chart that does not plot
    // percentiles. One structural rule fixes both.
    expect(
      listedInResultsCatalog({
        category: "vitals",
        name: "Body Mass Index Percentile (BMI)",
        canonical_name: null,
      })
    ).toBe(true);
    // The BMI itself still leaves, exactly as #2365 decided.
    expect(
      listedInResultsCatalog({
        category: "vitals",
        name: "Body Mass Index (BMI)",
        canonical_name: null,
      })
    ).toBe(false);
  });
});

describe("listedInResultsCatalog scopes the rule to `vitals`", () => {
  it("drops a homed vitals row and keeps a homeless one", () => {
    expect(
      listedInResultsCatalog({
        category: "vitals",
        name: "Blood Pressure Systolic",
        canonical_name: "Blood Pressure Systolic",
      })
    ).toBe(false);
    expect(
      listedInResultsCatalog({
        category: "vitals",
        name: "Periodontal Probing Depth",
        canonical_name: "Periodontal Probing Depth",
      })
    ).toBe(true);
  });

  it("never touches another category, however the analyte is named", () => {
    // The rule is about the one category that holds two populations. A `scan` body-fat
    // reading is a DEXA measurement and keeps its catalog row; a lab keeps its.
    expect(
      listedInResultsCatalog({
        category: "scan",
        name: "Body Fat Percentage",
        canonical_name: "Body Fat Percentage",
      })
    ).toBe(true);
    expect(
      listedInResultsCatalog({ category: "lab", name: "LDL Cholesterol" })
    ).toBe(true);
    expect(
      listedInResultsCatalog({ category: "genomics", name: "APOE Genotype" })
    ).toBe(true);
  });

  it("keys on the identity the table renders — canonical name, else the printed one", () => {
    // biomarkerNameKey's COALESCE, in JS. A document that printed "BMI" and snapped
    // onto a canonical spelling is one analyte, matched either way.
    expect(
      listedInResultsCatalog({
        category: "vitals",
        name: "BMI",
        canonical_name: null,
      })
    ).toBe(false);
    expect(
      listedInResultsCatalog({
        category: "vitals",
        name: "TEMP",
        canonical_name: "Body Temperature",
      })
    ).toBe(false);
    // A blank canonical name falls through to the printed one rather than matching
    // nothing.
    expect(
      listedInResultsCatalog({
        category: "vitals",
        name: "Oxygen Saturation",
        canonical_name: "   ",
      })
    ).toBe(false);
  });
});

// #2646 — the `derived-inputs` arm, asked at the DOOR. Before this, it was the only
// REACHING variant with no ingest consequence at all: `observations` keeps the row,
// `observation-fold` keeps it, `import-projection` drops it via a `withoutCaptured*`
// helper, and this one did nothing — so a printed BMI survived as a `medical_records`
// row, coined an ai vocabulary name, and became a permanent Coverage candidate for a
// quantity `/trends/metric/bmi` already charts.
describe("derivedInputsMetricFor (#2646)", () => {
  it("recognizes the derived quantity under every spelling the registry knows", () => {
    // The registry TITLE, the acronym LABEL, and the "Full Name (ABBR)" print form —
    // the same three sources `trendMetricHomeFor` derives from, so a document's
    // spelling and the registry's are one quantity here too.
    for (const spelling of [
      "Body Mass Index",
      "BMI",
      "Body Mass Index (BMI)",
      "body mass index",
      "bmi",
    ])
      expect(derivedInputsMetricFor(spelling), spelling).toBe("bmi");
  });

  it("says nothing about a quantity whose reach is a different arm", () => {
    // The point of deriving this from METRIC_DOCUMENT_REACH rather than a second
    // list: a projected or folded quantity has its OWN ingest consequence, and must
    // not acquire this one on top.
    for (const other of [
      "Waist Circumference", // import-projection — a `withoutCaptured*` helper owns it
      "Body Fat Percentage", // observation-fold
      "Blood Pressure Systolic", // observations — the row IS the chart point
      "Heart Rate Variability", // reaches: false — the catalog is still its home
      "LDL Cholesterol", // not a metric at all
      "",
    ])
      expect(derivedInputsMetricFor(other), other || "(empty)").toBeNull();
    expect(derivedInputsMetricFor(null)).toBeNull();
    expect(derivedInputsMetricFor(undefined)).toBeNull();
  });

  it("does NOT claim the percentile that shares BMI's stem", () => {
    // A BMI percentile is an age/sex score, not a BMI, and the app recomputes it from
    // the growth curves. It is separated on the NAME axis for free — which is why the
    // recognizer never reads LOINC, where 39156-5 and 59574-4 would need a negative
    // list to stay apart.
    for (const percentile of [
      "Body Mass Index Percentile",
      "BMI Percentile",
      "BMI for Age Percentile",
    ])
      expect(derivedInputsMetricFor(percentile), percentile).toBeNull();
  });

  it("the disagreement pairs, side by side (#2678)", () => {
    // The whole issue in three lines. The first is the quantity and is DROPPED; the
    // other two name a statistic OF it and are STORED. They leak through different
    // mechanisms — the middle one through the acronym split, the last through
    // punctuation-stripping — so the pair is only meaningful read together.
    expect(derivedInputsMetricFor("Body Mass Index (BMI)")).toBe("bmi");
    expect(
      derivedInputsMetricFor("Body Mass Index Percentile (BMI)")
    ).toBeNull();
    expect(derivedInputsMetricFor("BMI%")).toBeNull();
  });

  it("every parenthesised and %-marked percentile spelling survives (#2678)", () => {
    // The probes from the issue, both halves. Before the fix each of these resolved to
    // `bmi` and was therefore deleted at ingest with no record that it had existed.
    for (const spelling of [
      "Body Mass Index Percentile (BMI%)",
      "Body Mass Index Percentile (BMI)",
      "BMI Percentile (BMI%)",
      "BMI%",
      "BMI %",
      "Body Mass Index Centile (BMI)",
      "BMI z-score",
      "BMI SDS",
    ])
      expect(derivedInputsMetricFor(spelling), spelling).toBeNull();
    // …and the spellings that were already safe, kept as a regression floor so a
    // future loosening of the recognizer has to break something visible.
    for (const spelling of [
      "BMI Percentile",
      "Body mass index (BMI) [Percentile]",
      "BMI percentile per age",
    ])
      expect(derivedInputsMetricFor(spelling), spelling).toBeNull();
  });

  it("no curated registry name is swallowed by the drop (#2675's guard, kept)", () => {
    // The check #2675's PR ran by hand, pinned so it runs on every change instead of
    // once. A curated entry is a quantity the app stores and charts under its own
    // identity; not one of them may resolve to a derived-input slug, because that
    // resolution is a DELETE.
    const swallowed = CANONICAL_BIOMARKERS.map((e) => e.name).filter(
      (name) => derivedInputsMetricFor(name) !== null
    );
    expect(swallowed).toEqual([]);
    // Non-vacuous: the registry it swept is the whole curated vocabulary (327 entries
    // when this landed), not an empty list.
    expect(CANONICAL_BIOMARKERS.length).toBeGreaterThan(300);
  });

  it("EVERY derived-inputs name survives EVERY statistic qualifier — generatively (#2678)", () => {
    // BMI is the FIRST `derived-inputs` slug and the pattern is the point: the next one
    // must inherit this protection without anyone remembering to write its cases. So
    // the cases are DERIVED — every name the slug claims × every Tier-2 signifier ×
    // the shapes a document writes them in.
    const derivedSlugs = TREND_METRIC_SLUGS.filter(
      (slug) => METRIC_DOCUMENT_REACH[slug].reaches === "derived-inputs"
    );
    expect(derivedSlugs.length).toBeGreaterThan(0);
    let cases = 0;
    for (const slug of derivedSlugs) {
      const names = registryNamesFor(slug);
      expect(names.length).toBeGreaterThan(0);
      const abbr = TREND_METRIC_META[slug].label;
      // The bare names ARE the quantity and MUST still be dropped — otherwise every
      // assertion below passes for the wrong reason.
      for (const name of names)
        expect(derivedInputsMetricFor(name), name).toBe(slug);
      for (const name of names)
        for (const sig of STATISTIC_SIGNIFIERS)
          for (const spelling of [
            `${name} ${sig.token}`,
            `${name}${sig.token}`,
            `${name} ${sig.token} (${abbr})`,
            `${name} ${sig.token.toUpperCase()}`,
          ]) {
            cases += 1;
            expect(derivedInputsMetricFor(spelling), spelling).toBeNull();
          }
    }
    expect(cases).toBeGreaterThan(20);
  });

  it("every statistic signifier states why it earns a place", () => {
    // The glyph-registry discipline: a curated list stays small only while each entry
    // has to justify itself, and a bare token nobody can defend is how it grows.
    const tokens = STATISTIC_SIGNIFIERS.map((s) => s.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const sig of STATISTIC_SIGNIFIERS) {
      expect(sig.reason.length, sig.token).toBeGreaterThan(40);
      // No `g` flag — these patterns are reused across calls and a sticky lastIndex
      // would make the SECOND label carrying a signifier slip through.
      expect(sig.pattern.flags, sig.token).not.toContain("g");
      expect(sig.pattern.test(sig.token), sig.token).toBe(true);
    }
  });

  it("covers exactly the slugs whose declared reach is derived-inputs", () => {
    // Derived, never hand-listed: a second `derived-inputs` slug gets the ingest arm
    // with no edit at the door, and this cannot disagree with the declaration it
    // implements.
    const declared = TREND_METRIC_SLUGS.filter(
      (slug) => METRIC_DOCUMENT_REACH[slug].reaches === "derived-inputs"
    );
    const recognized = TREND_METRIC_SLUGS.filter((slug) =>
      [TREND_METRIC_META[slug].title, TREND_METRIC_META[slug].label].some(
        (n) => derivedInputsMetricFor(n) === slug
      )
    );
    expect(recognized).toEqual(declared);
    // …and the arm is not empty, so the assertion above is not vacuous.
    expect(declared).toEqual(["bmi"]);
  });
});
