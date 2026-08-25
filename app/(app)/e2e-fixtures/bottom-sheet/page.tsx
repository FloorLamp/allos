import { notFound } from "next/navigation";
import BottomSheetGestureHarness from "./BottomSheetGestureHarness";
import PageContainer from "@/components/PageContainer";
import { PageHeader } from "@/components/ui";

// This route exists only for real-browser gesture coverage that needs a
// BottomSheet `description` (the prop has no product caller). The E2E worker is
// the only server that opts it in; an ordinary deployment gets a 404.
export const dynamic = "force-dynamic";

export default async function BottomSheetGesturePage({
  searchParams,
}: {
  searchParams: Promise<{ guarded?: string }>;
}) {
  if (process.env.ALLOS_E2E_TEST_HARNESS !== "1") notFound();
  const query = await searchParams;
  return (
    <PageContainer width="form">
      <PageHeader title="Bottom sheet gesture fixture" />
      <BottomSheetGestureHarness guarded={query.guarded === "1"} />
    </PageContainer>
  );
}
