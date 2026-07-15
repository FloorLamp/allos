import { IconAlertTriangle } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
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
import { PageHeader } from "@/components/ui";
import CarePlanForm from "./CarePlanForm";
import CarePlanList from "./CarePlanList";
import { addCarePlanItem } from "./actions";

export const dynamic = "force-dynamic";

// Care plan: the profile's planned / ordered future care, soonest first. Imported
// from a health record's Plan of Treatment / Care Plan section (LOINC 18776-5) or a
// FHIR CarePlan resource, plus manual add/edit/delete. Each row shows its planned
// activity, category, planned date, and status. NB: this is CLINICAL care planned
// in the record — distinct from the user's own fitness "Goals" (/goals).
export default async function CarePlanPage() {
  const { profile } = await requireSession();
  const items = getCarePlanItems(profile.id);
  const providerNames = getProviderNames();

  // Contrast-safety notes (issue #701): a planned contrast imaging study meeting a
  // contrast/iodine/gadolinium allergy or a renal (CKD) contraindication on file. The
  // SAME pure computation the dismissible Upcoming finding formats over ("one
  // question, one computation"); honors the shared findings-suppression bus so a
  // note dismissed on Upcoming disappears here too. Informational, never prescriptive.
  const contrastNotes = activeByKey(
    getContrastSafetyWarnings(profile.id),
    (h) => h.dedupeKey,
    getFindingSuppressions(profile.id),
    today(profile.id)
  );

  return (
    <div>
      {/* Shared provider picker options for the add + edit forms. */}
      <ProviderDatalist names={providerNames} />
      <PageHeader
        title="Care plan"
        subtitle="Planned & ordered care from your health records (Plan of Treatment / Care Plan section) — upcoming procedures, visits, tests, and orders. Add them manually or import from uploaded records."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          {contrastNotes.length > 0 && (
            <div className="space-y-2" data-testid="contrast-safety-notes">
              {contrastNotes.map((hit) => (
                <div
                  key={hit.dedupeKey}
                  data-testid={`contrast-note-${hit.dedupeKey}`}
                  className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm dark:border-amber-500/30 dark:bg-amber-500/10"
                >
                  <IconAlertTriangle
                    className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                    stroke={2}
                  />
                  <div className="min-w-0">
                    <p className="font-medium text-amber-800 dark:text-amber-200">
                      {contrastTitle(hit)}
                    </p>
                    <p className="text-amber-700 dark:text-amber-300/90">
                      {contrastDetail(hit)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
          <CarePlanList items={items} />
        </div>

        <div className="min-w-0 space-y-4">
          <CarePlanForm action={addCarePlanItem} />
          <p className="px-1 text-xs text-slate-400 dark:text-slate-500">
            Informational only, not medical advice. Imported care-plan items
            come from uploaded health records (Plan of Treatment section).
          </p>
        </div>
      </div>
    </div>
  );
}
