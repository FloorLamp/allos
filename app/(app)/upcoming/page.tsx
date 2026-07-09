import Link from "next/link";
import {
  IconPill,
  IconRefresh,
  IconStethoscope,
  IconVaccine,
  IconChartLine,
  IconTarget,
  IconBarbell,
  IconDotsVertical,
  IconClock,
  IconEyeOff,
  IconArrowBackUp,
  type TablerIcon,
} from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { collectUpcoming, collectSuppressedUpcoming } from "@/lib/queries";
import {
  groupUpcoming,
  upcomingDueText,
  type UpcomingDomain,
  type UrgencyBand,
  type UpcomingItem,
} from "@/lib/upcoming";
import { PageHeader, EmptyState } from "@/components/ui";
import SubmitButton from "@/components/SubmitButton";
import { markTaken, snoozeItem, dismissItem, restoreItem } from "./actions";

// Quick-snooze options offered in each item's menu.
const SNOOZE_OPTIONS: { label: string; days: number }[] = [
  { label: "1 day", days: 1 },
  { label: "1 week", days: 7 },
  { label: "1 month", days: 30 },
];

export const dynamic = "force-dynamic";

// Domain → icon for the leading glyph on each row.
const DOMAIN_ICON: Record<UpcomingDomain, TablerIcon> = {
  dose: IconPill,
  refill: IconRefresh,
  appointment: IconStethoscope,
  immunization: IconVaccine,
  biomarker: IconChartLine,
  goal: IconTarget,
  training: IconBarbell,
};

// Urgency band → accent tone for the band heading + the overdue-date text.
const BAND_TONE: Record<UrgencyBand, string> = {
  overdue: "text-rose-600 dark:text-rose-400",
  today: "text-brand-700 dark:text-brand-400",
  week: "text-amber-600 dark:text-amber-400",
  later: "text-slate-500 dark:text-slate-400",
};

export default function UpcomingPage() {
  const { profile } = requireSession();
  const now = today(profile.id);
  const items = collectUpcoming(profile.id, now);
  const groups = groupUpcoming(items, now);
  const suppressed = collectSuppressedUpcoming(profile.id, now);

  return (
    <div>
      <PageHeader
        title="Upcoming"
        subtitle="Everything due soon — doses, refills, appointments, vaccines, retests, goals, and training — in one forward-looking list."
      />

      {groups.length === 0 ? (
        <EmptyState message="Nothing due. You're all caught up." />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.band}>
              <h2
                className={`mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide ${BAND_TONE[group.band]}`}
              >
                {group.label}
                <span className="text-slate-400 dark:text-slate-500">
                  ({group.items.length})
                </span>
              </h2>
              <div className="card space-y-1 p-2">
                {group.items.map((item) => (
                  <Row
                    key={item.key}
                    item={item}
                    now={now}
                    tone={BAND_TONE[group.band]}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {suppressed.length > 0 && <SuppressedSection items={suppressed} />}
    </div>
  );
}

// The collapsed "Snoozed & dismissed" section: items the user has deferred or
// silenced, each with a Restore that removes its suppression so it reappears.
function SuppressedSection({
  items,
}: {
  items: {
    item: UpcomingItem;
    signalKey: string;
    snoozeUntil: string | null;
    dismissedAt: string | null;
  }[];
}) {
  return (
    <details className="mt-8">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Snoozed &amp; dismissed{" "}
        <span className="text-slate-400 dark:text-slate-500">
          ({items.length})
        </span>
      </summary>
      <div className="card mt-2 space-y-1 p-2">
        {items.map(({ item, signalKey, snoozeUntil }) => {
          const Icon = DOMAIN_ICON[item.domain];
          return (
            <div
              key={signalKey}
              className="flex items-center gap-3 rounded-lg px-2 py-2"
            >
              <Icon
                className="h-5 w-5 shrink-0 text-slate-400 dark:text-slate-500"
                stroke={1.75}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-slate-600 dark:text-slate-300">
                  {item.title}
                </div>
                <div className="text-xs text-slate-400 dark:text-slate-500">
                  {snoozeUntil ? `Snoozed until ${snoozeUntil}` : "Dismissed"}
                </div>
              </div>
              <form action={restoreItem} className="shrink-0">
                <input type="hidden" name="signal_key" value={signalKey} />
                <SubmitButton
                  pendingLabel="…"
                  className="flex items-center gap-1 rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
                >
                  <IconArrowBackUp className="h-3.5 w-3.5" stroke={1.75} />
                  Restore
                </SubmitButton>
              </form>
            </div>
          );
        })}
      </div>
    </details>
  );
}

// Per-item snooze/dismiss menu — a native <details> popover (no client JS) with
// the quick-snooze options + a dismiss. Each control is a server-action form.
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
          <form action={snoozeItem} key={opt.days}>
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
          action={dismissItem}
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

function Row({
  item,
  now,
  tone,
}: {
  item: UpcomingItem;
  now: string;
  tone: string;
}) {
  const Icon = DOMAIN_ICON[item.domain];
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-slate-50 dark:hover:bg-ink-850">
      <Icon
        className="h-5 w-5 shrink-0 text-slate-400 dark:text-slate-500"
        stroke={1.75}
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
        <form action={markTaken} className="shrink-0">
          <input type="hidden" name="dose_id" value={item.doseId} />
          <SubmitButton
            pendingLabel="…"
            className="rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
          >
            Mark taken
          </SubmitButton>
        </form>
      )}
      <ItemMenu signalKey={item.key} />
    </div>
  );
}
