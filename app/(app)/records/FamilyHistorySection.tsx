import { getFamilyHistory } from "@/lib/queries";
import { readForProfiles, stampSubjects, type ProfileScope } from "@/lib/scope";
import FamilyHistoryForm from "@/app/(app)/records/care/overview/FamilyHistoryForm";
import AddEntryPanel from "@/components/AddEntryPanel";
import FamilyHistoryList from "@/app/(app)/records/care/overview/FamilyHistoryList";
import { addFamilyHistory } from "@/app/(app)/records/care/overview/family-history-actions";

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
    <div className="space-y-6">
      <FamilyHistoryList
        items={entries}
        multiView={
          multi ? { actingProfileId: scope.actingProfileId } : undefined
        }
      />
      <div>
        <AddEntryPanel
          testId="add-family-history-panel"
          panelId="add-family-history-panel-body"
          label="Add family history"
          presentation="modal"
        >
          <FamilyHistoryForm action={addFamilyHistory} />
        </AddEntryPanel>
        <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
          Imported entries come from uploaded health records (CCD Family History
          section).
        </p>
      </div>
    </div>
  );
}
