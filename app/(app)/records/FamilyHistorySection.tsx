import { getFamilyHistory } from "@/lib/queries";
import { readForProfiles, stampSubjects, type ProfileScope } from "@/lib/scope";
import FamilyHistoryForm from "@/app/(app)/family-history/FamilyHistoryForm";
import FamilyHistoryList from "@/app/(app)/family-history/FamilyHistoryList";
import { addFamilyHistory } from "@/app/(app)/family-history/actions";

// Family history (former /family-history index, #1042 phase 6): conditions
// affecting the profile's relatives — high-value clinical context for hereditary
// risk — now the #family-history section of /records. Imported from a health
// record's CCD Family History section (LOINC 10157-6) or a FHIR
// FamilyMemberHistory resource, plus manual add/edit/delete. One row per
// (relative, condition) pair.
export default function FamilyHistorySection({
  scope,
}: {
  scope: ProfileScope;
}) {
  const multi = scope.viewIds.length > 1;
  const entries = stampSubjects(
    scope,
    readForProfiles(scope.viewIds, (pid) => getFamilyHistory(pid))
  );

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="min-w-0 space-y-4 lg:col-span-2">
        <FamilyHistoryList
          items={entries}
          multiView={
            multi ? { actingProfileId: scope.actingProfileId } : undefined
          }
        />
      </div>

      <div className="min-w-0 space-y-4">
        <FamilyHistoryForm action={addFamilyHistory} />
        <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
          Imported entries come from uploaded health records (CCD Family History
          section).
        </p>
      </div>
    </div>
  );
}
