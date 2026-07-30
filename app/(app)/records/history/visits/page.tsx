import { requireScope } from "@/lib/scope";
import VisitsSection from "../../VisitsSection";
import { SectionSubtitle } from "../../SectionHeader";

export const dynamic = "force-dynamic";

// Health record › History › Visits (#1079): appointments + past encounters. A heavy
// solo pane (can run to dozens of rows) — the default landing. Content component
// moved, not rewritten.
export default async function RecordsVisitsPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const searchParams = await props.searchParams;
  // Multi-view (#1359): resolve the cross-profile scope once — the Past encounters
  // list reads its own view-set; the appointment/booking apparatus stays acting-only.
  // Single view is byte-identical to the former requireSession()/profile.id path.
  const scope = await requireScope();
  // Widen-to-household link — shown only when the login can reach 2+ profiles
  // (the SAME predicate that gates the Household strip/nav).
  const showHousehold = scope.profiles.length > 1;
  return (
    <div data-testid="records-visits">
      <SectionSubtitle
        title="Visits"
        more="Use Add visit to schedule an appointment or log one that already happened. Completing a scheduled appointment can also create its visit-history entry and close matching preventive or care-plan items."
      >
        Manage upcoming appointments and your visit history.
      </SectionSubtitle>
      <VisitsSection
        scope={scope}
        searchParams={searchParams}
        showHousehold={showHousehold}
      />
    </div>
  );
}
