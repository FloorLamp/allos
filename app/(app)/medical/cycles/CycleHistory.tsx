"use client";

import EntryHistoryTable from "@/components/EntryHistoryTable";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { useToast } from "@/components/Toast";
import { formatLongDate } from "@/lib/format-date";
import { FLOW_LABELS, periodLengthDays, type CyclePeriod } from "@/lib/cycle";
import CycleForm from "./CycleForm";
import { deleteCycleAction, saveCycleAction } from "./actions";

export default function CycleHistory({ periods }: { periods: CyclePeriod[] }) {
  const prefs = useFormatPrefs();
  const toast = useToast();
  const periodName = (p: CyclePeriod) => formatLongDate(p.period_start, prefs);
  const periodEnd = (p: CyclePeriod) =>
    p.period_end ? formatLongDate(p.period_end, prefs) : "ongoing";
  return (
    <EntryHistoryTable
      items={periods}
      columns={[
        {
          header: "Period",
          slot: "title",
          cell: (period) => `${periodName(period)} – ${periodEnd(period)}`,
        },
        {
          header: "Details",
          slot: "trailing",
          cell: (period) => {
            const days = periodLengthDays(period);
            const length =
              days == null
                ? "In progress"
                : `${days} day${days === 1 ? "" : "s"}`;
            return `${length}${
              period.flow ? ` · ${FLOW_LABELS[period.flow]} flow` : ""
            }`;
          },
        },
        {
          header: "Notes",
          slot: "meta",
          label: "Notes",
          empty: (period) => !period.note,
          cell: (period) => period.note ?? "—",
        },
      ]}
      expandToggle={{
        collapsedLabel: `View ${periods.length} recent periods`,
        expandedLabel: "Show fewer periods",
      }}
      menuItemName={periodName}
      rowTestId={() => "cycle-history-row"}
      deleteTestId={() => "cycle-delete-button"}
      renderEditForm={(period, done) => (
        <CycleForm action={saveCycleAction} period={period} onDone={done} />
      )}
      confirmDelete={(period) => ({
        title: "Delete period?",
        message: `Remove the period starting ${periodName(period)}. You can undo this.`,
        confirmLabel: "Delete period",
      })}
      deleteFormData={(period) => {
        const fd = new FormData();
        fd.set("id", String(period.id));
        return fd;
      }}
      deleteAction={deleteCycleAction}
      deletedMessage="Period deleted"
      onDeleteError={() =>
        toast("Couldn't delete this period. Try again.", { tone: "error" })
      }
    />
  );
}
