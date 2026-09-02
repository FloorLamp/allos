import { IconCircleCheck } from "@tabler/icons-react";
import LedgerDoorLink from "@/components/LedgerDoorLink";
import QuickLogPrnControl from "@/components/medications/QuickLogPrnControl";
import TodayMedRow from "@/components/medications/TodayMedRow";
import ScheduledDoseAction from "@/components/medications/ScheduledDoseAction";
import MomentSlot from "@/components/medications/MomentSlot";
import { historyHref, medicationHref } from "@/lib/hrefs";
import { buildTodayPanelModel } from "@/lib/medication-today";
import { buildMomentSections, type MomentDose } from "@/lib/moment-sections";
import {
  currentTimeBucket,
  isOnDemand,
  timeBucket,
  TIME_BUCKET_LABELS,
} from "@/lib/intake-schedule";
import type { TimeFormat } from "@/lib/format-date";
import { formatMedicationDoseLine } from "@/lib/medication-dose-format";
import {
  formatGivenAtClock,
  formatGivenAtClockWithRelativeAge,
} from "@/lib/administration-format";
import type { MedCardData } from "./med-data";

// The Today panel that LEADS the Medications page (#817): the daily-use job first.
// Scheduled meds due today get their dose check-offs (the shared tri-state
// DoseStatusControl — same control the supplement row uses), and PRN meds get an
// administration row with a one-tap Log button (the reused QuickLogPrnControl the
// dashboard presentation renders, so "log a PRN dose" is one interaction everywhere).
// Renders nothing when there's nothing to act on — no standing empty panel.
//
// Time-aware (#852 item 1): rows are ordered by the SHARED doseSortKey comparator
// (bucket → priority → stack → name) via buildTodayPanelModel — the SAME order the
// Supplements tab and Upcoming use — a past-bucket unresolved dose reads amber, and a
// quiet "All done today ✓" line shows once every due dose is resolved.
//
// MOMENT-LED since #2652 behavior 1: those same rows are now grouped into their dose-day
// slots, and a slot earns full height only when this moment is its moment. The decision
// is `buildMomentSections` (pure, unit-tested, no DOM); this file only renders it, and
// the row order INSIDE each slot is still buildTodayPanelModel's — one ordering, not two.
export default function MedicationsTodayPanel({
  scheduled,
  prnToday,
  taken,
  skipped,
  nowHhmm,
  nowIso,
  timeFormat,
  timezone,
  profileId,
  canWrite = true,
  ledgerDoor = false,
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
  // The board's owning profile (#1373 multi-view). On a non-acting board every dose
  // confirm / PRN log targets THIS profile via the #858 gate; absent on the acting
  // board / single-view, so the panel is byte-identical.
  profileId?: number;
  // Whether the viewer may write this member's doses. A read-only member's board is
  // view-only: scheduled rows show status without the check-off control, and the
  // PRN log rows (a pure write affordance) are omitted. Default true (acting board /
  // single-view) keeps the panel byte-identical.
  canWrite?: boolean;
  // Whether this panel carries the door onto the cross-item dose record (#3479,
  // re-homed to `/history` by #3958). The door left the page header and joined this
  // card, because this card is what the record is OF. ACTING-ONLY, like every other
  // affordance with no cross-profile seam (`historyHref` resolves to the acting
  // profile's record, so a copy on each member's board in multi-view would be N doors
  // to one place).
  // Default false so a non-acting board renders exactly what it rendered before.
  ledgerDoor?: boolean;
}) {
  const dueScheduled = scheduled.filter(
    (d) => !isOnDemand(d.med) && d.due && d.doses.length > 0
  );
  // PRN log rows are a pure write affordance; a read-only board omits them.
  const showPrn = canWrite && prnToday.length > 0;
  if (dueScheduled.length === 0 && !showPrn) return null;

  const byId = new Map(dueScheduled.map((d) => [d.med.id, d]));
  const model = buildTodayPanelModel(
    dueScheduled.map((d) => ({
      id: d.med.id,
      name: d.med.name,
      obligation: d.med.obligation,
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

  // Flattened in buildTodayPanelModel's order, so slot grouping never re-sorts anything.
  const rowKeyOf = (medId: number, doseId: number) => `${medId}:${doseId}`;
  const flat = model.meds.flatMap((m) =>
    m.doses.map((dose) => ({ key: rowKeyOf(m.id, dose.id), medId: m.id, dose }))
  );
  const rowByKey = new Map(flat.map((entry) => [entry.key, entry]));

  const momentDoses: MomentDose<string>[] = flat.map(({ key, medId, dose }) => {
    const card = byId.get(medId)!;
    const isTaken = taken.has(dose.id);
    return {
      key,
      bucket: timeBucket(dose.timeOfDay),
      resolved: isTaken || skipped.has(dose.id),
      taken: isTaken,
      // The bare clock, not the "(2h ago)" variant the ROW shows: a one-line slot
      // summary states when the slot settled, and the relative age belongs to the row
      // it annotates.
      takenClock: isTaken
        ? formatGivenAtClock(timezone, card.takenDoseTimes[dose.id], timeFormat)
        : null,
    };
  });

  const rowFor = (key: string) => {
    const entry = rowByKey.get(key);
    if (!entry) return null;
    const { medId, dose } = entry;
    const card = byId.get(medId)!;
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
        key={key}
        testId="today-scheduled-med"
        itemId={medId}
        name={card.med.name}
        detail={formatMedicationDoseLine({
          amount: storedDose?.amount ?? null,
          product: card.med.product,
          timeOfDay: dose.timeOfDay,
          asNeeded: false,
          timeFormat,
        })}
        href={medicationHref(medId)}
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
            readOnly={!canWrite}
            profileId={profileId}
            tz={timezone}
          />
        }
        variant="embedded"
      />
    );
  };

  const sections = buildMomentSections<string>({
    doses: momentDoses,
    currentBucket: currentTimeBucket(nowHhmm),
    labels: TIME_BUCKET_LABELS,
  });

  return (
    <section data-testid="medications-today" className="card">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            Today
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Check off scheduled doses or log an as-needed medication.
          </p>
        </div>
        {ledgerDoor ? (
          <LedgerDoorLink
            href={historyHref({ kind: "dose", class: "medication" })}
            label="Dose history"
            testId="dose-ledger-link"
          />
        ) : null}
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
      <div className="mt-3 flex flex-col gap-1">
        {sections.map((section) => (
          <MomentSlot key={section.bucket} section={section}>
            {section.doses.map((d) => rowFor(d.key))}
          </MomentSlot>
        ))}

        {showPrn && (
          <div className="divide-y divide-black/5 dark:divide-white/5">
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
                profileId={profileId}
                tz={timezone}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
