// Prompting stage: the system prompt, the structured save_medical_data tool
// schema, and building the per-document content blocks sent to the model.
import Anthropic from "@anthropic-ai/sdk";
import { CATEGORIES, FLAGS } from "./constants";
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
  and a short note else null. Set document_type to "immunization" for such documents. A lab
  report with antibody TITERS (e.g. "Measles IgG", "Hepatitis B Surface Antibody") is NOT an
  immunization record — put those in results as normal lab analytes, not in immunizations.
- clinical entities: when the document is a CLINICAL NARRATIVE (a discharge / after-visit
  summary, progress note, or a problem / allergy / surgical-history printout) rather than a pure
  lab or scan report, ALSO extract its structured clinical entities into the matching arrays.
  Emit ONLY what the document actually states; never invent a code, status, or date — leave a
  field null when it isn't printed. Each array is empty for a plain lab/scan report:
  - conditions: problem-list diagnoses (name + ICD-10/SNOMED code when printed; status
    "active"/"inactive"/"resolved" when stated; onset/resolved dates ISO YYYY-MM-DD).
  - allergies: allergies / intolerances (substance + reaction + severity + status). Do NOT emit a
    row for an explicit "no known allergies" / "NKDA" statement — leave the array empty.
  - procedures: procedures / surgical history (name + code + performed date ISO YYYY-MM-DD).
  - encounters: the visit(s) the document describes (date, end/discharge date, type e.g.
    "Office Visit"/"Emergency", class_code AMB/IMP/EMER, reason, attending provider name, facility
    name). A document's own visit diagnoses ALSO go in conditions.
  - family_history: one entry per (relative, condition) pair (relation, condition, onset_age,
    deceased).
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
    ultrasound, DEXA/bone-density, mammogram, or similar), emit ONE entry into the
    "imaging_studies" array describing the study. Capture what the report states — do NOT
    diagnose or add commentary of your own: modality (one of "x-ray", "ct", "mri",
    "ultrasound", "dexa", "other" — a mammogram or plain film is "x-ray"), body_region
    (the anatomy imaged, e.g. "Chest", "Left Knee", "Abdomen/Pelvis"), laterality
    ("left" / "right" / "bilateral" / "na" when not applicable/midline), contrast (was IV
    or oral contrast given? "with" / "without"), contrast_agent (the agent if named, e.g.
    "gadolinium", "iodinated"), study_date (ISO YYYY-MM-DD), impression (the radiologist's
    IMPRESSION / FINDINGS text — the report body — captured VERBATIM; for most imaging this
    IS the result), indication (the reason the study was ordered / clinical history, e.g.
    "screening", "cough", "follow-up of nodule"), status (e.g. "final", "preliminary").
    Extract the STRUCTURED report only — you cannot see the images themselves. A plain lab
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
- Be concise: emit only the structured fields above. Brevity matters — there may be 100+
  results and the response must fit in the output budget.
- Do not invent data. If the document has no extractable results, return empty arrays.`;

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
                "Clean canonical biomarker name for cross-document grouping; reuse a provided one when it matches",
            },
            value: { type: ["string", "null"] },
            value_num: { type: ["number", "null"] },
            unit: { type: ["string", "null"] },
            reference_range: { type: ["string", "null"] },
            flag: { type: ["string", "null"], enum: [...FLAGS, null] },
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
            onset_date: {
              type: ["string", "null"],
              description: "Onset date, ISO YYYY-MM-DD, else null",
            },
            resolved_date: {
              type: ["string", "null"],
              description: "Resolution date, ISO YYYY-MM-DD, else null",
            },
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
            onset_date: {
              type: ["string", "null"],
              description: "Onset date, ISO YYYY-MM-DD, else null",
            },
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
              description: "Right eye (OD) sphere, printed notation e.g. '-2.00'",
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
