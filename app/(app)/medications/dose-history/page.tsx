import { requireScope } from "@/lib/scope";
import PageContainer from "@/components/PageContainer";
import DoseLedgerView from "@/components/intake/DoseLedgerView";

export const dynamic = "force-dynamic";

// The medications surface's door into the cross-item dose ledger (#2417) — the same
// shared DoseLedgerView /nutrition/dose-history renders, pre-filtered to the other
// kind. See that file and components/intake/DoseLedgerView.tsx: one ledger, two doors,
// because a medication and a supplement are one table and one set of dose machinery.
export default async function MedicationDoseHistoryPage(props: {
  searchParams: Promise<{
    from?: string | string[];
    to?: string | string[];
    range?: string | string[];
    kind?: string | string[];
    item?: string | string[];
  }>;
}) {
  const searchParams = await props.searchParams;
  const scope = await requireScope();
  return (
    <PageContainer width="reading" className="mx-auto">
      <DoseLedgerView
        profileId={scope.actingProfileId}
        loginId={scope.loginId}
        canWrite={scope.access.get(scope.actingProfileId) === "write"}
        surface="medication"
        params={searchParams}
      />
    </PageContainer>
  );
}
