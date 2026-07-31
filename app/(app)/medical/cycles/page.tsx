import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import PageContainer from "@/components/PageContainer";
import { PageHeader, EmptyState } from "@/components/ui";
import LineChartCard from "@/components/LineChartCard";
import { chartSeries } from "@/lib/chart-colors";
import SymptomLogBar from "@/components/illness/SymptomLogBar";
import { SYMPTOMS } from "@/lib/symptoms";
import {
  getSymptomSeveritiesOnDate,
  getSymptomNotesOnDate,
  getCustomSymptomNames,
  getSymptomLogOrder,
} from "@/lib/queries";
import { getUnitPrefs } from "@/lib/settings";
import { listCyclePeriods } from "@/lib/cycle-store";
import {
  cyclePhaseOnDate,
  cycleLengths,
  cycleStats,
  CYCLE_PHASE_LABELS,
  CYCLE_REGULARITY_VARIATION_DAYS,
} from "@/lib/cycle";
import { cycleControlState } from "@/lib/cycle-plausibility";
import CycleForm from "./CycleForm";
import PeriodQuickActions from "./PeriodQuickActions";
import CycleHistoryRow from "./CycleHistoryRow";
import { saveCycleAction } from "./actions";

export const dynamic = "force-dynamic";

// The Cycle surface (issue #714), under Medical. Manual menstrual-cycle log: one-tap
// "period started/ended", a full add/edit form, per-day cycle symptoms (the shipped
// symptom bar led with the cycle context), the DERIVED current phase, and a cycle-length /
// variability trend answering "is it regular / changing." Deliberately tracking, NOT
// forecasting — no next-period or ovulation prediction. Informational, not medical advice.

const REGULARITY_COPY: Record<string, string> = {
  regular: "Your recent cycles look regular.",
  irregular: "Your recent cycle lengths vary by more than a week.",
  insufficient: "Log a few cycles to see whether they're regular.",
};

export default async function CyclePage() {
  const { login, profile } = await requireSession();
  const todayStr = today(profile.id);
  const periods = listCyclePeriods(profile.id);
  // The ONE control-state computation (#1681): which quick action may be offered, the
  // derived state line, and whether an open period has outrun the plausible maximum. The
  // client component renders it and decides nothing.
  const control = cycleControlState(periods, todayStr);
  const currentPhase = cyclePhaseOnDate(periods, todayStr);
  const stats = cycleStats(periods);
  const lengths = cycleLengths(periods); // oldest-first
  const trendData = lengths.map((l) => ({ date: l.start, value: l.days }));
  const temperatureUnit = getUnitPrefs(login.id).temperatureUnit;

  return (
    <PageContainer width="reading" className="mx-auto space-y-6">
      <PageHeader
        title="Cycle"
        subtitle="Log your period and see the derived phase and cycle-length trends. Informational only — no prediction."
      />

      {/* Current status + one-tap logging. */}
      <section className="card space-y-3" data-testid="cycle-status">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="section-label">Current phase</div>
            <div
              className="text-lg font-semibold text-slate-800 dark:text-slate-100"
              data-testid="cycle-current-phase"
            >
              {currentPhase ? CYCLE_PHASE_LABELS[currentPhase] : "—"}
            </div>
          </div>
          <div className="text-right text-xs text-slate-500 dark:text-slate-400">
            {control.openPeriodStart
              ? `Period open since ${control.openPeriodStart}`
              : "No period currently open"}
          </div>
        </div>
        {/* A period left open past the plausible maximum (#1682): the phase above has
            already stopped claiming menstrual, and we ASK rather than closing the record
            ourselves — the record is the user's, and only their tap writes to it. */}
        {control.staleOpenPeriod && (
          <p
            className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200"
            data-testid="cycle-stale-open"
          >
            Still bleeding? This period has been open since{" "}
            {control.openPeriodStart} — set its end date below, or tap “Period
            ended today”. Until then the phase is derived without it.
          </p>
        )}
        <PeriodQuickActions state={control} />
        <p className="text-xs text-slate-500 dark:text-slate-400">
          The luteal phase resolves once your next period is logged — the phase
          is derived from history, never forecast.
        </p>
      </section>

      {/* Cycle-length + variability trend. */}
      <section className="space-y-2" data-testid="cycle-trend">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          Cycle length
        </h2>
        {stats.cycleCount > 0 ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Average" value={fmtDays(stats.meanLength)} />
              <Stat label="Shortest" value={fmtDays(stats.minLength)} />
              <Stat label="Longest" value={fmtDays(stats.maxLength)} />
              <Stat
                label="Variability"
                value={fmtDays(stats.variabilityDays)}
              />
            </div>
            <p
              className="text-xs text-slate-500 dark:text-slate-400"
              data-testid="cycle-regularity"
            >
              {REGULARITY_COPY[stats.regularity]}
              {stats.regularity !== "insufficient" &&
                ` (regular = within ${CYCLE_REGULARITY_VARIATION_DAYS} days)`}
            </p>
            {trendData.length >= 2 && (
              <LineChartCard
                data={trendData}
                label="Cycle length"
                unit=" d"
                color={chartSeries.rose}
                decimals={0}
              />
            )}
          </>
        ) : (
          <EmptyState message="Log at least two periods to see your cycle length and whether it's regular." />
        )}
      </section>

      {/* Per-day cycle symptoms — the shipped symptom bar, led with the cycle context. */}
      <section className="card space-y-2" data-testid="cycle-symptoms">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          Symptoms today
        </h2>
        <SymptomLogBar
          date={todayStr}
          initial={getSymptomSeveritiesOnDate(profile.id, todayStr)}
          initialNotes={getSymptomNotesOnDate(profile.id, todayStr)}
          symptoms={SYMPTOMS}
          customNames={getCustomSymptomNames(profile.id)}
          rankedKeys={getSymptomLogOrder(profile.id, "cycle")}
          suggestActivateIllness={false}
          temperatureUnit={temperatureUnit}
          showTitle={false}
        />
      </section>

      {/* Add a period. */}
      <CycleForm action={saveCycleAction} />

      {/* History. */}
      <section className="space-y-2" data-testid="cycle-history">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          History
        </h2>
        {periods.length === 0 ? (
          <EmptyState message="No periods logged yet. Use “Period started” above or add one with dates." />
        ) : (
          <ul className="flex flex-col gap-2">
            {periods.map((p) => (
              <CycleHistoryRow key={p.id} period={p} />
            ))}
          </ul>
        )}
      </section>
    </PageContainer>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/5 bg-white/60 px-3 py-2 dark:border-white/5 dark:bg-ink-900/40">
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
        {value}
      </div>
    </div>
  );
}

function fmtDays(n: number | null): string {
  return n == null ? "—" : `${n} d`;
}
