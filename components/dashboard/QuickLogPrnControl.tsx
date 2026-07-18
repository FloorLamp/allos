"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconClock, IconCheck } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import TodayMedRow from "@/components/medications/TodayMedRow";
import { medicationHref } from "@/lib/hrefs";
import { logMedicationAdministration } from "@/app/(app)/medications/actions";

// One PRN (as-needed) medication's quick-log row in the dashboard widget (#797).
// A primary "Taken now" button records an administration NOW; "Earlier dose" reveals
// retro offsets — 30m ago, 1h ago, or a specific time today — the retro-entry home
// ("gave it at 4pm, logging it now"). Each successful log is a real administration
// (the ledger allows multiples/day), and router.refresh() pulls the revalidated
// "N today · last …" subtitle from the server.
export default function QuickLogPrnControl({
  itemId,
  name,
  doseAmount,
  dayLabel,
  redoseLine = null,
  linkToDetail = false,
  profileId,
  rowVariant = "inset",
}: {
  itemId: number;
  name: string;
  doseAmount?: string | null;
  dayLabel: string;
  // The redose-window status line (#798), or null when the med has no confirmed
  // interval/max. Informational — window state + running count, never permissive.
  redoseLine?: string | null;
  // The name links to the med's detail page (#852 item 2), matching the scheduled row.
  // Both hosts — the Medications Today panel (#851 item 10) and the dashboard quick-log
  // widget — pass this now; it stays a prop only so a future non-linking host can opt out.
  linkToDetail?: boolean;
  // The profile this dose is logged for (issue #858). Set on the illness-hero cockpit so
  // a caregiver logs a household member's PRN dose without switching — the action gates on
  // the TARGET (requireProfileWriteAccess). Absent on the dashboard/medications mounts.
  profileId?: number;
  rowVariant?: "inset" | "embedded";
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState("");
  const router = useRouter();
  const toast = useToast();

  async function log(offset: string, customTime?: string) {
    if (busy) return;
    setBusy(true);
    const fd = new FormData();
    fd.set("id", String(itemId));
    fd.set("offset", offset);
    if (customTime) fd.set("time", customTime);
    if (profileId != null) fd.set("profileId", String(profileId));
    try {
      const res = await logMedicationAdministration(fd);
      if (res.ok) {
        toast(`Logged ${name}${doseAmount ? ` · ${doseAmount}` : ""}.`);
        setOpen(false);
        setTime("");
        router.refresh();
      } else {
        toast(res.error, { tone: "error" });
      }
    } catch {
      toast("Couldn't log that dose. Try again.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  const control = (
    <>
      <button
        type="button"
        onClick={() => log("now")}
        disabled={busy}
        className="btn btn-sm"
        data-testid="prn-log-now"
      >
        <IconCheck className="h-3.5 w-3.5" stroke={2.5} />
        <span>Taken now</span>
      </button>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="btn-ghost btn-sm"
        aria-expanded={open}
        aria-label="Earlier dose"
        data-testid="prn-log-more"
      >
        <IconClock className="h-4 w-4" stroke={2} />
        <span>Earlier dose</span>
      </button>
    </>
  );

  const sublines = (
    <div className="min-w-0 pl-6">
      <div
        className="text-xs text-slate-500 dark:text-slate-400"
        data-testid="prn-day-label"
      >
        {dayLabel}
      </div>
      {redoseLine && (
        <div
          className="text-xs font-medium text-slate-600 dark:text-slate-300"
          data-testid="prn-redose-line"
        >
          {redoseLine}
        </div>
      )}
    </div>
  );

  return (
    <TodayMedRow
      testId="quick-log-prn-item"
      itemId={itemId}
      variant={rowVariant}
      name={name}
      detail={doseAmount}
      href={linkToDetail ? medicationHref(itemId) : undefined}
      control={control}
      sublines={sublines}
      footer={
        open ? (
          <div
            className="border-t border-black/5 pt-2 pl-6 dark:border-white/5"
            data-testid="prn-log-options"
          >
            <p className="mb-2 text-xs font-medium text-slate-600 dark:text-slate-300">
              When was it taken?
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <button
                type="button"
                onClick={() => log("30m")}
                disabled={busy}
                className="btn-ghost btn-sm"
                data-testid="prn-log-30m"
              >
                30 min ago
              </button>
              <button
                type="button"
                onClick={() => log("1h")}
                disabled={busy}
                className="btn-ghost btn-sm"
                data-testid="prn-log-1h"
              >
                1 hr ago
              </button>
              <label className="block">
                <span className="sr-only">Specific time today</span>
                <input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="input h-8 w-28 text-sm"
                  aria-label="Specific time today"
                  data-testid="prn-log-time"
                />
              </label>
              <button
                type="button"
                onClick={() => time && log("custom", time)}
                disabled={busy || !time}
                className="btn btn-sm"
                data-testid="prn-log-custom"
              >
                <IconCheck className="h-3.5 w-3.5" stroke={2.5} />
                <span>Save dose</span>
              </button>
            </div>
          </div>
        ) : null
      }
    />
  );
}
