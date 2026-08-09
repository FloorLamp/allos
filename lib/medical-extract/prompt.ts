// Prompting stage: the system prompt, the structured save_medical_data tool
// schema, and building the per-document content blocks sent to the model.
import Anthropic from "@anthropic-ai/sdk";
import { CATEGORIES, FLAGS } from "./constants";
import { EXTRACTION_CONFIDENCES } from "../extraction-confidence";
import { RESULT_STATUSES } from "../lab-result-lifecycle";
import { ext, IMAGE_TYPES, spreadsheetToText } from "./files";

export const SYSTEM = `You are a medical-records data-extraction engine. You are given a single
medical document (a lab report, DEXA/body-composition scan, imaging report, or a spreadsheet
of results). Extract every individual measurable result into structured rows by calling the
save_medical_data tool exactly once.

Rules:
- Emit ONE entry per analyte / metric / measurement (e.g. each lab test, each DEXA region's
  BMD/T-score/Z-score, each body-composition number). Do not summarise or merge rows.
- canonical_name: a clean, consistent biomarker name for grouping this analyte across
  documents — Title Case. Drop method/processing qualifiers that don't change WHAT is measured
  ("direct"/"calculated"/"serum"/"plasma"): name "LDL CHOL., DIRECT" → canonical_name
  "LDL Cholesterol". But KEEP qualifiers that make it a DIFFERENT measurement so they stay
  separate — especially the specimen/source: blood vs urine creatinine are different
  ("Creatinine" for blood/serum vs "Creatinine, Urine"); likewise random vs 24-hour, total vs
  free vs ratio vs percentage, and vitamin D2 (ergocalciferol) vs D3 (cholecalciferol) — keep
  the D2/D3 suffix so "25-OH Vitamin D2" and "25-OH Vitamin D3" never collapse onto one name.
  When a canonical name from the provided list matches this exact analyte, REUSE it; only coin
  a new one when none fits.
  Those qualifiers you may READ OFF THE LAYOUT are structural — the specimen, the panel /
  section a row sits under, laterality, method: a row inside a URINALYSIS section IS urine, so
  a bare "GLUCOSE" there is "Glucose, Urine", and a row under "Left Eye" is the left one. But
  NEVER add a PATIENT-STATE condition the document does not print — fasting / non-fasting,
  post-prandial, pre-/post-dose, supine/standing, at-rest/post-exercise. Those describe how the
  patient was PREPARED, not what was sampled, and the panel a row appears in does not state
  them: a bare "GLUCOSE" on a metabolic panel is "Glucose", NOT "Glucose, Fasting", even when
  such a panel is usually drawn fasting. Qualify only when the document itself prints the
  condition ("FBG (Glucose Fasting)" → "Glucose, Fasting"). The condition changes which
  reference range applies, so an unprinted one must never be assumed.
- category: use "lab" for blood/urine/serum lab analytes; "scan" for DEXA, body composition,
  and imaging metrics; "genomics" for genetic results; "prescription" for medications;
  "vitals" for vital signs (BP, HR, temp); "biomarker" only if nothing else fits.
- value: the result as shown. Keep qualitative values verbatim ("NEGATIVE", "YELLOW",
  "Pattern A", "RH(D) POSITIVE"). value_num: the same value as a number ONLY when it is
  purely numeric; otherwise null. For "<0.10" or "<10", set value as the string and
  value_num null.
- unit: the unit if present, else null.
- reference_range: the CONCISE range only (e.g. "<200", "50-180", ">=40", "NEGATIVE"). Do
  NOT copy surrounding guideline text, risk tables, methodology, or disclaimers.
- flag: "high" if marked H / above range, "low" if marked L / below range, "abnormal" for
  non-numeric out-of-range results, "normal" or null otherwise.
- panel: the panel/section heading it appeared under (e.g. "Lipid Panel", "CBC",
  "Comprehensive Metabolic Panel", "Body Composition"), else null.
- result_status: ONLY when the report states the result's status — "preliminary",
  "final", "corrected", or "amended" (a "CORRECTED REPORT" / "AMENDED" banner or a
  per-analyte status column). A corrected/amended result is a re-issue of a value the
  patient may already have seen, so never guess it, and never write "final" just
  because the report looks routine — leave null when nothing is stated.
- fasting: 1 when the report states the specimen was drawn FASTING, 0 when it states
  it was non-fasting/random, null when it doesn't say. Never infer from the analyte.
- specimen: the specimen as printed ("Serum", "Plasma", "Whole Blood", "Urine",
  "RBC", "Urine, 24-hour"), else null.
- notes: leave null. Only set it for a short (<12 words) clinically meaningful note; never
  copy reference paragraphs, citations, methodology, or boilerplate disclaimers.
- prescription: when a result is a MEDICATION (category "prescription") read off a pharmacy
  label, prescription printout, or medication order, ALSO fill the "prescription" object with
  what the document actually states: sig (the directions VERBATIM, e.g. "Take 1 tablet by mouth
  daily" — this drives dose reminders, so copy it exactly and do NOT paraphrase away the
  frequency), strength (the per-dose amount, e.g. "10 mg"), prn (1 only when the label says
  as-needed / PRN, else 0), prescriber (ordering clinician), pharmacy (dispensing pharmacy),
  rx_number (the Rx / prescription number), start_date (ISO YYYY-MM-DD when the course started).
  Leave any field null when the document doesn't print it — never invent a schedule, prescriber,
  or Rx number. Leave the whole object null for non-medication results.
- collected_date / document_date: ISO YYYY-MM-DD when determinable, else null. Prefer the
  specimen collection date or scan date.
- immunizations: if the document is an immunization record / vaccine card / shot history, emit
  one entry per administered dose in the "immunizations" array — vaccine (the name or brand
  EXACTLY as printed, e.g. "Vaxelis", "Tdap", "Boostrix", "Shingrix", "Yellow Fever"), date
  (ISO YYYY-MM-DD of administration), dose_label (e.g. "Dose 1", "Booster") if shown else null,
  lot_number / route / site / reaction when the card prints them else null, and a short note
  else null. Set document_type to "immunization" for such documents. A lab
  report with antibody TITERS (e.g. "Measles IgG", "Hepatitis B Surface Antibody") is NOT an
  immunization record — put those in results as normal lab analytes, not in immunizations.
- clinical entities: when the document is a CLINICAL NARRATIVE (a discharge / after-visit
  summary, progress note, or a problem / allergy / surgical-history printout) rather than a pure
  lab or scan report, ALSO extract its structured clinical entities into the matching arrays.
  Emit ONLY what the document actually states; never invent a code, status, or date — leave a
  field null when it isn't printed. Each array is empty for a plain lab/scan report:
  - conditions: problem-list diagnoses (name + ICD-10/SNOMED code when printed; status
    "active"/"inactive"/"resolved" when stated; onset/resolved dates ISO YYYY-MM-DD; plus
    laterality left/right/bilateral, severity mild/moderate/severe and stage EXACTLY when the
    document states them — a side or a grade is never inferred from the diagnosis name).
  - allergies: allergies / intolerances (substance + reaction + severity + status, plus
    criticality and verification_status when the document states them — never inferred). Do NOT
    emit a row for an explicit "no known allergies" / "NKDA" statement — leave the array empty.
  - procedures: procedures / surgical history (name + code + performed date ISO YYYY-MM-DD).
  - encounters: the visit(s) the document describes (date, end/discharge date, type e.g.
    "Office Visit"/"Emergency", class_code AMB/IMP/EMER, reason, attending provider name, facility
    name). A document's own visit diagnoses ALSO go in conditions.
  - family_history: one entry per (relative, condition) pair (relation, condition, onset_age,
    deceased, plus age_at_death / cause_of_death when the record states how and how young the
    relative died, and relation_type half/adopted/step and lineage maternal/paternal ONLY when
    the document says so — an ordinary relative is a genetic one).
  - care_plan: planned / ordered FUTURE care — follow-ups, ordered tests, referrals, planned
    procedures (the "Plan" / "Follow-up" section).
  - care_goals: stated clinical goals / targets (e.g. "A1c < 7.0%").
  - genomic_variants: when the document is a CLINICAL GENETICS or PHARMACOGENOMIC (PGx)
    report (e.g. Invitae / Color / Myriad / a pharmacy PGx panel), emit one entry per
    REPORTED variant into the "genomic_variants" array. Capture what the report states,
    verbatim — do NOT infer, re-interpret raw calls, or add any risk commentary of your
    own: gene (the HGNC symbol, e.g. "BRCA1", "CYP2C19", "APOE" — REQUIRED), variant
    (the rsID and/or HGVS, e.g. "rs4986893" / "c.681G>A"), genotype (e.g. "ε3/ε4"),
    star_allele (e.g. "*2/*2"), zygosity ("heterozygous" / "homozygous" / "hemizygous"),
    significance (the ACMG term as printed: "pathogenic" / "likely pathogenic" /
    "uncertain significance" (VUS) / "likely benign" / "benign" — leave null for a PGx
    star-allele result that carries no ACMG call), result_type (one of "pharmacogenomic",
    "hereditary-risk", "carrier", "diagnostic", "other" — classify by what the report is:
    a drug-response / metabolizer panel is "pharmacogenomic", a hereditary-cancer /
    predisposition finding is "hereditary-risk"), interpretation (the report's own
    interpretation text, verbatim, if brief), source_lab (the testing lab), report_date
    (ISO YYYY-MM-DD). A lab report of ordinary blood analytes is NOT a genetics report —
    leave this array empty for it.
  - imaging_studies: when the document is a RADIOLOGY / IMAGING report (an X-ray, CT, MRI,
    ultrasound, DEXA/bone-density, mammogram, PET, nuclear-medicine, fluoroscopy, or
    similar), emit ONE entry into the "imaging_studies" array describing the study.
    Capture what the report states — do NOT diagnose or add commentary of your own:
    modality (one of "x-ray", "ct", "mri", "ultrasound", "dexa", "pet",
    "nuclear-medicine", "fluoroscopy", "other" — a mammogram or plain film is "x-ray";
    a hybrid PET/CT is "pet"; SPECT / scintigraphy / a bone scan is
    "nuclear-medicine"; an angiogram or fluoroscopy-guided procedure is
    "fluoroscopy"), body_region
    (the anatomy imaged, e.g. "Chest", "Left Knee", "Abdomen/Pelvis"), laterality
    ("left" / "right" / "bilateral" / "na" when not applicable/midline), contrast (was IV
    or oral contrast given? "with" / "without"), contrast_agent (the agent if named, e.g.
    "gadolinium", "iodinated"), study_date (ISO YYYY-MM-DD), impression (the radiologist's
    IMPRESSION / FINDINGS text — the report body — captured VERBATIM; for most imaging this
    IS the result), indication (the reason the study was ordered / clinical history, e.g.
    "screening", "cough", "follow-up of nodule"), status (e.g. "final", "preliminary"),
    dose_msv (the effective radiation DOSE in millisieverts, ONLY if the report actually
    prints one, e.g. "effective dose 8 mSv" or a DLP the report converts to mSv — MOST
    reports do NOT state a dose, so leave this null unless it's explicitly written; never
    estimate or infer it). Extract the STRUCTURED report only — you cannot see the images
    themselves. A plain lab
    or genetics report is NOT an imaging study — leave this array empty for it. NOTE: any
    NUMERIC imaging measurements (DEXA T-scores, coronary calcium score, ejection fraction,
    carotid IMT) still belong in "results" as their own analytes — the imaging_studies entry
    is the narrative, not those numbers.
  - optical_prescriptions: when the document is an EYEGLASS or CONTACT-LENS prescription /
    optometry Rx slip / eye-exam refraction, emit ONE entry into the "optical_prescriptions"
    array. Capture the printed values verbatim — do NOT compute or convert: kind ("glasses"
    or "contacts"). Per-eye refraction, where OD = right eye and OS = left eye — od_sphere,
    od_cylinder, od_axis (whole degrees 0–180), od_add, and os_sphere, os_cylinder, os_axis,
    os_add. Keep the printed notation, e.g. "-2.00", "+1.25", "plano". Then pd (pupillary
    distance in mm), and for CONTACTS only base_curve + diameter (mm) + brand. issued_date
    and expiry_date (ISO YYYY-MM-DD), prescriber (the optometrist's name), notes. A lab /
    imaging / genetics report is NOT an optical prescription — leave this array empty for it.
  - dental_procedures: when the document is a DENTAL exam/treatment record, chart note, or
    after-visit summary from a dentist, emit ONE entry into the "dental_procedures" array
    per procedure DONE or exam finding, describing what the record states — do NOT diagnose:
    name (the procedure or finding, e.g. "Composite filling", "Extraction", "Crown", "Caries
    watch", "Periodontal re-evaluation"), status ("completed" for work done, "planned" for a
    treatment-plan / recommended procedure, "watch" for a monitored finding to recheck), tooth
    (the tooth number as written, e.g. "14", "#30", "UL6"), tooth_system ("universal" for ADA
    1-32, "fdi" for two-digit FDI/ISO, "palmer" — omit if unclear), surface (the surface code
    if given, e.g. "MOD", "buccal"), cdt_code (the CDT/ADA procedure code if present, e.g.
    "D2392"), procedure_date (ISO YYYY-MM-DD), finding (the free-text clinical impression,
    e.g. "watch mesial #14 for recurrent decay", "4mm pocket #30 with BOP"),
    follow_up_interval_days (when the record says to recheck in N months/weeks, the interval
    in DAYS, e.g. "recheck in 6 months" → 180). A dental X-ray (bitewing/panoramic) is an
    imaging study, NOT a dental_procedure — leave this array empty for a non-dental document.
    NOTE: periodontal MEASUREMENTS (pocket depths in mm, bleeding-on-probing %) belong in
    "results" as their own analytes ("Periodontal Probing Depth", "Bleeding on Probing").
  - AUDIOGRAM / hearing test: when the document is an audiogram or audiology report, put each
    pure-tone air-conduction threshold into "results" as its OWN analyte, one row per ear per
    frequency, category "vitals", unit "dB HL", value the number of decibels. Use the canonical
    names "Hearing Threshold, Right Ear <freq>" and "Hearing Threshold, Left Ear <freq>" where
    <freq> is one of 250 Hz, 500 Hz, 1 kHz, 2 kHz, 4 kHz, 8 kHz (right = AD/OD, left = AS/OS).
    There is no separate audiogram object — thresholds are results only.
  - SPIROMETRY / pulmonary function test: when the document is a spirometry or PFT report,
    put each measured value into "results" as its own analyte, category "vitals", using the
    canonical names "FEV1" (unit "L"), "FVC" (unit "L"), "FEV1/FVC Ratio" (unit "%", so a
    printed 0.68 becomes 68) and "Peak Expiratory Flow" (unit "L/min"). Emit the MEASURED
    value, never the predicted one, and prefer the post-bronchodilator column when both are
    printed. A percent-of-predicted column is NOT the same analyte as the litres value —
    if you emit it at all, keep it under its own printed name rather than folding it onto
    "FEV1". There is no separate spirometry object — these are results only.
- confidence: on EVERY row you emit (in results and in every clinical array), state how
  sure you are that the row you just wrote matches the document: "high" when the text is
  clean and unambiguous, "medium" when you had to interpret something (a cramped or
  partly illegible figure, an ambiguous unit or reference range, a date you inferred from
  context, a hedged clinical phrasing), "low" when you are genuinely unsure the row is
  right. Judge YOUR reading of the document, not whether the result itself is normal or
  the diagnosis serious. For a medium/low row add confidence_reason: a phrase (<12 words)
  naming what was unclear, e.g. "unit smudged", "collection date inferred from header",
  "diagnosis stated as possible". Leave confidence_reason null on a high row. Be honest and
  sparing — this ONLY decides which rows a human looks at first; nothing is discarded,
  auto-accepted, or scored because of it, so neither hedging on everything nor claiming
  high on everything helps the reader.
- Be concise: emit only the structured fields above. Brevity matters — there may be 100+
  results and the response must fit in the output budget.
- Do not invent data. If the document has no extractable results, return empty arrays.`;

// Per-record certainty (#1601), spread into EVERY array item's schema below so the
// model answers it the same way for a lab reading, a condition, and an imaging study.
// Not in any `required` list: an older/smaller model that omits it must still produce a
// valid extraction, and an absent answer degrades to "unknown" (lib/extraction-confidence).
const CONFIDENCE_FIELDS = {
  confidence: {
    type: ["string", "null"],
    enum: [...EXTRACTION_CONFIDENCES, null],
    description:
      "How sure you are that THIS row matches the document: high / medium / low. About your reading of the source, not about whether the finding is clinically worrying. Used only to order human review — nothing is discarded or auto-accepted from it.",
  },
  confidence_reason: {
    type: ["string", "null"],
    description:
      "For a medium/low row only: a phrase (<12 words) naming what was unclear, e.g. 'unit smudged', 'date inferred from header'. Null on a high row.",
  },
} as const;

export const TOOL: Anthropic.Tool = {
  name: "save_medical_data",
  description: "Save the structured data extracted from the medical document.",
  input_schema: {
    type: "object",
    properties: {
      document_type: {
        type: "string",
        description: "One of: lab, dexa, imaging, other",
      },
      source: {
        type: ["string", "null"],
        description:
          "Lab/provider that produced the document, e.g. 'Quest Diagnostics'",
      },
      patient_name: { type: ["string", "null"] },
      patient_sex: {
        type: ["string", "null"],
        description:
          "The patient's sex/gender as stated on the document, normalized to 'male' or 'female'. Null if not stated or not clearly one of those.",
      },
      patient_birthdate: {
        type: ["string", "null"],
        description:
          "The patient's date of birth as ISO YYYY-MM-DD, if the document states one. Null otherwise.",
      },
      patient_age: {
        type: ["number", "null"],
        description:
          "The patient's age in whole years, if the document states an age but not a date of birth. Null otherwise.",
      },
      document_date: {
        type: ["string", "null"],
        description: "Primary date of the document, ISO YYYY-MM-DD",
      },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: CATEGORIES },
            panel: { type: ["string", "null"] },
            name: { type: "string" },
            canonical_name: {
              type: "string",
              description:
                "Clean canonical biomarker name for cross-document grouping; reuse a provided one when it matches. Qualifiers the LAYOUT encodes (specimen, panel/section, laterality, method) belong in it — a urinalysis row is 'Glucose, Urine'. A PATIENT-STATE condition the document does not print does NOT: fasting/non-fasting, post-prandial, pre-/post-dose, supine/standing, at-rest/post-exercise. A bare 'GLUCOSE' is 'Glucose', never 'Glucose, Fasting', however likely the panel makes it — the condition selects the reference range.",
            },
            value: { type: ["string", "null"] },
            value_num: { type: ["number", "null"] },
            unit: { type: ["string", "null"] },
            reference_range: { type: ["string", "null"] },
            flag: { type: ["string", "null"], enum: [...FLAGS, null] },
            result_status: {
              type: ["string", "null"],
              enum: [...RESULT_STATUSES, null],
              description:
                "The result's stated status: preliminary / final / corrected / amended. Null unless the report states it — a corrected or amended result re-issues a value the patient may already have read.",
            },
            fasting: {
              type: ["number", "null"],
              description:
                "1 when the report states the draw was fasting, 0 when it states non-fasting, null when unstated. Never inferred from the analyte.",
            },
            specimen: {
              type: ["string", "null"],
              description:
                "Specimen as printed: Serum, Plasma, Whole Blood, Urine, RBC, ... Null when unstated.",
            },
            collected_date: { type: ["string", "null"] },
            notes: { type: ["string", "null"] },
            prescription: {
              type: ["object", "null"],
              description:
                "For a MEDICATION result (category 'prescription') only: the structured order read off the label. Null for non-medications.",
              properties: {
                sig: {
                  type: ["string", "null"],
                  description:
                    "Directions verbatim, e.g. 'Take 1 tablet by mouth daily'. Copy the frequency exactly — it drives dose reminders.",
                },
                strength: {
                  type: ["string", "null"],
                  description: "Per-dose strength, e.g. '10 mg', '1 tablet'",
                },
                prn: {
                  type: ["number", "null"],
                  description:
                    "1 when the label states as-needed / PRN, else 0. A PRN med is never scheduled-due.",
                },
                prescriber: {
                  type: ["string", "null"],
                  description:
                    "Ordering clinician name, e.g. 'Grace Hopper, MD'",
                },
                pharmacy: {
                  type: ["string", "null"],
                  description: "Dispensing pharmacy name",
                },
                rx_number: {
                  type: ["string", "null"],
                  description: "Prescription / Rx number as printed",
                },
                start_date: {
                  type: ["string", "null"],
                  description: "Course start date, ISO YYYY-MM-DD, else null",
                },
              },
            },
            ...CONFIDENCE_FIELDS,
          },
          required: ["category", "name", "canonical_name"],
        },
      },
      immunizations: {
        type: "array",
        description:
          "Vaccine administrations from an immunization record / vaccine card. Empty for lab reports, scans, and other documents.",
        items: {
          type: "object",
          properties: {
            vaccine: {
              type: "string",
              description:
                "Vaccine or brand name exactly as printed, e.g. 'Vaxelis', 'Tdap', 'Boostrix', 'Shingrix', 'Yellow Fever'",
            },
            date: {
              type: ["string", "null"],
              description: "Date administered, ISO YYYY-MM-DD",
            },
            dose_label: { type: ["string", "null"] },
            notes: { type: ["string", "null"] },
            lot_number: {
              type: ["string", "null"],
              description: "Lot number exactly as printed, else null",
            },
            route: {
              type: ["string", "null"],
              description:
                "Route as printed, e.g. 'IM', 'intramuscular', 'SC', 'oral', 'intranasal'. Null if not stated.",
            },
            site: {
              type: ["string", "null"],
              description:
                "Body site as printed, e.g. 'Left deltoid', 'R thigh'. Null if not stated.",
            },
            reaction: {
              type: ["string", "null"],
              description:
                "Adverse reaction to THIS dose, if the record states one, else null",
            },
            ...CONFIDENCE_FIELDS,
          },
          required: ["vaccine"],
        },
      },
      conditions: {
        type: "array",
        description:
          "Problem-list diagnoses / conditions stated on the document. Empty for a plain lab/scan report.",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "The condition/diagnosis display name, e.g. 'Type 2 diabetes mellitus'",
            },
            code: {
              type: ["string", "null"],
              description: "ICD-10 / SNOMED code if printed, else null",
            },
            code_system: {
              type: ["string", "null"],
              description:
                "Code system, e.g. 'ICD-10-CM' or 'SNOMED', else null",
            },
            status: {
              type: ["string", "null"],
              description:
                "Clinical status if stated: active, inactive, or resolved. Null otherwise.",
            },
            laterality: {
              type: ["string", "null"],
              description:
                "Side of the body if the diagnosis states one: left, right, or bilateral. Null otherwise — never infer a side.",
            },
            severity: {
              type: ["string", "null"],
              description:
                "Severity grade if stated: mild, moderate, or severe. Null otherwise.",
            },
            stage: {
              type: ["string", "null"],
              description:
                "Stage exactly as printed if the diagnosis is staged, e.g. 'Stage IIIA', 'CKD stage 3b'. Null otherwise.",
            },
            onset_date: {
              type: ["string", "null"],
              description: "Onset date, ISO YYYY-MM-DD, else null",
            },
            resolved_date: {
              type: ["string", "null"],
              description: "Resolution date, ISO YYYY-MM-DD, else null",
            },
            ...CONFIDENCE_FIELDS,
          },
          required: ["name"],
        },
      },
      allergies: {
        type: "array",
        description:
          "Allergies / intolerances stated on the document. Do NOT emit a row for an explicit 'no known allergies' statement — leave the array empty.",
        items: {
          type: "object",
          properties: {
            substance: {
              type: "string",
              description:
                "The offending agent (drug/food/environmental), e.g. 'Penicillin'",
            },
            substance_code: { type: ["string", "null"] },
            substance_code_system: { type: ["string", "null"] },
            reaction: {
              type: ["string", "null"],
              description: "Reaction / manifestation as printed, e.g. 'Hives'",
            },
            severity: {
              type: ["string", "null"],
              description: "mild / moderate / severe, or as printed",
            },
            status: {
              type: ["string", "null"],
              description: "active, inactive, or resolved. Null if not stated.",
            },
            criticality: {
              type: ["string", "null"],
              description:
                "Criticality of a FUTURE exposure: 'low', 'high', or 'unable-to-assess'. Null if not stated — do NOT infer it from the severity.",
            },
            verification_status: {
              type: ["string", "null"],
              description:
                "'confirmed', 'suspected', 'unconfirmed', 'refuted', or 'entered-in-error' when the document states it. Null if not stated.",
            },
            onset_date: {
              type: ["string", "null"],
              description: "Onset date, ISO YYYY-MM-DD, else null",
            },
            ...CONFIDENCE_FIELDS,
          },
          required: ["substance"],
        },
      },
      procedures: {
        type: "array",
        description: "Procedures / surgical history stated on the document.",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Procedure display name, e.g. 'Appendectomy'",
            },
            code: {
              type: ["string", "null"],
              description:
                "CPT / SNOMED / ICD-10-PCS code if printed, else null",
            },
            code_system: { type: ["string", "null"] },
            date: {
              type: ["string", "null"],
              description: "Performed date, ISO YYYY-MM-DD, else null",
            },
            ...CONFIDENCE_FIELDS,
          },
          required: ["name"],
        },
      },
      encounters: {
        type: "array",
        description:
          "Visits / encounters the document describes (an after-visit or discharge summary usually describes ONE). The visit's diagnoses ALSO go in conditions.",
        items: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description: "Visit/admission date, ISO YYYY-MM-DD",
            },
            end_date: {
              type: ["string", "null"],
              description: "Discharge/end date, ISO YYYY-MM-DD, else null",
            },
            type: {
              type: ["string", "null"],
              description:
                "Encounter type display, e.g. 'Office Visit', 'Emergency', 'Inpatient'",
            },
            class_code: {
              type: ["string", "null"],
              description:
                "HL7 encounter class if known: AMB (ambulatory), IMP (inpatient), EMER (emergency). Else null.",
            },
            reason: {
              type: ["string", "null"],
              description: "Chief complaint / reason for visit",
            },
            diagnoses: {
              type: "array",
              items: { type: "string" },
              description: "Visit diagnosis display names",
            },
            provider: {
              type: ["string", "null"],
              description:
                "Attending/treating clinician name, e.g. 'Grace Hopper, MD'",
            },
            location: {
              type: ["string", "null"],
              description: "Facility / clinic / hospital name",
            },
            notes: {
              type: ["string", "null"],
              description: "A short visit summary note, else null",
            },
            ...CONFIDENCE_FIELDS,
          },
          required: ["date"],
        },
      },
      family_history: {
        type: "array",
        description:
          "Family medical history — one condition affecting one relative.",
        items: {
          type: "object",
          properties: {
            relation: {
              type: ["string", "null"],
              description: "Affected relative: mother / father / sibling / …",
            },
            condition: {
              type: "string",
              description: "The relative's condition display name",
            },
            code: { type: ["string", "null"] },
            code_system: { type: ["string", "null"] },
            onset_age: {
              type: ["number", "null"],
              description: "Relative's age (years) at onset, if stated",
            },
            deceased: {
              type: ["boolean", "null"],
              description: "Whether the relative is deceased, if stated",
            },
            age_at_death: {
              type: ["number", "null"],
              description:
                "Relative's age (years) at DEATH, if stated. Distinct from onset_age (age at diagnosis).",
            },
            cause_of_death: {
              type: ["string", "null"],
              description:
                "What the relative died of, if stated, e.g. 'Myocardial infarction'",
            },
            relation_type: {
              type: ["string", "null"],
              description:
                "Only when the document SAYS so: 'half' (half sibling), 'adopted' or 'step' (not a genetic relative), or 'genetic' (explicitly biological). Null otherwise — an ordinary relative is genetic by default.",
            },
            lineage: {
              type: ["string", "null"],
              description:
                "Family side if stated: maternal or paternal. Null otherwise.",
            },
            ...CONFIDENCE_FIELDS,
          },
          required: ["condition"],
        },
      },
      care_plan: {
        type: "array",
        description:
          "Planned / ordered FUTURE care — follow-ups, ordered tests, referrals, planned procedures (the 'Plan' / 'Follow-up' section).",
        items: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description:
                "The planned activity, e.g. 'Follow up in 3 months', 'Order lipid panel'",
            },
            code: { type: ["string", "null"] },
            code_system: { type: ["string", "null"] },
            category: {
              type: ["string", "null"],
              description:
                "procedure / encounter / medication / observation / … if classifiable",
            },
            planned_date: {
              type: ["string", "null"],
              description: "Scheduled/intended date, ISO YYYY-MM-DD, else null",
            },
            status: {
              type: ["string", "null"],
              description:
                "Lifecycle status if stated (planned / active / completed / …)",
            },
            ...CONFIDENCE_FIELDS,
          },
          required: ["description"],
        },
      },
      care_goals: {
        type: "array",
        description:
          "Clinical goals / targets stated on the document (the 'Goals' section), e.g. 'A1c < 7.0%'.",
        items: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description: "The goal statement",
            },
            code: { type: ["string", "null"] },
            code_system: { type: ["string", "null"] },
            target_date: {
              type: ["string", "null"],
              description: "Target date, ISO YYYY-MM-DD, else null",
            },
            status: {
              type: ["string", "null"],
              description:
                "Lifecycle status if stated (proposed / active / achieved / …)",
            },
            ...CONFIDENCE_FIELDS,
          },
          required: ["description"],
        },
      },
      genomic_variants: {
        type: "array",
        description:
          "Reported variants from a clinical genetics / PGx report. Empty for a plain lab/scan report. Capture what the report states verbatim — never re-interpret raw calls or add risk commentary.",
        items: {
          type: "object",
          properties: {
            gene: {
              type: "string",
              description: "HGNC gene symbol, e.g. 'BRCA1', 'CYP2C19', 'APOE'",
            },
            variant: {
              type: ["string", "null"],
              description: "rsID and/or HGVS, e.g. 'rs4986893' / 'c.681G>A'",
            },
            genotype: {
              type: ["string", "null"],
              description: "Genotype as printed, e.g. 'ε3/ε4'",
            },
            star_allele: {
              type: ["string", "null"],
              description: "Star-allele diplotype, e.g. '*2/*2'",
            },
            zygosity: {
              type: ["string", "null"],
              description: "heterozygous / homozygous / hemizygous, if stated",
            },
            significance: {
              type: ["string", "null"],
              description:
                "ACMG significance as printed: pathogenic / likely pathogenic / uncertain significance (VUS) / likely benign / benign. Null for a PGx result with no ACMG call.",
            },
            result_type: {
              type: ["string", "null"],
              description:
                "pharmacogenomic / hereditary-risk / carrier / diagnostic / other",
            },
            interpretation: {
              type: ["string", "null"],
              description: "The report's own interpretation text, verbatim",
            },
            source_lab: {
              type: ["string", "null"],
              description: "The testing lab, e.g. 'Invitae'",
            },
            report_date: {
              type: ["string", "null"],
              description: "Report date, ISO YYYY-MM-DD, else null",
            },
            ...CONFIDENCE_FIELDS,
          },
          required: ["gene"],
        },
      },
      imaging_studies: {
        type: "array",
        description:
          "One entry per imaging/radiology study described by the document. Empty for a plain lab / genetics report. Capture the report's structured metadata + the radiologist's impression verbatim — never diagnose. Numeric imaging measurements (DEXA T-score, calcium score, EF, IMT) still go in `results`, not here.",
        items: {
          type: "object",
          properties: {
            modality: {
              type: ["string", "null"],
              description:
                "x-ray / ct / mri / ultrasound / dexa / other (a mammogram or plain film is x-ray)",
            },
            body_region: {
              type: ["string", "null"],
              description: "Anatomy imaged, e.g. 'Chest', 'Left Knee'",
            },
            laterality: {
              type: ["string", "null"],
              description: "left / right / bilateral / na, if stated",
            },
            contrast: {
              type: ["string", "null"],
              description: "'with' or 'without' contrast, if stated",
            },
            contrast_agent: {
              type: ["string", "null"],
              description: "Contrast agent if named, e.g. 'gadolinium'",
            },
            study_date: {
              type: ["string", "null"],
              description: "Study date, ISO YYYY-MM-DD, else null",
            },
            dose_msv: {
              type: ["string", "null"],
              description:
                "Effective radiation dose in mSv ONLY if the report prints one; else null (most reports omit it — never estimate)",
            },
            impression: {
              type: ["string", "null"],
              description:
                "The radiologist's IMPRESSION / FINDINGS text (the report body), verbatim",
            },
            indication: {
              type: ["string", "null"],
              description:
                "Reason the study was ordered / clinical history, e.g. 'screening'",
            },
            status: {
              type: ["string", "null"],
              description: "e.g. 'final', 'preliminary'",
            },
            ...CONFIDENCE_FIELDS,
          },
          required: [],
        },
      },
      optical_prescriptions: {
        type: "array",
        description:
          "One entry per eyeglass / contact-lens prescription described by the document. Empty for a plain lab / imaging / genetics report. Capture the printed refraction verbatim — never compute or convert.",
        items: {
          type: "object",
          properties: {
            kind: {
              type: ["string", "null"],
              description: "'glasses' or 'contacts'",
            },
            od_sphere: {
              type: ["string", "null"],
              description:
                "Right eye (OD) sphere, printed notation e.g. '-2.00'",
            },
            od_cylinder: {
              type: ["string", "null"],
              description: "Right eye (OD) cylinder",
            },
            od_axis: {
              type: ["string", "null"],
              description: "Right eye (OD) axis, whole degrees 0–180",
            },
            od_add: {
              type: ["string", "null"],
              description: "Right eye (OD) add power",
            },
            os_sphere: {
              type: ["string", "null"],
              description: "Left eye (OS) sphere, printed notation",
            },
            os_cylinder: {
              type: ["string", "null"],
              description: "Left eye (OS) cylinder",
            },
            os_axis: {
              type: ["string", "null"],
              description: "Left eye (OS) axis, whole degrees 0–180",
            },
            os_add: {
              type: ["string", "null"],
              description: "Left eye (OS) add power",
            },
            pd: {
              type: ["string", "null"],
              description: "Pupillary distance in mm",
            },
            base_curve: {
              type: ["string", "null"],
              description: "Contacts only: base curve (mm)",
            },
            diameter: {
              type: ["string", "null"],
              description: "Contacts only: lens diameter (mm)",
            },
            brand: {
              type: ["string", "null"],
              description: "Contacts only: lens brand",
            },
            issued_date: {
              type: ["string", "null"],
              description: "Date issued, ISO YYYY-MM-DD, else null",
            },
            expiry_date: {
              type: ["string", "null"],
              description: "Expiry date, ISO YYYY-MM-DD, else null",
            },
            prescriber: {
              type: ["string", "null"],
              description: "The prescribing optometrist's name",
            },
            notes: {
              type: ["string", "null"],
              description: "Any other printed note",
            },
            ...CONFIDENCE_FIELDS,
          },
          required: [],
        },
      },
      dental_procedures: {
        type: "array",
        description:
          "One entry per dental procedure done or exam finding in a DENTAL exam/treatment record or after-visit summary. Empty for a non-dental document. A dental X-ray is an imaging_study, not here; periodontal pocket-depth / bleeding measurements go in `results`.",
        items: {
          type: "object",
          properties: {
            name: {
              type: ["string", "null"],
              description:
                "Procedure or finding, e.g. 'Composite filling', 'Extraction', 'Caries watch'",
            },
            status: {
              type: ["string", "null"],
              description:
                "completed (work done) / planned (treatment plan) / watch (finding to recheck)",
            },
            tooth: {
              type: ["string", "null"],
              description: "Tooth number as written, e.g. '14', '#30', 'UL6'",
            },
            tooth_system: {
              type: ["string", "null"],
              description:
                "universal (ADA 1-32) / fdi (two-digit) / palmer, if clear",
            },
            surface: {
              type: ["string", "null"],
              description: "Surface code if given, e.g. 'MOD', 'buccal'",
            },
            cdt_code: {
              type: ["string", "null"],
              description: "CDT/ADA procedure code if present, e.g. 'D2392'",
            },
            procedure_date: {
              type: ["string", "null"],
              description: "Procedure/finding date, ISO YYYY-MM-DD, else null",
            },
            finding: {
              type: ["string", "null"],
              description:
                "Free-text clinical impression / note, e.g. 'watch mesial #14'",
            },
            follow_up_interval_days: {
              type: ["number", "null"],
              description:
                "Recommended recheck interval in DAYS when stated ('recheck in 6 months' → 180)",
            },
            ...CONFIDENCE_FIELDS,
          },
          required: [],
        },
      },
    },
    required: ["document_type", "results"],
  },
};

// Cap how many known canonical names we inject, to keep the prompt bounded.
const VOCAB_CAP = 400;

export async function buildContent(
  buffer: Buffer,
  mime: string,
  filename: string,
  knownCanonical: string[] = []
): Promise<Anthropic.ContentBlockParam[]> {
  const e = ext(filename);
  const instruction: Anthropic.TextBlockParam = {
    type: "text",
    text: "Extract all structured results from this medical document using the save_medical_data tool.",
  };
  const vocab = knownCanonical.slice(0, VOCAB_CAP);
  const vocabBlock: Anthropic.TextBlockParam | null = vocab.length
    ? {
        type: "text",
        text: `Canonical biomarker names to reuse when an analyte matches (set canonical_name to the matching entry; only coin a new name when none fits):\n${vocab.join(
          ", "
        )}`,
      }
    : null;
  const tail = vocabBlock ? [instruction, vocabBlock] : [instruction];

  if (e === "pdf" || mime === "application/pdf") {
    return [
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: buffer.toString("base64"),
        },
      },
      ...tail,
    ];
  }

  const imageType =
    IMAGE_TYPES[e] ?? (mime.startsWith("image/") ? (mime as any) : null);
  if (imageType) {
    return [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: imageType,
          data: buffer.toString("base64"),
        },
      },
      ...tail,
    ];
  }

  if (e === "xlsx") {
    return [
      {
        type: "text",
        text: `Spreadsheet "${filename}" contents:\n\n${await spreadsheetToText(buffer)}`,
      },
      ...tail,
    ];
  }

  // CSV / fallback: treat as UTF-8 text.
  return [
    {
      type: "text",
      text: `File "${filename}" contents:\n\n${buffer.toString("utf8")}`,
    },
    ...tail,
  ];
}
