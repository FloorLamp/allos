import { IconCircleCheck } from "@tabler/icons-react";
import DoseStatusControl from "@/components/DoseStatusControl";
import QuickLogPrnControl from "@/components/dashboard/QuickLogPrnControl";
import TodayMedRow from "@/components/medications/TodayMedRow";
import { medicationHref } from "@/lib/hrefs";
import { buildTodayPanelModel } from "@/lib/medication-today";
import type { MedCardData } from "./med-data";

// The Today panel that LEADS the Medications page (#817): the daily-use job first.
// Scheduled meds due today get their dose check-offs (the shared tri-state
// DoseStatusControl — same control the supplement row uses), and PRN meds get an
// administration row with a one-tap Log button (the reused QuickLogPrnControl the
// dashboard widget renders, so "log a PRN dose" is one interaction everywhere).
// Renders nothing when there's nothing to act on — no standing empty panel.
//
// Time-aware (#852 item 1): rows are ordered by the SHARED doseSortKey comparator
// (bucket → priority → stack → name) via buildTodayPanelModel — the SAME order the
// Supplements tab and Upcoming use — a past-bucket unresolved dose reads amber, and a
// quiet "All done today ✓" line shows once every due dose is resolved.
export default function MedicationsTodayPanel({
  scheduled,
  prnToday,
  taken,
  skipped,
  nowHhmm,
}: {
  // The current, due, SCHEDULED (non-PRN) meds with their doses.
  scheduled: MedCardData[];
  // The recently-used active PRN meds with pre-formatted day + redose lines.
  prnToday: {
    id: number;
    name: string;
    amount: string | null;
    dayLabel: string;
    redoseLine: string | null;
  }[];
  taken: Set<number>;
  skipped: Set<number>;
  // The profile's local wall clock (HH:MM), so past-due is judged in the profile's tz.
  nowHhmm: string;
}) {
  const dueScheduled = scheduled.filter(
    (d) => d.med.as_needed !== 1 && d.due && d.doses.length > 0
  );
  if (dueScheduled.length === 0 && prnToday.length === 0) return null;

  const byId = new Map(dueScheduled.map((d) => [d.med.id, d]));
  const model = buildTodayPanelModel(
    dueScheduled.map((d) => ({
      id: d.med.id,
      name: d.med.name,
      priority: d.med.priority,
      stack: d.med.stack,
      doses: d.doses.map((dose) => ({
        id: dose.id,
        timeOfDay: dose.time_of_day,
        label: dose.amount || dose.time_of_day || "Dose",
        resolved: taken.has(dose.id) || skipped.has(dose.id),
      })),
    })),
    nowHhmm
  );

  return (
    <section data-testid="medications-today" className="card">
      <h2 className="mb-3 section-label text-brand-700 dark:text-brand-400">
        Today
      </h2>
      {model.allDone && (
        <div
          data-testid="today-all-done"
          className="mb-3 flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400"
        >
          <IconCircleCheck className="h-4 w-4" stroke={2} aria-hidden="true" />
          All done today
        </div>
      )}
      <div className="space-y-3">
        {model.meds.map((m) => {
          const card = byId.get(m.id)!;
          return (
            <TodayMedRow
              key={m.id}
              testId="today-scheduled-med"
              itemId={m.id}
              name={card.med.name}
              href={medicationHref(m.id)}
              control={m.doses.map((dose) => (
                <span
                  key={dose.id}
                  data-testid="today-dose"
                  data-past-due={dose.pastDue ? "1" : undefined}
                  className={
                    dose.pastDue
                      ? "rounded-full ring-2 ring-amber-400 dark:ring-amber-500"
                      : undefined
                  }
                  title={dose.pastDue ? "Past due — earlier today" : undefined}
                >
                  <DoseStatusControl
                    doseId={dose.id}
                    taken={taken.has(dose.id)}
                    skipped={skipped.has(dose.id)}
                    variant="pill"
                    label={dose.label}
                  />
                </span>
              ))}
            />
          );
        })}

        {prnToday.map((m) => (
          <QuickLogPrnControl
            key={m.id}
            itemId={m.id}
            name={m.name}
            doseAmount={m.amount}
            dayLabel={m.dayLabel}
            redoseLine={m.redoseLine}
            linkToDetail
          />
        ))}
      </div>
    </section>
  );
}
