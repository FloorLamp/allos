import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import PageContainer from "@/components/PageContainer";
import { PageHeader, EmptyState } from "@/components/ui";
import LineChartCard from "@/components/LineChartCard";
import { chartSeries } from "@/lib/chart-colors";
import SymptomLogBar from "@/components/illness/SymptomLogBar";
import { PICKER_SYMPTOMS } from "@/lib/symptoms";
import {
  getSymptomSeveritiesOnDate,
  getSymptomNotesOnDate,
  getCustomSymptomNames,
  getSymptomLogOrder,
} from "@/lib/queries";
import { getUnitPrefs } from "@/lib/settings";
import { getCycleForecast, listCyclePeriods } from "@/lib/cycle-store";
import { getTtcState } from "@/lib/ttc-store";
import { getProfileAge } from "@/lib/settings";
import { isMinor } from "@/lib/life-stage";
import {
  cyclePhaseOnDate,
  cycleLengths,
  cycleStats,
  CYCLE_PHASE_LABELS,
  CYCLE_REGULARITY_VARIATION_DAYS,
} from "@/lib/cycle";
import { cycleControlState } from "@/lib/cycle-plausibility";
import AddEntryPanel from "@/components/AddEntryPanel";
import CycleForecastCard from "./CycleForecastCard";
import TtcSection from "./TtcSection";
import CycleForm from "./CycleForm";
import PeriodQuickActions from "./PeriodQuickActions";
import CycleHistoryRow from "./CycleHistoryRow";
import { saveCycleAction } from "./actions";

export const dynamic = "force-dynamic";

// The Cycle surface (issue #714), under Medical. Manual menstrual-cycle log: one-tap
// "period started/ended", a full add/edit form, per-day cycle symptoms (the shipped
// symptom bar led with the cycle context), the DERIVED current phase, and a cycle-length /
// variability trend answering "is it regular / changing."
//
// Since #1679 it ALSO forecasts — the #714 tracking-only exclusion was reversed by owner
// ruling. The projection is always a confidence-framed window from the profile's own
// measured variability, never a date, and it is absent entirely when the history can't
// carry it. Since #1680 the adult-gated trying-to-conceive section sits below it, off
// unless the user DECLARES it. Informational, not medical advice or diagnosis, and never
// a contraceptive method.

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
  const currentPhase = cyclePhaseOnDate(periods, todayStr, todayStr);
  const stats = cycleStats(periods);
  const lengths = cycleLengths(periods); // oldest-first
  const trendData = lengths.map((l) => ({ date: l.start, value: l.days }));
  const temperatureUnit = getUnitPrefs(login.id).temperatureUnit;
  // ONE forecast computation for the page (#221); the dashboard tile reads the same core.
  const forecast = getCycleForecast(profile.id, todayStr);
  // TTC is adult-only content — the same `!isMinor` line the other adult topics use
  // (#1174) — and off entirely until the user declares a start (the declared-only rule).
  const ttcEligible = !isMinor(getProfileAge(profile.id));
  const ttc = ttcEligible ? getTtcState(profile.id, todayStr) : null;

  return (
    <PageContainer width="reading" className="mx-auto space-y-6">
      <PageHeader
        title="Cycle"
        subtitle="Log your period, see the derived phase and cycle-length trends, and a confidence-framed projection of the next one."
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
            ourselves — the record is the user's, and only their tap writes to it.

            The second half of the sentence used to read "set its end date below", which
            pointed at the dated ADD form — a form that mints a NEW row and whose
            plausibility gate (#1682) refuses one overlapping the very period being
            described, so the direction never worked. Folding that form (#2583) made the
            miss visible rather than causing it, so the sentence now names the control
            that does close an existing row: Edit on its History entry, which is also
            where reopenPeriodAction's too-old refusal already sends people. */}
        {control.staleOpenPeriod && (
          <p
            className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200"
            data-testid="cycle-stale-open"
          >
            Still bleeding? This period has been open since{" "}
            {control.openPeriodStart} — tap “Period ended today”, or use “Edit”
            on its row in the history below to set its end date. Until then the
            phase is derived without it.
          </p>
        )}
        <PeriodQuickActions state={control} />
        <p className="text-xs text-slate-500 dark:text-slate-400">
          The luteal phase resolves once your next period is logged — the phase
          says what already happened. The projection below is a separate,
          separately-labelled estimate.
        </p>
      </section>

      <CycleForecastCard forecast={forecast} />

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
                // gap-exempt: one point per CYCLE — the index is the event, and
                // a cycle has no calendar cadence to densify to.
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

      {/* Per-day symptoms — the shipped symptom bar, with the PICKER led by the cycle
          context. What renders as logged is the day's WHOLE ledger (#221: one store),
          which is why a fever logged this morning appears on this page too.

          #2583 part 3 is the framing, and it is COPY ONLY. A bare "Symptoms today"
          heading inside a Cycle page promises cycle symptoms and delivers the day, so
          the readability sweep read Fever and Cough leading the bar as a category
          error. The behaviour is right: filtering the logged set to cycle symptoms
          would hide a fever the user recorded and make the heading lie, so the subtitle
          says what the section is instead. `leadDomain` stays an ORDER lever for the
          picker only, still ranked below the profile's own usage
          (lib/queries/symptoms.ts). Do NOT turn this into a domain filter. */}
      <section className="card space-y-2" data-testid="cycle-symptoms">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          Symptoms today
        </h2>
        <p
          className="text-xs text-slate-500 dark:text-slate-400"
          data-testid="cycle-symptoms-scope"
        >
          Your whole symptom log for today, not a cycle-only list — cycle
          symptoms lead the picker, and anything you log today shows up here
          whatever it is.
        </p>
        <SymptomLogBar
          date={todayStr}
          initial={getSymptomSeveritiesOnDate(profile.id, todayStr)}
          initialNotes={getSymptomNotesOnDate(profile.id, todayStr)}
          symptoms={PICKER_SYMPTOMS}
          customNames={getCustomSymptomNames(profile.id)}
          rankedKeys={getSymptomLogOrder(profile.id, "cycle")}
          suggestActivateIllness={false}
          temperatureUnit={temperatureUnit}
          showTitle={false}
        />
      </section>

      {ttc && (
        <TtcSection
          state={ttc}
          today={todayStr}
          temperatureUnit={temperatureUnit}
        />
      )}

      {/* Add a period with dates — behind a disclosure since #2583 (the #1497
          rare-cadence-entry rule, which named this page as one of its examples). A
          period is a ~monthly event and the common case is the one-tap control at the
          top of this page; a four-field dated form standing permanently open charges
          every visit for the unusual case.

          The affordance is UNCONDITIONAL — the same named button in the same place on
          every visit, never behind a menu and never gated on state — because the way
          this fold fails is by getting quieter and taking the backfilled and corrected
          periods with it. INLINE rather than the hubs' modal: this is one reading
          column, and the sentences above ("add one with dates below") point at a
          summary the reader can see without a dialog opening over it. The qualifier
          rides the OPEN heading and the collapsed button stays short, which is exactly
          what AddEntryPanel's addLabel is for. */}
      <AddEntryPanel
        testId="cycle-add-panel"
        panelId="cycle-add-panel-body"
        label="Add a period with dates — for a past or corrected period"
        addLabel="Add a period with dates"
      >
        <CycleForm action={saveCycleAction} />
      </AddEntryPanel>

      {/* History. */}
      <section className="space-y-2" data-testid="cycle-history">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          History
        </h2>
        {periods.length === 0 ? (
          <EmptyState message="No periods logged yet. Use “Period started” above for today’s, or “Add a period with dates” for an earlier one." />
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
