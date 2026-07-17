// Medical-document extraction barrel. The implementation is split by pipeline
// stage under lib/medical-extract/ (#597): `constants` (model knob + whitelists),
// `types` (extracted record shapes), `files` (upload handling), `prompt` (system
// prompt + tool schema + content building), `normalize` (response parsing /
// record mapping), and `extract` (the orchestrator + SDK error mapping). Every
// original import path and export name is preserved by re-exporting here.
export {
  describeError,
  extractMedicalDocument,
  resultFromExtractionInput,
  clinicalCountOf,
} from "./medical-extract/extract";
export type { ExtractionSuccess } from "./medical-extract/extract";
export {
  normalizeSex,
  normalizeBirthdate,
  normalizeAge,
  normalizePrescription,
  normalizeClinicalDomains,
  normalizeResults,
  unwrapExtractionInput,
  looksLikeExtractionInput,
} from "./medical-extract/normalize";
export { isSupportedFile, spreadsheetToText } from "./medical-extract/files";
export type {
  ExtractedPrescription,
  ExtractedResult,
  ExtractedImmunization,
  ExtractedCondition,
  ExtractedAllergy,
  ExtractedProcedure,
  ExtractedEncounter,
  ExtractedFamilyHistory,
  ExtractedCarePlanItem,
  ExtractedCareGoal,
  ExtractionMeta,
  ExtractionResult,
} from "./medical-extract/types";
