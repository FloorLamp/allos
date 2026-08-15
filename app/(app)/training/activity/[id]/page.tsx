import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import PageContainer from "@/components/PageContainer";
import { accessForProfile, requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { getUnitPrefs, getDisplayFormatPrefs } from "@/lib/settings";
import { getActivityDetailData } from "@/lib/training-activity-detail";
import {
  rideDetailHref,
  rideHeartRateSeries,
  rideZoneRows,
} from "@/lib/ride-detail";
import { trainingActivityPageHref } from "@/lib/hrefs";
import { ZONE_COLORS } from "@/lib/training-zones";
import ActivityRecord from "../ActivityRecord";
import RideHeartRateChart from "../../rides/[id]/RideHeartRateChart";

export const dynamic = "force-dynamic";

// One activity's canonical page (#2870 step 1): the record, at its own URL.
// The record IS the Training Log card — rendered whole (sets, statuses, notes,
// clips, provenance, fault warnings, the full menu with same-day merge
// targets), so every surface that used to anchor into the log list lands on a
// page that can do everything the card could. Heart rate renders LAST
// (owner-ruled: a strength record leads with the work; HR is its appendix),
// through the same window → minutes → zones pipeline the ride page uses.
// Cycling activities keep their bespoke ride page; this route redirects them.
export default async function TrainingActivityPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await props.params;
  const id = Number.parseInt(rawId, 10);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const { login, profile } = await requireSession();
  if (isTrainingRestricted(profile.id)) redirect("/training");

  const units = getUnitPrefs(login.id);
  const data = getActivityDetailData(
    profile.id,
    id,
    units,
    getDisplayFormatPrefs(login.id)
  );
  if (!data) notFound();

  // Cycling keeps its dedicated performance page (#2566's convergence step
  // decides its future) — the canonical URL for a ride is the ride page.
  const ride = rideDetailHref(data.row);
  if (ride) redirect(ride);

  const canWrite =
    accessForProfile(login.id, login.role, profile.id) === "write";
  const heartRateSeries = rideHeartRateSeries(
    data.heartRate.window,
    data.heartRate.minutes
  );
  const zoneRows = data.heartRate.zoneMinutes
    ? rideZoneRows(data.heartRate.zoneMinutes)
    : [];
  const zoneTotal = zoneRows.reduce((sum, zone) => sum + zone.minutes, 0);

  return (
    <PageContainer
      width="reading"
      className="mx-auto"
      data-testid="training-activity-page"
    >
      <div className="mb-4 flex items-center gap-3 text-sm">
        <Link
          href="/training?tab=log"
          className="inline-flex items-center gap-1 font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
          <IconChevronLeft className="h-4 w-4" aria-hidden /> Training log
        </Link>
        {/* ‹ older / newer › walk the ledger in (date, id) order so a review
            session continues without bouncing back to a list (#2870). */}
        <span className="ml-auto flex items-center gap-3">
          {data.olderId != null && (
            <Link
              href={trainingActivityPageHref(data.olderId)}
              data-testid="activity-older-link"
              className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline dark:text-brand-400"
            >
              <IconChevronLeft className="h-4 w-4" aria-hidden /> Older
            </Link>
          )}
          {data.newerId != null && (
            <Link
              href={trainingActivityPageHref(data.newerId)}
              data-testid="activity-newer-link"
              className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline dark:text-brand-400"
            >
              Newer <IconChevronRight className="h-4 w-4" aria-hidden />
            </Link>
          )}
        </span>
      </div>

      <ActivityRecord
        card={data.card}
        siblings={data.siblings}
        units={units}
        canWrite={canWrite}
      />

      {heartRateSeries.length > 0 && (
        <div className="card mt-4" data-testid="activity-heart-rate">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="font-semibold text-slate-800 dark:text-slate-100">
              Heart rate
            </h3>
            <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
              {data.heartRate.minutes.length} recorded min
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            One-minute readings recorded during this session. A break in the
            line is a gap in wear.
          </p>
          <div className="mt-4">
            <RideHeartRateChart
              data={heartRateSeries}
              rideDate={data.row.date}
              zoneModel={data.heartRate.zoneModel}
            />
          </div>
          {zoneTotal > 0 && (
            <div className="mt-4" data-testid="activity-heart-rate-zones">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                Time in zones
              </h3>
              <div
                className="mt-3 flex h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-ink-800"
                aria-hidden
              >
                {zoneRows.map((zone, index) =>
                  zone.minutes > 0 ? (
                    <span
                      key={zone.id}
                      style={{
                        width: `${(zone.minutes / zoneTotal) * 100}%`,
                        backgroundColor: ZONE_COLORS[index],
                      }}
                    />
                  ) : null
                )}
              </div>
              <ul className="mt-3 space-y-2">
                {zoneRows.map((zone, index) => (
                  <li
                    key={zone.id}
                    data-testid={`activity-zone-${zone.id}`}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: ZONE_COLORS[index] }}
                      />
                      <span className="font-medium text-slate-700 dark:text-slate-200">
                        {zone.name}
                      </span>
                      <span className="truncate text-slate-500 dark:text-slate-400">
                        {zone.label}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums text-slate-600 dark:text-slate-300">
                      {zone.minutes} min · {zone.percent}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </PageContainer>
  );
}
