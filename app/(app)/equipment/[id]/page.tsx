import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { IconArrowLeft, IconBarbell } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getEquipmentById } from "@/lib/equipment";
import { getEquipmentUsageById, getEquipmentSessions } from "@/lib/queries";
import { getUnitPrefs } from "@/lib/settings";
import { isTrainingRestricted } from "@/lib/age-gate";
import { kindOf } from "@/lib/types";
import { kgTo, kmTo, round } from "@/lib/units";
import { formatLastUsed } from "@/lib/usage-format";
import { formatRecordDate } from "@/lib/record-format";
import { PageHeader } from "@/components/ui";
import EquipmentTrend from "@/components/EquipmentTrend";
import EquipmentDetailActions from "@/components/EquipmentDetailActions";

export const dynamic = "force-dynamic";

function Stat({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: string;
  sub?: string | null;
  // Stable e2e hook for a stat whose label text also appears elsewhere on the
  // page ("Sessions" vs the "Recent sessions" heading — Playwright strict mode).
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="rounded-lg border border-black/5 bg-white/60 px-4 py-3 dark:border-white/10 dark:bg-black/10"
    >
      <div className="section-label">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-slate-800 dark:text-slate-100">
        {value}
      </div>
      {sub ? (
        <div className="text-xs text-slate-500 dark:text-slate-400">{sub}</div>
      ) : null}
    </div>
  );
}

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
  if (isTrainingRestricted(profile.id)) redirect("/");

  const id = Number(params.id);
  const equipment = id ? getEquipmentById(profile.id, id) : undefined;
  if (!equipment) notFound();

  const units = getUnitPrefs(login.id);
  const usage = getEquipmentUsageById(profile.id, id);
  const sessions = getEquipmentSessions(profile.id, id);
  const kind = kindOf(equipment.category);

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
    <div className="max-w-3xl" data-testid="equipment-detail">
      <Link
        href="/equipment"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-brand-700 dark:text-slate-400 dark:hover:text-brand-300"
      >
        <IconArrowLeft className="h-4 w-4" stroke={1.75} />
        Back to equipment
      </Link>

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

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Sessions"
          value={String(sessionCount)}
          testId="equipment-stat-sessions"
        />
        <Stat
          label="Last used"
          value={formatLastUsed(lastUsed, today(profile.id))}
          sub={lastUsed ? formatRecordDate(lastUsed, "") : null}
          testId="equipment-stat-last-used"
        />
        {showsDistance ? (
          <Stat
            label="Total distance"
            value={`${round(kmTo(totalDistanceKm, units.distanceUnit), 1)} ${units.distanceUnit}`}
            testId="equipment-stat-distance"
          />
        ) : (
          <Stat
            label="Total volume"
            value={`${round(kgTo(totalVolumeKg, units.weightUnit), 0)} ${units.weightUnit}`}
            testId="equipment-stat-volume"
          />
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Stat
          label="Own weight"
          value={
            equipment.weight_kg != null
              ? `${round(kgTo(equipment.weight_kg, units.weightUnit), 2)} ${units.weightUnit}`
              : "not set"
          }
          sub="reference only — logged loads are always the total"
        />
        <Stat
          label="Added"
          value={formatRecordDate(equipment.created_at.slice(0, 10), "—")}
        />
      </div>

      {trendPoints.length > 0 ? (
        <div className="mt-6 rounded-xl border border-black/5 bg-white/60 p-4 dark:border-white/10 dark:bg-black/10">
          <EquipmentTrend
            points={trendPoints}
            label={
              showsDistance ? "Distance per session" : "Volume per session"
            }
            ariaLabel={`Usage trend for ${equipment.name}`}
          />
        </div>
      ) : (
        <p
          className="mt-6 rounded-lg border border-dashed border-black/10 px-4 py-6 text-center text-sm text-slate-500 dark:border-white/10 dark:text-slate-400"
          data-testid="equipment-no-usage"
        >
          No sessions have used this equipment yet. Tag a workout with it to
          start building usage history.
        </p>
      )}

      {sessions.length > 0 ? (
        <div className="mt-6">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Recent sessions
          </h2>
          <ul className="divide-y divide-black/5 rounded-xl border border-black/5 dark:divide-white/10 dark:border-white/10">
            {[...sessions]
              .reverse()
              .slice(0, 12)
              .map((s) => (
                <li
                  key={s.activityId}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                >
                  <span className="min-w-0 truncate text-slate-800 dark:text-slate-100">
                    {s.title}
                  </span>
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
                    <span>{formatRecordDate(s.date, "")}</span>
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
    </div>
  );
}
