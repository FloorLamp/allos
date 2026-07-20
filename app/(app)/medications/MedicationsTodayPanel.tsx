import { IconCircleCheck } from "@tabler/icons-react";
import QuickLogPrnControl from "@/components/dashboard/QuickLogPrnControl";
import TodayMedRow from "@/components/medications/TodayMedRow";
import ScheduledDoseAction from "@/components/medications/ScheduledDoseAction";
import { medicationHref } from "@/lib/hrefs";
import { buildTodayPanelModel } from "@/lib/medication-today";
import type { TimeFormat } from "@/lib/format-date";
import { formatMedicationDoseLine } from "@/lib/medication-dose-format";
import { formatGivenAtClockWithRelativeAge } from "@/lib/administration-format";
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
  nowIso,
  timeFormat,
  timezone,
}: {
  // The current, due, SCHEDULED (non-PRN) meds with their doses.
  scheduled: MedCardData[];
  // The recently-used active PRN meds with pre-formatted day + redose lines.
  prnToday: {
    id: number;
    name: string;
    product: string | null;
    amount: string | null;
    dayLabel: string;
    redoseLine: string | null;
    redosePrimary: boolean;
  }[];
  taken: Set<number>;
  skipped: Set<number>;
  // The profile's local wall clock (HH:MM), so past-due is judged in the profile's tz.
  nowHhmm: string;
  nowIso: string;
  timeFormat: TimeFormat;
  timezone: string;
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
        label:
          formatMedicationDoseLine({
            amount: null,
            timeOfDay: dose.time_of_day,
            asNeeded: false,
            timeFormat,
          }) || "",
        resolved: taken.has(dose.id) || skipped.has(dose.id),
      })),
    })),
    nowHhmm
  );

  return (
    <section data-testid="medications-today" className="card">
      <div>
        <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
          Today
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Check off scheduled doses or log an as-needed medication.
        </p>
      </div>
      {model.allDone && (
        <div
          data-testid="today-all-done"
          className="mt-4 flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400"
        >
          <IconCircleCheck className="h-4 w-4" stroke={2} aria-hidden="true" />
          All done today
        </div>
      )}
      <div className="mt-3 divide-y divide-black/5 dark:divide-white/5">
        {model.meds.flatMap((m) => {
          const card = byId.get(m.id)!;
          return m.doses.map((dose) => {
            const storedDose = card.doses.find((item) => item.id === dose.id);
            const isTaken = taken.has(dose.id);
            const takenTime = formatGivenAtClockWithRelativeAge(
              timezone,
              card.takenDoseTimes[dose.id],
              timeFormat,
              new Date(nowIso)
            );
            return (
              <TodayMedRow
                key={dose.id}
                testId="today-scheduled-med"
                itemId={m.id}
                name={card.med.name}
                detail={formatMedicationDoseLine({
                  amount: storedDose?.amount ?? null,
                  product: card.med.product,
                  timeOfDay: dose.timeOfDay,
                  asNeeded: false,
                  timeFormat,
                })}
                href={medicationHref(m.id)}
                pastDue={dose.pastDue}
                status={
                  dose.pastDue || (isTaken && takenTime) ? (
                    <>
                      {dose.pastDue ? (
                        <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
                          Past due
                        </span>
                      ) : null}
                      {isTaken && takenTime ? (
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                          {takenTime}
                        </span>
                      ) : null}
                    </>
                  ) : null
                }
                control={
                  <ScheduledDoseAction
                    doseId={dose.id}
                    doseLabel=""
                    taken={isTaken}
                    skipped={skipped.has(dose.id)}
                    compactActions
                  />
                }
                variant="embedded"
              />
            );
          });
        })}

        {prnToday.map((m) => (
          <QuickLogPrnControl
            key={m.id}
            itemId={m.id}
            name={m.name}
            doseAmount={m.amount}
            product={m.product}
            dayLabel={m.dayLabel}
            redoseLine={m.redoseLine}
            redosePrimary={m.redosePrimary}
            linkToDetail
            rowVariant="embedded"
            compactActions
          />
        ))}
      </div>
    </section>
  );
}
