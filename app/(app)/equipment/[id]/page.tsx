import Link from "next/link";
import { notFound } from "next/navigation";
import { IconBarbell } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getEquipmentById } from "@/lib/equipment";
import { getEquipmentUsageById, getEquipmentSessions } from "@/lib/queries";
import {
  getUnitPrefs,
  getDisplayFormatPrefs,
  getProfileAge,
  getTimezone,
} from "@/lib/settings";
import { kindOf } from "@/lib/types";
import {
  isStrengthTrainingRelevant,
  isTrainingRelevant,
} from "@/lib/life-stage";
import { kgTo, kmTo, round } from "@/lib/units";
import { formatLastUsed } from "@/lib/usage-format";
import { formatRecordDate } from "@/lib/record-format";
import { dateFromCreatedAt } from "@/lib/timeline-format";
import { PageHeader, EmptyState } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import EquipmentTrend from "@/components/EquipmentTrend";
import EquipmentDetailActions from "@/components/EquipmentDetailActions";
import BackLink from "@/components/BackLink";
import { StatBox } from "@/components/StatBox";

export const dynamic = "force-dynamic";

// Equipment detail (issue #343): a single piece of gear's identity + the usage
// payoff (sessions, last used, Σ volume lifted, Σ distance for shoes/bikes) with a
// small trend chart, plus the retire/delete lifecycle. Scoped by (profile, id) so
// a guessed id from another profile 404s. The usage comes from the SAME
// profile-scoped read the index badges use (one computation, two formatters).
export default async function EquipmentDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  const { login, profile } = await requireSession();
  const id = Number(params.id);
  const equipment = id ? getEquipmentById(profile.id, id) : undefined;
  if (!equipment) notFound();

  const kind = kindOf(equipment.category);
  const trainingRelevant = isTrainingRelevant(getProfileAge(profile.id));
  if (
    kind === "strength" &&
    !isStrengthTrainingRelevant(getProfileAge(profile.id))
  )
    notFound();

  const units = getUnitPrefs(login.id);
  const fmt = getDisplayFormatPrefs(login.id);
  const usage = getEquipmentUsageById(profile.id, id);
  const sessions = getEquipmentSessions(profile.id, id);

  const sessionCount = usage?.sessions ?? 0;
  const lastUsed = usage?.lastUsed ?? null;
  const totalVolumeKg = usage?.totalVolumeKg ?? 0;
  const totalDistanceKm = usage?.totalDistanceKm ?? 0;

  // A cardio implement (bike/shoes) shows distance; everything else shows lifted
  // volume as its primary "how much" stat.
  const showsDistance = kind === "cardio" && totalDistanceKm > 0;
  const trendPoints = showsDistance
    ? sessions.map((s) => kmTo(s.distanceKm, units.distanceUnit))
    : sessions.map((s) => kgTo(s.volumeKg, units.weightUnit));

  return (
    <PageContainer width="reading" data-testid="equipment-detail">
      <BackLink href="/equipment" label="Back to equipment" />

      <PageHeader
        title={equipment.name}
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            <IconBarbell className="h-4 w-4" stroke={1.75} />
            {equipment.category ?? "Uncategorized"}
            {equipment.retired ? (
              <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                Retired
              </span>
            ) : null}
          </span>
        }
      />

      <dl className="grid gap-3 sm:grid-cols-3">
        <StatBox
          label="Sessions"
          value={String(sessionCount)}
          data-testid="equipment-stat-sessions"
        />
        <StatBox
          label="Last used"
          value={formatLastUsed(lastUsed, today(profile.id))}
          sub={lastUsed ? formatRecordDate(lastUsed, "", fmt) : null}
          data-testid="equipment-stat-last-used"
        />
        {showsDistance ? (
          <StatBox
            label="Total distance"
            value={`${round(kmTo(totalDistanceKm, units.distanceUnit), 1)} ${units.distanceUnit}`}
            data-testid="equipment-stat-distance"
          />
        ) : (
          <StatBox
            label="Total volume"
            value={`${round(kgTo(totalVolumeKg, units.weightUnit), 0)} ${units.weightUnit}`}
            data-testid="equipment-stat-volume"
          />
        )}
      </dl>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <StatBox
          label="Own weight"
          value={
            equipment.weight_kg != null
              ? `${round(kgTo(equipment.weight_kg, units.weightUnit), 2)} ${units.weightUnit}`
              : "not set"
          }
          sub="reference only — logged loads are always the total"
        />
        <StatBox
          label="Added"
          // WHICH day, then how it reads (#3573). `equipment.created_at` is an
          // instant; this printed its first ten characters, which is the UTC day.
          // A bike added at 17:00 in UTC−08:00 read as Added tomorrow. The fallback
          // is `null`, which formatRecordDate renders as "—": a stamp that will not
          // parse has no day, and "—" is what this tile already says for absent.
          value={formatRecordDate(
            dateFromCreatedAt(equipment.created_at, getTimezone(profile.id)),
            "—",
            fmt
          )}
        />
      </dl>

      {trendPoints.length > 0 ? (
        <div className="band mt-6 rounded-xl border border-(--border) bg-surface p-4">
          <EquipmentTrend
            points={trendPoints}
            label={
              showsDistance ? "Distance per session" : "Volume per session"
            }
            ariaLabel={`Usage trend for ${equipment.name}`}
            loneCaption={`Single reading · ${round(trendPoints[0], showsDistance ? 2 : 0)} ${showsDistance ? units.distanceUnit : units.weightUnit} · ${formatRecordDate(sessions[0].date, "", fmt)}`}
          />
        </div>
      ) : (
        <div className="mt-6">
          <EmptyState
            compact
            data-testid="equipment-no-usage"
            message={
              trainingRelevant
                ? "No sessions have used this equipment yet. Tag a workout with it to start building usage history."
                : "No sessions have used this equipment yet."
            }
            action={
              trainingRelevant
                ? { href: "/training", label: "Log a workout" }
                : undefined
            }
          />
        </div>
      )}

      {sessions.length > 0 ? (
        <div className="mt-6">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Recent sessions
          </h2>
          <ul className="band divide-y divide-black/5 rounded-xl border border-black/5 dark:divide-white/10 dark:border-white/10">
            {[...sessions]
              .reverse()
              .slice(0, 12)
              .map((s) => (
                <li
                  key={s.activityId}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                >
                  <Link
                    href={s.href}
                    data-testid="equipment-session-link"
                    className="min-w-0 truncate font-medium text-slate-800 hover:text-brand-700 hover:underline dark:text-slate-100 dark:hover:text-brand-300"
                  >
                    {s.title}
                  </Link>
                  <span className="flex shrink-0 items-center gap-3 tabular-nums text-xs text-slate-500 dark:text-slate-400">
                    {showsDistance && s.distanceKm > 0 ? (
                      <span>
                        {round(kmTo(s.distanceKm, units.distanceUnit), 2)}{" "}
                        {units.distanceUnit}
                      </span>
                    ) : s.volumeKg > 0 ? (
                      <span>
                        {round(kgTo(s.volumeKg, units.weightUnit), 0)}{" "}
                        {units.weightUnit}
                      </span>
                    ) : null}
                    <span>{formatRecordDate(s.date, "", fmt)}</span>
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-6 border-t border-black/5 pt-4 dark:border-white/10">
        <EquipmentDetailActions
          id={equipment.id}
          name={equipment.name}
          retired={!!equipment.retired}
        />
      </div>
    </PageContainer>
  );
}
