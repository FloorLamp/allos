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
  IconTemperature,
  IconClipboardPlus,
  IconCircleCheck,
  type TablerIcon,
} from "@tabler/icons-react";
import SubmitButton from "@/components/SubmitButton";
import SnoozeDismissMenu from "@/components/SnoozeDismissMenu";
import FollowUpResolveControls from "@/components/FollowUpResolveControls";
import { resolveFollowUp } from "@/app/(app)/upcoming/actions";
import {
  groupAttentionForCard,
  attentionCardItems,
  attentionCountLabel,
  attentionHeroState,
  attentionSetupItems,
  moreInUpcomingCount,
  planAttentionMoreLinks,
  SETUP_GROUP_LABEL,
  type CardBand,
} from "@/lib/attention";
import AttentionHeroCard from "@/components/dashboard/AttentionHeroCard";
import AppBadge from "@/components/AppBadge";
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
  "prn-max": IconPill,
  refill: IconRefresh,
  "dietary-limit": IconAlertTriangle,
  "food-drug-event": IconAlertTriangle,
  "illness-care": IconTemperature,
  "condition-review": IconClipboardPlus,
  // A calm, medical icon for the mental-health crisis check-in (#716).
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
      className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg px-2 py-2 transition hover:bg-slate-50 sm:flex-nowrap sm:items-center dark:hover:bg-ink-850"
    >
      <Icon
        className={`h-5 w-5 shrink-0 ${tone}`}
        stroke={1.75}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <Link
          href={item.href}
          className="block break-words font-medium text-slate-800 hover:text-brand-700 hover:underline lg:truncate dark:text-slate-100 dark:hover:text-brand-400"
        >
          {item.title}
        </Link>
        {item.detail && (
          <div
            data-testid="attention-item-detail"
            className="break-words text-xs whitespace-normal text-slate-500 lg:truncate dark:text-slate-400"
          >
            {item.detail}
          </div>
        )}
      </div>
      <div
        data-testid="attention-item-actions"
        className="ml-8 flex w-[calc(100%-2rem)] items-center justify-between gap-2 sm:ml-0 sm:w-auto sm:justify-end"
      >
        <div
          className={`shrink-0 whitespace-nowrap text-xs font-medium ${tone}`}
        >
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
        {item.doseId == null &&
          item.followUpResolve == null &&
          item.actionLabel && (
            <Link
              href={item.href}
              className="shrink-0 rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
            >
              {item.actionLabel}
            </Link>
          )}
        {/* Finding follow-up resolution offer (issue #700): confirm-first outcome
        buttons, identical to the Upcoming page's. */}
        {item.followUpResolve != null && (
          <FollowUpResolveControls
            action={async (fd) => {
              "use server";
              await resolveFollowUp(fd);
            }}
            carePlanItemId={item.followUpResolve.carePlanItemId}
            resolvingRecordId={item.followUpResolve.resolvingRecordId}
          />
        )}
        {/* Per-item snooze/dismiss popover — the shared OverflowMenu-based menu
        (issue #281), so it matches every other popover in the app. Only rendered
        for suppressible items (Upcoming-derived + biomarker flags); structural
        signals (review/integration) are resolved, not snoozed. A care-persistent
        overdue follow-up (#700) gets a snooze-ONLY menu (resists dismiss). */}
        {isItemSuppressibleFlag(item) && (
          <SnoozeDismissMenu
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

// The COLLAPSED cold-start line (issue #1433). A preventive rule with nothing on
// record is not overdue — it is unknown — so on a brand-new profile the hero used to
// open with a dozen red "Overdue — none on record" rows about a person it had known
// for thirty seconds. That is manufactured obligation: it buries the day-one
// onboarding content, and it teaches the reader that the red rows on this card do not
// mean anything.
//
// The replacement is ONE line, closed by default, that states the count and opens to
// the same rows with the same deep links. It sits BELOW the card and outside its
// bands and count (cardBandForItem excludes these), so it can never present as
// attention — and it renders on the all-clear branch too, because a fresh profile's
// hero is exactly the case with zero real items and a full setup list.
function SetupDisclosure({
  items,
  now,
}: {
  items: UpcomingItem[];
  now: string;
}) {
  if (items.length === 0) return null;
  return (
    <details className="mt-3" data-testid="attention-setup">
      <summary className="cursor-pointer text-xs font-medium text-slate-600 hover:text-brand-700 dark:text-slate-300 dark:hover:text-brand-400">
        {SETUP_GROUP_LABEL}{" "}
        <span
          data-testid="attention-setup-count"
          className="text-slate-500 dark:text-slate-400"
        >
          ({items.length})
        </span>
      </summary>
      <div className="mt-2 space-y-0.5">
        {items.map((item) => {
          const Icon = DOMAIN_ICON[item.domain] ?? IconClipboardPlus;
          return (
            <Link
              key={item.key}
              href={item.href}
              data-testid={`attention-setup-item-${item.key}`}
              className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-ink-850"
            >
              <Icon
                className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400"
                stroke={1.75}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">
                {item.title}
              </span>
              <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                {upcomingDueText(item, now)}
              </span>
            </Link>
          );
        })}
      </div>
    </details>
  );
}

export default function NeedsAttentionHero({
  items,
  today,
  preferCollapsed,
  saveCollapsed,
}: {
  items: UpcomingItem[];
  today: string;
  // The VIEWER's stored collapse preference (issue #1413, per-login). Only ever a
  // request: attentionHeroState ignores it for a safety-locked or empty hero.
  preferCollapsed: boolean;
  saveCollapsed: (collapsed: boolean) => Promise<void>;
}) {
  const groups = groupAttentionForCard(items, today);
  // The badge / count is the CARD subset — the act-now slice, NOT the full model.
  const count = attentionCardItems(items, today).length;
  // The resolved collapse decision (#1413 section B). Computed in lib/attention so
  // the #449 contract — count always visible, safety items never compacted — is
  // pinned by unit tests rather than by what this JSX happens to render.
  const heroState = attentionHeroState(items, today, preferCollapsed);
  // The far-future scheduled work the card hides, waiting on the Upcoming page. A
  // strict subset guarantees this reconciles with the page's total.
  const more = moreInUpcomingCount(items, count);
  // "+N more" link copy that names each link's referent and merges the last-band
  // overflow with the card remainder when they'd otherwise stack (issue #538).
  const moreLinks = planAttentionMoreLinks(groups, more);
  // The never-recorded preventive rules (#1433) — present, counted, and calm. Not
  // part of `count`, `more`, the badge, or any band.
  const setupItems = attentionSetupItems(items);

  if (count === 0) {
    return (
      <>
        <section
          data-testid="needs-attention"
          aria-label="Needs attention"
          className="card flex flex-wrap items-center justify-between gap-2 border-l-4 border-l-emerald-500 py-3 dark:border-l-emerald-400"
        >
          {/* Clears the installed-PWA icon badge (#1424). Mounting it on THIS
            branch too is the point: the card below isn't rendered at count 0, so
            a badge set on a previous visit would otherwise never come off. */}
          <AppBadge count={count} />
          <div
            data-testid="attention-all-clear"
            className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300"
          >
            <IconCircleCheck
              className="h-5 w-5 text-emerald-500 dark:text-emerald-400"
              stroke={1.75}
              aria-hidden="true"
            />
            <span className="font-medium">All clear</span>
            <span className="hidden text-slate-500 sm:inline dark:text-slate-400">
              Nothing needs your attention right now.
            </span>
          </div>
          <Link
            href="/upcoming"
            data-testid={more > 0 ? "attention-more-upcoming" : undefined}
            className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            {more > 0 ? `${more} scheduled later` : "View upcoming"}
          </Link>
        </section>
        <SetupDisclosure items={setupItems} now={today} />
      </>
    );
  }

  // The card chrome (section, heading, count badge, collapse toggle) is owned by the
  // client shell — the collapse state drives the heading as well as the body, and the
  // #449 always-visible count lives there. Everything below is the BODY: the item
  // rows, which keep their inline Server Action forms and stay server-rendered.
  return (
    <>
      {/* Same count the card's own badge shows, painted on the installed app
          icon (#1424) — one number, two surfaces, no second query. A SIBLING of
          the card, not a child: the card's body sits inside a <Collapse>, and a
          badge that stopped updating whenever the user collapsed the hero would
          be a silent, viewport-shaped bug. */}
      <AppBadge count={count} />
      <AttentionHeroCard
        count={count}
        topBand={heroState.topBand}
        locked={heroState.locked}
        initialCollapsed={heroState.collapsed}
        saveCollapsed={saveCollapsed}
      >
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.band}>
              <div className={`mb-1 section-label ${BAND_TONE[group.band]}`}>
                {group.label}
                <span className="ml-1 text-slate-500 dark:text-slate-400">
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
                {/* Defensive global cap (issue #283): a pathological day (a giant
                flagged import, an overdue backlog) collapses each band's remainder
                to a link instead of blowing the layout. The copy names THIS band's items so it can't be
                mistaken for the card-level remainder below (issue #538); when this
                is the last band and a remainder follows, the link is merged into the
                trailing line instead (planAttentionMoreLinks), so two never stack. */}
                {moreLinks.perBand[group.band] && (
                  <Link
                    href={moreLinks.perBand[group.band]!.href}
                    data-testid={`attention-overflow-${group.band}`}
                    className="block rounded-lg px-2 py-1.5 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
                  >
                    {moreLinks.perBand[group.band]!.text}
                  </Link>
                )}
              </div>
            </div>
          ))}
          {/* The card is a strict subset of the Upcoming page; the far-future
          scheduled work it hides is one click away, with an exact count so the two
          surfaces reconcile (issue #524). Names what it hides ("scheduled later") so
          it reads distinctly from a band cap-overflow link; when the last band also
          overflowed, this line absorbs it into one merged link (issue #538). */}
          {moreLinks.trailing && (
            <Link
              href={moreLinks.trailing.href}
              data-testid="attention-more-upcoming"
              className="block text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
            >
              {moreLinks.trailing.text}
            </Link>
          )}
        </div>
      </AttentionHeroCard>
      <SetupDisclosure items={setupItems} now={today} />
    </>
  );
}
