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
  IconSparkles,
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
import { requireScope, stampSubjects, type SubjectInfo } from "@/lib/scope";
import { today } from "@/lib/db";
import {
  collectMultiProfileAttention,
  collectMultiProfileSuppressed,
  type ProfiledSuppressedEntry,
} from "@/lib/queries";
import { SUPPRESSION_DOMAIN_ORDER } from "@/lib/suppression-display";
import { getUserBirthdate, getStoredAge, getUnitPrefs } from "@/lib/settings";
import { type PageGroupKind, type ProfiledUpcomingItem } from "@/lib/attention";
import {
  isItemSuppressibleFlag,
  upcomingDueText,
  type UpcomingDomain,
} from "@/lib/upcoming";
import { PageHeader, EmptyState } from "@/components/ui";
import Avatar from "@/components/Avatar";
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
  practice: IconSparkles,
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
  // The cross-profile scope (issue #1096): the persisted view-set (∩ accessible).
  // In the common single-view case `viewIds` is just the acting profile and the page
  // renders exactly as before; when the user has toggled other profiles into view,
  // this merges each member's attention model — computed in THAT member's own
  // timezone/today (the per-profile-context trap) — into one list, subject-stamped.
  const scope = await requireScope();
  const { loginId, actingProfileId, viewIds } = scope;
  const multi = viewIds.length > 1;
  // The acting profile's own today — the fallback clock for the demographics banner
  // and any item whose member-today lookup misses (never in practice).
  const now = today(actingProfileId);
  // The viewer's unit prefs (#1019 display-unit policy: web always follows the
  // login's prefs) so measurement-carrying item strings render in the viewer's unit.
  const units = getUnitPrefs(loginId);

  // The ONE unified attention model (issue #524), composed per member (#1096). Each
  // member's dueness/banding is computed in its own today (loop-composed, never
  // set-based SQL over a shared clock — the trap). The single-profile page is just
  // the one-member case of this.
  const model = collectMultiProfileAttention(viewIds, units);
  const groups = model.groups;
  const total = model.total;
  const suppressed = collectMultiProfileSuppressed(viewIds, units);

  // Per-member "today" for correct relative due-text on each merged row, and the
  // per-item subject identity (#534) resolved ONCE through the shared stampSubjects
  // (names show only when multi — a single view stays exactly as clean as today).
  const nowByProfile = new Map(
    model.members.map((m) => [m.profileId, m.today])
  );
  const subjectByProfile = new Map<number, SubjectInfo>();
  if (multi) {
    for (const s of stampSubjects(
      scope,
      viewIds.map((id) => ({ profileId: id }))
    )) {
      subjectByProfile.set(s.profileId, s.subject);
    }
  }

  // Preventive well-visits/screenings (issue #82) are only assessed when the acting
  // profile's age is known; the pointer is acting-profile guidance.
  const hasDemographics =
    getUserBirthdate(actingProfileId) != null ||
    getStoredAge(actingProfileId) != null;
  const hasPreventive = groups.some((g) =>
    g.items.some((i) => i.domain === "visit" || i.domain === "screening")
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
                {(group.items as ProfiledUpcomingItem[]).map((item) => (
                  <Row
                    key={`${item.profileId}:${item.key}`}
                    item={item}
                    now={nowByProfile.get(item.profileId) ?? now}
                    tone={GROUP_TONE[group.kind]}
                    multi={multi}
                    actingProfileId={actingProfileId}
                    subject={
                      multi
                        ? (subjectByProfile.get(item.profileId) ?? null)
                        : null
                    }
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {suppressed.length > 0 && (
        <SuppressedSection
          items={suppressed}
          multi={multi}
          subjectByProfile={subjectByProfile}
        />
      )}

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

// A small subject chip (#534/#900) rendered on a cross-profile row when the view
// holds more than one profile. On-element identity, never spatial (#531).
function SubjectChip({ subject }: { subject: SubjectInfo }) {
  return (
    <span
      data-testid={`subject-chip-${subject.profileId}`}
      className="flex shrink-0 items-center gap-1 rounded-full border border-black/10 bg-slate-50 py-0.5 pl-0.5 pr-2 text-xs font-medium text-slate-600 dark:border-white/10 dark:bg-ink-850 dark:text-slate-300"
    >
      <Avatar
        profile={{
          id: subject.profileId,
          name: subject.name,
          photo_path: subject.photoPath,
          photo_version: subject.photoVersion,
        }}
        size="sm"
      />
      {subject.name}
      {subject.access === "read" && (
        <span className="rounded-full bg-amber-100 px-1 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          RO
        </span>
      )}
    </span>
  );
}

// Inline controls for a due preventive visit/screening row (issue #82): a fast
// "Mark done" (records a satisfaction dated today, like a dose "mark taken") plus
// an override menu to mark the rule Declined or Not applicable — either hides it.
// The override menu is the shared OverflowMenu-based popover (issue #281).
function PreventiveControls({
  ruleKey,
  profileId,
}: {
  ruleKey: string;
  profileId: number;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <form
        action={async (fd) => {
          "use server";
          await markPreventiveDone(fd);
        }}
      >
        <input type="hidden" name="rule_key" value={ruleKey} />
        <input type="hidden" name="profile_id" value={profileId} />
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

// The collapsed "Snoozed & dismissed" section — the COMPLETE window over the
// findings-suppression bus (issue #1151), now cross-profile (#1096): each row's
// Restore targets the ITEM's own profile (profile_id threaded), never the acting
// one.
function SuppressedSection({
  items,
  multi,
  subjectByProfile,
}: {
  items: ProfiledSuppressedEntry[];
  multi: boolean;
  subjectByProfile: Map<number, SubjectInfo>;
}) {
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
                const subject = multi
                  ? (subjectByProfile.get(e.profileId) ?? null)
                  : null;
                return (
                  <div
                    key={`${e.profileId}:${e.signalKey}`}
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
                    {subject && <SubjectChip subject={subject} />}
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
                      <input
                        type="hidden"
                        name="profile_id"
                        value={e.profileId}
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
  multi,
  actingProfileId,
  subject,
}: {
  item: ProfiledUpcomingItem;
  now: string;
  tone: string;
  // True when >1 profile is in view — gates subject chips and per-item write
  // targeting.
  multi: boolean;
  actingProfileId: number;
  // The row's subject identity (#534), or null in single-view. When present and
  // read-only-granted, this row's write affordances are hidden — the #858 per-item
  // access-gating rule generalized (#1096).
  subject: SubjectInfo | null;
}) {
  const Icon = DOMAIN_ICON[item.domain];
  // A row is writable when single-view (server still enforces), or when the item's
  // subject is write-granted. A read-only-granted member's rows show but carry no
  // write buttons.
  const canWrite = subject == null || subject.access === "write";
  const isActing = item.profileId === actingProfileId;
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
      {multi && subject && <SubjectChip subject={subject} />}
      <div className={`shrink-0 whitespace-nowrap text-xs font-medium ${tone}`}>
        {upcomingDueText(item, now)}
      </div>
      {canWrite && item.doseId != null && (
        <form
          action={async (fd) => {
            "use server";
            await markTaken(fd);
          }}
          className="shrink-0"
        >
          <input type="hidden" name="dose_id" value={item.doseId} />
          <input type="hidden" name="profile_id" value={item.profileId} />
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
      {canWrite && item.preventiveRuleKey != null && (
        <PreventiveControls
          ruleKey={item.preventiveRuleKey}
          profileId={item.profileId}
        />
      )}
      {canWrite && item.carePlanItemId != null && (
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
          <input type="hidden" name="profile_id" value={item.profileId} />
          <SubmitButton
            pendingLabel="…"
            className="rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
          >
            Mark done
          </SubmitButton>
        </form>
      )}
      {/* Condition suggestion (issue #685): an inline confirm that adds the suggested
      problem-list condition. confirmConditionSuggestion targets the ACTING profile,
      so on a multi-view page it's shown only for the acting profile's own rows —
      never a wrong-target write on another member's row (#1096). */}
      {canWrite && item.conditionSuggestion != null && (!multi || isActing) && (
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
      {canWrite && item.followUpResolve != null && (
        <FollowUpResolveControls
          action={async (fd) => {
            "use server";
            await resolveFollowUp(fd);
          }}
          carePlanItemId={item.followUpResolve.carePlanItemId}
          resolvingRecordId={item.followUpResolve.resolvingRecordId}
          profileId={item.profileId}
        />
      )}
      {/* "Why is this flagged?" (issue #878, Phase 1): narrate the item's OWN carried
      reasons. Read-only, so it's shown regardless of write access. */}
      {item.reasons != null && item.reasons.length > 0 && (
        <ExplainFinding
          title={item.title}
          detail={item.detail}
          reasons={item.reasons}
        />
      )}
      {/* Per-item snooze/dismiss popover — the dismissal writes to the ITEM's own
      profile (profile_id threaded), never the acting one (#1096). Hidden on a
      read-only-granted row. */}
      {canWrite && isItemSuppressibleFlag(item) && (
        <SnoozeDismissMenu
          signalKey={item.key}
          profileId={item.profileId}
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
