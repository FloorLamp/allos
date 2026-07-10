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
  IconDotsVertical,
  IconClock,
  IconEyeOff,
  type TablerIcon,
} from "@tabler/icons-react";
import SubmitButton from "@/components/SubmitButton";
import {
  groupAttention,
  type AttentionItem,
  type AttentionSeverity,
} from "@/lib/attention";
import {
  snoozeAttention,
  dismissAttention,
  markAttentionDose,
} from "@/app/(app)/actions";

// The Tier-1 "Needs attention" hero (issue #171). Full-width, pinned first, NOT
// hideable — a health app where a user can configure away "three doses overdue" is
// a liability, so control is item-level (snooze/dismiss the instance, never the
// category) via the same shared findings store as the Upcoming page. Renders the
// merged, severity-ordered attention model computed in lib/attention.ts (the SAME
// signals the Telegram digest and Upcoming read). Empty → a quiet "all clear",
// which is itself information.

// Domain → leading glyph. Covers every attention domain (Upcoming domains plus the
// hero-only biomarker-flag / integration / review signals).
const DOMAIN_ICON: Record<string, TablerIcon> = {
  dose: IconPill,
  refill: IconRefresh,
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

// Severity → accent tone for the due-text + section heading.
const SEVERITY_TONE: Record<AttentionSeverity, string> = {
  overdue: "text-rose-600 dark:text-rose-400",
  today: "text-brand-700 dark:text-brand-400",
  soon: "text-amber-600 dark:text-amber-400",
  info: "text-slate-500 dark:text-slate-400",
};

const SNOOZE_OPTIONS: { label: string; days: number }[] = [
  { label: "1 day", days: 1 },
  { label: "1 week", days: 7 },
  { label: "1 month", days: 30 },
];

// Per-item snooze/dismiss menu — a native <details> popover (no client JS), each
// control a server-action form keyed by the item's signal key. Only rendered for
// suppressible items (Upcoming-derived); structural signals (review/integration)
// are resolved, not snoozed.
function ItemMenu({ signalKey }: { signalKey: string }) {
  return (
    <details className="relative shrink-0">
      <summary
        aria-label="Snooze or dismiss"
        title="Snooze or dismiss"
        className="tap-target flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-ink-750 dark:hover:text-slate-300 [&::-webkit-details-marker]:hidden"
      >
        <IconDotsVertical className="h-4 w-4" stroke={1.75} />
      </summary>
      <div className="card absolute right-0 z-10 mt-1 w-40 space-y-0.5 p-1 shadow-lg">
        <div className="flex items-center gap-1 px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
          <IconClock className="h-3 w-3" stroke={1.75} />
          Snooze
        </div>
        {SNOOZE_OPTIONS.map((opt) => (
          <form action={snoozeAttention} key={opt.days}>
            <input type="hidden" name="signal_key" value={signalKey} />
            <input type="hidden" name="days" value={opt.days} />
            <button
              type="submit"
              className="w-full rounded-md px-2 py-1 text-left text-sm text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-ink-750"
            >
              {opt.label}
            </button>
          </form>
        ))}
        <form
          action={dismissAttention}
          className="border-t border-black/5 pt-0.5 dark:border-white/5"
        >
          <input type="hidden" name="signal_key" value={signalKey} />
          <button
            type="submit"
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-ink-750"
          >
            <IconEyeOff className="h-3.5 w-3.5" stroke={1.75} />
            Dismiss
          </button>
        </form>
      </div>
    </details>
  );
}

function Row({ item, tone }: { item: AttentionItem; tone: string }) {
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
      {item.dueText && (
        <div
          className={`shrink-0 whitespace-nowrap text-xs font-medium ${tone}`}
        >
          {item.dueText}
        </div>
      )}
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
      {item.suppressible && <ItemMenu signalKey={item.key} />}
    </div>
  );
}

export default function NeedsAttentionHero({
  items,
}: {
  items: AttentionItem[];
}) {
  const groups = groupAttention(items);
  const count = items.length;

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
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.severity}>
              <div
                className={`mb-1 text-xs font-semibold uppercase tracking-wide ${SEVERITY_TONE[group.severity]}`}
              >
                {group.label}
                <span className="ml-1 text-slate-400 dark:text-slate-500">
                  ({group.items.length})
                </span>
              </div>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <Row
                    key={item.key}
                    item={item}
                    tone={SEVERITY_TONE[group.severity]}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
