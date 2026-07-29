import { Suspense } from "react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { isTrainingRestricted } from "@/lib/age-gate";
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
import { activeRangeLabel } from "@/lib/trends-context";
import { PageHeader } from "@/components/ui";
import TrendsContextBar from "@/components/TrendsContextBar";
import DateRangeControl from "@/components/DateRangeControl";
import {
  TrendAnnotationControls,
  TrendAnnotationProvider,
} from "@/components/TrendAnnotationToggles";
import TrendingDigest from "./TrendingDigest";
import StarredSection from "./StarredSection";
import BodySection from "./BodySection";
import { parseBodyView } from "./body-view";
import FitnessSection from "./FitnessSection";
import InsightsSection from "./InsightsSection";
import NutritionSection from "./NutritionSection";
import ChartJumpChips from "./ChartJumpChips";
import SectionHashScroll from "./SectionHashScroll";
import StreamedCensus from "./StreamedCensus";
import TrendsSectionShell, {
  TrendsSectionSkeleton,
} from "./TrendsSectionShell";
import type { AppRoute } from "@/lib/hrefs";
import { trendsSectionStrip } from "@/lib/trends-sections";

export const dynamic = "force-dynamic";

function firstParam(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

// The Trends hub: the analytics lens — a sibling to the Timeline — that aggregates
// the app's trend charts into ONE scrollable page under a SHARED date-range
// control (issue #1644).
//
// ── The page, top to bottom ──────────────────────────────────────────────────
//   1. "What's trending" digest — the movers over the shared window.
//   2. Starred grid — the cross-domain curation surface (tile zoom, drag order via
//      SortableOrder → reorderSaved). Still the ONE place curation is expressed,
//      and still the one place where nothing renders unconditionally.
//   3. Body / Fitness / Nutrition censuses — each rendering exactly what its tab
//      rendered, starred-first-then-ranked on #1643's substrate.
//   4. Insights — the derived views (AI narratives, situation impacts, compare)
//      closing the page. See lib/trends-sections.ts for why it is a section here
//      and not a surface of its own.
//
// The jump-chip strip takes the tab strip's slot in the context bar, so it is
// sticky on a phone exactly where the tabs were: the long scroll stays navigable
// and the range control still sits under it.
//
// ── Streaming (an acceptance criterion, not an optimization) ──────────────────
// The tab strip WAS the render budget: #105 made the hub build only the active
// tab. A merged page must not pay for that by serializing every domain's chart
// assembly into first paint. So the head (digest + starred grid) renders inline —
// the same work the Overview tab did — and each census is its own <Suspense>
// boundary BELOW it. Nothing between the shell and those boundaries awaits a
// census, so the first byte carries the header, the chips, the range control, the
// head AND every section's heading + anchor (the Suspense boundary is INSIDE the
// section shell, so a chip is never a link to something that has not rendered
// yet), and the censuses stream in after it.
//
// ── `?tab=` is gone (#1635 / #1644) ──────────────────────────────────────────
// Retired WITHOUT a compatibility shim: there is no strip left for it to select.
// Every internal deep link moved to a section anchor (`/trends#body`) through
// `trendsSectionHref` in the same change. The RETIRED nested `?ftab=` (#1492) went
// with it. Unknown params are simply ignored — an old bookmark lands on the page
// that now contains everything its tab did.
export default async function TrendsPage(props: {
  searchParams: Promise<{
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
  const cmpA = firstParam(searchParams.cmpA);
  const cmpB = firstParam(searchParams.cmpB);
  const cmpNormalized = firstParam(searchParams.cmpn) === "1";
  // #1067 Phase 2: the Body census's layout mode (tiles vs the classic chart
  // stack). Carried through the range control so a chosen layout survives a
  // window change.
  const bodyView = parseBodyView(firstParam(searchParams.view));
  // The "1D" pill (#1466), injected through the shared control's extra-ranges
  // slot. It was scoped to the Body TAB because only that surface swaps to
  // genuinely intraday content; the Body census is now always on the page, so the
  // pill is always offered and the swap still happens in exactly one section.
  const extraRanges = [intradayQuickRange(todayStr)];

  // Build a /trends URL, preserving the window and compare state. `section` adds
  // the in-page anchor so a control inside a census (the Body tiles/all toggle)
  // doesn't bounce the reader back to the top of the page.
  function trendsHref(params: {
    from?: string;
    to?: string;
    // The explicit all-time sentinel (#1485 G). Carried by every hub link so the
    // window survives a view switch: without it a paramless link would land back
    // on the 90D default and "All time" would be a one-render state.
    allTime?: boolean;
    cmpA?: string;
    cmpB?: string;
    cmpn?: boolean;
    view?: "tiles" | "all";
    section?: string;
  }): AppRoute {
    const sp = new URLSearchParams();
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
    const hash = params.section ? `#${params.section}` : "";
    return `${qs ? `/trends?${qs}` : "/trends"}${hash}` as AppRoute;
  }

  // DateRangeControl asks for `{}` for BOTH "All time" and "Clear dates", which is
  // exactly the URL the 90D default now claims — so an empty range from the control
  // is what mints the sentinel.
  const buildRangeHref = (r: DateRange) =>
    trendsHref({
      from: r.from,
      to: r.to,
      allTime: isAllTimeRange(r),
      cmpA,
      cmpB,
      cmpn: cmpNormalized,
      view: bodyView,
    });

  // The page's section navigation, built by the pure registry
  // (lib/trends-sections.ts). Fitness is the one age-gated section omitted
  // entirely for training-restricted profiles, so it is neither a chip nor a
  // render for them.
  const sections = trendsSectionStrip(restricted);
  const showFitness = sections.some((s) => s.id === "fitness");

  // The phone range trigger is built from the SAME predicates the pills light
  // themselves with, so its compact label can never disagree with the expanded
  // range control.
  const rangeLabel = activeRangeLabel(range, todayStr, extraRanges);

  return (
    <div>
      {/* Heading + subtitle are given up below `sm` (#1485 F, the #1413 dashboard
          precedent): the context bar right under it already names the window, and
          the two-line subtitle is read-once orientation copy that cost ~85px of
          every phone visit. The h1 survives as `sr-only`, so the page is still
          named for AT and the shared-PageHeader guard stays honest. */}
      <PageHeader
        title="Trends"
        subtitle="Your analytics lens — body, nutrition, fitness, and insights on one page, under one date range."
        compactBelowSm
      />

      {/* The chips stay visible on phones while the range and annotation controls
          expand below them. The provider wraps both the bar and the page because
          the toggles rendered here filter charts registered by the sections. */}
      <TrendAnnotationProvider>
        <TrendsContextBar
          rangeLabel={rangeLabel}
          tabs={
            <ChartJumpChips
              chips={sections.map((s) => ({ id: s.id, label: s.label }))}
              ariaLabel="Jump to section"
              testId="trends-section-chips"
            />
          }
          controls={
            <DateRangeControl
              basePath="/trends"
              range={range}
              todayStr={todayStr}
              hiddenParams={{
                cmpA,
                cmpB,
                cmpn: cmpNormalized ? "1" : undefined,
                view: bodyView,
              }}
              buildHref={buildRangeHref}
              idPrefix="trends"
              extraRanges={extraRanges}
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
              // Event / protocol-window toggles are the most specific context: the
              // chips say where you are, the pills say over what window, and these
              // say which life events are drawn over the charts. The shared row
              // stacks on phones and aligns the controls on desktop.
              companionSlot={<TrendAnnotationControls />}
            />
          }
        />

        {/* A `#section` deep link has to survive the sections streaming in below
            the head — see the component for why the native fragment scroll can't. */}
        <SectionHashScroll />

        <div className="space-y-10" data-testid="trends-page">
          {/* ── The head: what moved, then what you curated ────────────────── */}
          <TrendingDigest range={range} />

          <TrendsSectionShell id="starred" heading="Starred" quietHeading>
            <StarredSection range={range} />
          </TrendsSectionShell>

          {/* ── The censuses: streamed, so the head never waits on them ────── */}
          <TrendsSectionShell
            id="body"
            heading="Body"
            description="Today's readings, vitals, composition, and every synced daily metric over the selected window."
          >
            <Suspense fallback={<TrendsSectionSkeleton label="Body" />}>
              <StreamedCensus>
                <BodySection
                  range={range}
                  view={bodyView}
                  tilesHref={trendsHref({
                    from: range.from,
                    to: range.to,
                    allTime,
                    view: "tiles",
                    section: "body",
                  })}
                  allHref={trendsHref({
                    from: range.from,
                    to: range.to,
                    allTime,
                    view: "all",
                    section: "body",
                  })}
                />
              </StreamedCensus>
            </Suspense>
          </TrendsSectionShell>

          {showFitness && (
            <TrendsSectionShell
              id="fitness"
              heading="Fitness"
              description="Volume and cadence, zones and cardio, strength progression, and sport — all windowed. Logging and the full-history explorers live on Training."
            >
              <Suspense fallback={<TrendsSectionSkeleton label="Fitness" />}>
                <StreamedCensus>
                  <FitnessSection range={range} />
                </StreamedCensus>
              </Suspense>
            </TrendsSectionShell>
          )}

          <TrendsSectionShell
            id="nutrition"
            heading="Nutrition"
            description="Macros and fiber, food-goal adherence, and what you actually logged day by day."
          >
            <Suspense fallback={<TrendsSectionSkeleton label="Nutrition" />}>
              <StreamedCensus>
                <NutritionSection range={range} />
              </StreamedCensus>
            </Suspense>
          </TrendsSectionShell>

          <TrendsSectionShell
            id="insights"
            heading="Insights"
            description="Derived views over the same window — situation impacts, AI recaps and daily analyses, and the compare overlay."
          >
            <Suspense fallback={<TrendsSectionSkeleton label="Insights" />}>
              <StreamedCensus>
                <InsightsSection
                  range={range}
                  cmpA={cmpA}
                  cmpB={cmpB}
                  cmpNormalized={cmpNormalized}
                />
              </StreamedCensus>
            </Suspense>
          </TrendsSectionShell>
        </div>
      </TrendAnnotationProvider>
    </div>
  );
}
