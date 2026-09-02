"use client";

import { useState } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import IntakeItemForm from "@/components/IntakeItemForm";
import QuickLogPrnContent from "@/components/medications/QuickLogPrnContent";
import { addIntakeItem } from "@/app/(app)/nutrition/intake-actions";
import type { PrnMedForQuickLog } from "@/lib/queries";
import type { IntakeFormContext } from "@/lib/intake-form-context";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";

// The shared medication workspace for an active illness. Existing PRN medications use
// the same compact quick-log rows on the dashboard cockpit and episode page; adding an
// OTC medication expands the standard intake form in place. Cross-profile
// surfaces omit canAdd because the add action intentionally writes the active profile.
export default function IllnessMedicationLogger({
  meds,
  tz,
  profileId,
  intakeContext,
  canAdd,
  nowIso,
}: {
  meds: PrnMedForQuickLog[];
  tz: string;
  profileId?: number;
  // REQUIRED, and the whole of it (#4609). This fold used to pass the pediatric
  // context alone, so the form it mounts knew the profile was a child — weight-band
  // dosing and all — while its food-note age gate ran on "unknown" and its stack, PGx
  // and pairing inputs were empty. A host that cannot supply the subject's full
  // context has no business opening this door.
  intakeContext: IntakeFormContext;
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
              <IntakeItemForm
                action={addIntakeItem}
                kind="medication"
                allIntakeItems={intakeContext.allIntakeItems}
                stackItems={intakeContext.stackItems}
                pgxVariants={intakeContext.pgxVariants}
                conditions={intakeContext.conditions}
                pediatric={intakeContext.pediatric}
                todayStr={intakeContext.todayStr}
                onDone={() => setAdding(false)}
              />
            </div>
          ) : null}
        </>
      }
    />
  );
}
