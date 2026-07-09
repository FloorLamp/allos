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
import BiomarkersSection, {
  type BiomarkerFlagFilter,
} from "./BiomarkersSection";
import BodySection from "./BodySection";
import FitnessSection from "./FitnessSection";
import InsightsSection from "./InsightsSection";

export const dynamic = "force-dynamic";

const TABS = [
  "overview",
  "compare",
  "biomarkers",
  "body",
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

function parseFlag(
  value: string | string[] | undefined
): BiomarkerFlagFilter | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === "oor" || first === "nonoptimal" ? first : undefined;
}

// The Trends hub (issue #212, Phase 1): the analytics lens — a sibling to the
// Timeline — that aggregates the app's existing trend charts into one place under
// a SHARED date-range control. Every section reuses existing components/queries;
// the shared window (from/to) drives them all. Fitness + Insights (age-gated
// surfaces) are hidden for training-restricted profiles.
export default function TrendsPage({
  searchParams,
}: {
  searchParams: {
    tab?: string | string[];
    ftab?: string | string[];
    from?: string | string[];
    to?: string | string[];
    bflag?: string | string[];
    bpanel?: string | string[];
    cmpA?: string | string[];
    cmpB?: string | string[];
    cmpn?: string | string[];
  };
}) {
  const { profile } = requireSession();
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
  const bflag = parseFlag(searchParams.bflag);
  const bpanel =
    (Array.isArray(searchParams.bpanel)
      ? searchParams.bpanel[0]
      : searchParams.bpanel
    )?.trim() || undefined;
  const cmpA = firstParam(searchParams.cmpA);
  const cmpB = firstParam(searchParams.cmpB);
  const cmpNormalized = firstParam(searchParams.cmpn) === "1";
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
    bflag?: BiomarkerFlagFilter;
    bpanel?: string;
    cmpA?: string;
    cmpB?: string;
    cmpn?: boolean;
  }): string {
    const sp = new URLSearchParams();
    if (params.tab && params.tab !== "overview") sp.set("tab", params.tab);
    if (params.from) sp.set("from", params.from);
    if (params.to) sp.set("to", params.to);
    if (params.bflag) sp.set("bflag", params.bflag);
    if (params.bpanel) sp.set("bpanel", params.bpanel);
    if (params.cmpA) sp.set("cmpA", params.cmpA);
    if (params.cmpB) sp.set("cmpB", params.cmpB);
    if (params.cmpn) sp.set("cmpn", "1");
    const qs = sp.toString();
    return qs ? `/trends?${qs}` : "/trends";
  }

  const buildRangeHref = (r: DateRange) =>
    trendsHref({
      tab: activeTab,
      from: r.from,
      to: r.to,
      bflag,
      bpanel,
      cmpA,
      cmpB,
      cmpn: cmpNormalized,
    });

  const biomarkerHrefFor = (opts: {
    flag?: BiomarkerFlagFilter;
    panel?: string;
  }) =>
    trendsHref({
      tab: "biomarkers",
      from: range.from,
      to: range.to,
      bflag: opts.flag,
      bpanel: opts.panel,
    });

  // Tab-strip spec: labels only. Fitness + Insights are age-gated surfaces —
  // omitted entirely for training-restricted profiles (matching the
  // Journal/Training/Insights nav gate), so they're never in the strip or
  // reachable via ?tab= for them (the activeTab fallback above enforces the
  // latter).
  const tabStrip: { id: TrendsTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "compare", label: "Compare" },
    { id: "biomarkers", label: "Biomarkers" },
    { id: "body", label: "Body" },
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
      case "biomarkers":
        return (
          <BiomarkersSection
            range={range}
            flag={bflag}
            panel={bpanel}
            hrefFor={biomarkerHrefFor}
          />
        );
      case "body":
        return <BodySection range={range} />;
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
        subtitle="Your analytics lens — biomarkers, body, fitness, and insights under one date range."
      />

      <div className="mb-6 space-y-2 sm:space-y-4">
        <DateRangeControl
          basePath="/trends"
          range={range}
          todayStr={todayStr}
          hiddenParams={{
            tab: activeTab === "overview" ? undefined : activeTab,
            bflag,
            bpanel,
            cmpA,
            cmpB,
            cmpn: cmpNormalized ? "1" : undefined,
          }}
          buildHref={buildRangeHref}
          idPrefix="trends"
          rightSlot={
            <span className="whitespace-nowrap rounded-full border border-slate-200 bg-white/60 px-3 py-1 text-slate-500 dark:border-white/10 dark:bg-ink-900/60 dark:text-slate-400">
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
