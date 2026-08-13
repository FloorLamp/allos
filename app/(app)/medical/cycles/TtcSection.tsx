import { EmptyState } from "@/components/ui";
import type { TemperatureUnit } from "@/lib/settings";
import { fmtTemp } from "@/lib/units";
import {
  FERTILE_EVIDENCE_LABELS,
  NOT_CONTRACEPTION_NOTE,
  SHORT_LUTEAL_PHASE_DAYS,
} from "@/lib/ttc";
import type { TtcState } from "@/lib/ttc-store";
import TtcDeclareControl from "./TtcDeclareControl";
import TtcLogBar from "./TtcLogBar";
import TtcOffDisclosure from "./TtcOffDisclosure";

// The trying-to-conceive surface (issue #1680), rendered inside the Cycle page. A SERVER
// component: it formats the ONE assembled TtcState (lib/ttc-store.getTtcState) and decides
// nothing for itself.
//
// Register: flat and factual. The fertile window states its evidence and always carries
// NOT_CONTRACEPTION_NOTE; ovulation confirmation is stated as a past event; the counter
// reports elapsed months and cycles and nothing else. No streaks, no encouragement, no
// score, no "chance today" — the app states what it observed and stops.
//
// THREE branches, and only the third folds (#2583 part 2). Pregnancy-paused and
// declared/active render exactly as they always have — someone who declared this is
// mid-topic, and folding their surface would be the app second-guessing a declaration
// it is not allowed to make for them. The NOT-ACTIVE branch is the one that stood open
// on every visit for people who never asked about it, so it spends one line
// (TtcOffDisclosure) with the same explainer and the same declare control behind it.
export default function TtcSection({
  state,
  today,
  temperatureUnit,
}: {
  state: TtcState;
  today: string;
  temperatureUnit: TemperatureUnit;
}) {
  if (state.pregnant) {
    return (
      <section className="card space-y-2" data-testid="ttc-section">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          Trying to conceive
        </h2>
        <p
          className="text-sm text-slate-600 dark:text-slate-300"
          data-testid="ttc-suspended"
        >
          Paused while a pregnancy is recorded. Fertile windows and ovulation
          estimates don&rsquo;t apply, and the months-trying count stops at
          {state.ttcStart ? ` ${state.ttcStart}` : " your recorded start"} and
          is kept for your history.
        </p>
      </section>
    );
  }

  if (!state.active) {
    return (
      <TtcOffDisclosure>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Turn this on to record ovulation (LH) tests, waking temperatures and
          cervical mucus, and to see a fertile window built from them — with the
          evidence each window rests on.
        </p>
        <TtcDeclareControl ttcStart={state.ttcStart} today={today} />
      </TtcOffDisclosure>
    );
  }

  const w = state.window;

  return (
    <section className="card space-y-4" data-testid="ttc-section">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          Trying to conceive
        </h2>
        {state.duration && (
          <div
            className="text-xs text-slate-500 dark:text-slate-400"
            data-testid="ttc-duration"
          >
            {state.duration.months} months · {state.duration.cyclesAttempted}{" "}
            cycles since {state.ttcStart}
          </div>
        )}
      </div>

      {/* Fertile window — always named by the evidence it used. */}
      <div className="space-y-1" data-testid="ttc-window">
        <div className="section-label">Fertile window</div>
        {w ? (
          <>
            <div className="text-lg font-semibold text-slate-800 dark:text-slate-100">
              {w.start} – {w.end}
            </div>
            <div
              className="text-xs font-medium text-slate-600 dark:text-slate-300"
              data-testid="ttc-window-evidence"
            >
              Based on: {FERTILE_EVIDENCE_LABELS[w.evidence]}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {w.detail}
            </p>
          </>
        ) : (
          <EmptyState message="No fertile window yet — record an LH test or a mucus observation, or log a few more cycles for a calendar estimate." />
        )}
        <p
          className="text-xs text-slate-500 dark:text-slate-400"
          data-testid="ttc-not-contraception"
        >
          {NOT_CONTRACEPTION_NOTE}
        </p>
      </div>

      {/* Ovulation confirmation + luteal length — retrospective readings. */}
      <div className="space-y-1" data-testid="ttc-confirmation">
        <div className="section-label">Ovulation confirmation</div>
        {state.confirmation ? (
          <p className="text-sm text-slate-700 dark:text-slate-200">
            A sustained temperature rise from {state.confirmation.firstHighDate}{" "}
            puts estimated ovulation on {state.confirmation.ovulationDate},
            above a baseline of{" "}
            {fmtTemp(state.confirmation.baselineF, temperatureUnit)}. This is a
            reading of what already happened, not a prediction.
          </p>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No sustained temperature rise recorded in this cycle yet.
          </p>
        )}
        {state.lutealDays != null && (
          <p
            className="text-xs text-slate-500 dark:text-slate-400"
            data-testid="ttc-luteal"
          >
            Last luteal phase: {state.lutealDays} days
            {state.lutealDays <= SHORT_LUTEAL_PHASE_DAYS
              ? ` — ${SHORT_LUTEAL_PHASE_DAYS} days or fewer is worth mentioning to a clinician.`
              : "."}
          </p>
        )}
      </div>

      <TtcLogBar
        todayLh={state.todayLh}
        todayBbtF={state.todayBbtF}
        todayMucus={state.todayMucus}
        temperatureUnit={temperatureUnit}
      />

      <TtcDeclareControl ttcStart={state.ttcStart} today={today} />
    </section>
  );
}
