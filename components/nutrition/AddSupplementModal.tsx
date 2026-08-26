"use client";

import { useState } from "react";
import { IconPlus } from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import IntakeItemForm from "@/components/IntakeItemForm";
import type { InteractionItem } from "@/lib/drug-interactions";
import type { PgxVariantInput } from "@/lib/pgx";
import type { SupplyOption } from "@/lib/supply-product";
import type { FormResult } from "@/lib/types";

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
  purposeConditions?: { id: number; name: string }[];
  purposeBiomarkers?: string[];
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
  purposeConditions = [],
  purposeBiomarkers = [],
}: AddSupplementModalProps) {
  const [open, setOpen] = useState(initialSupply != null);

  return (
    <div data-testid="add-supplement-card">
      <button
        type="button"
        data-testid="supplement-add-toggle"
        aria-label="Add supplement"
        onClick={() => setOpen(true)}
        className="btn btn-sm px-2 sm:px-3"
      >
        <IconPlus className="h-4 w-4" stroke={2} />
        <span className="hidden sm:inline">Add supplement</span>
      </button>
      {open && (
        <ModalShell
          title="Add supplement"
          onClose={() => setOpen(false)}
          size="lg"
        >
          {/* Spacing and a test hook only — NO `overflow` here (#2774). This
              used to be `min-h-0 overflow-y-auto` inside a panel this file
              bounded itself with `max-h-[calc(100vh-2rem)]`, which made it the
              modal's scroller. That clipped the name combobox's listbox off
              mid-row at the modal's bottom edge, with the listbox's own
              `max-h-56` scrollbar beside it — the two-scrollbar symptom the
              owner reported. The host owns scrolling now, at every width, so a
              second scroller here would only re-establish the clip: an
              `overflow` clips whether or not it is currently scrolling. */}
          <div data-testid="supplement-add-panel" className="px-1">
            <IntakeItemForm
              action={action}
              kind="supplement"
              allIntakeItems={allIntakeItems}
              stackItems={stackItems}
              pgxVariants={pgxVariants}
              initialSupply={initialSupply}
              conditions={purposeConditions}
              biomarkers={purposeBiomarkers}
              activityScheduleAvailable={activityScheduleAvailable}
              onDone={() => setOpen(false)}
            />
          </div>
        </ModalShell>
      )}
    </div>
  );
}
