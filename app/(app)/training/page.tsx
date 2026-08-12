import Link from "next/link";
import TabFirstPage from "@/components/TabFirstPage";
import { TRAINING_TAB_FIRST_PAGE } from "@/components/tab-first-pages";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { parseTrainingTab } from "@/lib/training-tabs";
import OverviewSection from "./OverviewSection";
import HistorySection from "./HistorySection";
import FitnessCheckSection from "./FitnessCheckSection";
import AnalyzeSection from "./AnalyzeSection";
import GoalsSection from "./GoalsSection";
import RoutinesSection from "./RoutinesSection";
import RestrictedActivityView from "./RestrictedActivityView";
import { isRealIsoDate } from "@/lib/date";
import { today } from "@/lib/db";

export const dynamic = "force-dynamic";

// Combined training hub: the Training Log, the doing-first overview, per-activity
// analysis, the fitness check, routines, and goals behind tabs.
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

  const activeTab = parseTrainingTab(searchParams?.tab);
  const requestedDate = one(searchParams?.date);
  const initialCreateDate =
    isRealIsoDate(requestedDate) && requestedDate <= today(profile.id)
      ? requestedDate
      : undefined;

  // #105 (the Trends pattern, #1496): build ONLY the active section server-side.
  // Handing every section to `Tabs` as a `content:` prop rendered — and ran the
  // queries for — all SIX on every request; the client `keepMounted` flag gated DOM,
  // not the RSC pass. Each tab switch is already a URL navigation (NavTabs → Link),
  // so this makes a /training visit compute one tab instead of all of them, at no
  // extra round-trips. The `?tab=` vocabulary is unchanged, so every deep link
  // (?tab=log from the timeline/integrations, ?tab=analyze from the plateau finding,
  // ?tab=goals from the dashboard widget, …) lands exactly where it always did.
  const activeSection: React.ReactNode = (() => {
    switch (activeTab) {
      case "overview":
        return <OverviewSection />;
      case "analyze":
        return (
          <AnalyzeSection
            kind={one(searchParams?.kind)}
            item={one(searchParams?.item)}
            exercise={one(searchParams?.exercise)}
            metric={one(searchParams?.metric)}
            range={one(searchParams?.range)}
            lane={one(searchParams?.lane)}
          />
        );
      case "fitness":
        return <FitnessCheckSection />;
      case "routines":
        return <RoutinesSection />;
      case "goals":
        return <GoalsSection />;
      case "log":
      default:
        return <HistorySection initialCreateDate={initialCreateDate} />;
    }
  })();

  return (
    <TabFirstPage
      config={TRAINING_TAB_FIRST_PAGE}
      testId="training-page"
      // A stable, ungated door to the equipment registry (#592) — gear lives
      // conceptually under training, but /equipment has no top-level nav item.
      // Reachable on a phone too since #1661; the vertical padding is what makes
      // it a real tap target there (it costs desktop nothing, the row is taller).
      action={
        <Link
          href="/equipment"
          data-testid="training-equipment-link"
          className="inline-flex shrink-0 items-center py-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
        >
          Equipment
        </Link>
      }
    >
      {activeSection}
    </TabFirstPage>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
