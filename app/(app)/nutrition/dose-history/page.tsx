import { requireScope } from "@/lib/scope";
import PageContainer from "@/components/PageContainer";
import DoseLedgerView from "@/components/intake/DoseLedgerView";

export const dynamic = "force-dynamic";

// The supplements surface's door into the cross-item dose ledger (#2417).
//
// The whole page body is the shared DoseLedgerView — /medications/dose-history is the
// same component with the other `surface`, because the ledger is intake machinery and
// intake machinery is not split by kind. This file's entire job is the auth boundary
// and the pre-filter: a caller arriving from Nutrition → Supplements opens on
// supplements, and the page's kind filter is what widens that.
export default async function SupplementDoseHistoryPage(props: {
  searchParams: Promise<{
    from?: string | string[];
    to?: string | string[];
    range?: string | string[];
    kind?: string | string[];
    item?: string | string[];
    // The ledger's page (#2445) — the read's bound, so it has to reach the view.
    page?: string | string[];
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
        surface="supplement"
        params={searchParams}
      />
    </PageContainer>
  );
}
