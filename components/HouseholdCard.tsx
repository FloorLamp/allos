import {
  IconChevronRight,
  IconTrendingDown,
  IconTrendingUp,
  IconMinus,
  IconPill,
  IconAlarm,
  IconCalendarEvent,
  IconCheck,
  IconVirus,
  IconBarbell,
  IconChecklist,
  IconX,
} from "@tabler/icons-react";
import Link from "next/link";
import Avatar from "@/components/Avatar";
import type { AvatarProfile } from "@/components/Avatar";
import DoseConfirmButton from "@/components/DoseConfirmButton";
import {
  openProfileAction,
  confirmDoseAction,
  undoConfirmDoseAction,
  openMemberSetupAction,
  dismissMemberSetupAction,
} from "@/app/(app)/household/actions";
import type {
  HouseholdSetupCheck,
  HouseholdSetupRow,
} from "@/lib/household-setup";
import type { FindingTone } from "@/lib/findings";
import { aggregateLabel, planBandRender } from "@/lib/upcoming-aggregate";
import type { UpcomingItem } from "@/lib/upcoming";
import { fmtWeight } from "@/lib/units";
import { subjectActionLabel } from "@/lib/own-profile";
import { upcomingDueText } from "@/lib/upcoming";
import { type DisplayFormatPrefs } from "@/lib/format-date";
import type { HouseholdRollup } from "@/lib/queries";
import type { WeightUnit } from "@/lib/settings";
import type { Adherence, GoalHighlight, WeightTrend } from "@/lib/household";

// One compact, at-a-glance card per profile on the household dashboard (issue
// #31). The header is a submit button bound to openProfileAction — one click
// switches the session's active profile to this person and opens their dashboard —
// while the actionable rollup below carries its OWN per-dose confirm forms
// (confirmDoseAction) so a caregiver can check off a due dose for this profile
// WITHOUT switching to it. Presentational only: the page assembles every value
// (via the pure lib/household helpers + collectHouseholdRollup over per-profile
// queries) and passes display-ready data; the confirm buttons only render when the
// caller holds WRITE on this profile (the server action re-checks regardless).
export interface HouseholdCardData {
  profile: AvatarProfile;
  // The caller's access to THIS profile: gates whether quick-action buttons render.
  canWrite: boolean;
  // The subject NAME to stamp on this card's write affordance ("Confirm — Mia"), or
  // null when the write goes to the login's OWN profile / no own-profile is set
  // (issue #1013). Resolved server-side (writeSubjectName over the scope's ownProfileId
  // vs THIS card's profile) so a caregiver's dose confirm names the card's person,
  // never the viewer.
  subjectName: string | null;
  // Today's attention items (due doses / low refills / next visit) for this profile.
  rollup: HouseholdRollup;
  // This profile's "today" (resolved in its timezone) — for the appointment due-text.
  today: string;
  // The VIEWING login's date shape (#964). The appointment due-text prints a calendar
  // date once the visit is past this week (#2579-B), and a rendered date follows the
  // reader's prefs — the profile owns the clock, the login owns the shape.
  formatPrefs: DisplayFormatPrefs;
  adherence: Adherence;
  // The pushed tier's state-change headline (#1505 part 3) — "Missed: Magnesium
  // (3 days)" — preformatted by the ONE shared `intakeDeltaLine` the morning digest
  // and the weekly recap also render. Null on a quiet window: no state change, no
  // line. The x/y fraction beside it is unchanged and still counts low-priority
  // supplements — adherence answers "what did I do", this answers "what changed
  // among the things that push me".
  intakeDeltaLine: string | null;
  lastActivity: { title: string; when: string } | null;
  activities7d: number;
  // Preformatted in the viewing login's unit preference, or null with no weigh-in.
  weightLabel: string | null;
  weightWhen: string | null;
  trend: WeightTrend | null;
  // The viewing login's weight unit, so the trend delta reads in the same unit
  // as weightLabel (never a hardcoded kg).
  weightUnit: WeightUnit;
  oorBiomarkers: number;
  goals: GoalHighlight[];
  // A one-line "sick day N · 101.3°F" chip when this profile has an OPEN illness
  // episode (issue #801), else null — the household mirror of the dashboard card.
  sick: string | null;
  // A compact "mid-workout · N min" chip while this profile is in a live session
  // (#921), else null. Live-only and unlinked (no cross-profile activity route).
  presence: string | null;
  // A compact structural data-quality gaps line (issue #1045), else null — the same
  // ranked gap model the dashboard widget formats, condensed. Unlinked (a cross-
  // profile deep link lands on a dead anchor, #879); tapping the card switches to
  // this profile where each gap's own CTA is reachable.
  dataQuality: string | null;
  // The member's SETUP-HEALTH row (issue #2173) — unroutable reminders, never-started
  // onboarding, undosed active items, unactioned preventive nudges, the SUGGEST-only
  // roster question — or null when their setup is healthy (or the current episode was
  // dismissed). Derived at read time by householdSetupForProfile; this card only
  // renders it.
  setup: HouseholdSetupRow | null;
}

function TrendArrow({ trend, unit }: { trend: WeightTrend; unit: WeightUnit }) {
  const Icon =
    trend.dir === "up"
      ? IconTrendingUp
      : trend.dir === "down"
        ? IconTrendingDown
        : IconMinus;
  const label =
    trend.dir === "flat"
      ? "steady"
      : `${trend.dir === "up" ? "up" : "down"} ${fmtWeight(Math.abs(trend.deltaKg), unit)}`;
  return (
    <span
      className="inline-flex items-center text-slate-500 dark:text-slate-400"
      title={`Weight ${label} since the previous reading`}
    >
      <Icon className="h-4 w-4" stroke={1.75} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="section-label">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-slate-800 dark:text-slate-100">
        {children}
      </div>
    </div>
  );
}

// A single attention row: an icon, the item's title + optional detail, and an
// optional trailing action (the dose confirm button).
function AttentionRow({
  Icon,
  title,
  detail,
  action,
  testid,
}: {
  Icon: typeof IconPill;
  title: string;
  detail?: string | null;
  action?: React.ReactNode;
  testid?: string;
}) {
  return (
    <div className="flex items-center gap-2" data-testid={testid}>
      <Icon
        className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400"
        stroke={1.75}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">
          {title}
        </div>
        {detail && (
          <div className="truncate text-xs text-slate-500 dark:text-slate-400">
            {detail}
          </div>
        )}
      </div>
      {action}
    </div>
  );
}

// One due-dose row. Split out of Attention so the fold below can render exactly the
// same row inside its disclosure — folding is a RENDERING decision and identity is
// not (#1496/#1504), so the confirm form, its ids and its outcome toast are unchanged
// on either side of the summary.
//
// THE DETAIL LINE NAMES THE SLOT (#2615 item 2). A caregiver's card listed "Omega-3"
// / "600 mg" twice in a row, once for the morning dose and once for the evening one,
// with two identical Confirm buttons — the label must include the attribute that
// actually distinguishes otherwise identical choices, and this row already knew it:
// `dueText` is the dose's own bucket ("Morning", "Evening", "Morning · Mondays"),
// formatted by the ONE `timeBucket`/`cadenceLabel` pair the Upcoming row, the digest
// and the reminder all use. It leads the line because it is the distinguishing half.
function DueDoseRow({
  item,
  profileId,
  canWrite,
  subjectName,
}: {
  item: UpcomingItem;
  profileId: number;
  canWrite: boolean;
  subjectName: string | null;
}) {
  const detail =
    [item.dueText, item.detail].filter(Boolean).join(" · ") || null;
  return (
    <AttentionRow
      Icon={IconPill}
      title={item.title}
      detail={detail}
      testid="household-due-dose"
      action={
        canWrite && item.doseId != null ? (
          // Confirm this dose for THIS profile without switching to it —
          // the hidden profileId targets the action at the card's profile.
          // Rendered through the shared outcome-toast confirm (#2106), so a
          // refusal (item paused, dose retired) is said out loud instead of
          // the row silently re-rendering unchanged.
          <DoseConfirmButton
            action={confirmDoseAction}
            // Act → toast → Undo (#2642). The undo re-runs this card's OWN gate on the
            // member's profile and refuses the moment the day's ledger is no longer the
            // single row this confirm wrote, so a caregiver takes back their own tap and
            // never a second caregiver's.
            undoAction={undoConfirmDoseAction}
            fields={{ profileId, dose_id: item.doseId }}
            testid="household-confirm-dose"
            // The visible label stays short; the accessible name carries the same
            // distinguishing attributes the detail line just gained, so two confirms
            // on one card are never announced identically.
            ariaLabel={subjectActionLabel(
              `Confirm ${[item.title, detail].filter(Boolean).join(" · ")}`,
              subjectName
            )}
            className="inline-flex items-center gap-1 rounded-md border border-black/10 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
          >
            <IconCheck className="h-3.5 w-3.5" stroke={2} aria-hidden="true" />
            {subjectActionLabel("Confirm", subjectName)}
          </DoseConfirmButton>
        ) : null
      }
    />
  );
}

function Attention({ data }: { data: HouseholdCardData }) {
  const { profile, canWrite, rollup, today, subjectName, formatPrefs } = data;
  const { dueDoses, lowRefills, nextAppointment } = rollup;
  const nothing =
    dueDoses.length === 0 && lowRefills.length === 0 && !nextAppointment;
  // The SAME fold decision the Upcoming page's band makes (#1504, #2615 item 2):
  // this list ran twelve dose rows unrolled on a card whose whole job is a glance,
  // while the page-side equivalent folded. `planBandRender` is that one decision —
  // safety-pinned rows lead and never fold, a class under AGGREGATE_MIN_ROWS renders
  // individually exactly as before, and the aggregate takes the position of the first
  // row it folded. Reused rather than re-derived, so "when does a dose list fold" has
  // one answer.
  const doseNodes = planBandRender(dueDoses);

  return (
    <div className="mt-4 space-y-2 border-t border-black/5 pt-3 dark:border-white/5">
      <div className="section-label">Attention today</div>
      {nothing ? (
        <div
          className="text-sm text-slate-500 dark:text-slate-400"
          data-testid="household-all-clear"
        >
          Nothing needs attention.
        </div>
      ) : (
        <div className="space-y-2">
          {doseNodes.map((node) =>
            node.node === "item" ? (
              <DueDoseRow
                key={node.item.key}
                item={node.item}
                profileId={profile.id}
                canWrite={canWrite}
                subjectName={subjectName}
              />
            ) : (
              // A plain <details>: no persisted state, collapsed on every visit, and
              // the count is never hidden — the ALWAYS-PRESENT contract, not an
              // always-full one.
              <details
                key={`aggregate:${node.kind}`}
                className="group"
                data-testid="household-dose-aggregate"
              >
                <summary
                  data-testid="household-dose-aggregate-summary"
                  className="flex cursor-pointer list-none items-center gap-2 rounded-md py-0.5 transition hover:bg-slate-50 dark:hover:bg-ink-850"
                >
                  <IconPill
                    className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400"
                    stroke={1.75}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700 dark:text-slate-200">
                    {aggregateLabel(node.kind, node.items.length)} due
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-xs font-medium text-brand-700 dark:text-brand-400">
                    <span className="group-open:hidden">Show</span>
                    <span className="hidden group-open:inline">Hide</span>
                  </span>
                </summary>
                <div className="mt-2 space-y-2 border-l-2 border-black/5 pl-2 dark:border-white/10">
                  {node.items.map((item) => (
                    <DueDoseRow
                      key={item.key}
                      item={item}
                      profileId={profile.id}
                      canWrite={canWrite}
                      subjectName={subjectName}
                    />
                  ))}
                </div>
              </details>
            )
          )}
          {lowRefills.map((item) => (
            <AttentionRow
              key={item.key}
              Icon={IconAlarm}
              title={item.title}
              detail={item.detail}
              testid="household-low-refill"
            />
          ))}
          {nextAppointment && (
            <AttentionRow
              Icon={IconCalendarEvent}
              title={nextAppointment.title}
              detail={upcomingDueText(nextAppointment, today, formatPrefs)}
              testid="household-next-appointment"
            />
          )}
        </div>
      )}
    </div>
  );
}

// Tone → the check row's text colour. The BANDING vocabulary is the attention model's
// existing `FindingTone` (#2173 constraint 2 — content may raise a row, but no new
// severity words); this map is presentation only. Deliberately NOT a bordered tinted
// block: the setup row is a calm configuration note on a glance card, not an alert.
const SETUP_TONE_TEXT: Record<FindingTone, string> = {
  caution: "text-amber-700 dark:text-amber-300",
  action: "text-sky-700 dark:text-sky-300",
  info: "text-slate-600 dark:text-slate-300",
  neutral: "text-slate-600 dark:text-slate-300",
  positive: "text-emerald-700 dark:text-emerald-300",
};

function SetupCheckRow({
  check,
  profileId,
}: {
  check: HouseholdSetupCheck;
  profileId: number;
}) {
  return (
    <div data-testid="household-setup-check" data-check={check.id}>
      <div
        className={`text-sm font-medium ${SETUP_TONE_TEXT[check.tone]}`}
        data-testid="household-setup-title"
      >
        {check.title}
      </div>
      <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        {check.detail}
      </div>
      {check.cta &&
        (check.cta.scope === "login" ? (
          // A route about the VIEWER's own login/instance configuration — Settings →
          // People & access (the grant UI `setGrants` can finally act on since #2345) or
          // Settings → Notifications. No profile switch is involved, so it is an
          // ordinary link.
          <Link
            href={check.cta.href}
            data-testid="household-setup-cta"
            className="mt-1 inline-block text-xs font-medium text-sky-700 hover:underline dark:text-sky-300"
          >
            {check.cta.label} →
          </Link>
        ) : (
          // A route about THIS MEMBER's own data. It needs the profile switch first
          // (#879), and the destination is re-derived server-side from the check id —
          // never posted.
          <form action={openMemberSetupAction} className="mt-1">
            <input type="hidden" name="profileId" value={profileId} />
            <input type="hidden" name="check" value={check.id} />
            <button
              type="submit"
              data-testid="household-setup-cta"
              className="text-xs font-medium text-sky-700 hover:underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-sky-300"
            >
              {check.cta.label} →
            </button>
          </form>
        ))}
    </div>
  );
}

// The member's setup-health block. Rendered-aggregate only: it never sends, and it never
// enters the digest (#2173 constraint 6).
function Setup({
  setup,
  profile,
  canWrite,
}: {
  setup: HouseholdSetupRow;
  profile: AvatarProfile;
  canWrite: boolean;
}) {
  return (
    <div
      className="mt-4 space-y-2 border-t border-black/5 pt-3 dark:border-white/5"
      data-testid="household-setup"
      data-tone={setup.tone}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="section-label">Setup</div>
        {/* Dismiss is EPISODE-scoped (the failing-check set is the key) and is not
        offered at all while the profile is unroutable — a standing "this profile is
        unroutable" dismissal would recreate the silence this exists to remove. The
        action re-checks both, so the absence of the button is UX, not the guarantee. */}
        {canWrite && setup.dismissible && (
          <form action={dismissMemberSetupAction}>
            <input type="hidden" name="profileId" value={profile.id} />
            <input type="hidden" name="dedupe_key" value={setup.dedupeKey} />
            <button
              type="submit"
              data-testid="household-setup-dismiss"
              aria-label={`Dismiss setup notes for ${profile.name}`}
              title="Dismiss"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-600 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-300"
            >
              <IconX className="h-3.5 w-3.5" stroke={2} aria-hidden="true" />
            </button>
          </form>
        )}
      </div>
      <div className="space-y-2.5">
        {setup.checks.map((check) => (
          <SetupCheckRow key={check.id} check={check} profileId={profile.id} />
        ))}
      </div>
    </div>
  );
}

export default function HouseholdCard({ data }: { data: HouseholdCardData }) {
  const {
    profile,
    adherence,
    intakeDeltaLine,
    lastActivity,
    activities7d,
    weightLabel,
    weightWhen,
    trend,
    weightUnit,
    oorBiomarkers,
    goals,
    sick,
    presence,
    dataQuality,
    setup,
  } = data;

  return (
    <div
      className="card"
      data-testid="household-card"
      data-profile-id={profile.id}
    >
      {/* Header = the profile-switch affordance (issue #31 keeps switching one tap
      away). A form/button, so it can't wrap the confirm forms below (nested forms
      are invalid) — the card is a plain container instead of one big button. */}
      <form action={openProfileAction}>
        <input type="hidden" name="profileId" value={profile.id} />
        <button
          type="submit"
          data-testid="household-open"
          className="-m-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg p-2 text-left transition hover:bg-slate-50 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-ink-850"
        >
          <Avatar profile={profile} size="md" />
          <span className="min-w-0 flex-1 truncate text-base font-semibold text-slate-900 dark:text-slate-100">
            {profile.name}
          </span>
          <IconChevronRight
            className="h-5 w-5 shrink-0 text-slate-300 dark:text-slate-600"
            stroke={1.75}
            aria-hidden="true"
          />
        </button>
      </form>

      {sick && (
        <div
          data-testid="household-sick-chip"
          className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
        >
          <IconVirus className="h-3.5 w-3.5" stroke={1.75} aria-hidden="true" />
          {sick}
        </div>
      )}

      {presence && (
        <div
          data-testid="household-presence-chip"
          className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
        >
          <IconBarbell
            className="h-3.5 w-3.5"
            stroke={1.75}
            aria-hidden="true"
          />
          {presence}
        </div>
      )}

      {dataQuality && (
        <div
          data-testid="household-data-quality"
          className="mt-3 flex items-start gap-1.5 text-xs text-slate-500 dark:text-slate-400"
        >
          <IconChecklist
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            stroke={1.75}
            aria-hidden="true"
          />
          <span className="min-w-0">{dataQuality}</span>
        </div>
      )}

      {intakeDeltaLine && (
        <div
          data-testid="household-intake-delta"
          className="mt-3 flex items-start gap-1.5 text-xs text-slate-500 dark:text-slate-400"
        >
          <IconPill
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            stroke={1.75}
            aria-hidden="true"
          />
          <span className="min-w-0">{intakeDeltaLine}</span>
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
        <Stat label="Supplements">
          {adherence.due > 0 ? (
            <span>
              {adherence.taken}/{adherence.due}{" "}
              <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                today
              </span>
            </span>
          ) : (
            <span className="text-slate-500 dark:text-slate-400">none due</span>
          )}
        </Stat>

        <Stat label="Out of range">
          {oorBiomarkers > 0 ? (
            <span className="text-rose-600 dark:text-rose-400">
              {oorBiomarkers} biomarker{oorBiomarkers === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="text-slate-500 dark:text-slate-400">none</span>
          )}
        </Stat>

        <Stat label={`Last activity · ${activities7d} in 7d`}>
          {lastActivity ? (
            <span className="flex items-baseline gap-1">
              <span className="truncate">{lastActivity.title}</span>
              <span className="shrink-0 text-xs font-normal text-slate-500 dark:text-slate-400">
                {lastActivity.when}
              </span>
            </span>
          ) : (
            <span className="text-slate-500 dark:text-slate-400">
              nothing logged
            </span>
          )}
        </Stat>

        <Stat label="Weight">
          {weightLabel ? (
            <span className="flex items-center gap-1.5">
              <span>{weightLabel}</span>
              {trend && <TrendArrow trend={trend} unit={weightUnit} />}
              {weightWhen && (
                <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                  {weightWhen}
                </span>
              )}
            </span>
          ) : (
            <span className="text-slate-500 dark:text-slate-400">
              no entries
            </span>
          )}
        </Stat>
      </div>

      {goals.length > 0 && (
        <div className="mt-4 space-y-2 border-t border-black/5 pt-3 dark:border-white/5">
          {goals.map((g) => (
            <div key={g.id}>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate font-medium text-slate-600 dark:text-slate-300">
                  {g.title}
                </span>
                {g.pct != null && (
                  <span className="shrink-0 text-slate-500 dark:text-slate-400">
                    {g.pct}%
                  </span>
                )}
              </div>
              {g.pct != null && (
                <div className="mt-1 h-1.5 w-full rounded-full bg-slate-100 dark:bg-ink-800">
                  <div
                    className={`h-1.5 rounded-full ${g.barClass}`}
                    style={{ width: `${g.pct}%` }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Attention data={data} />

      {/* Setup health sits BELOW today's attention on purpose: "what needs doing today"
      leads, and "why this member may never be told" is the standing structural note
      under it. */}
      {setup && (
        <Setup setup={setup} profile={profile} canWrite={data.canWrite} />
      )}
    </div>
  );
}
