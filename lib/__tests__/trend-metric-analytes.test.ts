import { describe, it, expect } from "vitest";
import {
  METRIC_DOCUMENT_REACH,
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
