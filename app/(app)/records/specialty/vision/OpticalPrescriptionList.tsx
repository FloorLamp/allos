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
import type { Stamped } from "@/lib/scope";
import type { ListMultiView } from "@/lib/multi-view";

// A profile id → that profile's local `today` (lib/db `today(profileId)`). "Has this
// Rx expired?" is asked in the SUBJECT's timezone, not the actor's, so multi-view
// resolves one per member in view rather than reusing the acting profile's day.
export type TodayByProfile = Record<number, string>;

function ExpiryBadge({ state }: { state: RxExpiryState }) {
  if (state === "expired")
    return (
      <span className="rounded-sm bg-rose-100 px-1.5 py-0.5 text-xs text-rose-700 dark:bg-rose-950 dark:text-rose-300">
        Expired
      </span>
    );
  if (state === "expiring-soon")
    return (
      <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
        Expires soon
      </span>
    );
  return null;
}

function buildColumns(
  todayByProfile: TodayByProfile,
  actingProfileId: number,
  fmt: DisplayFormatPrefs
): RecordColumn<OpticalPrescription>[] {
  // The row's own subject's day, falling back to the actor's — which is exactly the
  // single-view answer, since there the row IS the actor's.
  const dayFor = (rx: OpticalPrescription) =>
    todayByProfile[
      (rx as { profileId?: number }).profileId ?? actingProfileId
    ] ??
    todayByProfile[actingProfileId] ??
    "";
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
            const state = rxExpiryState(rx.expiry_date, dayFor(rx));
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
      empty: (rx) => !rx.issued_date,
      cell: (rx) => formatRecordDate(rx.issued_date, "—", fmt),
    },
    {
      header: "Expires",
      headerClassName: "hidden sm:table-cell",
      cellClassName:
        "hidden whitespace-nowrap text-slate-500 sm:table-cell dark:text-slate-400",
      empty: (rx) => !rx.expiry_date,
      cell: (rx) => formatRecordDate(rx.expiry_date, "—", fmt),
    },
    {
      header: "Prescriber",
      headerClassName: "hidden md:table-cell",
      cellClassName: "hidden md:table-cell",
      empty: (rx) => !rx.provider_id,
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
      cellClassName: "whitespace-nowrap",
      cell: (rx) => (
        <RecordProvenance source={rx.source} documentId={rx.document_id} />
      ),
    },
  ];
}

// Manage stored optical prescriptions on the shared RecordTable: edit in place or
// delete. `todayByProfile` drives the expiry badge (plain UI text — no findings
// engine, #697), one day per profile in view (#2557).
export default function OpticalPrescriptionList({
  items,
  todayByProfile,
  multiView,
}: {
  items: Stamped<OpticalPrescription>[];
  todayByProfile: TodayByProfile;
  multiView?: ListMultiView;
}) {
  const fmt = useFormatPrefs();
  // Single view has exactly one day in the map, and it is the acting profile's.
  const actingProfileId =
    multiView?.actingProfileId ?? Number(Object.keys(todayByProfile)[0] ?? 0);
  const columns = useMemo(
    () => buildColumns(todayByProfile, actingProfileId, fmt),
    [todayByProfile, actingProfileId, fmt]
  );
  return (
    <div data-testid="optical-prescription-list" className="space-y-3">
      <RecordTable
        items={items}
        columns={columns}
        emptyMessage="No prescriptions yet. Add one, or upload an Rx slip to import it."
        multiView={
          multiView
            ? {
                actingProfileId: multiView.actingProfileId,
                subjectOf: (rx) => rx.subject,
              }
            : undefined
        }
        renderEditForm={(rx, done) => (
          <OpticalPrescriptionForm
            action={updateOpticalPrescription}
            rx={rx}
            profileId={multiView ? rx.subject.profileId : undefined}
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
          // Multi-view (#2557): post the ROW's own profile so the action gates and
          // writes that member, never whoever happens to be acting.
          if (multiView) fd.set("profile_id", String(rx.subject.profileId));
          await deleteOpticalPrescription(fd);
        }}
      />
    </div>
  );
}
