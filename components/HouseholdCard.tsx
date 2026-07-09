import {
  IconChevronRight,
  IconTrendingDown,
  IconTrendingUp,
  IconMinus,
} from "@tabler/icons-react";
import Avatar from "@/components/Avatar";
import type { AvatarProfile } from "@/components/Avatar";
import { openProfileAction } from "@/app/(app)/household/actions";
import { goalBarClass } from "@/lib/goals";
import { fmtWeight } from "@/lib/units";
import type { WeightUnit } from "@/lib/settings";
import type { Adherence, GoalHighlight, WeightTrend } from "@/lib/household";

// One compact, at-a-glance card per profile on the admin household dashboard
// (issue #102). The whole card is a submit button bound to openProfileAction, so
// a single click switches the session's active profile to this person and jumps
// to their dashboard — the same "set active profile + navigate" as the header
// switcher. Presentational only: the page assembles the numbers (via the pure
// lib/household helpers over per-profile queries) and passes display-ready values.
export interface HouseholdCardData {
  profile: AvatarProfile;
  adherence: Adherence;
  lastActivity: { title: string; when: string } | null;
  activities7d: number;
  // Preformatted in the viewing admin's unit preference, or null with no weigh-in.
  weightLabel: string | null;
  weightWhen: string | null;
  trend: WeightTrend | null;
  // The viewing admin's weight unit, so the trend delta reads in the same unit
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
      className="inline-flex items-center text-slate-400 dark:text-slate-500"
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
      <div className="text-[0.65rem] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold text-slate-800 dark:text-slate-100">
        {children}
      </div>
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
    <form action={openProfileAction}>
      <input type="hidden" name="profileId" value={profile.id} />
      <button
        type="submit"
        className="card block w-full text-left transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <div className="flex items-center gap-3">
          <Avatar profile={profile} size="md" />
          <span className="min-w-0 flex-1 truncate text-base font-semibold text-slate-900 dark:text-slate-100">
            {profile.name}
          </span>
          <IconChevronRight
            className="h-5 w-5 shrink-0 text-slate-300 dark:text-slate-600"
            stroke={1.75}
            aria-hidden="true"
          />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
          <Stat label="Supplements">
            {adherence.due > 0 ? (
              <span>
                {adherence.taken}/{adherence.due}{" "}
                <span className="text-xs font-normal text-slate-400 dark:text-slate-500">
                  today
                </span>
              </span>
            ) : (
              <span className="text-slate-400 dark:text-slate-500">
                none due
              </span>
            )}
          </Stat>

          <Stat label="Out of range">
            {oorBiomarkers > 0 ? (
              <span className="text-rose-600 dark:text-rose-400">
                {oorBiomarkers} biomarker{oorBiomarkers === 1 ? "" : "s"}
              </span>
            ) : (
              <span className="text-slate-400 dark:text-slate-500">none</span>
            )}
          </Stat>

          <Stat label={`Last activity · ${activities7d} in 7d`}>
            {lastActivity ? (
              <span className="flex items-baseline gap-1">
                <span className="truncate">{lastActivity.title}</span>
                <span className="shrink-0 text-xs font-normal text-slate-400 dark:text-slate-500">
                  {lastActivity.when}
                </span>
              </span>
            ) : (
              <span className="text-slate-400 dark:text-slate-500">
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
                  <span className="text-xs font-normal text-slate-400 dark:text-slate-500">
                    {weightWhen}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-slate-400 dark:text-slate-500">
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
                    <span className="shrink-0 text-slate-400 dark:text-slate-500">
                      {g.pct}%
                    </span>
                  )}
                </div>
                {g.pct != null && (
                  <div className="mt-1 h-1.5 w-full rounded-full bg-slate-100 dark:bg-ink-800">
                    <div
                      className={`h-1.5 rounded-full ${goalBarClass(g.pct)}`}
                      style={{ width: `${g.pct}%` }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </button>
    </form>
  );
}
