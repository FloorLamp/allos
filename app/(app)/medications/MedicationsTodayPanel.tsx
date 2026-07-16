import Link from "next/link";
import DoseStatusControl from "@/components/DoseStatusControl";
import QuickLogPrnControl from "@/components/dashboard/QuickLogPrnControl";
import { medicationHref } from "@/lib/hrefs";
import type { MedCardData } from "./med-data";

// The Today panel that LEADS the Medications page (#817): the daily-use job first.
// Scheduled meds due today get their dose check-offs (the shared tri-state
// DoseStatusControl — same control the supplement row uses), and PRN meds get an
// administration row with a one-tap Log button (the reused QuickLogPrnControl the
// dashboard widget renders, so "log a PRN dose" is one interaction everywhere).
// Renders nothing when there's nothing to act on — no standing empty panel.
export default function MedicationsTodayPanel({
  scheduled,
  prnToday,
  taken,
  skipped,
}: {
  // The current, due, SCHEDULED (non-PRN) meds with their doses.
  scheduled: MedCardData[];
  // The recently-used active PRN meds with pre-formatted day + redose lines.
  prnToday: {
    id: number;
    name: string;
    dayLabel: string;
    redoseLine: string | null;
  }[];
  taken: Set<number>;
  skipped: Set<number>;
}) {
  const dueScheduled = scheduled.filter(
    (d) => d.med.as_needed !== 1 && d.due && d.doses.length > 0
  );
  if (dueScheduled.length === 0 && prnToday.length === 0) return null;

  return (
    <section data-testid="medications-today" className="card">
      <h2 className="mb-3 section-label text-brand-700 dark:text-brand-400">
        Today
      </h2>
      <div className="space-y-3">
        {dueScheduled.map((d) => (
          <div
            key={d.med.id}
            data-testid="today-scheduled-med"
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <Link
              href={medicationHref(d.med.id)}
              className="font-medium text-slate-800 hover:underline dark:text-slate-100"
            >
              {d.med.name}
            </Link>
            <div className="flex flex-wrap gap-2">
              {d.doses.map((dose) => (
                <DoseStatusControl
                  key={dose.id}
                  doseId={dose.id}
                  taken={taken.has(dose.id)}
                  skipped={skipped.has(dose.id)}
                  variant="pill"
                  label={dose.amount || dose.time_of_day || "Dose"}
                />
              ))}
            </div>
          </div>
        ))}

        {prnToday.map((m) => (
          <QuickLogPrnControl
            key={m.id}
            itemId={m.id}
            name={m.name}
            dayLabel={m.dayLabel}
            redoseLine={m.redoseLine}
          />
        ))}
      </div>
    </section>
  );
}
