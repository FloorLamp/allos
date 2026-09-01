import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import StreamedSection, { PendingSection } from "@/components/StreamedSection";
import TabFirstPage from "@/components/TabFirstPage";
import { TRAINING_TAB_FIRST_PAGE } from "@/components/tab-first-pages";
import { requireSession } from "@/lib/auth";
import {
  parseTrainingTab,
  retiredTrainingTabTarget,
  trainingTabStrip,
} from "@/lib/training-tabs";
import OverviewSection from "./OverviewSection";
import HistorySection from "./HistorySection";
import AnalyzeSection from "./AnalyzeSection";
import PlanSection from "./PlanSection";
import { isRealIsoDate } from "@/lib/date";
import { today } from "@/lib/db";
import { getProfileAge } from "@/lib/settings/profile-attrs";
import { isTrainingRelevant } from "@/lib/life-stage";
import AddTrainingActivityButton from "@/app/(app)/training/AddTrainingActivityButton";

export const dynamic = "force-dynamic";

// Combined training hub: the Training Log, the doing-first overview, per-activity
// analysis, and planning (routines + goals + targets) behind tabs. The fitness
// check lives on its own route (#2894), reached from Overview's strip.
export default async function TrainingPage(props: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const { profile } = await requireSession();
  // The workout product stands down through early childhood. Activity facts are
  // still preserved and their record-level pages remain reachable from Timeline,
  // search, and imports; only the hub/create/programming experience redirects.
  if (!isTrainingRelevant(getProfileAge(profile.id))) redirect("/");

  // Retired tab names redirect to their canonical URLs (#2892/#2894) — an
  // explicit mapping, not the unknown-tab fallback, because these links live on
  // in bookmarks and Telegram history and mean a specific surface, not whatever
  // tab happens to be default. Normalizing the URL is also what keeps the
  // client tab strip's highlight honest and restores the section anchors.
  const retired = retiredTrainingTabTarget(searchParams?.tab);
  if (retired) redirect(retired);

  const activeTab = parseTrainingTab(searchParams?.tab);
  // The pending state names the tab the way the strip above it does, so the two
  // never disagree about what is arriving.
  const activeTabLabel =
    trainingTabStrip().find((t) => t.id === activeTab)?.label ?? "Training";
  const requestedDate = one(searchParams?.date);
  const initialCreateDate =
    isRealIsoDate(requestedDate) && requestedDate <= today(profile.id)
      ? requestedDate
      : undefined;

  // Build only the server-selected section (#105/#1496); URL links keep each tab
  // deep-linkable without evaluating every tab's queries during the RSC pass.
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
    // Width cap (#2893): "wide" (72rem) fits every tab's densest layout
    // (Analyze's chart + 28rem aside). The cap wraps the WHOLE tab-first shell
    // — header, tab strip, and panel — the way records and nutrition cap
    // theirs: capping only the panel left the tab strip running to the shell's
    // 3xl (1920px with the browser-default 16px initial font size) edge, wider
    // than the content beneath it.
    <PageContainer width="wide" className="mx-auto">
      <TabFirstPage
        config={TRAINING_TAB_FIRST_PAGE}
        testId="training-page"
        // A stable, ungated door to the equipment registry (#592) — gear lives
        // conceptually under training, but /equipment has no top-level nav item.
        // Desktop-only since #2892: on phones the header action rendered as a
        // full-width row above every tab, and the Plan tab's Equipment card is
        // the phone door now.
        createAction={{
          kind: "training-activity",
          available: activeTab === "log",
          control: <AddTrainingActivityButton />,
        }}
        action={
          <Link
            href="/equipment"
            data-testid="training-equipment-link"
            className="hidden shrink-0 items-center py-1 text-sm text-link md:inline-flex"
          >
            Equipment
          </Link>
        }
      >
        {/* THE HEAD DOES NOT WAIT ON THE TAB (#2641 gap 1, the Trends pattern).
            Everything above this line is cheap — one session read and one age
            read — while the selected section is the hub's whole query load
            (Overview alone runs ~25 of them). Streaming the panel is what makes
            a tap on Training paint the page's name, its four tabs and its header
            action immediately instead of holding the previous page for the
            destination's full render. The tabs are LINKS, so the shell is
            usable, not decorative: you can switch surface before the first one
            has arrived.

            The placeholder is one card because the panel's own first element is
            one card, and nothing renders below it — a section that lands taller
            grows the page downward, past the fold, rather than moving anything
            the reader is looking at. That is the #2531/#2399 height rule applied
            to a pending state: reserve what you know, never a spinner in a void.

            NOT a route-level `loading.tsx` (#530): that judgment — a content-less
            shell is worse than nothing — is exactly why this boundary sits BELOW
            the header and the tab strip rather than above them. */}
        <Suspense fallback={<PendingSection label={activeTabLabel} />}>
          <StreamedSection>{activeSection}</StreamedSection>
        </Suspense>
      </TabFirstPage>
    </PageContainer>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
