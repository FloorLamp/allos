import Link from "next/link";
import { PageHeader } from "@/components/ui";
import Tabs from "@/components/Tabs";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import OverviewSection from "./OverviewSection";
import HistorySection from "./HistorySection";
import FitnessCheckSection from "./FitnessCheckSection";
import AnalyzeSection from "./AnalyzeSection";
import GoalsSection from "./GoalsSection";
import RoutinesSection from "./RoutinesSection";
import RestrictedActivityView from "./RestrictedActivityView";

export const dynamic = "force-dynamic";

// Combined training hub: aggregate overview, workout history, per-activity
// analysis, and goals behind tabs.
export default async function TrainingPage(props: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const searchParams = await props.searchParams;
  // Type-aware training restriction (#489): a minor keeps age-neutral sport/cardio
  // tracking via a lightweight activity log instead of losing the surface outright.
  // The adult hub below (strength e1RM/standards, fitness-age, coaching, goals)
  // stays gated — this branch swaps it for the sport/cardio log.
  const { profile } = await requireSession();
  if (isTrainingRestricted(profile.id)) return <RestrictedActivityView />;
  return (
    <div>
      <PageHeader
        title="Training"
        subtitle="Review workouts, compare progress, and manage training goals."
        // A stable, ungated door to the equipment registry (#592) — gear lives
        // conceptually under training, but /equipment has no top-level nav item.
        action={
          <Link
            href="/equipment"
            data-testid="training-equipment-link"
            className="shrink-0 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            Equipment
          </Link>
        }
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
            // Non-default panels: don't keep them mounted client-side when a
            // different tab is active (each section reads only its own data), so
            // switching away drops their DOM instead of hiding it.
            keepMounted: false,
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
            keepMounted: false,
          },
          {
            id: "fitness",
            label: "Fitness check",
            content: <FitnessCheckSection />,
            keepMounted: false,
          },
          {
            id: "routines",
            label: "Routines",
            content: <RoutinesSection />,
            keepMounted: false,
          },
          {
            id: "goals",
            label: "Goals",
            content: <GoalsSection />,
            keepMounted: false,
          },
        ]}
      />
    </div>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
