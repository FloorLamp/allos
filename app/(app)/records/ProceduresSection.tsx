import { getProcedures, getProviderNames } from "@/lib/queries";
import ProviderDatalist from "@/components/ProviderDatalist";
import ProcedureForm from "@/app/(app)/procedures/ProcedureForm";
import ProcedureList from "@/app/(app)/procedures/ProcedureList";
import { addProcedure } from "@/app/(app)/procedures/actions";

// Procedures / surgical history (former /procedures index, #1042 phase 6): the
// profile's procedure history, newest first, now the #procedures section of
// /records. Imported from a health record's CCD Procedures section (LOINC
// 47519-4) or a FHIR Procedure resource, plus manual add/edit/delete. Each row
// shows its name, code, performed date, and performing provider (resolved from
// the shared registry).
export default function ProceduresSection({
  profileId,
  prefillName,
}: {
  profileId: number;
  // Deep-link add-form prefill (#1083) forwarded to the add form.
  prefillName?: string;
}) {
  const procedures = getProcedures(profileId);
  const providerNames = getProviderNames();

  return (
    <>
      {/* Shared provider picker options for the add + edit forms. */}
      <ProviderDatalist names={providerNames} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <ProcedureList items={procedures} />
        </div>

        <div className="min-w-0 space-y-4">
          <ProcedureForm action={addProcedure} prefillName={prefillName} />
          <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
            Imported procedures come from uploaded health records (CCD
            Procedures section).
          </p>
        </div>
      </div>
    </>
  );
}
