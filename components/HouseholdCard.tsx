import {
  IconTrendingDown,
  IconTrendingUp,
  IconMinus,
  IconPill,
  IconVirus,
  IconBarbell,
  IconChecklist,
  IconX,
} from "@tabler/icons-react";
import DestinationIndicator from "@/components/DestinationIndicator";
import DestinationLink from "@/components/DestinationLink";
import Avatar from "@/components/Avatar";
import IconButton from "@/components/IconButton";
import CardSectionHeader from "@/components/CardSectionHeader";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";
import {
  PILLAR_TONE_CLASS,
  PillarToneBadge,
} from "@/components/dashboard/HealthspanPillarPresentation";
import type { PillarTone } from "@/lib/longevity-pillars";
import type { AvatarProfile } from "@/components/Avatar";
import {
  openProfileAction,
  openMemberDayAction,
  openMemberSetupAction,
  dismissMemberSetupAction,
} from "@/app/(app)/household/actions";
import type {
  HouseholdSetupCheck,
  HouseholdSetupRow,
} from "@/lib/household-setup";
import type { FindingTone } from "@/lib/findings";
import { fmtWeight } from "@/lib/units";
import type { RecentChangeRender } from "@/lib/recent-changes";
import type { WeightUnit } from "@/lib/settings";
import type { Adherence, GoalHighlight, WeightTrend } from "@/lib/household";

// One compact, at-a-glance card per profile on the household dashboard (issue
// #31), sharpened by #1463 into the family STATUS BOARD: status strip, then the
// member's 7-day recent-changes digest, then one link out to where the work is done.
// The header is a submit button bound to openProfileAction — one click switches the
// session's active profile to this person and opens their dashboard.
//
// IN-APP ACTIONS ARE CEDED, NOT LOST (#1463 §1, owner-approved 2026-07-25). The card
// used to carry per-dose confirm forms and the actionable rollup list; Upcoming
// multi-view owns cross-profile in-app actions now (its rows carry the subject-gated
// "Mark taken" over the same markDoseTaken), and #1459 owns the away-from-app dose
// moment. A card is a summary, not a second action surface — so what stands here is
// the attention COUNT and its link, not the rows.
//
// Presentational only: the page assembles every value (the pure lib/household helpers,
// collectHouseholdRollup for the count, and collectRecentChanges for the digest) and
// passes display-ready data.
export interface HouseholdCardData {
  profile: AvatarProfile;
  // The caller's access to THIS profile: gates the setup row's dismiss.
  canWrite: boolean;
  // The member's 7-DAY DIGEST, straight off the shipped collector (#1463 §2 /
  // lib/recent-changes.ts) — already ranked, already capped, already masked, and
  // already worded, because §3 puts masking inside the collector so no formatter can
  // forget it. `lines` is the capped set with the "+N more this week" line appended
  // LAST when `overflow > 0`, which is the only line this card turns into a link.
  recent: RecentChangeRender;
  // How many attention items this member has today (due doses + low refills + the
  // soonest visit), counted off the SAME collectHouseholdRollup aggregation the card
  // used to render as rows. Zero renders nothing.
  attention: number;
  adherence: Adherence;
  // The pushed tier's state-change headline (#1505 part 3) — "Missed: Magnesium
  // (3 days)" — preformatted by the ONE shared `intakeDeltaLine` the morning digest
  // and the weekly recap also render. Null on a quiet window: no state change, no
  // line. The x/y fraction beside it is unchanged and still counts `may`
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
  // The BROAD-PANEL optimal fraction the dashboard's own pillar states (#3487 item 1,
  // owner-ruled 2026-08-21) — `optimal of total`, plus the pillar's tone so the glance
  // and the dashboard render one judgment. Null when the profile has no judgeable
  // marker at all, which is the same condition that omits the pillar entirely.
  // This replaced a bare rose count of every out-of-lab-range analyte; that OOR read
  // left this page with it (#2479 explains why both were "right").
  biomarkers: { optimal: number; total: number; tone: PillarTone } | null;
  goals: GoalHighlight[];
  // A one-line "sick day N · 101.3°F" chip when this profile has an OPEN illness
  // episode (issue #801), else null — the household mirror of the dashboard card.
  sick: string | null;
  // A compact "mid-workout · N min" chip while this profile is in a live session
  // (#921), else null. Live-only and unlinked (no cross-profile activity route).
  presence: string | null;
  // A compact structural data-quality gaps line (issue #1045), else null — the same
  // ranked gap model the dashboard presentation formats, condensed. Unlinked (a cross-
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
    <span className="inline-flex items-center text-slate-500 dark:text-slate-400">
      <Icon className="h-4 w-4" stroke={1.75} aria-hidden="true" />
      <span className="sr-only">{label}</span>
      <InfoTooltipIcon label={`Weight ${label} since the previous reading`} />
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

// THE WEEK'S DIGEST (#1463 §1 item 2 / §2). Pure formatting over the shipped
// collector: `lines` arrives ranked, capped and masked, so this renders it and adds
// nothing. The card mints no wording of its own — the same rule that already sends
// `intakeDeltaLine` here from the one shared formatter the morning digest renders.
//
// THE OVERFLOW LINE IS THE LAST ONE, and it is the only one that links. `renderRecentChanges`
// appends "+N more this week" after the capped set precisely when `overflow > 0`, so
// the split below reads the contract rather than re-deriving the cap.
//
// AND IT LINKS THROUGH A PROFILE SWITCH, not directly. #1329 took `?subject=` out of the
// URL grammar for good — "reading a member's day means switching to them" — so a bare
// `/history?day=` from this card would silently show the VIEWER's day instead of the
// member's, failing in the reassuring direction. The form posts the member and nothing
// else; `openMemberDayAction` resolves their day in THEIR timezone server-side.
function RecentDigest({
  recent,
  profileId,
}: {
  recent: RecentChangeRender;
  profileId: number;
}) {
  const overflowing = recent.overflow > 0;
  const shown = overflowing ? recent.lines.slice(0, -1) : recent.lines;
  const overflowLine = overflowing
    ? recent.lines[recent.lines.length - 1]
    : null;

  return (
    <div
      className="mt-4 space-y-1.5 border-t border-black/5 pt-3 dark:border-white/5"
      data-testid="household-digest"
    >
      <div className="section-label">This week</div>
      {shown.length === 0 ? (
        // A quiet week says so once. The surface never manufactures news to fill
        // space — the same rule the collector follows when it returns no lines.
        <div
          className="text-sm text-slate-500 dark:text-slate-400"
          data-testid="household-digest-quiet"
        >
          Nothing new this week.
        </div>
      ) : (
        shown.map((line) => (
          <div
            key={line}
            className="truncate text-sm text-slate-700 dark:text-slate-200"
            data-testid="household-digest-line"
          >
            {line}
          </div>
        ))
      )}
      {overflowLine && (
        <form action={openMemberDayAction}>
          <input type="hidden" name="profileId" value={profileId} />
          <button
            type="submit"
            data-testid="household-digest-more"
            className="inline-flex items-center gap-1 text-xs text-link focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {overflowLine}
            <DestinationIndicator />
          </button>
        </form>
      )}
    </div>
  );
}

// "N need attention → Upcoming" (#1463 §1 item 3). The COUNT, not the rows: Upcoming
// multi-view is where a caregiver acts on another member's dose, and this is the door
// to it. An ordinary link — /upcoming is the viewer's own page and needs no profile
// switch to be honest, because the multi-view rows carry their own subject chips.
function AttentionLink({ attention }: { attention: number }) {
  if (attention === 0) return null;
  return (
    <div className="mt-4 border-t border-black/5 pt-3 dark:border-white/5">
      <DestinationLink
        href="/upcoming"
        data-testid="household-attention-link"
        className="inline-flex items-center gap-1 text-sm text-link"
      >
        {attention} {attention === 1 ? "needs" : "need"} attention
      </DestinationLink>
    </div>
  );
}

// Tone → the check row's text colour. The BANDING vocabulary is the attention model's
// existing `FindingTone` (#2173 constraint 2 — content may raise a row, but no new
// severity words); this map is presentation only. Deliberately NOT a bordered tinted
// block: the setup row is a calm configuration note on a glance card, not an alert.
//
// This map is for the check's HEADLINE, not for its link. The two CTAs below draw
// `text-link` — the one inline action-link treatment (#2719), which this block had
// re-hand-rolled as a literal `text-sky-700 dark:text-sky-300` pair on both sites while
// three brand links rendered on the same screen (#3487 item 2). The `action` tone here
// stays sky by the tone map's own rule; the links are ruled by #2719.
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
          <DestinationLink
            href={check.cta.href}
            data-testid="household-setup-cta"
            className="mt-1 inline-block text-xs text-link"
          >
            {check.cta.label}
          </DestinationLink>
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
              className="inline-flex items-center gap-1 text-xs text-link focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {check.cta.label}
              <DestinationIndicator />
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
      <CardSectionHeader title="Setup" variant="label">
        {/* Dismiss is EPISODE-scoped (the failing-check set is the key) and is not
        offered at all while the profile is unroutable — a standing "this profile is
        unroutable" dismissal would recreate the silence this exists to remove. The
        action re-checks both, so the absence of the button is UX, not the guarantee. */}
        {canWrite && setup.dismissible && (
          <form action={dismissMemberSetupAction}>
            <input type="hidden" name="profileId" value={profile.id} />
            <input type="hidden" name="dedupe_key" value={setup.dedupeKey} />
            <IconButton
              type="submit"
              data-testid="household-setup-dismiss"
              label={`Dismiss setup notes for ${profile.name}`}
            >
              <IconX className="h-3.5 w-3.5" stroke={2} aria-hidden="true" />
            </IconButton>
          </form>
        )}
      </CardSectionHeader>
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
    recent,
    attention,
    adherence,
    intakeDeltaLine,
    lastActivity,
    activities7d,
    weightLabel,
    weightWhen,
    trend,
    weightUnit,
    biomarkers,
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
          <DestinationIndicator />
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

        <Stat label="Biomarkers optimal">
          {biomarkers ? (
            <span
              className="flex flex-wrap items-center gap-1.5"
              data-testid="household-biomarkers"
            >
              <span className={PILLAR_TONE_CLASS[biomarkers.tone]}>
                {biomarkers.optimal} of {biomarkers.total}
              </span>
              {/* The tone's TEXT twin (#1220): the verdict may never travel by colour
                  alone, and this is the same badge both pillar surfaces render. */}
              <PillarToneBadge tone={biomarkers.tone} />
            </span>
          ) : (
            <span
              className="text-slate-500 dark:text-slate-400"
              data-testid="household-biomarkers"
            >
              no results yet
            </span>
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

      <RecentDigest recent={recent} profileId={profile.id} />

      <AttentionLink attention={attention} />

      {/* Setup health sits BELOW the week and the attention door on purpose: what
      happened and what needs doing lead, and "why this member may never be told" is
      the standing structural note under it. */}
      {setup && (
        <Setup setup={setup} profile={profile} canWrite={data.canWrite} />
      )}
    </div>
  );
}
