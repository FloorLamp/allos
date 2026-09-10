"use client";

import DoseStatusControl, {
  type DoseVariant,
} from "@/components/DoseStatusControl";
import { useTimeStatement } from "@/components/TimeStatement";
import type { DoseStatusResult } from "@/app/(app)/nutrition/intake-actions";

// A dose row that stands on a STATED day, and asks for the minute when that day has
// already ended (#4686 owner ruling 2).
//
// WHY IT EXISTS AT ALL. `DoseStatusControl` is the domain's one row control and already
// accepts a `statement` and already posts its `at`; what it cannot do is MOUNT one,
// because the statement's two pieces belong in two places — the door beside the action,
// the reveal on its own line below — and only the host knows its layout. Every other
// mount that states a time is a host exactly like this one (`ScheduledDoseAction`).
// The rows here are drawn in loops, so the hook needs a component per row, and this is
// that component: nothing but the statement, the control, and where the reveal sits.
//
// WHY THE PROMPT IS REQUIRED ON A PAST DAY. A past-dated tap is genuinely ambiguous
// between "I am giving this now, for yesterday's slot" and "I am checking off a dose
// taken yesterday", and the app cannot tell them apart — so it writes no instant, and
// since #4686 the redose window reads that honestly as unplaced instead of guessing one
// from the capture stamp. That honesty has a cost, and the cost lands on ordinary
// catch-up use: check off yesterday's dose and the card stops answering "when is the
// next one OK". Asking for the minute is what pays it. An explicit "Don't know" keeps
// the row untimed, because a caregiver often does not know and should not have to
// invent a number.
//
// THE DAY DECIDES, AND IT MAY BE ABSENT. `date` undefined means today (the control's
// own contract), so this compares rather than assuming: the quick-log sheet passes
// undefined on the live day and a date string otherwise, while the day ledger passes
// its day either way. Both reach today through this one expression, and `profileToday`
// is the SERVER's answer rather than a browser clock read here — a tab left open past
// midnight would otherwise start demanding a minute for a row it is still calling
// today.
export default function DatedDoseControl({
  doseId,
  date,
  profileToday,
  taken,
  skipped,
  variant,
  itemName,
  payload,
  compact,
  rowLeaves,
  profileId,
  onSettled,
}: {
  doseId: number;
  /** The row's day; absent means the profile's today. */
  date?: string;
  /** The profile's live local day, from the server. */
  profileToday: string;
  taken: boolean;
  skipped: boolean;
  variant: DoseVariant;
  /**
   * WHICH DOSE, for the accessible name AND the minute field's label. It reaches
   * `DoseStatusControl` unchanged, so only a host whose buttons ALREADY named their
   * dose passes one — #2615 item 2 left the ledger's controls unnamed on purpose, and
   * adding the prompt is not a reason to rename them. A host without one gets "this
   * dose" on the field, beside a row that prints the name anyway.
   */
  itemName?: string;
  payload?: string;
  compact?: boolean;
  rowLeaves?: boolean;
  profileId?: number;
  onSettled?: (result: DoseStatusResult) => void;
}) {
  const day = date ?? profileToday;
  const pastDay = date != null && date !== profileToday;
  const statement = useTimeStatement({
    // Only an unresolved dose is being stated about: once a row is taken or skipped,
    // changing what the record says is the dose-history panel's audited door.
    shown: pastDay && !taken && !skipped,
    day,
    required: pastDay,
    unknownLabel: "Don’t know",
    timeLabel: `Time ${itemName || "this dose"} was taken`,
    testId: `dated-dose-when-${doseId}`,
  });
  return (
    <>
      <DoseStatusControl
        doseId={doseId}
        date={date}
        taken={taken}
        skipped={skipped}
        variant={variant}
        itemName={itemName}
        payload={payload}
        compact={compact}
        rowLeaves={rowLeaves}
        profileId={profileId}
        onSettled={onSettled}
        statement={statement}
      />
      {/* The door is null while the statement is REQUIRED — there is nothing to open,
          the field is already on screen. It is drawn anyway, and here, because this is
          where it belongs the moment a mount makes the prompt optional: immediately
          right of the action it modifies. */}
      {statement.door}
      {statement.reveal ? (
        <div className="w-full">{statement.reveal}</div>
      ) : null}
    </>
  );
}
