import { requireSession } from "@/lib/auth";
import { getFamilyHistory } from "@/lib/queries";
import { PageHeader } from "@/components/ui";
import FamilyHistoryForm from "./FamilyHistoryForm";
import FamilyHistoryList from "./FamilyHistoryList";
import { addFamilyHistory } from "./actions";

export const dynamic = "force-dynamic";

// Family history: conditions affecting the profile's relatives — high-value clinical
// context for hereditary risk. Imported from a health record's CCD Family History
// section (LOINC 10157-6) or a FHIR FamilyMemberHistory resource, plus manual
// add/edit/delete. One row per (relative, condition) pair.
export default function FamilyHistoryPage() {
  const { profile } = requireSession();
  const entries = getFamilyHistory(profile.id);

  return (
    <div>
      <PageHeader
        title="Family history"
        subtitle="Conditions affecting your relatives — hereditary risk context, coded when imported from a health record. Add entries manually or import from uploaded records (CCD Family History section)."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <FamilyHistoryList items={entries} />
        </div>

        <div className="min-w-0 space-y-4">
          <FamilyHistoryForm action={addFamilyHistory} />
          <p className="px-1 text-xs text-slate-400 dark:text-slate-500">
            Informational only, not medical advice. Imported entries come from
            uploaded health records (CCD Family History section).
          </p>
        </div>
      </div>
    </div>
  );
}
