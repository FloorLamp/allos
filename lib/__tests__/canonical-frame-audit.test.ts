import { describe, it, expect } from "vitest";
import canonicalSeed from "@/lib/canonical-biomarkers.json";
import descriptionsJson from "@/lib/datasets/data/biomarker-descriptions.json";
import {
  DERIVED_NAMES,
  derivedInputSlots,
  type DerivedName,
} from "@/lib/derived-biomarkers";
import {
  patientStateQualifiersIn,
  withoutPatientState,
} from "@/lib/patient-state-qualifiers";
import { normalizeCanonicalKey } from "@/lib/canonical-name";

// The #2526 frame audit, as a standing ledger.
//
// #2518 found `Insulin` carrying FASTING reference bands with nothing but a one-word
// `note` reading "Fasting" to say so. That is the #2371 shape: a canonical entry whose
// bands are only valid under a CONDITION — fasting, a morning draw, supine, a post-dose
// trough — where the condition lives in prose while the name stays unqualified. Any
// consumer that narrows an input by canonical name then gets the bands WITHOUT the
// condition, and the name gives a reader no reason to look.
//
// The issue asked for an audit, not a reflexive rename, so the deliverable is this: a
// sweep that finds every entry of that shape, and a VERDICT recorded per entry. The
// sweep runs on every build, so the audit cannot go stale — a new curated entry whose
// prose names a frame its name does not fails here until someone decides which verdict
// it earns, and a ledger row whose entry stopped matching fails as dead weight.
//
// What the audit is NOT allowed to do: re-point stored readings. A bare reading states
// no frame, and re-filing it under a qualified name asserts one it never made (#2338 /
// #2518). A bare reading ceasing to feed a frame-requiring calculation is the guard
// working. There is no migration here, and `seed` rows are never retired — coining a
// qualified twin is purely ADDITIVE, and normalizeCanonicalKey folds word order, so the
// coined name needs no alias to stay reachable.

type Biomarker = {
  name: string;
  note?: string | null;
  [k: string]: unknown;
};

const BIOMARKERS = (canonicalSeed as { biomarkers: Biomarker[] }).biomarkers;
const VOCAB = BIOMARKERS.map((b) => b.name);
const DESCRIPTION = new Map(
  (
    descriptionsJson as { entries: { name: string; description: string }[] }
  ).entries.map((e) => [e.name, e.description])
);

// The bounds that make an entry JUDGE a reading. An entry with none of them shows the
// number and says nothing about it, which is why "no band" is a complete answer to this
// audit: there is no band for a consumer to be handed without its condition.
const BAND_FIELDS = [
  "ref_low",
  "ref_high",
  "optimal_low",
  "optimal_high",
  "ref_low_male",
  "ref_high_male",
  "ref_low_female",
  "ref_high_female",
  "optimal_low_male",
  "optimal_high_male",
  "optimal_low_female",
  "optimal_high_female",
  "ranges_by_age",
  "ranges_by_status",
  "ranges_by_cycle_phase",
] as const;

function hasBand(b: Biomarker): boolean {
  return BAND_FIELDS.some((f) => b[f] != null);
}

// The frame vocabulary, grouped so SYNONYMS collapse to one token: an entry named
// "Resting Heart Rate" whose prose says "at rest" is not asserting an unstated
// condition, it is saying the same word twice. Deliberately WIDER than
// PATIENT_STATE_QUALIFIERS (which is a guard on identity resolution and must stay
// tight): this is a REVIEW trigger, so a false positive costs one ledger row with a
// reason, while a false negative is the defect going unnoticed.
const FRAME_TOKENS: { token: string; pattern: RegExp }[] = [
  { token: "fasting", pattern: /\b(?:non-)?fast(?:ing|ed)\b/i },
  {
    token: "prandial",
    pattern:
      /\b(?:post|pre)[\s-]?prandial\b|\bpost-load\b|\bOGTT\b|\bglucose challenge\b/i,
  },
  { token: "rest", pattern: /\bresting\b|\bat[\s-]rest\b/i },
  {
    token: "posture",
    pattern: /\bsupine\b|\bseated\b|\bstanding\b|\bupright\b|\brecumbent\b/i,
  },
  { token: "dose-timing", pattern: /\btrough\b|\b(?:pre|post)[\s-]?dose\b/i },
  {
    token: "time-of-day",
    pattern:
      /\bmorning\b|\bevening\b|\bmidnight\b|\bbedtime\b|\bovernight\b|\bdiurnal\b/i,
  },
  { token: "peak", pattern: /\bpeak\b/i },
  {
    token: "exertion",
    pattern: /\b(?:post|after)[\s-]?exercise\b|\bpost[\s-]?exertion\b/i,
  },
  { token: "collection", pattern: /\brandom\b|\btimed\b|\b24-hour\b/i },
  { token: "bronchodilator", pattern: /\bbronchodilator\b/i },
];

function tokensIn(text: string): string[] {
  return FRAME_TOKENS.filter((f) => f.pattern.test(text)).map((f) => f.token);
}

// The frames an entry's PROSE names that its NAME does not carry — the audit's trigger.
function unstatedFrames(b: Biomarker): string[] {
  const prose = `${b.note ?? ""} ${DESCRIPTION.get(b.name) ?? ""}`;
  const inName = new Set(tokensIn(b.name));
  return tokensIn(prose).filter((t) => !inName.has(t));
}

// ── The verdicts ──────────────────────────────────────────────────────────────
//
//   coined         The frame moved into a NEW qualified name and THIS entry gave up its
//                  bands (the #2337 posture). Checked: this entry is band-less and the
//                  named twin exists in the vocabulary carrying the frame in its name.
//   qualified      This IS the qualified twin. Its prose names other frames only to say
//                  what it is DISTINCT from. Checked: its own name carries a frame.
//   no-band        The entry judges nothing, so there is no band to hand a consumer
//                  without its condition. Checked: no band field is set.
//   intrinsic      The frame word is what the quantity IS, not a condition layered onto
//                  another quantity. Reason required.
//   frame-tolerant The entry has bands, the prose names a frame, and the bands are valid
//                  across it anyway. Reason required — this is the verdict that has to
//                  argue, and #2526 says recording WHY is a legitimate outcome.
type Verdict =
  "coined" | "qualified" | "no-band" | "intrinsic" | "frame-tolerant";

interface AuditRow {
  verdict: Verdict;
  // For `coined`: the qualified name the frame moved to.
  twin?: string;
  reason: string;
}

const FRAME_AUDIT: Record<string, AuditRow> = {
  // ── Coined: the frame is now in a name, and the bare entry judges nothing ────
  Glucose: {
    verdict: "coined",
    twin: "Glucose, Fasting",
    reason:
      "#2337. Fasting and non-fasting normal top out ~40 mg/dL apart, so either band on a draw of unstated frame is a guess.",
  },
  Insulin: {
    verdict: "coined",
    twin: "Insulin, Fasting",
    reason:
      "#2371/#2518, the case that prompted this audit. A post-prandial insulin runs several times the fasting value — a wider spread than glucose's.",
  },
  Cortisol: {
    verdict: "coined",
    twin: "Cortisol, Morning",
    reason:
      "#2526. The 6-18 ug/dL band was a MORNING band asserted by the two-word note 'Morning draw'. Cortisol's diurnal swing is the widest of the three: ~5 ug/dL is low at 8 a.m. and normal at 8 p.m., so the bare entry would have flagged a normal evening draw low.",
  },

  // ── Qualified: this entry IS the twin; its prose names contrasts ────────────
  "Glucose, Fasting": {
    verdict: "qualified",
    twin: undefined,
    reason:
      "The frame is in the name. 'random' appears only to say what this is distinct from.",
  },
  "Insulin, Fasting": {
    verdict: "qualified",
    reason:
      "The frame is in the name. 'post-load'/'OGTT' appear only as the contrasting draw.",
  },
  "Cortisol, Morning": {
    verdict: "qualified",
    reason:
      "The frame is in the name. 'evening'/'midnight'/'peak' describe the rhythm this timing sits at the top of.",
  },
  "Glucose, Gestational Screen (50 g)": {
    verdict: "intrinsic",
    reason:
      "The name states the whole procedure — a 1-hour draw after a 50 g challenge — so the timing is not a condition layered onto a plain glucose, it is a different test. 'fasting'/'random'/'OGTT' in the note name the other three glucose measurements it must not be confused with.",
  },

  // ── No band: nothing to hand a consumer ─────────────────────────────────────
  "30-Second Chair Stand": {
    verdict: "no-band",
    reason:
      "Read as an age/sex percentile, not against a fixed cutoff; 'seated' describes the movement.",
  },
  "Ketones, Urine": {
    verdict: "no-band",
    reason:
      "Qualitative dipstick. 'fasting' names a physiological cause of a positive, not a condition on a band.",
  },
  "Casts, Hyaline, Urine": {
    verdict: "no-band",
    reason:
      "Microscopy count with no band. 'after exercise' names a benign cause of a few casts.",
  },
  "Crystal Amount, Urine": {
    verdict: "no-band",
    reason:
      "Qualitative (few/moderate/many). 'standing' is the ordinary English verb in 'rather than standing on its own'.",
  },
  "Protein/Creatinine Ratio, Urine": {
    verdict: "no-band",
    reason:
      "No band is set: interpretation depends on clinical context. 'random' is the COLLECTION protocol (spot vs 24-hour), which is structural, not patient-state.",
  },

  // ── Intrinsic: the frame word is the quantity ───────────────────────────────
  "Homeostatic Model Assessment of Insulin Resistance (HOMA-IR)": {
    verdict: "intrinsic",
    reason:
      "HOMA-IR is DEFINED on the fasting pair; there is no non-fasting HOMA-IR for an unqualified name to be confused with. The frame lives where it can be enforced — both inputs are narrowed to the fasting entries in lib/derived-biomarkers, which the asymmetry test below pins.",
  },
  "Metabolic Equivalents (METs)": {
    verdict: "intrinsic",
    reason:
      "Peak functional capacity ON an exercise test is the quantity, not a condition on another quantity, and the entry carries no population reference band — the optimal >=10 is the prognostic reading of that same peak measurement. WATCH: if the app ever stores a METs value from something other than an exercise test (an activity-intensity estimate), this becomes a real frame split and the name has to say 'Peak'.",
  },

  // ── Frame-tolerant: has bands, names a frame, the bands survive it ──────────
  Triglycerides: {
    verdict: "frame-tolerant",
    reason:
      "#2526's other one-word note ('Fasting;'), and the verdict is the opposite of insulin's. Current lipid guidance measures the panel either way and applies one screening threshold, so — unlike glucose and insulin — there is no SECOND published band for the frame to select. Splitting the name would fork the most-charted lipid series in the app and hand both halves the same numbers. The note now states the sensitivity instead of asserting a condition.",
  },
  Estradiol: {
    verdict: "frame-tolerant",
    reason:
      "'peak' names the mid-cycle top of a deliberately WIDE reproductive envelope the band already spans, so no phase can fall outside it. When phase IS known it is applied structurally through ranges_by_cycle_phase / ranges_by_status, not by a second name.",
  },
  Progesterone: {
    verdict: "frame-tolerant",
    reason:
      "Same as Estradiol: the female band spans follicular to mid-luteal peak with an open low bound, and a known phase refines it through ranges_by_cycle_phase.",
  },
  "Ventricular Rate": {
    verdict: "frame-tolerant",
    reason:
      "'resting' appears only to say this is NOT Resting Heart Rate. The rate is measured during the ECG recording, and the 60-100 band is not conditioned on anything a report might omit.",
  },
  "FEV1/FVC Ratio": {
    verdict: "frame-tolerant",
    reason:
      "The post-bronchodilator qualification attaches to the DIAGNOSTIC CRITERION for fixed obstruction, not to the reference band: a pre-BD ratio at or above 0.70 excludes obstruction just as well, and one below it is a legitimate look-closer. Imported spirometry rarely states BD status, so coining a post-BD twin would strip the one spirometry value with a universal cutoff from nearly every import — losing more than it protects.",
  },
};

describe("#2526 — canonical entries whose clinical FRAME is asserted only by prose", () => {
  it("every entry of that shape carries an audit verdict", () => {
    const unaudited = BIOMARKERS.filter(
      (b) => unstatedFrames(b).length > 0 && !FRAME_AUDIT[b.name]
    ).map((b) => `${b.name} [${unstatedFrames(b).join(", ")}]`);
    expect(
      unaudited,
      `These entries name a clinical frame in their note/description that their NAME ` +
        `does not carry — the #2371 shape. Decide per entry and record it in ` +
        `FRAME_AUDIT: coin the qualified twin and leave this one band-less, or state ` +
        `why the bands are valid across the frame:\n${unaudited.join("\n")}`
    ).toEqual([]);
  });

  it("no audit row is dead weight", () => {
    const stale = Object.keys(FRAME_AUDIT).filter((name) => {
      const row = BIOMARKERS.find((b) => b.name === name);
      return !row || unstatedFrames(row).length === 0;
    });
    expect(
      stale,
      `These FRAME_AUDIT rows no longer match an entry of the audited shape (renamed, ` +
        `deleted, or the prose was rewritten). Delete them — a ledger nobody prunes ` +
        `stops being evidence:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  it("a `coined` verdict actually moved the bands onto a qualified twin", () => {
    const problems: string[] = [];
    for (const [name, row] of Object.entries(FRAME_AUDIT)) {
      if (row.verdict !== "coined") continue;
      const bare = BIOMARKERS.find((b) => b.name === name)!;
      if (hasBand(bare))
        problems.push(`${name}: still carries a band it cannot justify`);
      if (!row.twin) {
        problems.push(`${name}: no twin named`);
        continue;
      }
      const twin = BIOMARKERS.find((b) => b.name === row.twin);
      if (!twin)
        problems.push(`${name}: twin "${row.twin}" is not in the vocabulary`);
      else {
        if (!hasBand(twin))
          problems.push(
            `${row.twin}: the coined twin carries no band, so nothing moved`
          );
        if (patientStateQualifiersIn(twin.name).length === 0)
          problems.push(
            `${row.twin}: the twin's NAME states no condition, which is the defect being fixed`
          );
        // The whole point of the split: stripping the condition off the twin lands on
        // the bare entry, so the pair is one analyte in two frames rather than two
        // unrelated names.
        const stripped = withoutPatientState(
          twin.name,
          patientStateQualifiersIn(twin.name)
        );
        if (normalizeCanonicalKey(stripped) !== normalizeCanonicalKey(name))
          problems.push(
            `${row.twin}: demotes to "${stripped}", not to "${name}" — the pair is not a frame split`
          );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("a `qualified` verdict is only available to an entry whose name states a frame", () => {
    const wrong = Object.entries(FRAME_AUDIT)
      .filter(
        ([name, row]) =>
          row.verdict === "qualified" && tokensIn(name).length === 0
      )
      .map(([name]) => name);
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  it("a `no-band` verdict is only available to an entry that judges nothing", () => {
    const wrong = Object.entries(FRAME_AUDIT)
      .filter(([name, row]) => {
        if (row.verdict !== "no-band") return false;
        const b = BIOMARKERS.find((x) => x.name === name);
        return !b || hasBand(b);
      })
      .map(([name]) => name);
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  it("every verdict that has to ARGUE carries a reason", () => {
    const thin = Object.entries(FRAME_AUDIT)
      .filter(
        ([, row]) =>
          (row.verdict === "frame-tolerant" || row.verdict === "intrinsic") &&
          row.reason.length < 80
      )
      .map(([name]) => name);
    expect(thin, thin.join("\n")).toEqual([]);
  });
});

// ── The live-defect half: #2371's asymmetry ───────────────────────────────────
//
// #2371 was not the note; it was what the note let a CONSUMER do. HOMA-IR narrowed its
// glucose input to "Glucose, Fasting" while accepting any "Insulin", under a label
// reading "fasting insulin" — one input framed, its sibling not — so the index asserted
// a frame one of its own values never carried. That is checkable, so it is checked.

// A derived input is FRAMED when every canonical name it accepts states a patient-state
// condition. An input that accepts even one unqualified spelling is not framed: it will
// take a value of unknown frame whenever that is the only one on the draw.
function inputIsFramed(accepts: readonly string[]): boolean {
  return (
    accepts.length > 0 &&
    accepts.every((n) => patientStateQualifiersIn(n).length > 0)
  );
}

// Whether the vocabulary offers a frame-qualified twin of this input's analyte — i.e.
// whether the index COULD have required a frame here. An input with no such twin is not
// asymmetric, it is simply an analyte the vocabulary has never split.
function hasFramedTwin(key: string): boolean {
  const bare = normalizeCanonicalKey(key);
  return VOCAB.some((n) => {
    const qs = patientStateQualifiersIn(n);
    if (qs.length === 0) return false;
    return normalizeCanonicalKey(withoutPatientState(n, qs)) === bare;
  });
}

// An index deliberately mixing a framed input with an unframed one, with the argument.
// Empty: nothing in the catalogue does this today, and #2371 is why the exemption must
// be written down rather than inferred from the code reading as though it were fine.
const FRAME_MIXING_ALLOWED: Partial<Record<DerivedName, string>> = {};

describe("#2371 — no derived index requires a frame on one input and not its sibling", () => {
  it("an index that narrows one input by frame narrows every input that has a frame", () => {
    const problems: string[] = [];
    for (const name of DERIVED_NAMES) {
      const slots = derivedInputSlots(name);
      if (!slots.some((s) => inputIsFramed(s.accepts))) continue;
      if (FRAME_MIXING_ALLOWED[name]) continue;
      for (const slot of slots) {
        if (inputIsFramed(slot.accepts)) continue;
        if (!hasFramedTwin(slot.key)) continue;
        problems.push(
          `${name}: input "${slot.key}" accepts [${slot.accepts.join(", ")}] — an ` +
            `unframed value — while a sibling input requires a frame, and the ` +
            `vocabulary HAS a frame-qualified twin of it. Narrow it, or record the ` +
            `argument in FRAME_MIXING_ALLOWED.`
        );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("HOMA-IR requires the fasting frame on BOTH halves (the #2371 fix, pinned)", () => {
    const slots = derivedInputSlots(
      "Homeostatic Model Assessment of Insulin Resistance (HOMA-IR)"
    );
    expect(slots.map((s) => s.accepts)).toEqual([
      ["Glucose, Fasting"],
      ["Insulin, Fasting"],
    ]);
  });

  it("PhenoAge's declared fallback is a preference, not an asymmetry", () => {
    // Levine's model is a population mortality regression that PREFERS the fasting
    // analyte; it is not arithmetic that only holds on the fasting frame. So its
    // glucose input accepts the unqualified entry, no input of it is framed, and the
    // rule above correctly does not fire on it (#2334/#2357).
    const glucose = derivedInputSlots("PhenoAge").find(
      (s) => s.key === "Glucose, Fasting"
    );
    expect(glucose?.accepts).toEqual(["Glucose, Fasting", "Glucose"]);
    expect(
      derivedInputSlots("PhenoAge").some((s) => inputIsFramed(s.accepts))
    ).toBe(false);
  });

  it("the asymmetry rule fires on a planted mix", () => {
    // Proof the rule can fail: a framed glucose beside an unframed insulin is exactly
    // #2371, and both halves of the check must agree it is one.
    expect(inputIsFramed(["Glucose, Fasting"])).toBe(true);
    expect(inputIsFramed(["Insulin"])).toBe(false);
    expect(hasFramedTwin("Insulin")).toBe(true);
    // …and an analyte the vocabulary never split is not asymmetric.
    expect(hasFramedTwin("HDL Cholesterol")).toBe(false);
  });
});
