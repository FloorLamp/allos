import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { isTrainingRestricted } from "@/lib/age-gate";
import { getTrendViews } from "@/lib/settings";
import {
  ALL_TIME_RANGE_PARAM,
  ALL_TIME_RANGE_VALUE,
  intradayQuickRange,
  isAllTimeRange,
  isCustomRange,
  normalizeTimelineRange,
  resolveTrendsRange,
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
import FitnessSection from "./FitnessSection";
import InsightsSection from "./InsightsSection";
import NutritionSection from "./NutritionSection";
import type { AppRoute } from "@/lib/hrefs";
import {
  isTabRestricted,
  parseTab,
  trendsTabStrip,
  type TrendsTab,
} from "@/lib/trends-tabs";

export const dynamic = "force-dynamic";

function firstParam(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
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
    // The explicit all-time sentinel (#1485 G) — see resolveTrendsRange.
    range?: string | string[];
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
  // #1485 G: no-param loads open on 90D, not all time. An explicit window still
  // wins verbatim — a shared ?from/?to link, a saved view, a quick-range pill —
  // and `?range=all` is the explicit all-time window (the pill has to be able to
  // say itself now that "no params" means something else).
  const range = resolveTrendsRange(
    normalizeTimelineRange(from, to),
    todayStr,
    firstParam(searchParams.range)
  );
  const allTime = isAllTimeRange(range);
  // Fitness + Insights are spliced out below for restricted profiles; if one is
  // requested via ?tab=, fall back to the default so the URL doesn't advertise a
  // tab that isn't there (the tab strip already can't select it).
  // parseTab also maps the RETIRED `?tab=vitals` onto body (#1486) — a vocabulary
  // mapping in lib/trends-tabs.ts, so every old deep link lands on the merged tab.
  const requestedTab = parseTab(searchParams.tab);
  const activeTab = isTabRestricted(requestedTab, restricted)
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
  // The "1D" pill (#1466), injected through the shared control's extra-ranges slot.
  // It moved to Body with the vitals (#1486) and stays scoped to that ONE tab on
  // purpose: 1D is only meaningful where the surface swaps to genuinely intraday
  // content (the Body tab's vitals section — the HR minute series + time-positioned
  // BP/SpO2 points). On every daily-grain tab a one-day window renders a single
  // dot, so no other tab offers it.
  const extraRanges =
    activeTab === "body" ? [intradayQuickRange(todayStr)] : [];

  // Build a /trends URL, preserving the active tab + window unless overridden.
  // Overview is the default tab, so it's dropped from the query string.
  function trendsHref(params: {
    tab?: TrendsTab;
    from?: string;
    to?: string;
    // The explicit all-time sentinel (#1485 G). Carried by every hub link so the
    // window survives a tab/view switch: without it a paramless link would land
    // back on the 90D default and "All time" would be a one-render state.
    allTime?: boolean;
    cmpA?: string;
    cmpB?: string;
    cmpn?: boolean;
    view?: "tiles" | "all";
  }): AppRoute {
    const sp = new URLSearchParams();
    if (params.tab && params.tab !== "overview") sp.set("tab", params.tab);
    if (params.from) sp.set("from", params.from);
    if (params.to) sp.set("to", params.to);
    if (params.allTime && !params.from && !params.to) {
      sp.set(ALL_TIME_RANGE_PARAM, ALL_TIME_RANGE_VALUE);
    }
    if (params.cmpA) sp.set("cmpA", params.cmpA);
    if (params.cmpB) sp.set("cmpB", params.cmpB);
    if (params.cmpn) sp.set("cmpn", "1");
    if (params.view) sp.set("view", params.view);
    const qs = sp.toString();
    return qs ? `/trends?${qs}` : "/trends";
  }

  // DateRangeControl asks for `{}` for BOTH "All time" and "Clear dates", which is
  // exactly the URL the 90D default now claims — so an empty range from the control
  // is what mints the sentinel.
  const buildRangeHref = (r: DateRange) =>
    trendsHref({
      tab: activeTab,
      from: r.from,
      to: r.to,
      allTime: isAllTimeRange(r),
      cmpA,
      cmpB,
      cmpn: cmpNormalized,
      view: activeTab === "body" ? bodyView : undefined,
    });

  // Tab-strip spec: labels only, built by the pure registry (lib/trends-tabs.ts).
  // SIX entries since #1486 — Vitals merged into Body. Fitness + Insights are
  // age-gated surfaces, omitted entirely for training-restricted profiles (matching
  // the Journal/Training/Insights nav gate), so they're never in the strip or
  // reachable via ?tab= for them (the activeTab fallback above enforces the latter).
  const tabStrip = trendsTabStrip(restricted);

  // #105: build ONLY the active section server-side. Passing every section as a
  // prop rendered (and ran the queries for) all six on every request — the
  // client `keepMounted` flag only gated DOM, not the RSC pass. Each tab switch
  // is already a URL navigation (NavTabs → router.replace), so this makes every
  // Trends request compute one tab instead of all of them, at no extra round-trips.
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
      case "body":
        return (
          <BodySection
            range={range}
            view={bodyView}
            tilesHref={trendsHref({
              tab: "body",
              from: range.from,
              to: range.to,
              allTime,
              view: "tiles",
            })}
            allHref={trendsHref({
              tab: "body",
              from: range.from,
              to: range.to,
              allTime,
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

      <div className="mb-6">
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
          extraRanges={extraRanges}
          // The saved views ride the END of the chip row rather than a second
          // full-width row of their own (#1455 C).
          // The RESOLVED window goes to the saved-views bar, not the raw URL params
          // (#1485 G): "Save current" on a default load must capture the 90D window
          // the user is looking at, not the empty param bag that produced it —
          // otherwise every view saved from a default load would re-apply as all time.
          trailingChips={<SavedViewsBar views={savedViews} range={range} />}
          // Only a CUSTOM window needs a summary chip: with a preset lit, the chip
          // just repeats that pill's own label (the duplicate "All time" — #1455 D).
          rightSlot={
            isCustomRange(range, todayStr, extraRanges) ? (
              <span
                data-testid="range-summary-chip"
                className="whitespace-nowrap rounded-full border border-black/10 bg-white/60 px-3 py-1 text-slate-500 dark:border-white/10 dark:bg-ink-900/60 dark:text-slate-400"
              >
                {rangeSummaryLabel(range, todayStr)}
              </span>
            ) : undefined
          }
        />
      </div>

      <NavTabs paramKey="tab" tabs={tabStrip}>
        {activeSection}
      </NavTabs>
    </div>
  );
}
