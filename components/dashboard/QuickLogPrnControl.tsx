"use client";

import { useState } from "react";
import { IconClock, IconCheck } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import TodayMedRow from "@/components/medications/TodayMedRow";
import WhenControl, { type WhenValue } from "@/components/WhenControl";
import { useTimezone } from "@/components/TimezoneProvider";
import {
  DOSE_ACTION_BRAND,
  DOSE_ACTION_ICON,
  DOSE_ACTION_LABEL,
  DOSE_ACTION_NEUTRAL,
} from "@/components/medications/dose-action-styles";
import { medicationHref } from "@/lib/hrefs";
import { formatMedicationDoseProduct } from "@/lib/medication-dose-format";
import { logMedicationAdministration } from "@/app/(app)/medications/actions";
import { dateStrInTz } from "@/lib/date";
import { statedHhmm } from "@/lib/stated-time";

// One PRN (as-needed) medication's quick-log row in the dashboard widget (#797).
// A primary "Taken now" button records an administration NOW; "Earlier dose" reveals
// the shared WhenControl (#2236) — an absolute time today, empty until stated, with
// a one-tap "Now" — the retro-entry home ("gave it at 4pm, logging it now"). The
// old relative chips (30 min / 1 hr ago) are gone: a relative offset is computed at
// TAP time, so it drifts with every minute a rendered page sits open, which is the
// argument lib/correction-time.ts already made and this dashboard control never saw
// — the failure #2236 exists to end. Each successful log is a real administration
// (the ledger allows multiples/day), and the action's own revalidate brings back the
// updated "N today · last …" subtitle with its response.
//
// A PRN dose is ADDITIVE and declares no expected interval (#2007): several
// administrations a day are legitimate and #798's redose line already advises without
// blocking, so this NEVER confirms. It does take layer 1 — the shared ledger's
// post-success cooldown, keyed per offset so "taken now" and a retro entry are separate
// writes — which absorbs the queued second click on the same button.
export default function QuickLogPrnControl({
  itemId,
  name,
  doseAmount,
  product,
  dayLabel,
  redoseLine = null,
  redosePrimary = true,
  linkToDetail = false,
  profileId,
  rowVariant = "inset",
  layout = "row",
  compactActions = false,
  tz: tzProp,
}: {
  itemId: number;
  name: string;
  doseAmount?: string | null;
  product?: string | null;
  dayLabel: string;
  // The redose-window status line (#798), or null when the med has no confirmed
  // interval/max. Informational — window state + running count, never permissive.
  redoseLine?: string | null;
  redosePrimary?: boolean;
  // The name links to the med's detail page (#852 item 2), matching the scheduled row.
  // Both hosts — the Medications Today panel (#851 item 10) and the dashboard quick-log
  // widget — pass this now; it stays a prop only so a future non-linking host can opt out.
  linkToDetail?: boolean;
  // The profile this dose is logged for (issue #858). Set on the illness-hero cockpit so
  // a caregiver logs a household member's PRN dose without switching — the action gates on
  // the TARGET (requireProfileWriteAccess). Absent on the dashboard/medications mounts.
  profileId?: number;
  rowVariant?: "inset" | "embedded";
  // The medication detail card already establishes the medication identity and dose.
  // Its Today block needs only status + actions; list/dashboard hosts keep the full row.
  layout?: "row" | "detail";
  compactActions?: boolean;
  // The TARGET profile's timezone, for hosts that log another profile's dose (#858)
  // — the shared WhenControl's day/time must be that profile's, not the viewer's.
  // Defaults to the app-wide TimezoneProvider (the acting profile).
  tz?: string;
}) {
  const contextTz = useTimezone();
  const tz = tzProp ?? contextTz;
  const [open, setOpen] = useState(false);
  // The earlier-dose pair (#2236): the day is fixed to today (the action resolves
  // the wall time against the profile's today), the time starts UNSTATED — the
  // control never defaults it to now.
  const [when, setWhen] = useState<WhenValue>(() => ({
    date: dateStrInTz(tz),
    statedAt: null,
  }));
  const toast = useToast();
  const ledger = useOptimisticLedger("prn-dose");
  const busy = ledger.pending("now") || ledger.pending("custom");
  const doseDetail = formatMedicationDoseProduct(doseAmount, product);

  async function log(offset: string, customTime?: string) {
    await ledger.tap({
      key: offset,
      write: () => {
        const fd = new FormData();
        fd.set("id", String(itemId));
        fd.set("offset", offset);
        if (customTime) fd.set("time", customTime);
        if (profileId != null) fd.set("profileId", String(profileId));
        return logMedicationAdministration(fd);
      },
      settle: (res) => {
        if (!res.ok) {
          toast(res.error, { tone: "error" });
          // Nothing was administered, so a retry needs no cooldown.
          return { kind: "rollback" };
        }
        toast(
          res.outcome === "duplicate"
            ? offset === "now"
              ? `${name} was already logged just now.`
              : `${name} already has a dose logged at about that time.`
            : `Logged ${name}${doseDetail ? ` · ${doseDetail}` : ""}.`
        );
        setOpen(false);
        setWhen({ date: dateStrInTz(tz), statedAt: null });
        return { kind: "keep" };
      },
      onError: () => {
        toast("Couldn't log that dose. Try again.", { tone: "error" });
        return { kind: "rollback" };
      },
    });
  }

  const control = (
    <>
      <button
        type="button"
        onClick={() => log("now")}
        disabled={busy}
        className={`${compactActions ? DOSE_ACTION_ICON : DOSE_ACTION_LABEL} ${redosePrimary ? DOSE_ACTION_BRAND : DOSE_ACTION_NEUTRAL}`}
        aria-label="Taken now"
        title="Taken now"
        data-testid="prn-log-now"
      >
        <IconCheck className="h-3.5 w-3.5" stroke={2.5} />
        <span className={compactActions ? "sr-only" : undefined}>
          Taken now
        </span>
      </button>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className={`${compactActions ? DOSE_ACTION_ICON : DOSE_ACTION_LABEL} ${DOSE_ACTION_NEUTRAL}`}
        aria-expanded={open}
        aria-label="Earlier dose"
        title="Earlier dose"
        data-testid="prn-log-more"
      >
        <IconClock className="h-4 w-4" stroke={2} />
        <span className={compactActions ? "sr-only" : undefined}>
          Earlier dose
        </span>
      </button>
    </>
  );

  const sublines = (
    <div className="mt-0.5 min-w-0">
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

  // The saved value is the pair's local wall time, resolved back to an instant
  // SERVER-side against the profile's today (the same reason the food bar submits
  // a choice rather than a client timestamp): the control's fixed day IS today.
  const savedHhmm = statedHhmm(when.statedAt, tz);
  const options = open ? (
    <div data-testid="prn-log-options">
      <p className="mb-2 text-xs font-medium text-slate-600 dark:text-slate-300">
        When was it taken?
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <WhenControl
          mode="state"
          grain="minute"
          value={when}
          onChange={setWhen}
          tz={tz}
          timeRequired
          minDate={when.date}
          maxDate={when.date}
          timeLabel="Specific time today"
          disabled={busy}
          testId="prn-log-when"
        />
        <button
          type="button"
          onClick={() => savedHhmm && log("custom", savedHhmm)}
          disabled={busy || !savedHhmm}
          className="btn btn-sm"
          data-testid="prn-log-custom"
        >
          <IconCheck className="h-3.5 w-3.5" stroke={2.5} />
          <span>Save dose</span>
        </button>
      </div>
    </div>
  ) : null;

  if (layout === "detail") {
    return (
      <div data-testid="quick-log-prn-item" data-item-id={itemId}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="section-label">Today</div>
            <div
              className="mt-1 text-sm font-medium text-slate-700 dark:text-slate-200"
              data-testid="prn-day-label"
            >
              {dayLabel}
            </div>
            {redoseLine ? (
              <div
                className="mt-0.5 text-xs text-slate-500 dark:text-slate-400"
                data-testid="prn-redose-line"
              >
                {redoseLine}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {control}
          </div>
        </div>
        {options ? (
          <div className="mt-3 border-t border-black/5 pt-3 dark:border-white/5">
            {options}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <TodayMedRow
      testId="quick-log-prn-item"
      itemId={itemId}
      variant={rowVariant}
      name={name}
      detail={doseDetail}
      href={linkToDetail ? medicationHref(itemId) : undefined}
      control={control}
      sublines={sublines}
      footer={
        options ? (
          <div className="border-t border-black/5 pt-2 pl-6 dark:border-white/5">
            {options}
          </div>
        ) : null
      }
    />
  );
}
