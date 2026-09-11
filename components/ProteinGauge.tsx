import { proteinGaugeMarker, type ProteinToday } from "@/lib/protein";
import AdequacyGauge from "./AdequacyGauge";

// Protein's band gauge (issue #974): today so far, an average marker, and the goal band,
// drawn on the shared nutrient scale (#4485). This file is now only protein's half of the
// picture — its band bounds, its legend value and its spoken sentence; the track, the
// fill, the marker line and the legend layout are AdequacyGauge's, shared with fiber.
//
// Still a pure formatter over the ONE getProteinToday model (#221), so the bar, the
// marker and the band can never disagree with the adequacy card or the food-nudge status
// line. Nothing is derived here that the model does not already carry.
//
// WHICH average the marker is, and what it may therefore be called, is decided once in
// `proteinGaugeMarker` (#1917/#2328) — this passes on the label it is handed and never
// picks one. Normally that is THIS WEEK's daily average, the very figure the adequacy
// card beside it reaches its weekly verdict on; on a week-start morning, before the week
// has a figure at all, it is the trailing 7-day average under its own name.

function g(n: number): string {
  return String(Math.round(n));
}

export default function ProteinGauge({
  today,
  periodLabel = "Today",
}: {
  today: ProteinToday;
  periodLabel?: string;
}) {
  const { todayGrams, target } = today;
  const marker = proteinGaugeMarker(today);

  // Floor copy: today's bar reads "at least N g" unless it's a measured tracked reading.
  const isFloor = today.todayIntake
    ? today.todayIntake.basis !== "tracked"
    : true;
  const todayValueLabel = `${isFloor ? "at least " : ""}${g(todayGrams)} g`;

  return (
    <AdequacyGauge
      testId="protein-gauge"
      bandTestId="protein-gauge-band"
      fillTestId="protein-gauge-today"
      periodLabel={periodLabel}
      grams={todayGrams}
      isFloor={isFloor}
      band={{ low: target.gramsLow, high: target.gramsHigh }}
      goalLegend={`${g(target.gramsLow)}–${g(target.gramsHigh)}g`}
      ariaLabel={`Protein ${periodLabel.toLowerCase()} ${todayValueLabel}, goal ${g(target.gramsLow)} to ${g(target.gramsHigh)} grams${
        marker ? `, ${marker.ariaPhrase}` : ""
      }`}
      marker={
        marker && {
          // The test id stays `protein-gauge-weekly`: the element is the gauge's one
          // marker, and renaming it would silently drop every existing assertion.
          // `data-kind` is what says WHICH average is standing there.
          testId: "protein-gauge-weekly",
          labelTestId: "protein-gauge-marker-label",
          kind: marker.kind,
          grams: marker.grams,
          label: marker.label,
        }
      }
    />
  );
}
