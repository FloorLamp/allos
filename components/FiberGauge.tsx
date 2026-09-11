import { fiberBasisIsFloor, type FiberAdequacy } from "@/lib/fiber";
import AdequacyGauge from "./AdequacyGauge";

// Fiber's band gauge (issue #980 item 2), drawn on the shared nutrient scale (#4485) so
// the "Today's nutrients" card's two rows cannot drift apart in scale or legend. This
// file is now only fiber's half — its band bounds, its legend value and its spoken
// sentence.
//
// A pure formatter over the ONE getFiberAdequacy model (#221). Fiber has no in-progress
// "today" reading (its model is a weekly average), so the bar is THIS WEEK's intake and
// there is no marker the way protein has one. Every non-tracked basis is a FLOOR, so the
// bar reads "at least N g" and the legend says so.

function g(n: number): string {
  return String(Math.round(n));
}

export default function FiberGauge({
  adequacy,
  periodLabel = "Avg",
}: {
  adequacy: FiberAdequacy;
  periodLabel?: string;
}) {
  const { intake, target } = adequacy;
  const isFloor = fiberBasisIsFloor(intake.basis);
  const weekValueLabel = `${isFloor ? "at least " : ""}${g(intake.grams)} g`;
  const isWeekly = periodLabel === "Avg";

  return (
    <AdequacyGauge
      testId="fiber-gauge"
      bandTestId="fiber-gauge-band"
      fillTestId="fiber-gauge-week"
      periodLabel={periodLabel}
      grams={intake.grams}
      isFloor={isFloor}
      // The goal zone runs from the DRI adequate intake up to the soft "very high"
      // ceiling — a floor goal, not a band, which is why the legend states one number.
      band={{ low: target.grams, high: target.gramsHigh }}
      goalLegend={`~${g(target.grams)}g`}
      ariaLabel={`Fiber ${isWeekly ? "this week" : periodLabel.toLowerCase()} ${weekValueLabel}${isWeekly ? " a day" : ""}, goal at least ${g(target.grams)} grams a day`}
    />
  );
}
