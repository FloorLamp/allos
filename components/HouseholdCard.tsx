import {
  IconChevronRight,
  IconTrendingDown,
  IconTrendingUp,
  IconMinus,
  IconPill,
  IconAlarm,
  IconCalendarEvent,
  IconCheck,
} from "@tabler/icons-react";
import Avatar from "@/components/Avatar";
import type { AvatarProfile } from "@/components/Avatar";
import {
  openProfileAction,
  confirmDoseAction,
} from "@/app/(app)/household/actions";
import { fmtWeight } from "@/lib/units";
import { upcomingDueText } from "@/lib/upcoming";
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
  // Today's attention items (due doses / low refills / next visit) for this profile.
  rollup: HouseholdRollup;
  // This profile's "today" (resolved in its timezone) — for the appointment due-text.
  today: string;
  adherence: Adherence;
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
      <div className="text-[0.65rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </div>
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

function Attention({ data }: { data: HouseholdCardData }) {
  const { profile, canWrite, rollup, today } = data;
  const { dueDoses, lowRefills, nextAppointment } = rollup;
  const nothing =
    dueDoses.length === 0 && lowRefills.length === 0 && !nextAppointment;

  return (
    <div className="mt-4 space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
      <div className="text-[0.65rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Attention today
      </div>
      {nothing ? (
        <div
          className="text-sm text-slate-500 dark:text-slate-400"
          data-testid="household-all-clear"
        >
          Nothing needs attention.
        </div>
      ) : (
        <div className="space-y-2">
          {dueDoses.map((item) => (
            <AttentionRow
              key={item.key}
              Icon={IconPill}
              title={item.title}
              detail={item.detail}
              testid="household-due-dose"
              action={
                canWrite && item.doseId != null ? (
                  // Confirm this dose for THIS profile without switching to it —
                  // the hidden profileId targets the action at the card's profile.
                  <form action={confirmDoseAction}>
                    <input type="hidden" name="profileId" value={profile.id} />
                    <input type="hidden" name="dose_id" value={item.doseId} />
                    <button
                      type="submit"
                      data-testid="household-confirm-dose"
                      className="inline-flex items-center gap-1 rounded-md border border-black/10 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
                    >
                      <IconCheck
                        className="h-3.5 w-3.5"
                        stroke={2}
                        aria-hidden="true"
                      />
                      Confirm
                    </button>
                  </form>
                ) : null
              }
            />
          ))}
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
              detail={upcomingDueText(nextAppointment, today)}
              testid="household-next-appointment"
            />
          )}
        </div>
      )}
    </div>
  );
}

export default function HouseholdCard({ data }: { data: HouseholdCardData }) {
  const {
    profile,
    adherence,
    lastActivity,
    activities7d,
    weightLabel,
    weightWhen,
    trend,
    weightUnit,
    oorBiomarkers,
    goals,
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
          className="-m-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg p-2 text-left transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-ink-850"
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
        <div className="mt-4 space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
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
    </div>
  );
}
