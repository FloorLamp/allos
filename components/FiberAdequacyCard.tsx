import type { FiberAdequacy } from "@/lib/fiber";
import AdequacyRow from "./AdequacyRow";
import FiberGauge from "./FiberGauge";

// The fiber ROW of the "Today's nutrients" card (issues #976, #980 item 2). A pure
// formatter over the ONE computation (getFiberAdequacy → the pure fiber engine), shared
// with the coaching-tier fiber finding so the two surfaces can't disagree. The row's
// accent, heading and verdict word are AdequacyRow's, shared with protein (#4485); the
// band gauge leads beneath them. The load-bearing caveats — a non-tracked basis is a
// FLOOR, an unknown-unit fiber supplement is noted honestly — ride on the gauge and the
// intake lines, and the whole thing is informational, never prescriptive.

const STATUS_LABEL: Record<string, string> = {
  below: "Below goal",
  within: "In range",
  above: "Above range",
};

export default function FiberAdequacyCard({
  adequacy,
  periodLabel,
}: {
  adequacy: FiberAdequacy;
  // Weekly cards use the default "Avg"; historical day views name their day.
  periodLabel?: string;
}) {
  const { intake, status } = adequacy;
  return (
    <AdequacyRow
      testId="fiber-adequacy"
      title="Fiber"
      status={status}
      basis={intake.basis}
      statusLabel={STATUS_LABEL[status]}
    >
      <FiberGauge adequacy={adequacy} periodLabel={periodLabel} />
    </AdequacyRow>
  );
}
