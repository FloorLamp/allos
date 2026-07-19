import { formatRecordDate } from "@/lib/record-format";
import {
  sphereProgression,
  formatDiopter,
} from "@/lib/optical-prescription";
import type { OpticalPrescription } from "@/lib/types";

// Per-eye sphere-over-time progression — the "is it getting worse?" view (#697). A
// compact oldest→newest table of each dated Rx's OD/OS sphere, plus the net change
// per eye (a more-negative sphere = more myopic). Server component: reads the pure
// series builder (the one computation the whole surface shares). Renders nothing
// until there are at least two dated data points to compare.
function NetChange({ label, net }: { label: string; net: number | null }) {
  if (net == null) return null;
  const worse = net < 0; // more negative sphere = more myopic
  const cls = worse
    ? "text-amber-700 dark:text-amber-300"
    : "text-emerald-700 dark:text-emerald-300";
  const sign = net > 0 ? "+" : "";
  return (
    <span className={cls}>
      {label} {sign}
      {net.toFixed(2)} D
    </span>
  );
}

export default function OpticalProgression({
  items,
}: {
  items: OpticalPrescription[];
}) {
  const { points, netOd, netOs } = sphereProgression(items);
  if (points.length < 2) return null;

  return (
    <div className="card space-y-3" data-testid="optical-progression">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Sphere over time
        </h2>
        <div className="flex gap-3 text-xs">
          <NetChange label="OD" net={netOd} />
          <NetChange label="OS" net={netOs} />
        </div>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        A more negative sphere means more nearsighted (myopic). Informational only,
        not medical advice.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
              <th className="py-1 pr-3 font-medium">Date</th>
              <th className="py-1 pr-3 font-medium">OD (right)</th>
              <th className="py-1 font-medium">OS (left)</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr
                key={`${p.date}-${i}`}
                className="border-t border-black/5 dark:border-white/5"
              >
                <td className="py-1 pr-3 whitespace-nowrap text-slate-600 dark:text-slate-300">
                  {formatRecordDate(p.date)}
                </td>
                <td className="py-1 pr-3 tabular-nums">{formatDiopter(p.od)}</td>
                <td className="py-1 tabular-nums">{formatDiopter(p.os)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
