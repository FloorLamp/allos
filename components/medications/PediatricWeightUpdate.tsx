"use client";

import { useState } from "react";
import { IconScale } from "@tabler/icons-react";
import MeasurementsQuickAdd from "@/app/(app)/trends/MeasurementsQuickAdd";
import type { PediatricFormContext } from "@/lib/prn-dosing";

// The dosing-weight update embedded in the pediatric label lookup, and since #4424
// ruling 2 it DEFINES NO FIELDS: it mounts the body domain's one form, narrowed to the
// weight it needs. It used to draw its own weight input, its own "Measured on" date,
// its own range guard and its own never-the-future check, and post `addBodyMetric` —
// a fourth spelling of a weight entry, and one that stated no time at all, so a
// caregiver who weighed a child at 7am filed a reading with no minute on it.
//
// WHAT IS LEFT HERE IS THE ONLY PART THAT IS ABOUT MEDICATION: the disclosure, and
// re-deriving the dose band from the weight that was just written. The form hands the
// sitting's own canonical kilograms to `onSaved`, so this does not read the number
// back out of a field it no longer owns.
//
// IT IS NOT A NESTED FORM. This sits BELOW `IntakeItemForm`'s `</form>` — the mount is
// a sibling of that form, not a child of it — which is what makes mounting a component
// that renders its own `<form>` legal here. The old comment claiming otherwise
// described a placement that has not been true.
export default function PediatricWeightUpdate({
  context,
  initiallyOpen = false,
  onSaved,
}: {
  context: PediatricFormContext;
  initiallyOpen?: boolean;
  onSaved: (next: PediatricFormContext) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);

  if (!open) {
    return (
      <button
        type="button"
        className="btn-ghost btn-sm mt-2"
        data-testid="pediatric-weight-update-open"
        onClick={() => setOpen(true)}
      >
        <IconScale className="h-3.5 w-3.5" stroke={1.75} />
        Update weight
      </button>
    );
  }

  return (
    <div className="mt-2" data-testid="pediatric-weight-update">
      <MeasurementsQuickAdd
        defaultDate={context.today}
        maxDate={context.today}
        weightUnit={context.weightUnit}
        metric={{ key: "weight", label: "Weight" }}
        presentation="modal"
        onSaved={(saved) => {
          setOpen(false);
          if (saved.weightKg == null) return;
          onSaved({
            ...context,
            weightKg: saved.weightKg,
            weightDate: saved.date,
          });
        }}
      />
      <button
        type="button"
        className="btn-ghost btn-sm mt-2"
        onClick={() => setOpen(false)}
      >
        Cancel
      </button>
    </div>
  );
}
