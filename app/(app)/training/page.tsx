import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import Tabs from "@/components/Tabs";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import OverviewSection from "./OverviewSection";
import HistorySection from "./HistorySection";
import AnalyzeSection from "./AnalyzeSection";
import GoalsSection from "./GoalsSection";

export const dynamic = "force-dynamic";

// Combined training hub: aggregate overview, workout history, per-activity
// analysis, and goals behind tabs.
export default function TrainingPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  // Hidden for age-restricted profiles; the nav link is gone, this bounces any
  // direct navigation back to the dashboard (see lib/age-gate.ts).
  const { profile } = requireSession();
  if (isTrainingRestricted(profile.id)) redirect("/");
  return (
    <div>
      <PageHeader
        title="Training"
        subtitle="Review workouts, compare progress, and manage training goals."
      />
      <Tabs
        paramKey="tab"
        tabs={[
          {
            id: "log",
            label: "Log",
            content: <HistorySection />,
            keepMounted: false,
          },
          {
            id: "overview",
            label: "Overview",
            content: <OverviewSection />,
          },
          {
            id: "analyze",
            label: "Analyze",
            content: (
              <AnalyzeSection
                kind={one(searchParams?.kind)}
                item={one(searchParams?.item)}
                exercise={one(searchParams?.exercise)}
                metric={one(searchParams?.metric)}
                range={one(searchParams?.range)}
              />
            ),
          },
          { id: "goals", label: "Goals", content: <GoalsSection /> },
        ]}
      />
    </div>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
