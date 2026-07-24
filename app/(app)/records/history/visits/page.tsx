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
      <SectionSubtitle>
        Your appointments and visit history in one place — book upcoming visits
        (they also surface on Upcoming) and review past encounters, diagnoses,
        and notes.
      </SectionSubtitle>
      <VisitsSection
        scope={scope}
        searchParams={searchParams}
        showHousehold={showHousehold}
      />
    </div>
  );
}
