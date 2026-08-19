import CardSectionHeader from "@/components/CardSectionHeader";
import PeriodOfferButton from "@/components/cycle/PeriodOfferButton";
import type { CycleControlState } from "@/lib/cycle-plausibility";

// Dashboard Cycle control atom (#1892): the SAME <PeriodOfferButton> the
// Cycle page control and the quick-log sheet render, over the SAME server-resolved
// `cycleControlState`. It is a second RENDERER, not a second implementation: it decides
// nothing, and the label always names the write the tap will perform ("Period started
// today" / "Period ended today" / "Still bleeding"). The button self-suppresses where a
// tap would mint an implausible period, and every write lands on lib/cycle-write.ts's
// typed refusals, so a stale dashboard tap is refused rather than double-logged.
//
// Relevance is gated on the same cycle-applicability bit as navigation. Phase and
// forecast readings have their own authorities: Standing and the Cycle page.
export default function CycleControlAtom({
  control,
}: {
  control: CycleControlState;
}) {
  return (
    <div className="card" data-testid="cycle-control-atom">
      <CardSectionHeader title="Cycle" href="/medical/cycles" />
      <div className="mt-3">
        <PeriodOfferButton state={control} surface="atom" variant="compact" />
      </div>
    </div>
  );
}
