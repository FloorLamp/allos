import Link from "next/link";
import {
  IconPill,
  IconRefresh,
  IconAlertTriangle,
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
  IconArrowBackUp,
  IconInfoCircle,
  IconCalendarPlus,
  IconCalendarCheck,
  type TablerIcon,
} from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  collectAttentionModel,
  collectSuppressedAttention,
} from "@/lib/queries";
import { getUserBirthdate, getStoredAge } from "@/lib/settings";
import { groupAttentionForPage, type PageGroupKind } from "@/lib/attention";
import {
  isItemSuppressibleFlag,
  upcomingDueText,
  type UpcomingDomain,
  type UpcomingItem,
} from "@/lib/upcoming";
import { PageHeader, EmptyState } from "@/components/ui";
import SubmitButton from "@/components/SubmitButton";
import SnoozeDismissMenu from "@/components/SnoozeDismissMenu";
import PreventiveOverrideMenu from "./PreventiveOverrideMenu";
import {
  markTaken,
  snoozeItem,
  dismissItem,
  restoreItem,
  markPreventiveDone,
  markCarePlanDone,
} from "./actions";

export const dynamic = "force-dynamic";

// Domain → icon for the leading glyph on each row. Covers the date-scheduled
// domains plus the unified model's "something's off" signals (issue #524).
const DOMAIN_ICON: Record<UpcomingDomain, TablerIcon> = {
  dose: IconPill,
  refill: IconRefresh,
  "dietary-limit": IconAlertTriangle,
  interaction: IconAlertTriangle,
  appointment: IconStethoscope,
  visit: IconStethoscope,
  screening: IconMicroscope,
  immunization: IconVaccine,
  biomarker: IconChartLine,
  goal: IconTarget,
  training: IconBarbell,
  careplan: IconClipboardList,
  "biomarker-flag": IconFlask,
  integration: IconPlugConnectedX,
  review: IconInbox,
};

// Page group → accent tone for the group heading + the due-text. The date bands
// carry their urgency tone; the two signal groupings (Flagged / For review) get an
// alerting amber (issue #524).
const GROUP_TONE: Record<PageGroupKind, string> = {
  overdue: "text-rose-600 dark:text-rose-400",
  today: "text-brand-700 dark:text-brand-400",
  week: "text-amber-600 dark:text-amber-400",
  later: "text-slate-500 dark:text-slate-400",
  flagged: "text-amber-600 dark:text-amber-400",
  review: "text-amber-600 dark:text-amber-400",
};

export default async function UpcomingPage() {
  const { profile } = await requireSession();
  const now = today(profile.id);
  // The ONE unified attention model (issue #524) — the SAME set the dashboard card
  // renders (as an act-now subset). The page shows it in FULL: date-scheduled work
  // in calendar bands, plus the flagged-lab / failing-sync / review signals under
  // their own groupings. Completeness is the point of the planning view.
  const items = collectAttentionModel(profile.id, now);
  const groups = groupAttentionForPage(items, now);
  const total = items.length;
  const suppressed = collectSuppressedAttention(profile.id, now);

  // Preventive well-visits/screenings (issue #82) are only assessed when the
  // profile's age is known; without a birthdate/age they emit nothing. Surface a
  // one-time pointer instead of silence, and a general-guidelines disclaimer
  // whenever any preventive item is shown.
  const hasDemographics =
    getUserBirthdate(profile.id) != null || getStoredAge(profile.id) != null;
  const hasPreventive = items.some(
    (i) => i.domain === "visit" || i.domain === "screening"
  );

  return (
    <div>
      <PageHeader
        title="Upcoming"
        subtitle="Everything due soon — doses, refills, appointments, planned care, preventive visits & screenings, vaccines, retests, goals, and training — in one forward-looking list."
        action={
          total > 0 ? (
            <span
              data-testid="upcoming-total"
              className="shrink-0 rounded-full bg-brand-100 px-3 py-1 text-sm font-semibold text-brand-700 dark:bg-brand-500/20 dark:text-brand-300"
            >
              {total} total
            </span>
          ) : undefined
        }
      />

      {!hasDemographics && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-brand-200 bg-brand-50 p-3 text-sm text-brand-800 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-200">
          <IconInfoCircle className="mt-0.5 h-5 w-5 shrink-0" stroke={1.75} />
          <div>
            Add a birthdate to enable preventive visit &amp; screening
            reminders.{" "}
            <Link
              href="/settings/profile"
              className="font-medium underline hover:no-underline"
            >
              Set it in Profile settings
            </Link>
            .
          </div>
        </div>
      )}

      {groups.length === 0 ? (
        <EmptyState message="Nothing due. You're all caught up." />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            // id={group.kind} is the deep-link anchor the dashboard card's per-band
            // "+N more" overflow links target (e.g. /upcoming#overdue) — issue #538.
            <section key={group.kind} id={group.kind}>
              <h2
                className={`mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide ${GROUP_TONE[group.kind]}`}
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
                    tone={GROUP_TONE[group.kind]}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {suppressed.length > 0 && <SuppressedSection items={suppressed} />}

      {hasPreventive && (
        <p className="mt-8 flex items-start gap-2 text-xs text-slate-400 dark:text-slate-500">
          <IconInfoCircle
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            stroke={1.75}
          />
          <span>
            Preventive visit &amp; screening suggestions are based on general
            guidelines and are informational only — your provider&apos;s advice
            wins.
          </span>
        </p>
      )}
    </div>
  );
}

// Inline controls for a due preventive visit/screening row (issue #82): a fast
// "Mark done" (records a satisfaction dated today, like a dose "mark taken") plus
// an override menu to mark the rule Declined or Not applicable — either hides it.
// The override menu is the shared OverflowMenu-based popover (issue #281).
function PreventiveControls({ ruleKey }: { ruleKey: string }) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <form
        action={async (fd) => {
          "use server";
          await markPreventiveDone(fd);
        }}
      >
        <input type="hidden" name="rule_key" value={ruleKey} />
        <SubmitButton
          pendingLabel="…"
          className="rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
        >
          Mark done
        </SubmitButton>
      </form>
      <PreventiveOverrideMenu ruleKey={ruleKey} />
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
              <form
                action={async (fd) => {
                  "use server";
                  await restoreItem(fd);
                }}
                className="shrink-0"
              >
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
    <div
      data-testid={`upcoming-item-${item.key}`}
      className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-slate-50 dark:hover:bg-ink-850"
    >
      <Icon
        className="h-5 w-5 shrink-0 text-slate-400 dark:text-slate-500"
        stroke={1.75}
      />
      <div className="min-w-0 flex-1">
        <Link
          href={item.href}
          className="block truncate font-medium text-slate-800 hover:text-brand-700 hover:underline dark:text-slate-100 dark:hover:text-brand-400"
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
        <form
          action={async (fd) => {
            "use server";
            await markTaken(fd);
          }}
          className="shrink-0"
        >
          <input type="hidden" name="dose_id" value={item.doseId} />
          <SubmitButton
            pendingLabel="…"
            className="rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
          >
            Mark taken
          </SubmitButton>
        </form>
      )}
      {item.scheduled && (
        <span
          data-testid="scheduled-badge"
          className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-emerald-200 px-2 py-1 text-xs font-medium text-emerald-700 dark:border-emerald-900 dark:text-emerald-400"
        >
          <IconCalendarCheck className="h-3.5 w-3.5" stroke={1.75} />
          Scheduled
        </span>
      )}
      {item.bookHref && (
        <Link
          href={item.bookHref}
          className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
        >
          <IconCalendarPlus className="h-3.5 w-3.5" stroke={1.75} />
          Book
        </Link>
      )}
      {item.preventiveRuleKey != null && (
        <PreventiveControls ruleKey={item.preventiveRuleKey} />
      )}
      {item.carePlanItemId != null && (
        <form
          action={async (fd) => {
            "use server";
            await markCarePlanDone(fd);
          }}
          className="shrink-0"
        >
          <input
            type="hidden"
            name="care_plan_item_id"
            value={item.carePlanItemId}
          />
          <SubmitButton
            pendingLabel="…"
            className="rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
          >
            Mark done
          </SubmitButton>
        </form>
      )}
      {/* Per-item snooze/dismiss popover — the shared OverflowMenu-based menu
      (issue #281), identical to the dashboard hero's. Only suppressible items get
      one; the structural signals (failing sync / review count) are resolved, not
      snoozed (issue #524). */}
      {isItemSuppressibleFlag(item) && (
        <SnoozeDismissMenu
          signalKey={item.key}
          snoozeAction={async (fd) => {
            "use server";
            await snoozeItem(fd);
          }}
          dismissAction={async (fd) => {
            "use server";
            await dismissItem(fd);
          }}
        />
      )}
    </div>
  );
}
