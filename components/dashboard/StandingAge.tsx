import type { ReactNode } from "react";
import type { GlanceAgeToken } from "@/lib/glance-age";
import type { MeasurementGroup } from "@/lib/measurements-deeplink";
import DashboardQuickEntryAction from "./DashboardQuickEntryAction";

// THE AGE CELL of a Standing reading row (#4757). Weight, blood pressure, resting heart
// rate and a recent result each print a dated reading's age, and each used to spell
// this span out for itself — which is how the weight row came to print a bare date
// with no `data-stale` and no amber while the row beside it aged. The DECISION is the
// token's (lib/glance-age); this only wears it, once, so the `.standing-age` hook the
// door-rail geometry keys on and the stale attribute a spec reads cannot drift per row.
export function StandingAge({
  age,
  testId,
}: {
  age: GlanceAgeToken;
  testId: string;
}) {
  return (
    <span
      data-testid={testId}
      data-stale={age.stale ? "true" : undefined}
      className={`standing-age ${age.className}`}
    >
      {age.text}
    </span>
  );
}

// THE MEASUREMENT DOOR a stale reading earns (#4757): the app's one quick-write
// surface, opened on the measurements form at this reading's GROUP. A door, never a
// prefill — `QuickEntryPrefill` has no slot a value could ride in, so the person types
// the number; that is a fact of the type, not of this function's restraint.
//
// `undefined` when fresh rather than an element that renders nothing: a row with a
// `control` gives up its link wrap (DashboardFactRow), and a fresh reading keeps it.
export function staleMeasurementDoor(
  age: GlanceAgeToken,
  group: MeasurementGroup,
  actionLabel: string
): ReactNode | undefined {
  return age.stale ? (
    <DashboardQuickEntryAction
      form="measurements"
      prefill={{ measurementGroup: group }}
      actionLabel={actionLabel}
    />
  ) : undefined;
}

// THE VITALS FAMILY'S ONE SEAT (#4841 item 4, owner ruling 2026-09-03 12:25 UTC).
// Blood pressure and resting heart rate are two separate Standing families, each with
// its own row — but the owner ruled ONE "Log a vital" door for the pair, in a
// family-level control slot, present whenever the family exists rather than only when
// a reading is stale (#4826's per-row `staleMeasurementDoor` folds into this). With no
// single family grouping the two rows, "one door" is a SEAT: whichever row is
// currently live in Standing (not dormant — a dormant reading holds its own door
// outside Standing, unchanged) carries it, blood pressure first. This is the one
// decision point a second door could reappear from, so it is pure and tested alone.
export function vitalsFamilySeat(
  bpLive: boolean,
  restingHrLive: boolean
): "blood-pressure" | "resting-heart-rate" | null {
  if (bpLive) return "blood-pressure";
  if (restingHrLive) return "resting-heart-rate";
  return null;
}
