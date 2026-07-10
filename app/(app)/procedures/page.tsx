import { requireSession } from "@/lib/auth";
import { getProcedures, getProviderNames } from "@/lib/queries";
import ProviderDatalist from "@/components/ProviderDatalist";
import { PageHeader } from "@/components/ui";
import ProcedureForm from "./ProcedureForm";
import ProcedureList from "./ProcedureList";
import { addProcedure } from "./actions";

export const dynamic = "force-dynamic";

// Procedures / surgical history: the profile's procedure history, newest first.
// Imported from a health record's CCD Procedures section (LOINC 47519-4) or a FHIR
// Procedure resource, plus manual add/edit/delete. Each row shows its name, code,
// performed date, and performing provider (resolved from the shared registry).
export default function ProceduresPage() {
  const { profile } = requireSession();
  const procedures = getProcedures(profile.id);
  const providerNames = getProviderNames();

  return (
    <div>
      {/* Shared provider picker options for the add + edit forms. */}
      <ProviderDatalist names={providerNames} />
      <PageHeader
        title="Procedures"
        subtitle="Your procedure & surgical history — coded (CPT / SNOMED) when imported from a health record. Add them manually or import from uploaded records (CCD Procedures section)."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <ProcedureList items={procedures} />
        </div>

        <div className="min-w-0 space-y-4">
          <ProcedureForm action={addProcedure} />
          <p className="px-1 text-xs text-slate-400 dark:text-slate-500">
            Informational only, not medical advice. Imported procedures come
            from uploaded health records (CCD Procedures section).
          </p>
        </div>
      </div>
    </div>
  );
}
