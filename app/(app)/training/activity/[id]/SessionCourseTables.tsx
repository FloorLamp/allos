import CardGroup from "@/components/CardGroup";
import { ResponsiveTable, Td } from "@/components/ResponsiveTable";
import type {
  SessionLap,
  SessionSegmentEffort,
} from "@/lib/queries/training/session-course";
import type { DistanceUnit } from "@/lib/settings";
import { formatElapsed } from "@/lib/session-detail";
import { fmtDistance, fmtKmh } from "@/lib/units";

export default function SessionCourseTables({
  laps,
  segmentEfforts,
  distanceUnit,
}: {
  laps: SessionLap[];
  segmentEfforts: SessionSegmentEffort[];
  distanceUnit: DistanceUnit;
}) {
  const showLapPower = laps.some((lap) => lap.averageWatts != null);
  const showSegmentPower = segmentEfforts.some(
    (effort) => effort.averageWatts != null
  );

  return (
    <>
      {laps.length > 0 ? (
        <CardGroup title="Laps" className="mt-4" data-testid="session-laps">
          <div className="mt-4">
            <ResponsiveTable className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-black/10 text-left text-xs font-medium text-slate-500 dark:border-white/10 dark:text-slate-400">
                  <th className="th">Lap</th>
                  <th className="th text-right">Distance</th>
                  <th className="th text-right">Time</th>
                  <th className="th text-right">Speed</th>
                  {showLapPower ? (
                    <th className="th text-right">Power</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {laps.map((lap) => (
                  <tr
                    key={lap.id}
                    className="border-b border-black/5 last:border-0 dark:border-white/5"
                  >
                    <Td slot="title" className="py-2.5 pr-3 font-medium">
                      {lap.name ?? `Lap ${lap.lapIndex}`}
                    </Td>
                    <Td
                      slot="value"
                      label="Distance"
                      className="px-3 py-2.5 text-right tabular-nums"
                    >
                      {lap.distanceM == null
                        ? "—"
                        : fmtDistance(lap.distanceM / 1000, distanceUnit)}
                    </Td>
                    <Td
                      slot="meta"
                      label="Time"
                      className="px-3 py-2.5 text-right tabular-nums"
                    >
                      {formatElapsed(lap.movingTimeSec)}
                    </Td>
                    <Td
                      slot="meta"
                      label="Speed"
                      className="px-3 py-2.5 text-right tabular-nums"
                    >
                      {lap.averageSpeedMps == null
                        ? "—"
                        : fmtKmh(lap.averageSpeedMps * 3.6, distanceUnit)}
                    </Td>
                    {showLapPower ? (
                      <Td
                        slot="meta"
                        label="Power"
                        className="py-2.5 pl-3 text-right tabular-nums"
                      >
                        {lap.averageWatts == null
                          ? "—"
                          : `${Math.round(lap.averageWatts)} W`}
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </ResponsiveTable>
          </div>
        </CardGroup>
      ) : null}

      {segmentEfforts.length > 0 ? (
        <CardGroup
          title="Segments"
          className="mt-4"
          data-testid="session-segments"
        >
          <div className="mt-4">
            <ResponsiveTable className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-black/10 text-left text-xs font-medium text-slate-500 dark:border-white/10 dark:text-slate-400">
                  <th className="th">Segment</th>
                  <th className="th text-right">Distance</th>
                  <th className="th text-right">Time</th>
                  {showSegmentPower ? (
                    <th className="th text-right">Power</th>
                  ) : null}
                  <th className="th text-right">Result</th>
                </tr>
              </thead>
              <tbody>
                {segmentEfforts.map((effort) => (
                  <tr
                    key={effort.id}
                    className="border-b border-black/5 last:border-0 dark:border-white/5"
                  >
                    <Td slot="title" className="py-2.5 pr-3 font-medium">
                      {effort.name}
                    </Td>
                    <Td
                      slot="value"
                      label="Distance"
                      className="px-3 py-2.5 text-right tabular-nums"
                    >
                      {effort.distanceM == null
                        ? "—"
                        : fmtDistance(effort.distanceM / 1000, distanceUnit)}
                    </Td>
                    <Td
                      slot="meta"
                      label="Time"
                      className="px-3 py-2.5 text-right tabular-nums"
                    >
                      {formatElapsed(effort.movingTimeSec)}
                    </Td>
                    {showSegmentPower ? (
                      <Td
                        slot="meta"
                        label="Power"
                        className="px-3 py-2.5 text-right tabular-nums"
                      >
                        {effort.averageWatts == null
                          ? "—"
                          : `${Math.round(effort.averageWatts)} W`}
                      </Td>
                    ) : null}
                    <Td
                      slot="meta"
                      label="Result"
                      className="py-2.5 pl-3 text-right font-medium"
                    >
                      {effort.komRank
                        ? `KOM #${effort.komRank}`
                        : effort.prRank
                          ? `PR #${effort.prRank}`
                          : "—"}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </ResponsiveTable>
          </div>
        </CardGroup>
      ) : null}
    </>
  );
}
