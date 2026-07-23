import { MEDICAL_DISCLAIMER } from "@/lib/disclaimers";
import {
  getCarePlanItems,
  getProviderNames,
  getContrastSafetyWarnings,
  getFindingSuppressions,
} from "@/lib/queries";
import { activeByKey } from "@/lib/findings";
import { contrastTitle, contrastDetail } from "@/lib/contrast-safety";
import { today } from "@/lib/db";
import ProviderDatalist from "@/components/ProviderDatalist";
import { Notice } from "@/components/Notice";
import CarePlanForm from "@/app/(app)/care-plan/CarePlanForm";
import CarePlanList from "@/app/(app)/care-plan/CarePlanList";
import { addCarePlanItem } from "@/app/(app)/care-plan/actions";

// Care plan (former /care-plan index, #1042 phase 6): the profile's planned /
// ordered future care, soonest first — now the #care-plan section of /records.
// Imported from a health record's Plan of Treatment / Care Plan section (LOINC
// 18776-5) or a FHIR CarePlan resource, plus manual add/edit/delete. NB: this is
// CLINICAL care planned in the record — distinct from the user's own fitness
// "Goals" (/goals).
export default function CarePlanSection({ profileId }: { profileId: number }) {
  const items = getCarePlanItems(profileId);
  const providerNames = getProviderNames();

  // Contrast-safety notes (issue #701): a planned contrast imaging study meeting a
  // contrast/iodine/gadolinium allergy or a renal (CKD) contraindication on file. The
  // SAME pure computation the dismissible Upcoming finding formats over ("one
  // question, one computation"); honors the shared findings-suppression bus so a
  // note dismissed on Upcoming disappears here too. Informational, never prescriptive.
  const contrastNotes = activeByKey(
    getContrastSafetyWarnings(profileId),
    (h) => h.dedupeKey,
    getFindingSuppressions(profileId),
    today(profileId)
  );

  return (
    <>
      {/* Shared provider picker options for the add + edit forms. */}
      <ProviderDatalist names={providerNames} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          {contrastNotes.length > 0 && (
            <div className="space-y-2" data-testid="contrast-safety-notes">
              {contrastNotes.map((hit) => (
                <Notice
                  key={hit.dedupeKey}
                  tone="amber"
                  icon
                  testid={`contrast-note-${hit.dedupeKey}`}
                  title={contrastTitle(hit)}
                >
                  {contrastDetail(hit)}
                </Notice>
              ))}
            </div>
          )}
          <CarePlanList items={items} />
        </div>

        <div className="min-w-0 space-y-4">
          <CarePlanForm action={addCarePlanItem} />
          <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
            {MEDICAL_DISCLAIMER} Imported care-plan items come from uploaded
            health records (Plan of Treatment section).
          </p>
        </div>
      </div>
    </>
  );
}
