import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import type { DateRange } from "@/lib/timeline-format";
import {
  FITNESS_SECTIONS,
  fitnessWindow,
  fitnessWindowWeeks,
} from "@/lib/trends-fitness";
import ChartJumpMenu from "./ChartJumpMenu";
import FitnessPRs from "./FitnessPRs";
import WorkoutHistorySection from "./WorkoutHistorySection";
import FitnessVolumeSection from "./FitnessVolumeSection";
import FitnessZonesSection from "./FitnessZonesSection";
import FitnessStrengthSection from "./FitnessStrengthSection";
import FitnessSportSection from "./FitnessSportSection";

// Trends → Fitness: the WINDOWED ANALYTICS LENS (issue #1492).
//
// The rule: **analyze on Trends, do on /training.** This tab used to re-mount the
// /training page's Strength / Cardio / Sport sections VERBATIM behind a nested
// `?ftab=` strip — full history, un-windowed, with the apology in the UI ("full
// history") on a hub whose subtitle promises "under one date range". Once the hub
// defaulted to 90D (#1485 G) every other tab windowed and this one silently would
// not. It is now four SECTIONS, composition PINNED by the owner (2026-07-25):
//
// The tab LEADS with the Workout history (owner-directed, 2026-08-09): the
// generalized day-history calendar + by-type matrix over the window, which
// replaced the bespoke #186 heatmap that used to sit inside Volume & cadence.
// Below it, the four pinned sections:
//
//   1. Volume & cadence      — windowed training volume (bars)
//   2. Zones & cardio        — windowed HR-zone minutes / Zone 2 / polarization
//                              (#159) + windowed weekly cardio volume + mix
//   3. Strength progression  — windowed est-1RM movement + PR rate
//   4. Sport                 — windowed sport summaries
//
// Exactly these four, no others. Every chart reads the SAME window, so a range
// change re-windows the whole tab.
//
// What LEFT: the full-history explorers and the 14-row Recent-PRs pair. Those are
// "do" surfaces — /training owns them (Analyze is their windowless home, and
// #1491 item 3 converges the explorer triplet there) — and stacking them here was
// the audit's ~900px pre-chart wall. In their place the tab leads with a compact
// **PRs this window** block: the top three records set inside the window, with the
// full list one link away (the #1485/#1490 movers treatment).
//
// The nested strip is gone with them. `?ftab=strength|cardio|sport` is a retired
// VOCABULARY — an old deep link names the Fitness tab and the value is ignored
// (lib/trends-tabs.ts, the #1486/#1489 mapping pattern) — so `/trends?tab=fitness&
// ftab=cardio` from a Telegram nudge or a bookmark still lands here, now on a page
// where the zone content it wanted is simply a section.
//
// The whole tab stays TAB-level age-gated (RESTRICTED_TRENDS_TABS): a
// training-restricted profile never sees the chip and never reaches the section.
export default async function FitnessSection({ range }: { range: DateRange }) {
  const { profile } = await requireSession();
  const todayStr = today(profile.id);
  const window = fitnessWindow(range, todayStr);
  // ONE week-count decision, shared by every weekly-grain builder on the tab (the
  // heatmap columns, the zone weeks, the cardio weeks, the PR-rate weeks) so they
  // can't disagree about how long "this window" is.
  const weeks = fitnessWindowWeeks(window.days);

  return (
    <div className="space-y-6" data-testid="trends-fitness">
      {/* Four consecutive, clearly headed sections do not need a third navigation
          layer on phones. Keep the optional long-page shortcut as the same compact
          desktop chart menu used by Body. */}
      <div className="hidden justify-end md:flex">
        <ChartJumpMenu items={FITNESS_SECTIONS.map((s) => ({ ...s }))} />
      </div>

      <WorkoutHistorySection window={window} />

      <hr className="border-black/5 dark:border-white/10" />

      <FitnessPRs window={window} />

      <FitnessVolumeSection window={window} />
      <FitnessZonesSection window={window} weeks={weeks} />
      <FitnessStrengthSection window={window} weeks={weeks} />
      <FitnessSportSection window={window} />

      <p className="text-sm text-slate-500 dark:text-slate-400">
        Logging, live workouts, routines, the full-history explorers and the
        fitness check live on{" "}
        <Link
          href="/training"
          className="font-medium text-brand-700 hover:underline dark:text-brand-300"
        >
          Training
        </Link>
        .
      </p>
    </div>
  );
}
