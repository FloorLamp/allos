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
  IconUsers,
  IconLayoutList,
  IconCircleCheck,
  IconX,
  type TablerIcon,
} from "@tabler/icons-react";
import { requireScope, stampSubjects, type SubjectInfo } from "@/lib/scope";
import { today } from "@/lib/db";
import {
  collectMultiProfileAttention,
  collectMultiProfileSuppressed,
  type ProfiledSuppressedEntry,
} from "@/lib/queries";
import { type MemberSection, type AttentionPageGroup } from "@/lib/attention";
import {
  subjectChipVisible,
  itemAffordanceVisible,
  viewCountLabel,
  parseViewMode,
  type ViewMode,
} from "@/lib/multi-view";
import { SUPPRESSION_DOMAIN_ORDER } from "@/lib/suppression-display";
import {
  getUserBirthdate,
  getStoredAge,
  getUnitPrefs,
  isMultiviewHintDismissed,
} from "@/lib/settings";
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
  dismissMultiviewHintAction,
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

export default async function UpcomingPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The cross-profile scope (issue #1096): the persisted view-set (∩ accessible).
  // In the common single-view case `viewIds` is just the acting profile and the page
  // renders exactly as before; when the user has toggled other profiles into view,
  // this merges each member's attention model — computed in THAT member's own
  // timezone/today (the per-profile-context trap) — into one list, subject-stamped.
  const scope = await requireScope();
  const { loginId, actingProfileId, viewIds } = scope;
  const multi = viewIds.length > 1;
  // The page-level ordering toggle (issue #1327 fix 2, product-decided): interleaved
  // date bands (default) vs by-person sections. Only meaningful in multi-view.
  const searchParams = await props.searchParams;
  const viewMode: ViewMode = multi
    ? parseViewMode(searchParams.group)
    : "interleaved";
  // The acting profile's own today — the fallback clock for any item whose
  // member-today lookup misses (never in practice).
  const now = today(actingProfileId);
  // The viewer's unit prefs (#1019 display-unit policy: web always follows the
  // login's prefs) so measurement-carrying item strings render in the viewer's unit.
  const units = getUnitPrefs(loginId);

  // The ONE unified attention model (issue #524), composed per member (#1096). Each
  // member's dueness/banding is computed in its own today (loop-composed, never
  // set-based SQL over a shared clock — the trap). The single-profile page is just
  // the one-member case of this.
  const model = collectMultiProfileAttention(viewIds, units);
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

  // Preventive well-visits/screenings (issue #82) need each member's own age — so the
  // demographics nudge is PER-MEMBER (issue #1327 fix 4), never keyed on the acting
  // profile alone (which would silence an in-view member missing a birthdate and could
  // fire about nobody visible). One line per in-view member with no birthdate/age.
  const missingDemographics = viewIds.filter(
    (pid) => getUserBirthdate(pid) == null && getStoredAge(pid) == null
  );
  const hasPreventive = model.groups.some((g) =>
    g.items.some((i) => i.domain === "visit" || i.domain === "screening")
  );

  // One-time discoverability hint (issue #1327 fix 7): a dismissible pointer at the
  // profile-menu eye toggles, shown to a multi-profile login that hasn't yet spread
  // its view and hasn't dismissed the hint. No permanent chrome.
  const showMultiviewHint =
    !multi && scope.profiles.length > 1 && !isMultiviewHintDismissed(loginId);

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
              {viewCountLabel(total, viewIds.length)}
            </span>
          ) : undefined
        }
      />

      {showMultiviewHint && <MultiviewHint />}

      {missingDemographics.length > 0 && (
        <DemographicsNudge
          profileIds={missingDemographics}
          multi={multi}
          actingProfileId={actingProfileId}
          subjectByProfile={subjectByProfile}
        />
      )}

      {multi && <ModeToggle mode={viewMode} />}

      {total === 0 && viewMode === "interleaved" ? (
        <EmptyState message="Nothing due. You're all caught up." />
      ) : viewMode === "by-person" ? (
        <div className="space-y-8" data-testid="by-person-view">
          {model.memberSections.map((section) => (
            <MemberBlock
              key={section.profileId}
              section={section}
              subject={subjectByProfile.get(section.profileId) ?? null}
              nowByProfile={nowByProfile}
              now={now}
              multi={multi}
              actingProfileId={actingProfileId}
              subjectByProfile={subjectByProfile}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {model.groups.map((group) => (
            <GroupSection
              key={group.kind}
              group={group}
              idAnchor
              chipRows
              nowByProfile={nowByProfile}
              now={now}
              multi={multi}
              actingProfileId={actingProfileId}
              subjectByProfile={subjectByProfile}
            />
          ))}
          {multi && model.emptyMemberIds.length > 0 && (
            <AllCaughtUpLine
              profileIds={model.emptyMemberIds}
              subjectByProfile={subjectByProfile}
            />
          )}
        </div>
      )}

      {suppressed.length > 0 && (
        <SuppressedSection
          items={suppressed}
          multi={multi}
          actingProfileId={actingProfileId}
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
            guidelines and are informational only — your provider&apos;s
            guidance wins.
          </span>
        </p>
      )}
    </div>
  );
}

// One page-group (a date band or a signal grouping) rendered as a heading + a card of
// rows. Shared by BOTH view modes (issue #1327 fix 2): interleaved renders the merged
// cross-profile groups (with the `id={kind}` deep-link anchor #538, and per-row subject
// chips via `chipRows`); by-person renders each member's own groups (no anchor — the kind
// repeats per member — and NO chips, since the member header already names the subject:
// "stops scanning chips").
function GroupSection({
  group,
  idAnchor,
  chipRows,
  nowByProfile,
  now,
  multi,
  actingProfileId,
  subjectByProfile,
}: {
  group: AttentionPageGroup;
  idAnchor?: boolean;
  chipRows?: boolean;
  nowByProfile: Map<number, string>;
  now: string;
  multi: boolean;
  actingProfileId: number;
  subjectByProfile: Map<number, SubjectInfo>;
}) {
  return (
    <section id={idAnchor ? group.kind : undefined}>
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
            chipRow={chipRows === true}
            actingProfileId={actingProfileId}
            subject={
              multi ? (subjectByProfile.get(item.profileId) ?? null) : null
            }
          />
        ))}
      </div>
    </section>
  );
}

// One member's block in BY-PERSON mode (issue #1327 fix 2/3): a subject header naming
// the member, then that member's own page groups — or a calm "All caught up" when the
// member has nothing due (#489: acknowledge the quiet member, never leave them silent
// so their block reads as "scrolled past").
function MemberBlock({
  section,
  subject,
  nowByProfile,
  now,
  multi,
  actingProfileId,
  subjectByProfile,
}: {
  section: MemberSection;
  subject: SubjectInfo | null;
  nowByProfile: Map<number, string>;
  now: string;
  multi: boolean;
  actingProfileId: number;
  subjectByProfile: Map<number, SubjectInfo>;
}) {
  const name = subject?.name ?? `Profile ${section.profileId}`;
  return (
    <section data-testid={`member-section-${section.profileId}`}>
      <div className="mb-2 flex items-center gap-2 border-b border-black/5 pb-1 dark:border-white/5">
        {subject && (
          <Avatar
            profile={{
              id: subject.profileId,
              name: subject.name,
              photo_path: subject.photoPath,
              photo_version: subject.photoVersion,
            }}
            size="sm"
          />
        )}
        <span className="font-semibold text-slate-800 dark:text-slate-100">
          {name}
        </span>
      </div>
      {section.empty ? (
        <div
          data-testid={`member-caught-up-${section.profileId}`}
          className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500 dark:bg-ink-850 dark:text-slate-400"
        >
          <IconCircleCheck className="h-4 w-4 shrink-0" stroke={1.75} />
          All caught up.
        </div>
      ) : (
        <div className="space-y-6">
          {section.groups.map((group) => (
            <GroupSection
              key={group.kind}
              group={group}
              nowByProfile={nowByProfile}
              now={now}
              multi={multi}
              actingProfileId={actingProfileId}
              subjectByProfile={subjectByProfile}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// The interleaved-mode "All caught up" acknowledgement (issue #1327 fix 3): one calm
// compact line naming the in-view members with nothing due, so a quiet member is
// acknowledged rather than indistinguishable from scrolled-past. Never a nag (#489).
function AllCaughtUpLine({
  profileIds,
  subjectByProfile,
}: {
  profileIds: number[];
  subjectByProfile: Map<number, SubjectInfo>;
}) {
  const names = profileIds.map(
    (pid) => subjectByProfile.get(pid)?.name ?? `Profile ${pid}`
  );
  return (
    <p
      data-testid="all-caught-up-line"
      className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400"
    >
      <IconCircleCheck className="h-4 w-4 shrink-0" stroke={1.75} />
      All caught up: {names.join(", ")}.
    </p>
  );
}

// The interleaved | by-person ordering toggle (issue #1327 fix 2). Two server-rendered
// Next <Link>s (a native <a href> that works pre-hydration, #830) — no permanent client
// chrome. Only rendered in multi-view.
function ModeToggle({ mode }: { mode: ViewMode }) {
  const base =
    "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition";
  const on =
    "bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300";
  const off =
    "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-750";
  return (
    <div
      data-testid="upcoming-mode-toggle"
      className="mb-4 inline-flex items-center gap-1 rounded-xl border border-black/10 p-1 dark:border-white/10"
    >
      <Link
        href="/upcoming"
        data-testid="mode-interleaved"
        aria-pressed={mode === "interleaved"}
        className={`${base} ${mode === "interleaved" ? on : off}`}
      >
        <IconLayoutList className="h-4 w-4" stroke={1.75} />
        By date
      </Link>
      <Link
        href="/upcoming?group=by-person"
        data-testid="mode-by-person"
        aria-pressed={mode === "by-person"}
        className={`${base} ${mode === "by-person" ? on : off}`}
      >
        <IconUsers className="h-4 w-4" stroke={1.75} />
        By person
      </Link>
    </div>
  );
}

// The dismissible one-time multi-profile viewing hint (issue #1327 fix 7). A plain
// <form> bound to the Server Action so the dismiss works pre-hydration; dismissing
// stores a per-login "seen" flag (login_settings) so it never returns.
function MultiviewHint() {
  return (
    <div
      data-testid="multiview-hint"
      className="mb-6 flex items-start gap-3 rounded-xl border border-brand-200 bg-brand-50 p-3 text-sm text-brand-800 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-200"
    >
      <IconUsers className="mt-0.5 h-5 w-5 shrink-0" stroke={1.75} />
      <div className="min-w-0 flex-1">
        You can view several profiles at once — open the profile menu and tap
        the eye toggle beside a name to add them to this view.
      </div>
      <form
        action={async () => {
          "use server";
          await dismissMultiviewHintAction();
        }}
        className="shrink-0"
      >
        <button
          type="submit"
          data-testid="multiview-hint-dismiss"
          aria-label="Dismiss hint"
          className="flex h-6 w-6 items-center justify-center rounded-full text-brand-500 transition hover:bg-brand-100 dark:hover:bg-brand-500/20"
        >
          <IconX className="h-4 w-4" stroke={2} />
        </button>
      </form>
    </div>
  );
}

// The per-member demographics nudge (issue #1327 fix 4). Subject-coherent: one line per
// in-view member missing a birthdate/age, named from the scope (#534). The acting
// member's line carries the actionable link (Profile settings edits the ACTIVE profile);
// a non-acting member's line names them without a misleading deep-link.
function DemographicsNudge({
  profileIds,
  multi,
  actingProfileId,
  subjectByProfile,
}: {
  profileIds: number[];
  multi: boolean;
  actingProfileId: number;
  subjectByProfile: Map<number, SubjectInfo>;
}) {
  return (
    <div
      data-testid="demographics-nudge"
      className="mb-6 flex items-start gap-3 rounded-xl border border-brand-200 bg-brand-50 p-3 text-sm text-brand-800 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-200"
    >
      <IconInfoCircle className="mt-0.5 h-5 w-5 shrink-0" stroke={1.75} />
      {!multi ? (
        <div>
          Add a birthdate to enable preventive visit &amp; screening reminders.{" "}
          <Link
            href="/settings/profile"
            className="font-medium underline hover:no-underline"
          >
            Set it in Profile settings
          </Link>
          .
        </div>
      ) : (
        <div className="min-w-0">
          <p className="font-medium">
            Add a birthdate to enable preventive reminders for:
          </p>
          <ul className="mt-1 space-y-0.5">
            {profileIds.map((pid) => {
              const subject = subjectByProfile.get(pid);
              const name = subject?.name ?? `Profile ${pid}`;
              const isActing = pid === actingProfileId;
              return (
                <li
                  key={pid}
                  className="flex min-w-0 flex-wrap items-center gap-1.5"
                >
                  {subject && (
                    <Avatar
                      profile={{
                        id: subject.profileId,
                        name: subject.name,
                        photo_path: subject.photoPath,
                        photo_version: subject.photoVersion,
                      }}
                      size="sm"
                    />
                  )}
                  <span className="font-medium">{name}</span>
                  {isActing && (
                    <Link
                      href="/settings/profile"
                      className="underline hover:no-underline"
                    >
                      — set it in Profile settings
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// A small subject chip (#534/#900) rendered on a cross-profile row for a NON-acting
// member (issue #1327 fix 1: the acting profile's rows are implied by the view strip).
// On-element identity, never spatial (#531). The name truncates so the chip fits its
// fixed-width aligned slot.
function SubjectChip({ subject }: { subject: SubjectInfo }) {
  return (
    <span
      data-testid={`subject-chip-${subject.profileId}`}
      className="flex min-w-0 items-center gap-1 rounded-full border border-black/10 bg-slate-50 py-0.5 pl-0.5 pr-2 text-xs font-medium text-slate-600 dark:border-white/10 dark:bg-ink-850 dark:text-slate-300"
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
      <span className="truncate">{subject.name}</span>
      {subject.access === "read" && (
        <span className="shrink-0 rounded-full bg-amber-100 px-1 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-950 dark:text-amber-300">
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
  actingProfileId,
  subjectByProfile,
}: {
  items: ProfiledSuppressedEntry[];
  multi: boolean;
  actingProfileId: number;
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
                // Chip only NON-acting rows (issue #1327 fix 1), same rule as the
                // main list.
                const showChip = subjectChipVisible({
                  multi,
                  isActing: e.profileId === actingProfileId,
                });
                const subject = showChip
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
  chipRow,
  actingProfileId,
  subject,
}: {
  item: ProfiledUpcomingItem;
  now: string;
  tone: string;
  // True when >1 profile is in view — gates subject chips and per-item write
  // targeting.
  multi: boolean;
  // Whether THIS presentation renders subject chips on its rows (interleaved mode).
  // False in by-person mode, where the member header already names the subject.
  chipRow: boolean;
  actingProfileId: number;
  // The row's subject identity (#534), or null in single-view. When present and
  // read-only-granted, this row's write affordances are hidden — the #858 per-item
  // access-gating rule generalized (#1096).
  subject: SubjectInfo | null;
}) {
  const Icon = DOMAIN_ICON[item.domain];
  const isActing = item.profileId === actingProfileId;
  // A row's subject can write when single-view (server still enforces), or when the
  // item's subject is write-granted. A read-only-granted member's rows show but carry
  // no write buttons.
  const subjectCanWrite = subject == null || subject.access === "write";
  // Whether this item's INLINE ACTION may render (issue #1327 fix 5): item-targeted
  // actions gate on the subject's write access; acting-targeted actions (a condition
  // suggestion, which writes to the acting profile) render only on the acting profile's
  // own row. One shared rule (itemAffordanceVisible), no page-local `(!multi ||
  // isActing)`.
  const actionVisible = itemAffordanceVisible(item.writeTarget, {
    isActing,
    subjectCanWrite,
  });
  // The subject chip shows on non-acting rows only (issue #1327 fix 1), and only in a
  // presentation that renders chips (interleaved; by-person names the subject in its
  // member header instead).
  const showChip = chipRow && subjectChipVisible({ multi, isActing });
  return (
    <div
      data-testid={`upcoming-item-${item.key}`}
      // flex-wrap (#1063): the trailing action/badge chips are nowrap-by-design,
      // so at phone width they must WRAP under the title instead of forcing the
      // row past the viewport (where the shell's overflow-x-clip hides them).
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg px-2 py-2 transition hover:bg-slate-50 dark:hover:bg-ink-850"
    >
      {/* Row head: icon + title (+ subject chip). `basis-full` on phones makes the head
          OWN the first line, so the trailing due-text/actions WRAP beneath it (#1063)
          instead of shrinking the flex-1 title to an ellipsis ("Cardiology follow-up" →
          "C…" at 390px — issue #1327 fix 1). On sm+ the head is flex-1 and, inside it,
          the chip sits in a fixed-width aligned slot beside the title (a stable column
          for whose-row scanning, not a ragged float). ONE chip element that reflows from
          its own line (phone) to the slot (sm+) — no hidden md:* mirror. */}
      <div className="flex min-w-0 basis-full items-center gap-3 sm:basis-0 sm:flex-1">
        <Icon
          className="h-5 w-5 shrink-0 text-slate-500 dark:text-slate-400"
          stroke={1.75}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
          <div className="min-w-0 sm:flex-1">
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
          {showChip && subject && (
            <div className="flex shrink-0 sm:w-44 sm:justify-start">
              <SubjectChip subject={subject} />
            </div>
          )}
        </div>
      </div>
      <div className={`shrink-0 whitespace-nowrap text-xs font-medium ${tone}`}>
        {upcomingDueText(item, now)}
      </div>
      {actionVisible && item.doseId != null && (
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
      {actionVisible && item.preventiveRuleKey != null && (
        <PreventiveControls
          ruleKey={item.preventiveRuleKey}
          profileId={item.profileId}
        />
      )}
      {actionVisible && item.carePlanItemId != null && (
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
      problem-list condition. confirmConditionSuggestion targets the ACTING profile, so
      the item declares writeTarget "acting" and the shared affordance gate
      (actionVisible) shows this ONLY on the acting profile's own row — never a
      wrong-target write on another member's row (#1096 / #1327 fix 5). */}
      {actionVisible && item.conditionSuggestion != null && (
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
      {actionVisible && item.followUpResolve != null && (
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
      profile (profile_id threaded), never the acting one (#1096). This is item-scoped
      suppression (correct cross-profile even on a non-acting row), so it gates on the
      subject's write access — NOT the acting-targeted actionVisible — so you may snooze
      another member's finding. Hidden on a read-only-granted row. */}
      {subjectCanWrite && isItemSuppressibleFlag(item) && (
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
