import Link from "next/link";
import { redirect } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import TabFirstPage from "@/components/TabFirstPage";
import { TRAINING_TAB_FIRST_PAGE } from "@/components/tab-first-pages";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import {
  parseTrainingTab,
  retiredTrainingTabTarget,
} from "@/lib/training-tabs";
import OverviewSection from "./OverviewSection";
import HistorySection from "./HistorySection";
import AnalyzeSection from "./AnalyzeSection";
import PlanSection from "./PlanSection";
import RestrictedActivityView from "./RestrictedActivityView";
import { isRealIsoDate } from "@/lib/date";
import { today } from "@/lib/db";

export const dynamic = "force-dynamic";

// Combined training hub: the Training Log, the doing-first overview, per-activity
// analysis, and planning (routines + goals + targets) behind tabs. The fitness
// check lives on its own route (#2894), reached from Overview's strip.
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

  // Retired tab names redirect to their canonical URLs (#2892/#2894) — an
  // explicit mapping, not the unknown-tab fallback, because these links live on
  // in bookmarks and Telegram history and mean a specific surface, not whatever
  // tab happens to be default. Normalizing the URL is also what keeps the
  // client tab strip's highlight honest and restores the section anchors.
  const retired = retiredTrainingTabTarget(searchParams?.tab);
  if (retired) redirect(retired);

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
      case "log":
        return <HistorySection initialCreateDate={initialCreateDate} />;
      case "plan":
        return <PlanSection />;
      case "overview":
      default:
        return <OverviewSection />;
    }
  })();

  return (
    <TabFirstPage
      config={TRAINING_TAB_FIRST_PAGE}
      testId="training-page"
      // A stable, ungated door to the equipment registry (#592) — gear lives
      // conceptually under training, but /equipment has no top-level nav item.
      // Desktop-only since #2892: on phones the header action rendered as a
      // full-width row above every tab, and the Plan tab's Equipment card is
      // the phone door now.
      action={
        <Link
          href="/equipment"
          data-testid="training-equipment-link"
          className="hidden shrink-0 items-center py-1 text-sm font-medium text-brand-600 hover:underline md:inline-flex dark:text-brand-400"
        >
          Equipment
        </Link>
      }
    >
      {/* Width cap (#2893): training content stopped only at the shell's 3xl
          (~1760px) cap — Analyze and Log lines ran edge to edge on ordinary
          monitors. PageContainer owns width policy; "wide" (72rem) fits every
          tab's densest layout (Analyze's chart + 28rem aside). */}
      <PageContainer width="wide" className="mx-auto">
        {activeSection}
      </PageContainer>
    </TabFirstPage>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
