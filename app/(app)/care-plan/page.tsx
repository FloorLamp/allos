import { requireSession } from "@/lib/auth";
import { getCarePlanItems, getProviderNames } from "@/lib/queries";
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
