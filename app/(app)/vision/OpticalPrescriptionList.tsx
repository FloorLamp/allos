"use client";

import { useMemo } from "react";
import OpticalPrescriptionForm from "./OpticalPrescriptionForm";
import {
  updateOpticalPrescription,
  deleteOpticalPrescription,
} from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import ProviderName from "@/components/ProviderName";
import { formatRecordDate } from "@/lib/record-format";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import {
  kindLabel,
  formatDiopter,
  prescriptionDisplayLabel,
  rxExpiryState,
  type RxExpiryState,
} from "@/lib/optical-prescription";
import type { OpticalPrescription } from "@/lib/types";

function ExpiryBadge({ state }: { state: RxExpiryState }) {
  if (state === "expired")
    return (
      <span className="rounded bg-rose-100 px-1.5 py-0.5 text-xs text-rose-700 dark:bg-rose-950 dark:text-rose-300">
        Expired
      </span>
    );
  if (state === "expiring-soon")
    return (
      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
        Expires soon
      </span>
    );
  return null;
}

function buildColumns(
  today: string,
  fmt: DisplayFormatPrefs
): RecordColumn<OpticalPrescription>[] {
  return [
    {
      header: "Prescription",
      cellClassName: "font-medium text-slate-800 dark:text-slate-100",
      cell: (rx) => (
        <>
          {kindLabel(rx.kind)}
          <span className="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">
            OD {formatDiopter(rx.od_sphere)} · OS {formatDiopter(rx.os_sphere)}
          </span>
          {(() => {
            const state = rxExpiryState(rx.expiry_date, today);
            return state ? (
              <span className="ml-2">
                <ExpiryBadge state={state} />
              </span>
            ) : null;
          })()}
        </>
      ),
    },
    {
      header: "Issued",
      cellClassName: "whitespace-nowrap text-slate-600 dark:text-slate-300",
      cell: (rx) => formatRecordDate(rx.issued_date, "—", fmt),
    },
    {
      header: "Expires",
      headerClassName: "hidden sm:table-cell",
      cellClassName:
        "hidden whitespace-nowrap text-slate-500 sm:table-cell dark:text-slate-400",
      cell: (rx) => formatRecordDate(rx.expiry_date, "—", fmt),
    },
    {
      header: "Prescriber",
      headerClassName: "hidden md:table-cell",
      cellClassName: "hidden md:table-cell",
      cell: (rx) =>
        rx.provider_id ? (
          <ProviderName
            name={rx.provider_name ?? "Provider"}
            providerId={rx.provider_id}
            size="sm"
          />
        ) : (
          "—"
        ),
    },
    {
      header: "Source",
      headerClassName: "hidden sm:table-cell",
      cellClassName: "hidden whitespace-nowrap sm:table-cell",
      cell: (rx) => (
        <RecordProvenance source={rx.source} documentId={rx.document_id} />
      ),
    },
  ];
}

// Manage stored optical prescriptions on the shared RecordTable: edit in place or
// delete. `today` drives the expiry badge (plain UI text — no findings engine, #697).
export default function OpticalPrescriptionList({
  items,
  today,
}: {
  items: OpticalPrescription[];
  today: string;
}) {
  const fmt = useFormatPrefs();
  const columns = useMemo(() => buildColumns(today, fmt), [today, fmt]);
  return (
    <div data-testid="optical-prescription-list" className="space-y-3">
      <RecordTable
        items={items}
        columns={columns}
        emptyMessage="No prescriptions yet. Add one, or upload an Rx slip to import it."
        renderEditForm={(rx, done) => (
          <OpticalPrescriptionForm
            action={updateOpticalPrescription}
            rx={rx}
            onDone={done}
          />
        )}
        confirmDelete={(rx) => ({
          title: "Delete prescription",
          message: `Delete “${prescriptionDisplayLabel(rx)}”? This can’t be undone.`,
        })}
        onDelete={async (rx) => {
          const fd = new FormData();
          fd.set("id", String(rx.id));
          await deleteOpticalPrescription(fd);
        }}
      />
    </div>
  );
}
