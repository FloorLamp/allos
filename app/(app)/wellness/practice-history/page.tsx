import { requireScope } from "@/lib/scope";
import PageContainer from "@/components/PageContainer";
import PracticeLedgerMount from "@/components/practices/PracticeLedgerMount";

export const dynamic = "force-dynamic";

export default async function PracticeHistoryPage(props: {
  searchParams: Promise<
    Record<
      "from" | "to" | "range" | "item" | "page",
      string | string[] | undefined
    >
  >;
}) {
  const params = await props.searchParams;
  const scope = await requireScope();
  return (
    <PageContainer width="reading" className="mx-auto">
      <PracticeLedgerMount
        profileId={scope.actingProfileId}
        loginId={scope.loginId}
        canWrite={scope.access.get(scope.actingProfileId) === "write"}
        params={params}
      />
    </PageContainer>
  );
}
