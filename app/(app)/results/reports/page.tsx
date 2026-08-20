import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import PageContainer from "@/components/PageContainer";
import PaneIntro from "@/components/PaneIntro";
import ReportsSection from "../ReportsSection";

export const dynamic = "force-dynamic";

// Results › Reports (#708): the narrative diagnostic report bodies — microbiology
// culture, gram stain, and cytopathology reports — captured from imported CCD/XDM
// health records. Text-only documents that don't trend; the structured results
// (analytes, organisms) live under Clinical results.
export default async function ResultsReportsPage() {
  const { profile, login } = await requireSession();
  const fmt = getDisplayFormatPrefs(login.id);
  return (
    <PageContainer
      width="reading"
      className="mx-auto"
      data-testid="results-reports"
    >
      <PaneIntro title="Reports" testId="results-pane-intro">
        Narrative diagnostic reports — microbiology, gram stain, and
        cytopathology — as they were written.
      </PaneIntro>
      <ReportsSection profileId={profile.id} fmt={fmt} />
    </PageContainer>
  );
}
