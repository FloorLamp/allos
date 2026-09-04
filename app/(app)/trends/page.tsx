import { Suspense } from "react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  ALL_TIME_RANGE_PARAM,
  ALL_TIME_RANGE_VALUE,
  isAllTimeRange,
  isCustomRange,
  normalizeTimelineRange,
  resolveTrendsRange,
  timelineDateFromParam,
  type DateRange,
} from "@/lib/timeline-format";
import { rangeSummaryLabel } from "@/lib/trends";
import { clampPage } from "@/lib/pagination";
import { activeRangeLabel } from "@/lib/trends-context";
import { PageHeader } from "@/components/ui";
import TabList from "@/components/TabList";
import TrendsContextBar from "@/components/TrendsContextBar";
import DateRangeControl from "@/components/DateRangeControl";
import DestinationLink from "@/components/DestinationLink";
import { historyDayIntradayHref } from "@/lib/hrefs";
import {
  TrendAnnotationControls,
  TrendAnnotationProvider,
} from "@/components/TrendAnnotationToggles";
import TrendingDigest from "./TrendingDigest";
import BodySection from "./BodySection";
import { parseBodyView } from "./body-view";
import InsightsSection from "./InsightsSection";
import NutritionSection from "./NutritionSection";
import SectionHashScroll from "./SectionHashScroll";
import StreamedSection, { PendingSection } from "@/components/StreamedSection";
import TrendsSectionShell from "./TrendsSectionShell";
import type { AppRoute } from "@/lib/hrefs";
import {
  parseTab,
  retiredFitnessTabTarget,
  trendsTabStrip,
  type TrendsTab,
} from "@/lib/trends-tabs";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

function firstParam(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

// The Trends hub: the analytics lens — a sibling to the Timeline — that gathers the
// app's trend charts under a SHARED date-range control.
//
// ── The strip: THREE tabs (#3512) ────────────────────────────────────────────
// Overview · Nutrition · Insights. Fitness deliberately retired into Training →
// Analyze once that surface grew its own windowed analytics. Old Fitness and
// nested `ftab` URLs redirect there rather than falling onto this hub's default.
//
// ── The landing surface (the Overview tab), top to bottom ────────────────────
//   1. "What's trending" digest — the movers over the shared window.
//   2. The body census — the complete ranked metric stack, with saved cards pinned
//      in order and re-sequenced in place, streamed below the digest.
//
// The two are one surface because #1643 already made them one substrate: the same
// `saved_items` stars govern the grid's membership and the census's pinned run, so
// the split was a rendering boundary, not a distinction.
//
// ── Streaming (an acceptance criterion, not an optimization) ─────────────────
// The tab strip WAS the render budget: #105 made the hub build only the active tab.
// Overview must not pay for absorbing the census, so the digest renders inline and
// the census is a <Suspense> boundary BELOW it. Nothing between the shell and that
// boundary awaits the census, so the first byte carries the header, tab strip,
// range control, digest and census anchor.
//
// ── `?tab=body` is gone (#1635 / #1644) ─────────────────────────────────────
// Retired WITHOUT a shim: the census it named is the DEFAULT view now, so the
// ordinary unknown-value fallback in `parseTab` already lands an old link on the
// page that renders it. `?tab=overview` resolves to that same default. The other
// three tabs' URLs are untouched — those tabs survive.
export default async function TrendsPage(props: {
  searchParams: Promise<{
    tab?: string | string[];
    // Retired nested Fitness vocabulary, read only for the explicit Analyze
    // redirect (#3512); never re-emitted by this hub.
    ftab?: string | string[];
    from?: string | string[];
    to?: string | string[];
    // The explicit all-time sentinel (#1485 G) — see resolveTrendsRange.
    range?: string | string[];
    cmpA?: string | string[];
    cmpB?: string | string[];
    cmpn?: string | string[];
    view?: string | string[];
    // The body history table's 1-based page (#2530). Its own param because that
    // table is deliberately all-time — it does NOT follow the hub's date range —
    // so nothing else in the query string can bound it.
    bpage?: string | string[];
  }>;
}) {
  const searchParams = await props.searchParams;
  const { profile } = await requireSession();
  const todayStr = today(profile.id);
  const from = timelineDateFromParam(searchParams.from);
  const to = timelineDateFromParam(searchParams.to);
  // #1485 G: no-param loads open on 90D, not all time. An explicit window still
  // wins verbatim — a shared ?from/?to link, a bookmark, a quick-range pill —
  // and `?range=all` is the explicit all-time window (the pill has to be able to
  // say itself now that "no params" means something else).
  const range = resolveTrendsRange(
    normalizeTimelineRange(from, to),
    todayStr,
    firstParam(searchParams.range)
  );
  const allTime = isAllTimeRange(range);
  const retiredFitness = retiredFitnessTabTarget(
    searchParams.tab,
    searchParams.ftab
  );
  if (retiredFitness) redirect(retiredFitness);

  // parseTab maps the RETIRED `?tab=compare` onto insights (#1489) — a
  // vocabulary mapping in lib/trends-tabs.ts — and lets `?tab=body` / `?tab=vitals`
  // fall through to the default, which is the surface that absorbed them (#1644).
  // Fitness and its nested aliases have already taken the explicit redirect above.
  const requestedTab = parseTab(searchParams.tab);
  const activeTab = requestedTab;
  const cmpA = firstParam(searchParams.cmpA);
  const cmpB = firstParam(searchParams.cmpB);
  const cmpNormalized = firstParam(searchParams.cmpn) === "1";
  // #1067 Phase 2: the body census layout mode (tiles vs the classic chart
  // stack). Only meaningful where the census renders — the Overview tab —
  // and carried through the range control + tab navigation so a chosen layout
  // survives a window change.
  const bodyView = parseBodyView(firstParam(searchParams.view));
  const bodyHistoryPage = clampPage(
    Number(firstParam(searchParams.bpage)) || 1
  );
  const overview = activeTab === "overview";

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
    // The body history table's page. Dropped when it is page 1, so the ordinary
    // hub links stay paramless.
    bpage?: number;
    // An in-page anchor on the landing surface, so a control INSIDE the census
    // (the tiles/all toggle) doesn't bounce the reader back to the digest.
    section?: string;
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
    if (params.bpage && params.bpage > 1) sp.set("bpage", String(params.bpage));
    const qs = sp.toString();
    const hash = params.section ? `#${params.section}` : "";
    return `${qs ? `/trends?${qs}` : "/trends"}${hash}` as AppRoute;
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
      view: overview ? bodyView : undefined,
    });

  // Tab-strip spec: labels only, built by the pure registry (lib/trends-tabs.ts).
  // THREE entries since #3512 — Fitness retired into Training → Analyze.
  const tabStrip = trendsTabStrip();

  // The phone range trigger is built from the SAME predicates the pills light
  // themselves with, so its compact label can never disagree with the expanded
  // range control.
  const rangeLabel = activeRangeLabel(range, todayStr);

  // Build only the URL-selected tab server-side (#105); Overview divides its own
  // work once more with a Suspense boundary below.
  const activeSection: React.ReactNode = (() => {
    switch (activeTab) {
      case "nutrition":
        return <NutritionSection range={range} />;
      case "insights":
        // The hub's "derived views" tab: AI insights + situation analytics plus
        // the compare overlay.
        return (
          <InsightsSection
            range={range}
            cmpA={cmpA}
            cmpB={cmpB}
            cmpNormalized={cmpNormalized}
          />
        );
      case "overview":
      default:
        return (
          <div className="space-y-6" data-testid="trends-overview">
            {/* A legacy `#starred` / current `#body` deep link has to survive the census
                streaming in below the head — see the component for why the
                native fragment scroll can't do it alone. */}
            <SectionHashScroll />

            {/* What moved is the page's one fast head. */}
            <TrendingDigest range={range} />

            {/* The census, streamed so the head never waits on it. Practice
                trends moved to each /wellness card by the #2151 owner ruling. */}
            <TrendsSectionShell
              id="body"
              legacyId="starred"
              heading="Body"
              quietHeading
            >
              <Suspense
                fallback={<PendingSection label="Body" bodyClassName="h-32" />}
              >
                <StreamedSection>
                  <BodySection
                    range={range}
                    view={bodyView}
                    tilesHref={trendsHref({
                      from: range.from,
                      to: range.to,
                      allTime,
                      view: "tiles",
                      section: "body",
                      bpage: bodyHistoryPage,
                    })}
                    allHref={trendsHref({
                      from: range.from,
                      to: range.to,
                      allTime,
                      view: "all",
                      section: "body",
                      bpage: bodyHistoryPage,
                    })}
                    historyPage={bodyHistoryPage}
                    historyPageHref={(bpage) =>
                      trendsHref({
                        from: range.from,
                        to: range.to,
                        allTime,
                        view: bodyView,
                        section: "body",
                        bpage,
                      })
                    }
                  />
                </StreamedSection>
              </Suspense>
            </TrendsSectionShell>
          </div>
        );
    }
  })();

  return (
    <div>
      {/* Heading + subtitle are given up below `sm` (#1485 F, the #1413 dashboard
          precedent): the context bar right under it already names the tab AND the
          window, and the two-line subtitle is read-once orientation copy that cost
          ~85px of every phone visit. The h1 survives as `sr-only`, so the page is
          still named for AT and the shared-PageHeader guard stays honest.

          NOT `TabFirstPage`, and the difference is load-bearing rather than drift
          (#3236). That shell registers its phone tab strip into `ShellChrome`;
          Trends' strip shares a ROW with the range trigger inside
          `TrendsContextBar` — one unit by #1485 F's design, so the strip cannot
          move into the chrome without orphaning the trigger. The `sm` breakpoint
          here is the same reason: it is `TrendsContextBar`'s own `sm:static`
          seam, so raising it to the shell's `md` would leave a ~700px-wide
          tablet with neither a visible title nor a sticky context bar. What IS
          shared is the grammar — one `PageHeader`, an `sr-only` h1 on the
          compacted width, tabs directly beneath. */}
      <PageHeader
        title="Trends"
        subtitle="Your analytics lens — body, nutrition, and insights under one date range."
        compactBelowSm
      />

      {/* Tabs remain visible on phones while the range and annotation controls
          expand below them. The provider wraps both the bar and panel because the
          toggles rendered here filter charts registered by the active tab. */}
      <TrendAnnotationProvider>
        <TrendsContextBar
          // Preserve the phone disclosure while a range link re-renders the page;
          // changing tabs still starts the new tab with controls collapsed.
          key={activeTab}
          rangeLabel={rangeLabel}
          tabs={
            <div className="sm:mt-4">
              <TabList
                binding="link"
                ariaLabel="Trends sections"
                tabs={tabStrip}
                panelId="trends-tabpanel"
                paramKey="tab"
                activeId={activeTab}
                presentation={{
                  kind: "prominent",
                  mobileLayout: "scroll",
                }}
                testId="trends-tabs"
              />
            </div>
          }
          controls={
            <DateRangeControl
              basePath="/trends"
              range={range}
              todayStr={todayStr}
              hiddenParams={{
                tab: overview ? undefined : activeTab,
                cmpA,
                cmpB,
                cmpn: cmpNormalized ? "1" : undefined,
                view: overview ? bodyView : undefined,
              }}
              buildHref={buildRangeHref}
              idPrefix="trends"
              // WHERE THE 1D PILL SAT (#4767). The census no longer swaps to a clock
              // axis — the /history day view is the one intraday surface — so its door
              // takes the pill's seat on the landing surface: today, on the record.
              trailingChips={
                overview ? (
                  <DestinationLink
                    href={historyDayIntradayHref(todayStr)}
                    data-testid="body-timeline-link"
                    className="inline-flex min-h-(--control-box) shrink-0 items-center whitespace-nowrap text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
                  >
                    Today on History
                  </DestinationLink>
                ) : undefined
              }
              // Only a CUSTOM window needs a summary chip: with a preset lit, the chip
              // just repeats that pill's own label (the duplicate "All time" — #1455 D).
              rightSlot={
                isCustomRange(range, todayStr) ? (
                  <span
                    data-testid="range-summary-chip"
                    className="whitespace-nowrap rounded-full border border-(--border) bg-(--ghost) px-3 py-1 text-slate-500 dark:text-slate-400"
                  >
                    {rangeSummaryLabel(range, todayStr)}
                  </span>
                ) : undefined
              }
              // Event / protocol-window toggles are the most specific context:
              // the tab says what charts show, the pills say over what window,
              // and these say which life events are drawn over them. The shared
              // row stacks on phones and aligns the controls on desktop.
              companionSlot={<TrendAnnotationControls />}
            />
          }
        />

        <div id="trends-tabpanel" role="tabpanel" aria-label="Trends section">
          {activeSection}
        </div>
      </TrendAnnotationProvider>
    </div>
  );
}
