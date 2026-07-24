import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import ReportsSection from "../ReportsSection";

export const dynamic = "force-dynamic";

// Results › Reports (#708): the narrative diagnostic report bodies — microbiology
// culture, gram stain, and cytopathology reports — captured from imported CCD/XDM
// health records. Text-only documents that don't trend; the structured results
// (analytes, organisms) live on Biomarkers.
export default async function ResultsReportsPage() {
  const { profile, login } = await requireSession();
  const fmt = getDisplayFormatPrefs(login.id);
  return (
    <div data-testid="results-reports">
      <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        Narrative diagnostic reports — the free-text body of a microbiology
        culture, gram stain, or pathology/cytology report, captured from an
        imported health record. These are documents, not measurements, so they
        don&apos;t trend; the structured results live in Biomarkers.
      </p>
      <ReportsSection profileId={profile.id} fmt={fmt} />
    </div>
  );
}
