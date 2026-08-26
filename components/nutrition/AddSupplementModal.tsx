"use client";

import { useState } from "react";
import { IconPlus } from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import IntakeItemForm from "@/components/IntakeItemForm";
import type { InteractionItem } from "@/lib/drug-interactions";
import type { PgxVariantInput } from "@/lib/pgx";
import type { SupplyOption } from "@/lib/supply-product";
import type { FormResult } from "@/lib/types";
import { useCreateActionLabel } from "@/components/CreateAction";

export interface AddSupplementModalProps {
  action: (formData: FormData) => Promise<FormResult>;
  allIntakeItems: { id: number; name: string }[];
  stackItems: InteractionItem[];
  pgxVariants: PgxVariantInput[];
  // Arrived from the cabinet's "Add for another person" (#1705): the modal opens
  // already showing the seeded form rather than making the user find Add again.
  initialSupply?: SupplyOption | null;
  activityScheduleAvailable?: boolean;
  // Picker sources for the "What you take it for" control (#2857).
  conditions?: { id: number; name: string }[];
  biomarkers?: string[];
}

// The add workflow is intentionally absent from the resting schedule. A compact
// action opens the same kind-locked form in the shared accessible modal shell.
export default function AddSupplementModal({
  action,
  allIntakeItems,
  stackItems,
  pgxVariants,
  initialSupply = null,
  activityScheduleAvailable = true,
  conditions = [],
  biomarkers = [],
}: AddSupplementModalProps) {
  const [open, setOpen] = useState(initialSupply != null);
  const label = useCreateActionLabel();
  const close = () => setOpen(false);

  return (
    <div data-testid="add-supplement-card">
      <button
        type="button"
        data-testid="supplement-add-toggle"
        aria-label={label}
        onClick={() => setOpen(true)}
        className="btn btn-sm px-2 sm:px-3"
      >
        <IconPlus className="h-4 w-4" stroke={2} />
        <span className="hidden sm:inline">{label}</span>
      </button>
      {open && (
        <ModalShell title={label} onClose={close} size="lg">
          {/* ModalShell remains the only scroll owner; overflow here clips the
              portaled name combobox (#2774). */}
          <div data-testid="supplement-add-panel" className="px-1">
            <IntakeItemForm
              action={action}
              kind="supplement"
              allIntakeItems={allIntakeItems}
              stackItems={stackItems}
              pgxVariants={pgxVariants}
              initialSupply={initialSupply}
              conditions={conditions}
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
