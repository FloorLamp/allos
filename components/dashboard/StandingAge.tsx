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
