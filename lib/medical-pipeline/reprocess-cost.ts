import { extractionDailyLimit, getAiUsageCount } from "../ai-usage";
import { db } from "../db";
import { computeReprocessCost, type ReprocessCost } from "../reprocess-cost";

export function computeReprocessAllCost(profileId: number): ReprocessCost {
  const documents = db
    .prepare(
      "SELECT source, mime_type FROM medical_documents WHERE profile_id = ? AND stored_path IS NOT NULL AND stored_path != '' AND extraction_status != 'processing'"
    )
    .all(profileId) as { source: string | null; mime_type: string | null }[];
  const used = getAiUsageCount(profileId, "extraction");
  return computeReprocessCost(documents, used, extractionDailyLimit());
}
