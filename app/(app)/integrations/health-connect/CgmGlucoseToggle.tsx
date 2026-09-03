"use client";

import CheckboxControl from "@/components/CheckboxControl";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";
import { setCgmGlucose } from "./actions";

// The one switch the #3182 ruling asks for, and the only question this page asks
// about glucose. It is OFF by default and setup never raises it: a fingerstick meter
// and a CGM push the same Health Connect record type, so the safe answer for someone
// who has not thought about it is the one that keeps a discrete reading a discrete
// reading.
//
// A TAP-IS-THE-SAVE CONTROL, ON THE SHARED AUTOSAVE SUBSTRATE (#4972). It shipped
// holding its own `useState` and flipping it beside a bare `useTransition`, which is
// the shape `useSaveStatus` was built to end (#4688): the box reported the new value
// in the same frame while NOTHING said the write was still open, so a reload in that
// window cancelled it and the page came back showing the opposite of what had just
// been chosen — silently, on the switch that decides whether a reading is a lab
// result or a sensor trace. The hook owns the displayed value, so a write that throws
// takes its paint back; `SaveStatus` renders the spinner for exactly as long as the
// Server Action is outstanding, which is what makes the unsettled moment visible to a
// person and to e2e's `settledCheckSave`.
export default function CgmGlucoseToggle({ initial }: { initial: boolean }) {
  const { status, value: on, save } = useSaveStatus(initial);

  return (
    <div className="card space-y-2" data-testid="hc-cgm-glucose">
      <div className="flex items-start gap-3">
        <CheckboxControl
          label="Treat glucose from this connection as a continuous sensor"
          checked={on}
          disabled={status.pending}
          data-testid="hc-cgm-glucose-toggle"
          onChange={(next) =>
            save(next, async () => {
              await setCgmGlucose(next);
            })
          }
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
            Treat glucose from this connection as a continuous sensor
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Leave this off if your glucose readings come from a fingerstick
            meter — they stay lab results. Turn it on for a CGM: its readings
            are stored as a sensor trace instead, so a day of readings becomes a
            daily average and time in range rather than hundreds of lab rows.
            Only new readings are affected.
          </p>
        </div>
        <SaveStatus {...status} />
      </div>
    </div>
  );
}
