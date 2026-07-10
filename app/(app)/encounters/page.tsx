import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getEncounters, getProviderNames } from "@/lib/queries";
import ProviderDatalist from "@/components/ProviderDatalist";
import { PageHeader } from "@/components/ui";
import EncounterForm from "./EncounterForm";
import EncounterList from "./EncounterList";
import { addEncounter } from "./actions";

export const dynamic = "force-dynamic";

// Visits / encounters: the profile's visit history, newest first.
// Imported from a health record's CCD Encounters section, plus manual add/edit/
// delete. Each visit shows its date, type, chief complaint, diagnoses, and the
// attending provider + facility (resolved from the shared providers registry).
export default function EncountersPage() {
  const { profile } = requireSession();
  const now = today(profile.id);
  const encounters = getEncounters(profile.id);
  const providerNames = getProviderNames();

  return (
    <div>
      {/* Shared provider picker options for the add + edit forms. */}
      <ProviderDatalist names={providerNames} />
      <PageHeader
        title="Visits"
        subtitle="Your visit history — office visits, hospitalizations, and other encounters. Add them manually or import from uploaded health records (CCD Encounters section)."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <EncounterList items={encounters} defaultDate={now} />
        </div>

        <div className="min-w-0 space-y-4">
          <EncounterForm action={addEncounter} defaultDate={now} />
          <p className="px-1 text-xs text-slate-400 dark:text-slate-500">
            Informational only, not medical advice. Imported visits come from
            uploaded health records (CCD Encounters section).
          </p>
        </div>
      </div>
    </div>
  );
}
