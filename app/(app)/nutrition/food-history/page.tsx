import { requireScope } from "@/lib/scope";
import PageContainer from "@/components/PageContainer";
import FoodLedgerMount from "@/components/food/FoodLedgerMount";

export const dynamic = "force-dynamic";

export default async function FoodHistoryPage(props: {
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
      <FoodLedgerMount
        profileId={scope.actingProfileId}
        loginId={scope.loginId}
        canWrite={scope.access.get(scope.actingProfileId) === "write"}
        params={params}
      />
    </PageContainer>
  );
}
