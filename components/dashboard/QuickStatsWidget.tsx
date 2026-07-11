import { StatCard } from "@/components/ui";
import { fmtWeight } from "@/lib/units";
import { formatLongDate } from "@/lib/format-date";
import type { WeightUnit } from "@/lib/settings";

// The 4-up stat tiles (extracted from the old page.tsx block). The widget itself
// is always eligible (fitness:false — Weight + Supplements are universal), but its
// Activities and Active-goals tiles keep an internal `!restricted` guard.
export default function QuickStatsWidget({
  restricted,
  last7,
  activityCount,
  latestWeight,
  activeGoals,
  takenCount,
  supplementCount,
  weightUnit,
}: {
  restricted: boolean;
  last7: number;
  activityCount: number;
  // Reconciled current weight (value + measured date) from the canonical reader,
  // which applies the profile's primary-source priority (#302).
  latestWeight: { value: number; date: string } | null;
  activeGoals: number;
  takenCount: number;
  supplementCount: number;
  weightUnit: WeightUnit;
}) {
  return (
    // 4-up needs ~600px of content width: available from `sm` while the page is
    // sidebar-less, gone again at `md` when the w-60 sidebar appears, back for
    // good at `lg`.
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4 md:grid-cols-2 lg:grid-cols-4">
      {!restricted && (
        <StatCard
          label="Activities (7d)"
          value={String(last7)}
          sub={`${activityCount} logged all-time`}
          href="/training?tab=log"
        />
      )}
      <StatCard
        label="Current weight"
        value={latestWeight ? fmtWeight(latestWeight.value, weightUnit) : "—"}
        sub={
          latestWeight
            ? `on ${formatLongDate(latestWeight.date)}`
            : "no entries"
        }
        href="/trends?tab=body"
      />
      {!restricted && (
        <StatCard
          label="Active goals"
          value={String(activeGoals)}
          href="/training"
        />
      )}
      <StatCard
        label="Supplements"
        value={`${takenCount}/${supplementCount}`}
        sub="taken today"
        href="/medicine"
      />
    </div>
  );
}
