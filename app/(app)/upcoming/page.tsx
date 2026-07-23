import Link from "next/link";
import {
  IconPill,
  IconRefresh,
  IconAlertTriangle,
  IconTemperature,
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
  IconBellOff,
  IconInfoCircle,
  IconCalendarPlus,
  IconCalendarCheck,
  IconClipboardPlus,
  IconArrowRight,
  IconSun,
  type TablerIcon,
} from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  collectAttentionModel,
  collectSuppressedAttention,
  type SuppressedAttentionEntry,
} from "@/lib/queries";
import { SUPPRESSION_DOMAIN_ORDER } from "@/lib/suppression-display";
import { getUserBirthdate, getStoredAge, getUnitPrefs } from "@/lib/settings";
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
import FollowUpResolveControls from "@/components/FollowUpResolveControls";
import ExplainFinding from "@/components/ExplainFinding";
import {
  markTaken,
  snoozeItem,
  dismissItem,
  restoreItem,
  markPreventiveDone,
  markCarePlanDone,
  resolveFollowUp,
} from "./actions";
import { confirmConditionSuggestion } from "@/app/(app)/conditions/actions";

export const dynamic = "force-dynamic";

// Domain → icon for the leading glyph on each row. Covers the date-scheduled
// domains plus the unified model's "something's off" signals (issue #524).
const DOMAIN_ICON: Record<UpcomingDomain, TablerIcon> = {
  dose: IconPill,
  "prn-max": IconPill,
  refill: IconRefresh,
  "dietary-limit": IconAlertTriangle,
  "illness-care": IconTemperature,
  "condition-review": IconClipboardPlus,
  "allergy-med": IconAlertTriangle,
  interaction: IconAlertTriangle,
  pgx: IconAlertTriangle,
  contrast: IconAlertTriangle,
  "dental-safety": IconAlertTriangle,
  ototoxic: IconAlertTriangle,
  "uv-exposure": IconSun,
  appointment: IconStethoscope,
  visit: IconStethoscope,
  screening: IconMicroscope,
  immunization: IconVaccine,
  biomarker: IconChartLine,
  "med-monitor": IconMicroscope,
  goal: IconTarget,
  training: IconBarbell,
  careplan: IconClipboardList,
  followup: IconStethoscope,
  // A calm, medical icon for the crisis check-in (#716) — never an alarm triangle.
  "mental-health": IconStethoscope,
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
  const { login, profile } = await requireSession();
  const now = today(profile.id);
  // The viewer's unit prefs (#1019 display-unit policy: web always follows the
  // login's prefs) so measurement-carrying item strings — the temperature
  // red-flag, an endurance event distance — render in the viewer's unit.
  const units = getUnitPrefs(login.id);
  // The ONE unified attention model (issue #524) — the SAME set the dashboard card
  // renders (as an act-now subset). The page shows it in FULL: date-scheduled work
  // in calendar bands, plus the flagged-lab / failing-sync / review signals under
  // their own groupings. Completeness is the point of the planning view.
  const items = collectAttentionModel(profile.id, now, units);
  const groups = groupAttentionForPage(items, now);
  const total = items.length;
  const suppressed = collectSuppressedAttention(profile.id, now, units);

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
                className={`mb-2 flex items-center gap-2 section-label ${GROUP_TONE[group.kind]}`}
              >
                {group.label}
                <span className="text-slate-500 dark:text-slate-400">
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
        <p className="mt-8 flex items-start gap-2 text-xs text-slate-500 dark:text-slate-400">
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

// The collapsed "Snoozed & dismissed" section — now the COMPLETE window over the
// findings-suppression bus (issue #1151): care items, coaching/observational
// findings, per-surface suggestions, and warnings, grouped by domain. Each row
// carries a Restore that drops the suppression row (the exact shared-store op the
// inline restores use), so the finding reappears on its origin surface —
// "un-dismiss once, reappears everywhere". An orphan row (subject deleted /
// unknown key, #203) renders generically; its Restore just clears the dead key.
function SuppressedSection({ items }: { items: SuppressedAttentionEntry[] }) {
  const groups = SUPPRESSION_DOMAIN_ORDER.map((domain) => ({
    domain,
    entries: items.filter((e) => e.domain === domain),
  })).filter((g) => g.entries.length > 0);
  return (
    <details className="mt-8" data-testid="suppressed-section">
      <summary className="cursor-pointer section-label">
        Snoozed &amp; dismissed{" "}
        <span className="text-slate-500 dark:text-slate-400">
          ({items.length})
        </span>
      </summary>
      <div className="card mt-2 space-y-3 p-2">
        {groups.map((g) => (
          <div key={g.domain}>
            <div className="section-label px-2 pb-1">{g.domain}</div>
            <div className="space-y-1">
              {g.entries.map((e) => {
                const Icon = e.item ? DOMAIN_ICON[e.item.domain] : IconBellOff;
                return (
                  <div
                    key={e.signalKey}
                    data-testid="suppressed-row"
                    className="flex items-center gap-3 rounded-lg px-2 py-2"
                  >
                    <Icon
                      className="h-5 w-5 shrink-0 text-slate-500 dark:text-slate-400"
                      stroke={1.75}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-slate-600 dark:text-slate-300">
                        {e.label}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {e.snoozeUntil
                          ? `Snoozed until ${e.snoozeUntil}`
                          : "Dismissed"}
                      </div>
                    </div>
                    <form
                      action={async (fd) => {
                        "use server";
                        await restoreItem(fd);
                      }}
                      className="shrink-0"
                    >
                      <input
                        type="hidden"
                        name="signal_key"
                        value={e.signalKey}
                      />
                      <SubmitButton
                        pendingLabel="…"
                        className="flex items-center gap-1 rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
                      >
                        <IconArrowBackUp
                          className="h-3.5 w-3.5"
                          stroke={1.75}
                        />
                        {e.orphan ? "Clear" : "Restore"}
                      </SubmitButton>
                    </form>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
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
      // flex-wrap (#1063): the trailing action/badge chips are nowrap-by-design,
      // so at phone width they must WRAP under the title instead of forcing the
      // row past the viewport (where the shell's overflow-x-clip hides them).
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg px-2 py-2 transition hover:bg-slate-50 dark:hover:bg-ink-850"
    >
      <Icon
        className="h-5 w-5 shrink-0 text-slate-500 dark:text-slate-400"
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
      {/* The concrete next action for a preventive screening (#1083): a deep-link
          CTA naming exactly what to do — "Complete the AUDIT-C", "Record your LDL
          Cholesterol result", "Log or schedule a colonoscopy" — pointing at the
          prefilled form (item.href). Only screening items carry an actionLabel; a
          visit's action is the "Book" affordance below. */}
      {item.actionLabel && item.preventiveRuleKey != null && (
        <Link
          href={item.href}
          data-testid={`upcoming-cta-${item.key}`}
          className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
        >
          <IconArrowRight className="h-3.5 w-3.5" stroke={1.75} />
          {item.actionLabel}
        </Link>
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
      {/* Condition suggestion (issue #685): an inline confirm that adds the suggested
      problem-list condition — suggest-only, so it acts ONLY on this explicit click,
      never on ingest. Dismiss lives in the shared snooze/dismiss menu below. */}
      {item.conditionSuggestion != null && (
        <form
          action={async (fd) => {
            "use server";
            await confirmConditionSuggestion(fd);
          }}
          className="shrink-0"
        >
          <input
            type="hidden"
            name="name"
            value={item.conditionSuggestion.name}
          />
          {item.conditionSuggestion.code != null && (
            <input
              type="hidden"
              name="code"
              value={item.conditionSuggestion.code}
            />
          )}
          <SubmitButton
            pendingLabel="…"
            className="flex items-center gap-1 rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
          >
            <IconClipboardPlus className="h-3.5 w-3.5" stroke={1.75} />
            Add to conditions
          </SubmitButton>
        </form>
      )}
      {/* Finding follow-up resolution offer (issue #700): a matching later record
      landed, so offer the outcome (resolved / stable / changed) confirm-first. */}
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
      {/* "Why is this flagged?" (issue #878, Phase 1): narrate the item's OWN carried
      reasons via the Light tier, or the deterministic structured fallback keyless.
      Only shown when the item carries structured reasons. */}
      {item.reasons != null && item.reasons.length > 0 && (
        <ExplainFinding
          title={item.title}
          detail={item.detail}
          reasons={item.reasons}
        />
      )}
      {/* Per-item snooze/dismiss popover — the shared OverflowMenu-based menu
      (issue #281), identical to the dashboard hero's. Only suppressible items get
      one; the structural signals (failing sync / review count) are resolved, not
      snoozed (issue #524). A care-persistent overdue follow-up (#700) gets a
      snooze-ONLY menu — it resists an indefinite dismiss. */}
      {isItemSuppressibleFlag(item) && (
        <SnoozeDismissMenu
          signalKey={item.key}
          snoozeOnly={item.carePersistent === true}
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
