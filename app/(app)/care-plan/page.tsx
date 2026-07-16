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
import { Notice } from "@/components/Notice";
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
            Informational only, not medical advice. Imported care-plan items
            come from uploaded health records (Plan of Treatment section).
          </p>
        </div>
      </div>
    </div>
  );
}
