import Link from "next/link";
import {
  IconAlertTriangle,
  IconBarbell,
  IconChartLine,
  IconClipboardList,
  IconClipboardPlus,
  IconFlask,
  IconInbox,
  IconMicroscope,
  IconPill,
  IconPlugConnectedX,
  IconRefresh,
  IconStethoscope,
  IconTarget,
  IconTemperature,
  IconVaccine,
  type TablerIcon,
} from "@tabler/icons-react";
import DoseConfirmButton from "@/components/DoseConfirmButton";
import SnoozeDismissMenu from "@/components/SnoozeDismissMenu";
import FollowUpResolveControls from "@/components/FollowUpResolveControls";
import { resolveFollowUp } from "@/app/(app)/upcoming/actions";
import {
  attentionEmphasisBandForItem,
  type AttentionEmphasisBand,
} from "@/lib/attention";
import {
  isItemSuppressibleFlag,
  upcomingDueText,
  type UpcomingItem,
} from "@/lib/upcoming";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import {
  snoozeAttention,
  dismissAttention,
  markAttentionDose,
  undoAttentionDose,
} from "@/app/(app)/actions";

const DOMAIN_ICON: Record<string, TablerIcon> = {
  dose: IconPill,
  "prn-max": IconPill,
  refill: IconRefresh,
  "dietary-limit": IconAlertTriangle,
  "food-drug-event": IconAlertTriangle,
  "illness-care": IconTemperature,
  "condition-review": IconClipboardPlus,
  "mental-health": IconStethoscope,
  interaction: IconAlertTriangle,
  appointment: IconStethoscope,
  visit: IconStethoscope,
  screening: IconMicroscope,
  immunization: IconVaccine,
  biomarker: IconChartLine,
  "biomarker-flag": IconFlask,
  goal: IconTarget,
  training: IconBarbell,
  careplan: IconClipboardList,
  followup: IconStethoscope,
  integration: IconPlugConnectedX,
  review: IconInbox,
};

const BAND_TONE: Record<AttentionEmphasisBand, string> = {
  urgent: "text-rose-600 dark:text-rose-400",
  today: "text-brand-700 dark:text-brand-400",
  review: "text-amber-600 dark:text-amber-400",
};

function AttentionRow({
  item,
  today,
  tone,
  formatPrefs,
  canWrite,
}: {
  item: UpcomingItem;
  today: string;
  tone: string;
  formatPrefs: DisplayFormatPrefs;
  canWrite: boolean;
}) {
  const Icon = DOMAIN_ICON[item.domain] ?? IconAlertTriangle;
  return (
    <div
      data-testid={`attention-item-${item.key}`}
      // ONE GUTTER ON A PHONE (#3460). The `px-2 py-2` inset exists to give the
      // hover fill room to breathe — a DESKTOP affordance — while the card this row
      // sits in already pads itself (`p-4`, #1416 section A). Below `sm` that is a
      // double gutter on a 390px line, so the inset starts at `sm:` and the card's
      // own padding is the only one.
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 rounded-lg transition hover:bg-slate-50 sm:flex sm:flex-nowrap sm:items-center sm:px-2 sm:py-2 dark:hover:bg-ink-850"
    >
      <Icon
        className={`h-5 w-5 shrink-0 ${tone}`}
        stroke={1.75}
        aria-hidden="true"
      />
      {/* TITLE AND DETAIL SHARE A LINE ON A PHONE (#3460) — "Vitamin D3 · 2000 IU"
        rather than a two-line block spending 40px on two short facts. They still
        WRAP when the text needs it (flex-wrap, not truncation: a phone may never be
        the viewport that hides a fact). From `sm` up the stacked desktop block is
        exactly what it was, `lg:truncate` included. */}
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 sm:block">
        <Link
          href={item.href}
          className="wrap-break-word font-medium text-slate-800 hover:text-brand-700 hover:underline sm:block lg:truncate dark:text-slate-100 dark:hover:text-brand-400"
        >
          {item.title}
        </Link>
        {item.detail && (
          <>
            {/* The separator belongs to the one-line form only, and it is a MARK,
              not a word: the reading order is unchanged for anyone who hears the
              row rather than sees it. */}
            <span
              aria-hidden="true"
              className="text-xs text-slate-400 sm:hidden"
            >
              ·
            </span>
            <div
              data-testid="attention-item-detail"
              className="wrap-break-word text-xs whitespace-normal text-slate-500 sm:block lg:truncate dark:text-slate-400"
            >
              {item.detail}
            </div>
          </>
        )}
      </div>
      <div
        data-testid="attention-item-actions"
        className="col-span-2 flex min-w-0 items-center justify-between gap-2 pl-8 sm:ml-0 sm:w-auto sm:justify-end sm:pl-0"
      >
        <div
          className={`min-w-0 flex-1 text-xs font-medium sm:flex-none sm:shrink-0 sm:whitespace-nowrap ${tone}`}
        >
          {upcomingDueText(item, today, formatPrefs)}
        </div>
        {canWrite && item.doseId != null && (
          <DoseConfirmButton
            action={markAttentionDose}
            undoAction={undoAttentionDose}
            fields={{ dose_id: item.doseId }}
            testid="attention-mark-taken"
            className="rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
          >
            Mark taken
          </DoseConfirmButton>
        )}
        {canWrite &&
          item.doseId == null &&
          item.followUpResolve == null &&
          item.actionLabel && (
            <Link
              href={item.href}
              className="shrink-0 rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
            >
              {item.actionLabel}
            </Link>
          )}
        {canWrite && item.followUpResolve != null && (
          <FollowUpResolveControls
            action={async (fd) => {
              "use server";
              await resolveFollowUp(fd);
            }}
            carePlanItemId={item.followUpResolve.carePlanItemId}
            resolvingRecordId={item.followUpResolve.resolvingRecordId}
          />
        )}
        {canWrite && isItemSuppressibleFlag(item) && (
          <SnoozeDismissMenu
            itemName={item.title}
            signalKey={item.key}
            snoozeOnly={item.carePersistent === true}
            snoozeAction={snoozeAttention}
            dismissAction={dismissAttention}
          />
        )}
      </div>
    </div>
  );
}

// The write-capable rendering of one atomic attention candidate. Ahead never mounts
// this component; it receives a separate read-only presentation.
export default function DashboardAttentionAtom({
  item,
  today,
  formatPrefs,
  canWrite,
}: {
  item: UpcomingItem;
  today: string;
  formatPrefs: DisplayFormatPrefs;
  canWrite: boolean;
}) {
  const band = attentionEmphasisBandForItem(item, today);
  return (
    <article className="card" data-testid="dashboard-attention-atom">
      <AttentionRow
        item={item}
        today={today}
        tone={band ? BAND_TONE[band] : "text-slate-600 dark:text-slate-300"}
        formatPrefs={formatPrefs}
        canWrite={canWrite}
      />
    </article>
  );
}
