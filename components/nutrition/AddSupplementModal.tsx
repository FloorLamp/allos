"use client";

import { useState } from "react";
import { IconPlus } from "@tabler/icons-react";
import Button from "@/components/Button";
import ModalShell from "@/components/ModalShell";
import IntakeItemForm from "@/components/IntakeItemForm";
import type { IntakeFormContext } from "@/lib/intake-form-context";
import type { SupplyOption } from "@/lib/supply-product";
import type { FormResult } from "@/lib/types";
import { useCreateActionLabel } from "@/components/CreateAction";

export interface AddSupplementModalProps {
  action: (formData: FormData) => Promise<FormResult>;
  intakeContext: IntakeFormContext;
  // Arrived from the cabinet's "Add for another person" (#1705): the modal opens
  // already showing the seeded form rather than making the user find Add again.
  initialSupply?: SupplyOption | null;
  activityScheduleAvailable?: boolean;
  // Picker sources for the "What you take it for" control (#2857).
  biomarkers?: string[];
}

// The add workflow is intentionally absent from the resting schedule. A compact
// action opens the same kind-locked form in the shared accessible modal shell.
export default function AddSupplementModal({
  action,
  intakeContext,
  initialSupply = null,
  activityScheduleAvailable = true,
  biomarkers = [],
}: AddSupplementModalProps) {
  const [open, setOpen] = useState(initialSupply != null);
  const label = useCreateActionLabel();
  const close = () => setOpen(false);

  return (
    <div data-testid="add-supplement-card">
      {/* THE ONE PRIMARY ACTION ON MANAGE (#3987/#3982): the surface exists to hold
          the stack, so adding to it is the action it exists for. Rank is the only
          thing declared here — the paint, the 34px box and the focus ring are the
          primitive's, which is what the hand-rolled `btn btn-sm px-2 sm:px-3` was
          quietly re-deciding. */}
      <Button
        variant="primary"
        data-testid="supplement-add-toggle"
        aria-label={label}
        onClick={() => setOpen(true)}
      >
        <IconPlus className="h-4 w-4" stroke={2} />
        <span className="hidden sm:inline">{label}</span>
      </Button>
      {open && (
        <ModalShell title={label} onClose={close} size="lg">
          {/* ModalShell remains the only scroll owner; overflow here clips the
              portaled name combobox (#2774). */}
          <div data-testid="supplement-add-panel" className="px-1">
            <IntakeItemForm
              intakeContext={intakeContext}
              action={action}
              kind="supplement"
              initialSupply={initialSupply}
              biomarkers={biomarkers}
              activityScheduleAvailable={activityScheduleAvailable}
              onDone={close}
            />
          </div>
        </ModalShell>
      )}
    </div>
  );
}
