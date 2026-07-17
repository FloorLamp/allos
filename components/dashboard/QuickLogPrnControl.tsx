"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconPlus, IconClock, IconCheck } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import TodayMedRow from "@/components/medications/TodayMedRow";
import { medicationHref } from "@/lib/hrefs";
import { logMedicationAdministration } from "@/app/(app)/medications/actions";

// One PRN (as-needed) medication's quick-log row in the dashboard widget (#797).
// A primary "Log" button records an administration NOW; the "…" affordance reveals
// retro offsets — 30m ago, 1h ago, or a specific time today — the retro-entry home
// ("gave it at 4pm, logging it now"). Each successful log is a real administration
// (the ledger allows multiples/day), and router.refresh() pulls the revalidated
// "N today · last …" subtitle from the server.
export default function QuickLogPrnControl({
  itemId,
  name,
  dayLabel,
  redoseLine = null,
  linkToDetail = false,
  profileId,
}: {
  itemId: number;
  name: string;
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
        toast(`Logged ${name}.`);
        setOpen(false);
        setTime("");
        router.refresh();
      } else {
        toast(res.error, { tone: "error" });
      }
    } catch {
      toast("Couldn't log that dose. Please try again.", { tone: "error" });
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
        <IconPlus className="h-3.5 w-3.5" stroke={2.5} />
        <span>Log</span>
      </button>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="flex h-8 w-8 items-center justify-center rounded-full border border-black/10 text-slate-500 transition hover:border-brand-400 dark:border-white/10 dark:text-slate-300"
        aria-expanded={open}
        aria-label="Log at an earlier time"
        title="Log at an earlier time"
        data-testid="prn-log-more"
      >
        <IconClock className="h-4 w-4" stroke={2} />
      </button>
    </>
  );

  const sublines = (
    <div className="min-w-0">
      <div
        className="text-xs text-slate-500 dark:text-slate-400"
        data-testid="prn-day-label"
      >
        {dayLabel}
      </div>
      {redoseLine && (
        <div
          className="text-xs font-medium text-brand-700 dark:text-brand-400"
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
      name={name}
      href={linkToDetail ? medicationHref(itemId) : undefined}
      control={control}
      sublines={sublines}
      footer={
        open ? (
          <div
            className="flex flex-wrap items-center gap-2 border-t border-black/5 pt-2 dark:border-white/5"
            data-testid="prn-log-options"
          >
            <button
              type="button"
              onClick={() => log("30m")}
              disabled={busy}
              className="rounded-full border border-black/10 px-2.5 py-1 text-xs text-slate-600 transition hover:border-brand-400 dark:border-white/10 dark:text-slate-300"
              data-testid="prn-log-30m"
            >
              30m ago
            </button>
            <button
              type="button"
              onClick={() => log("1h")}
              disabled={busy}
              className="rounded-full border border-black/10 px-2.5 py-1 text-xs text-slate-600 transition hover:border-brand-400 dark:border-white/10 dark:text-slate-300"
              data-testid="prn-log-1h"
            >
              1h ago
            </button>
            <span className="mx-1 text-slate-300 dark:text-slate-600">|</span>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="rounded-md border border-black/10 bg-transparent px-2 py-1 text-xs dark:border-white/10"
              aria-label="Custom time today"
              data-testid="prn-log-time"
            />
            <button
              type="button"
              onClick={() => time && log("custom", time)}
              disabled={busy || !time}
              className="flex items-center gap-1 rounded-full border border-brand-600 px-2.5 py-1 text-xs text-brand-600 transition hover:bg-brand-50 disabled:opacity-40 dark:text-brand-400 dark:hover:bg-brand-950"
              data-testid="prn-log-custom"
            >
              <IconCheck className="h-3.5 w-3.5" stroke={2.5} />
              <span>Log at</span>
            </button>
          </div>
        ) : null
      }
    />
  );
}
