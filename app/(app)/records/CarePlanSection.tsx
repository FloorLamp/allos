import {
  getCarePlanItems,
  getPickerProviders,
  getContrastSafetyWarnings,
  getFindingSuppressions,
} from "@/lib/queries";
import { activeByKey } from "@/lib/findings";
import { contrastTitle, contrastDetail } from "@/lib/contrast-safety";
import { readForProfiles, stampSubjects, type ProfileScope } from "@/lib/scope";
import { today } from "@/lib/db";
import { ProviderOptionsProvider } from "@/components/ProviderOptionsContext";
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
// Multi-view (#1328): the care-plan LIST reads the view-set list-first (loop-composed;
// each profile's provider-joined rows in its own planned-date order) and gets subject
// chips + per-item write gates. The contrast-safety notes are a per-profile read-time
// derivation (today()/suppression bus) and stay on the ACTING profile — the #1096
// scope-limit. Single view is byte-identical.
export default function CarePlanSection({ scope }: { scope: ProfileScope }) {
  const profileId = scope.actingProfileId;
  const multi = scope.viewIds.length > 1;
  const items = stampSubjects(
    scope,
    readForProfiles(scope.viewIds, (pid) => getCarePlanItems(pid))
  );

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
    <ProviderOptionsProvider providers={getPickerProviders()}>
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
          <CarePlanList
            items={items}
            multiView={
              multi ? { actingProfileId: scope.actingProfileId } : undefined
            }
          />
        </div>

        <div className="min-w-0 space-y-4">
          <CarePlanForm action={addCarePlanItem} />
          <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
            Imported care-plan items come from uploaded health records (Plan of
            Treatment section).
          </p>
        </div>
      </div>
    </ProviderOptionsProvider>
  );
}
