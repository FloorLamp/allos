import type { WeightUnit } from "@/lib/settings";
import WeightQuickAdd from "./WeightQuickAdd";
import DashboardAtomCard from "./DashboardAtomCard";

// The dashboard's shipped quick-add, kept as an independent action candidate.
// Its hidden marker comes from the same server-resolved series as the Standing
// reading and changes only after the write and refresh have completed.
export default function WeightQuickAddAtom({
  latest,
  weightUnit,
  today,
  subjectName,
}: {
  latest: { date: string; value: number } | null;
  weightUnit: WeightUnit;
  today: string;
  subjectName: string | null;
}) {
  return (
    <DashboardAtomCard
      title="Log weight"
      href="/trends#body"
      testId="weight-quick-add-atom"
    >
      <WeightQuickAdd
        weightUnit={weightUnit}
        today={today}
        subjectName={subjectName}
      />
      {latest ? (
        <span
          hidden
          data-testid="weight-server-latest"
          data-date={latest.date}
          data-value={String(latest.value)}
        />
      ) : null}
    </DashboardAtomCard>
  );
}
