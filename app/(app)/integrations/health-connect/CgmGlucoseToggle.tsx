"use client";

import { useState, useTransition } from "react";
import CheckboxControl from "@/components/CheckboxControl";
import { setCgmGlucose } from "./actions";

// The one switch the #3182 ruling asks for, and the only question this page asks
// about glucose. It is OFF by default and setup never raises it: a fingerstick meter
// and a CGM push the same Health Connect record type, so the safe answer for someone
// who has not thought about it is the one that keeps a discrete reading a discrete
// reading.
export default function CgmGlucoseToggle({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [pending, start] = useTransition();

  return (
    <div className="card space-y-2" data-testid="hc-cgm-glucose">
      <div className="flex items-start gap-3">
        <CheckboxControl
          label="Treat glucose from this connection as a continuous sensor"
          checked={on}
          disabled={pending}
          data-testid="hc-cgm-glucose-toggle"
          onChange={(next) => {
            setOn(next);
            start(async () => {
              await setCgmGlucose(next);
            });
          }}
        />
        <div className="space-y-1">
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
      </div>
    </div>
  );
}
