import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getPracticeDays,
  getPracticeTrends,
  getWellnessPractices,
} from "@/lib/queries";
import { getWeekStart } from "@/lib/settings";
import { MAX_PRACTICE_TREND_WEEKS } from "@/lib/trends-practices";
import { WELLNESS_PRACTICE_HEATMAP_WEEKS } from "@/lib/practice-heatmap";
import { dayHistoryStart } from "@/lib/day-history";
import { PageHeader, EmptyState } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import RightSizeSuggestions from "@/components/RightSizeSuggestions";
import AddPracticeButton from "./AddPracticeButton";
import PracticeCard from "./PracticeCard";
import DayHistory from "@/components/DayHistory";

export const dynamic = "force-dynamic";

export default async function WellnessPage(props: {
  searchParams: Promise<{ new?: string }>;
}) {
  const searchParams = await props.searchParams;
  const { profile } = await requireSession();
  const todayStr = today(profile.id);
  const weekStart = getWeekStart(profile.id);
  const practices = getWellnessPractices(profile.id, todayStr, weekStart);
  const trendsByIdentity = new Map(
    getPracticeTrends(profile.id, MAX_PRACTICE_TREND_WEEKS, todayStr).map(
      (trend) => [trend.identity, trend]
    )
  );

  // Cross-practice day-history (owner-placed here 2026-08-09, honoring #2151:
  // no Trends practices section — each card owns ITS trend, and this section
  // shows what no card can: every practice on one shared day axis, over the
  // same trailing-quarter window the card heatmaps use. With a single logged
  // practice it overlaps that card's heatmap; accepted, it grows with the
  // roster.
  const historySince = dayHistoryStart(
    todayStr,
    WELLNESS_PRACTICE_HEATMAP_WEEKS,
    weekStart
  );
  const practiceDays = getPracticeDays(profile.id, historySince, todayStr);
  const practiceValues = practiceDays.map((d) => ({
    date: d.date,
    group: d.key,
    value: d.count,
    detail: d.minutes,
  }));
  const practiceTotals = new Map<string, { label: string; total: number }>();
  for (const d of practiceDays) {
    const t = practiceTotals.get(d.key) ?? { label: d.label, total: 0 };
    t.total += d.count;
    practiceTotals.set(d.key, t);
  }
  const practiceGroups = [...practiceTotals.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([key, v]) => ({ key, label: v.label }));

  return (
    <PageContainer
      width="reading"
      className="mx-auto"
      data-testid="wellness-page"
    >
      <PageHeader
        title="Wellness"
        subtitle="Track recurring wellness routines such as sauna, meditation, breathwork, and light exposure."
        action={<AddPracticeButton defaultOpen={searchParams.new === "1"} />}
        actionAlign="start"
      />

      {/* Right-sizing suggestions (#1670), above the cards they are about: a weekly
          goal the profile has been under for four completed weeks, offered for the
          cadence they actually keep or for the logs-only state (#1621). */}
      <div className="mb-6">
        <RightSizeSuggestions profileId={profile.id} domain="practice" />
      </div>

      {practiceValues.length > 0 && (
        <section data-testid="practice-history" className="mb-8">
          <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
            Practice history
          </h2>
          <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
            Every practice day in the trailing quarter, then the same days split
            by practice. Tap a day to open it on the Timeline.
          </p>
          <DayHistory
            domain="practice"
            values={practiceValues}
            groups={practiceGroups}
            end={todayStr}
            weeks={WELLNESS_PRACTICE_HEATMAP_WEEKS}
            weekStart={weekStart}
            today={todayStr}
            testId="practice-day-history"
          />
        </section>
      )}

      <section>
        <h2 className="mb-2 section-label">Your practices</h2>
        {practices.length === 0 ? (
          <EmptyState message="No practices yet. Add one to set a weekly goal and start logging sessions." />
        ) : (
          <div className="space-y-4">
            {practices.map((practice) => (
              <PracticeCard
                key={practice.identity}
                practice={practice}
                sessions={practice.sessions}
                today={todayStr}
                trend={trendsByIdentity.get(practice.identity) ?? null}
              />
            ))}
          </div>
        )}
      </section>
    </PageContainer>
  );
}
