// CDA section extractors — the default registry. Assembles every section
// extractor (defined in the sibling domain modules) into the ordered list the CDA
// walker runs.
import type { SectionExtractor } from "../constants";
import { immunizationExtractor } from "./immunizations";
import {
  labResultsExtractor,
  vitalSignsExtractor,
  functionalStatusExtractor,
} from "./observations";
import {
  medicationsExtractor,
  dischargeMedicationsExtractor,
  administeredMedicationsExtractor,
  orderedPrescriptionsExtractor,
} from "./medications";
import { careTeamsExtractor } from "./care-teams";
import { allergiesExtractor } from "./allergies";
import { problemsExtractor, pastIllnessExtractor } from "./conditions";
import { encountersExtractor } from "./encounters";
import { proceduresExtractor } from "./procedures";
import { familyHistoryExtractor } from "./family-history";
import { carePlanExtractor, goalsExtractor } from "./care-plan";
import { socialHistoryExtractor } from "./social-history";

export const DEFAULT_EXTRACTORS: SectionExtractor[] = [
  immunizationExtractor,
  labResultsExtractor,
  vitalSignsExtractor,
  medicationsExtractor,
  dischargeMedicationsExtractor,
  administeredMedicationsExtractor,
  orderedPrescriptionsExtractor,
  functionalStatusExtractor,
  careTeamsExtractor,
  allergiesExtractor,
  problemsExtractor,
  pastIllnessExtractor,
  encountersExtractor,
  proceduresExtractor,
  familyHistoryExtractor,
  carePlanExtractor,
  goalsExtractor,
  socialHistoryExtractor,
];

// ---- import DEBUGGER: drop-reason + coverage report ----
//
// The extractors above silently drop candidates: mapObservation returns null for a
// null-flavored "Comment(s)" row, mapImmunization for an unmapped vaccine code,
// mapAllergy for a "no known allergy" negation, and whole sections with no matching
// extractor are skipped by the walker (Insurance deliberately so — see SECTIONS).
// This block RECORDS each drop + why, and which sections were / weren't
// consumed, WITHOUT changing what imports. It re-runs the same leaf mappers (pure,
// cheap) and classifies the ones that came back null, so the mappers themselves stay
// untouched — the report is built at the extractor-framework level.
