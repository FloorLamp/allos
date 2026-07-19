"use client";

import { useState } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import QuickAddMedication from "@/components/QuickAddMedication";
import { QuickLogPrnContent } from "@/components/dashboard/QuickLogPrnWidget";
import { addSupplement } from "@/app/(app)/nutrition/supplement-actions";
import type { PrnMedForQuickLog } from "@/lib/queries";
import type { PediatricFormContext } from "@/lib/prn-dosing";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";

// The shared medication workspace for an active illness. Existing PRN medications use
// the same compact quick-log rows on the dashboard cockpit and episode page; adding an
// OTC medication expands the standard QuickAddMedication form in place. Cross-profile
// surfaces omit canAdd because the add action intentionally writes the active profile.
export default function IllnessMedicationLogger({
  meds,
  tz,
  profileId,
  pediatric,
  canAdd,
  nowIso,
}: {
  meds: PrnMedForQuickLog[];
  tz: string;
  profileId?: number;
  pediatric?: PediatricFormContext;
  canAdd: boolean;
  // The server's redose-window "now" (see QuickLogPrnContent.nowIso) — this is a
  // "use client" mount, so the frozen-clock env override is invisible here.
  nowIso: string;
}) {
  const formatPrefs = useFormatPrefs();
  const [adding, setAdding] = useState(false);

  return (
    <QuickLogPrnContent
      meds={meds}
      tz={tz}
      nowIso={nowIso}
      timeFormat={formatPrefs.timeFormat}
      title="Meds"
      headingVariant="section"
      compact
      rowVariant="embedded"
      profileId={profileId}
      emptyMessage="No medications added."
      intro={
        <>
          {canAdd ? (
            <div
              className="mb-3 flex items-center"
              data-testid="illness-medication-disclosure-row"
            >
              <button
                type="button"
                className="btn-ghost btn-sm"
                data-testid="illness-add-medication"
                aria-expanded={adding}
                aria-controls="illness-medication-quick-add"
                onClick={() => setAdding((open) => !open)}
              >
                <IconChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${adding ? "rotate-180" : ""}`}
                />
                Add medication
              </button>
            </div>
          ) : null}
          {adding ? (
            <div
              id="illness-medication-quick-add"
              className="mb-3 border-b border-black/5 pb-4 dark:border-white/5"
              data-testid="illness-medication-quick-add"
            >
              <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
                Add an over-the-counter medication and its usual dose.
              </p>
              <QuickAddMedication
                action={addSupplement}
                pediatric={pediatric}
                onDone={() => setAdding(false)}
              />
            </div>
          ) : null}
        </>
      }
    />
  );
}
