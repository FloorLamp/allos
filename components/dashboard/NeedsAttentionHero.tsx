import Link from "next/link";
import {
  IconPill,
  IconRefresh,
  IconStethoscope,
  IconMicroscope,
  IconVaccine,
  IconChartLine,
  IconFlask,
  IconTarget,
  IconBarbell,
  IconClipboardList,
  IconPlugConnectedX,
  IconInbox,
  IconAlertTriangle,
  IconCircleCheck,
  type TablerIcon,
} from "@tabler/icons-react";
import SubmitButton from "@/components/SubmitButton";
import SnoozeDismissMenu from "@/components/SnoozeDismissMenu";
import {
  groupAttentionForCard,
  attentionCardItems,
  attentionCountLabel,
  moreInUpcomingCount,
  type CardBand,
} from "@/lib/attention";
import {
  isItemSuppressibleFlag,
  upcomingDueText,
  type UpcomingItem,
} from "@/lib/upcoming";
import {
  snoozeAttention,
  dismissAttention,
  markAttentionDose,
} from "@/app/(app)/actions";

// The Tier-1 "Needs attention" hero (issue #171). Full-width, pinned first, NOT
// hideable — a health app where a user can configure away "three doses overdue" is
// a liability, so control is item-level (snooze/dismiss the instance, never the
// category) via the same shared findings store as the Upcoming page.
//
// It renders the ACT-NOW SUBSET of the ONE unified attention model (lib/attention.ts,
// issue #524) — overdue + due-today scheduled work plus the "something's off"
// signals (flagged labs, failing syncs, the review count) — banded as urgency
// (Urgent / Today / Needs review). The Upcoming page renders the SAME model in full
// (adding this-week / later scheduled items under a calendar framing), and the
// card's items are a strict subset of it, so the "+N more in Upcoming" number always
// reconciles. Empty → a quiet "all clear", which is itself information.

// Domain → leading glyph. Covers every attention domain (Upcoming domains plus the
// signal biomarker-flag / integration / review domains).
const DOMAIN_ICON: Record<string, TablerIcon> = {
  dose: IconPill,
  refill: IconRefresh,
  "dietary-limit": IconAlertTriangle,
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
  integration: IconPlugConnectedX,
  review: IconInbox,
};

// Card band → accent tone for the due-text + section heading.
const BAND_TONE: Record<CardBand, string> = {
  urgent: "text-rose-600 dark:text-rose-400",
  today: "text-brand-700 dark:text-brand-400",
  review: "text-amber-600 dark:text-amber-400",
};

function Row({
  item,
  now,
  tone,
}: {
  item: UpcomingItem;
  now: string;
  tone: string;
}) {
  const Icon = DOMAIN_ICON[item.domain] ?? IconAlertTriangle;
  return (
    <div
      data-testid={`attention-item-${item.key}`}
      className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-slate-50 dark:hover:bg-ink-850"
    >
      <Icon
        className={`h-5 w-5 shrink-0 ${tone}`}
        stroke={1.75}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <Link
          href={item.href}
          className="font-medium text-slate-800 hover:text-brand-700 hover:underline dark:text-slate-100 dark:hover:text-brand-400"
        >
          {item.title}
        </Link>
        {item.detail && (
          <div className="truncate text-xs text-slate-500 dark:text-slate-400">
            {item.detail}
          </div>
        )}
      </div>
      <div className={`shrink-0 whitespace-nowrap text-xs font-medium ${tone}`}>
        {upcomingDueText(item, now)}
      </div>
      {item.doseId != null && (
        <form action={markAttentionDose} className="shrink-0">
          <input type="hidden" name="dose_id" value={item.doseId} />
          <SubmitButton
            pendingLabel="…"
            className="rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
          >
            Mark taken
          </SubmitButton>
        </form>
      )}
      {/* Per-item snooze/dismiss popover — the shared OverflowMenu-based menu
      (issue #281), so it matches every other popover in the app. Only rendered
      for suppressible items (Upcoming-derived + biomarker flags); structural
      signals (review/integration) are resolved, not snoozed. */}
      {isItemSuppressibleFlag(item) && (
        <SnoozeDismissMenu
          signalKey={item.key}
          snoozeAction={snoozeAttention}
          dismissAction={dismissAttention}
        />
      )}
    </div>
  );
}

export default function NeedsAttentionHero({
  items,
  today,
}: {
  items: UpcomingItem[];
  today: string;
}) {
  const groups = groupAttentionForCard(items, today);
  // The badge / count is the CARD subset — the act-now slice, NOT the full model.
  const count = attentionCardItems(items, today).length;
  // The far-future scheduled work the card hides, waiting on the Upcoming page. A
  // strict subset guarantees this reconciles with the page's total.
  const more = moreInUpcomingCount(items, count);

  return (
    <section
      data-testid="needs-attention"
      aria-label="Needs attention"
      className="card border-l-4 border-l-brand-500 dark:border-l-brand-400"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
          <IconAlertTriangle
            className="h-5 w-5 text-brand-600 dark:text-brand-400"
            stroke={1.75}
            aria-hidden="true"
          />
          Needs attention
          {count > 0 && (
            <span
              data-testid="attention-count"
              className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-semibold text-brand-700 dark:bg-brand-500/20 dark:text-brand-300"
            >
              {count}
            </span>
          )}
        </h2>
        <Link
          href="/upcoming"
          className="text-xs text-brand-600 hover:underline dark:text-brand-400"
        >
          View all
        </Link>
      </div>

      {count === 0 ? (
        <div
          data-testid="attention-all-clear"
          className="flex items-center gap-2 py-2 text-sm text-slate-500 dark:text-slate-400"
        >
          <IconCircleCheck
            className="h-5 w-5 text-emerald-500 dark:text-emerald-400"
            stroke={1.75}
            aria-hidden="true"
          />
          All clear — nothing needs your attention right now.
          {more > 0 && (
            <Link
              href="/upcoming"
              data-testid="attention-more-upcoming"
              className="font-medium text-brand-600 hover:underline dark:text-brand-400"
            >
              {more} upcoming
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.band}>
              <div
                className={`mb-1 text-xs font-semibold uppercase tracking-wide ${BAND_TONE[group.band]}`}
              >
                {group.label}
                <span className="ml-1 text-slate-400 dark:text-slate-500">
                  ({attentionCountLabel(group.items.length, group.overflow)})
                </span>
              </div>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <Row
                    key={item.key}
                    item={item}
                    now={today}
                    tone={BAND_TONE[group.band]}
                  />
                ))}
                {/* Defensive per-band cap (issue #283): a pathological day (a giant
                flagged import, an overdue backlog) collapses to a link instead of
                blowing the layout. */}
                {group.overflow > 0 && (
                  <Link
                    href="/upcoming"
                    data-testid={`attention-overflow-${group.band}`}
                    className="block rounded-lg px-2 py-1.5 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
                  >
                    +{group.overflow} more in Upcoming
                  </Link>
                )}
              </div>
            </div>
          ))}
          {/* The card is a strict subset of the Upcoming page; the far-future
          scheduled work it hides is one click away, with an exact count so the two
          surfaces reconcile (issue #524). */}
          {more > 0 && (
            <Link
              href="/upcoming"
              data-testid="attention-more-upcoming"
              className="block text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
            >
              +{more} more in Upcoming
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
