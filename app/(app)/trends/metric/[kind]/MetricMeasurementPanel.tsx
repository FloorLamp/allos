"use client";

import { useState, type ReactNode } from "react";
import { IconPlus } from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import { PageHeader } from "@/components/ui";
import type { MeasurementEntryMetric } from "@/lib/measurement-entry";
import MeasurementsQuickAdd, {
  type MeasurementsQuickAddProps,
} from "../../MeasurementsQuickAdd";

// The metric detail page is primarily a reading/analysis surface. Entry stays one
// deliberate click away and, once opened, mounts the shared measurements form in
// the standard modal shell. The form stays metric-scoped — one observation, never
// the full morning log — on both phone and desktop.
export default function MetricMeasurementPanel({
  metric,
  label,
  title,
  subtitle,
  leading,
  headerAction,
  ...props
}: Omit<MeasurementsQuickAddProps, "metric" | "onSaved" | "headerSlot"> & {
  metric: MeasurementEntryMetric;
  label: string;
  title: string;
  subtitle?: ReactNode;
  leading: ReactNode;
  headerAction?: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-w-0" data-testid="metric-measurement-panel">
      <div className="flex min-w-0 items-start gap-2 sm:block">
        {leading}
        <PageHeader
          className="!mb-0 min-w-0 flex-1 !gap-2 sm:mt-3 sm:!gap-4"
          title={title}
          subtitle={subtitle}
          actionAlign="start"
          action={
            <div className="flex flex-nowrap items-center gap-1.5 sm:gap-2">
              {headerAction}
              <button
                type="button"
                onClick={() => setOpen(true)}
                aria-label={`Log ${label.toLowerCase()} manually`}
                aria-haspopup="dialog"
                aria-expanded={open}
                className="btn btn-sm min-h-10 min-w-10 px-2 sm:min-h-0 sm:min-w-0 sm:px-3"
                data-testid="metric-measurement-toggle"
              >
                <IconPlus className="h-4 w-4" stroke={1.75} aria-hidden />
                <span className="hidden sm:inline">Log Manually</span>
              </button>
            </div>
          }
        />
      </div>

      {open && (
        <ModalShell
          title={`Log ${label}`}
          onClose={() => setOpen(false)}
          className="flex max-h-[calc(100dvh-2rem)] w-full max-w-2xl flex-col rounded-xl bg-white p-4 shadow-xl outline-none sm:max-h-[calc(100dvh-4rem)] sm:p-5 dark:bg-ink-900"
        >
          <div
            className="mt-4 min-h-0 overflow-y-auto px-1 pb-1"
            data-testid="metric-measurement-modal-body"
          >
            <MeasurementsQuickAdd
              {...props}
              metric={{ key: metric, label }}
              presentation="modal"
              onSaved={() => setOpen(false)}
            />
          </div>
        </ModalShell>
      )}
    </div>
  );
}
