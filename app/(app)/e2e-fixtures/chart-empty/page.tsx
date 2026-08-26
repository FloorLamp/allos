import { notFound } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import { PageHeader } from "@/components/ui";
import ChartEmptyHarness from "./ChartEmptyHarness";

export const dynamic = "force-dynamic";

export default function ChartEmptyFixturePage() {
  if (process.env.ALLOS_E2E_TEST_HARNESS !== "1") notFound();
  return (
    <PageContainer width="form">
      <PageHeader title="Chart empty-state fixture" />
      <ChartEmptyHarness />
    </PageContainer>
  );
}
