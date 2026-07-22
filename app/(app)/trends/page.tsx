import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { isTrainingRestricted } from "@/lib/age-gate";
import { getTrendViews } from "@/lib/settings";
import {
  normalizeTimelineRange,
  timelineDateFromParam,
  type DateRange,
} from "@/lib/timeline-format";
import { rangeSummaryLabel } from "@/lib/trends";
import { PageHeader } from "@/components/ui";
import NavTabs from "@/components/NavTabs";
import DateRangeControl from "@/components/DateRangeControl";
import SavedViewsBar from "@/components/SavedViewsBar";
import OverviewSection from "./OverviewSection";
import CompareSection from "./CompareSection";
import BodySection from "./BodySection";
import { parseBodyView } from "./body-view";
import VitalsSection from "./VitalsSection";
import FitnessSection from "./FitnessSection";
import InsightsSection from "./InsightsSection";
import NutritionSection from "./NutritionSection";
import type { AppRoute } from "@/lib/hrefs";

export const dynamic = "force-dynamic";

const TABS = [
  "overview",
  "compare",
  "vitals",
  "body",
  "nutrition",
  "fitness",
  "insights",
] as const;
type TrendsTab = (typeof TABS)[number];

function firstParam(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

function parseTab(value: string | string[] | undefined): TrendsTab {
  const first = Array.isArray(value) ? value[0] : value;
  return TABS.includes(first as TrendsTab) ? (first as TrendsTab) : "overview";
}

// The Trends hub: the analytics lens — a sibling to the
// Timeline — that aggregates the app's existing trend charts into one place under
// a SHARED date-range control. Every section reuses existing components/queries;
// the shared window (from/to) drives them all. Fitness + Insights (age-gated
// surfaces) are hidden for training-restricted profiles.
export default async function TrendsPage(props: {
  searchParams: Promise<{
    tab?: string | string[];
    ftab?: string | string[];
    from?: string | string[];
    to?: string | string[];
    cmpA?: string | string[];
    cmpB?: string | string[];
    cmpn?: string | string[];
    view?: string | string[];
  }>;
}) {
  const searchParams = await props.searchParams;
  const { profile } = await requireSession();
  const todayStr = today(profile.id);
  const restricted = isTrainingRestricted(profile.id);
  const savedViews = getTrendViews(profile.id);

  const from = timelineDateFromParam(searchParams.from);
  const to = timelineDateFromParam(searchParams.to);
  const range = normalizeTimelineRange(from, to);
  // Fitness + Insights are spliced out below for restricted profiles; if one is
  // requested via ?tab=, fall back to the default so the URL doesn't advertise a
  // tab that isn't there (the tab strip already can't select it).
  const requestedTab = parseTab(searchParams.tab);
  const activeTab =
    restricted && (requestedTab === "fitness" || requestedTab === "insights")
      ? "overview"
      : requestedTab;
  const cmpA = firstParam(searchParams.cmpA);
  const cmpB = firstParam(searchParams.cmpB);
  const cmpNormalized = firstParam(searchParams.cmpn) === "1";
  // #1067 Phase 2: the Body tab's overview layout mode (tiles vs the classic chart
  // stack). Only meaningful on the Body tab; carried through the range control + tab
  // navigation so a chosen layout survives a window change.
  const bodyView = parseBodyView(firstParam(searchParams.view));
  // The Fitness section's nested strip (Strength/Cardio/Sport) is also driven by
  // the URL (?ftab=), so — like the top-level tab — only the active nested
  // section is built server-side. FitnessSection validates/defaults this.
  const ftab = firstParam(searchParams.ftab);

  // Build a /trends URL, preserving the active tab + window unless overridden.
  // Overview is the default tab, so it's dropped from the query string.
  function trendsHref(params: {
    tab?: TrendsTab;
    from?: string;
    to?: string;
    cmpA?: string;
    cmpB?: string;
    cmpn?: boolean;
    view?: "tiles" | "all";
  }): AppRoute {
    const sp = new URLSearchParams();
    if (params.tab && params.tab !== "overview") sp.set("tab", params.tab);
    if (params.from) sp.set("from", params.from);
    if (params.to) sp.set("to", params.to);
    if (params.cmpA) sp.set("cmpA", params.cmpA);
    if (params.cmpB) sp.set("cmpB", params.cmpB);
    if (params.cmpn) sp.set("cmpn", "1");
    if (params.view) sp.set("view", params.view);
    const qs = sp.toString();
    return qs ? `/trends?${qs}` : "/trends";
  }

  const buildRangeHref = (r: DateRange) =>
    trendsHref({
      tab: activeTab,
      from: r.from,
      to: r.to,
      cmpA,
      cmpB,
      cmpn: cmpNormalized,
      view: activeTab === "body" ? bodyView : undefined,
    });

  // Tab-strip spec: labels only. Fitness + Insights are age-gated surfaces —
  // omitted entirely for training-restricted profiles (matching the
  // Journal/Training/Insights nav gate), so they're never in the strip or
  // reachable via ?tab= for them (the activeTab fallback above enforces the
  // latter).
  const tabStrip: { id: TrendsTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "compare", label: "Compare" },
    { id: "vitals", label: "Vitals" },
    { id: "body", label: "Body" },
    { id: "nutrition", label: "Nutrition" },
    ...(restricted
      ? []
      : ([
          { id: "fitness", label: "Fitness" },
          { id: "insights", label: "Insights" },
        ] as const)),
  ];

  // #105: build ONLY the active section server-side. Passing every section as a
  // prop rendered (and ran the queries for) all six on every request — the
  // client `keepMounted` flag only gated DOM, not the RSC pass. Each tab switch
  // is already a URL navigation (NavTabs → router.replace), so this makes every
  // Trends request compute one tab instead of six, at no extra round-trips.
  const activeSection: React.ReactNode = (() => {
    switch (activeTab) {
      case "compare":
        return (
          <CompareSection
            range={range}
            a={cmpA}
            b={cmpB}
            normalized={cmpNormalized}
          />
        );
      case "vitals":
        return <VitalsSection range={range} />;
      case "body":
        return (
          <BodySection
            range={range}
            view={bodyView}
            tilesHref={trendsHref({
              tab: "body",
              from: range.from,
              to: range.to,
              view: "tiles",
            })}
            allHref={trendsHref({
              tab: "body",
              from: range.from,
              to: range.to,
              view: "all",
            })}
          />
        );
      case "nutrition":
        return <NutritionSection range={range} />;
      case "fitness":
        return <FitnessSection ftab={ftab} />;
      case "insights":
        return <InsightsSection range={range} />;
      case "overview":
      default:
        return <OverviewSection range={range} />;
    }
  })();

  return (
    <div>
      <PageHeader
        title="Trends"
        subtitle="Your analytics lens — body, nutrition, fitness, and insights under one date range."
      />

      <div className="mb-6 space-y-2 sm:space-y-4">
        <DateRangeControl
          basePath="/trends"
          range={range}
          todayStr={todayStr}
          hiddenParams={{
            tab: activeTab === "overview" ? undefined : activeTab,
            cmpA,
            cmpB,
            cmpn: cmpNormalized ? "1" : undefined,
            view: activeTab === "body" ? bodyView : undefined,
          }}
          buildHref={buildRangeHref}
          idPrefix="trends"
          rightSlot={
            <span className="whitespace-nowrap rounded-full border border-black/10 bg-white/60 px-3 py-1 text-slate-500 dark:border-white/10 dark:bg-ink-900/60 dark:text-slate-400">
              {rangeSummaryLabel(range, todayStr)}
            </span>
          }
        />
        <SavedViewsBar views={savedViews} />
      </div>

      <NavTabs paramKey="tab" tabs={tabStrip}>
        {activeSection}
      </NavTabs>
    </div>
  );
}
