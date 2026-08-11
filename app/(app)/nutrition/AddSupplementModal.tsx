"use client";

import { useState } from "react";
import { IconPlus } from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import SupplementForm from "@/components/SupplementForm";
import type { InteractionItem } from "@/lib/drug-interactions";
import type { PgxVariantInput } from "@/lib/pgx";
import type { SupplyOption } from "@/lib/supply-product";
import { addSupplement } from "./supplement-actions";

// The add workflow is intentionally absent from the resting schedule. A compact
// action opens the same kind-locked form in the shared accessible modal shell.
export default function AddSupplementModal({
  allSupplements,
  stackItems,
  pgxVariants,
  trainingRestricted,
  initialSupply = null,
}: {
  allSupplements: { id: number; name: string }[];
  stackItems: InteractionItem[];
  pgxVariants: PgxVariantInput[];
  trainingRestricted: boolean;
  // Arrived from the cabinet's "Add for another person" (#1705): the modal opens
  // already showing the seeded form rather than making the user find Add again.
  initialSupply?: SupplyOption | null;
}) {
  const [open, setOpen] = useState(initialSupply != null);

  return (
    <div data-testid="add-supplement-card">
      <button
        type="button"
        data-testid="supplement-add-toggle"
        aria-label="Add supplement"
        onClick={() => setOpen(true)}
        className="btn btn-sm min-h-10 min-w-10 px-2 sm:min-h-0 sm:min-w-0 sm:px-3"
      >
        <IconPlus className="h-4 w-4" stroke={2} />
        <span className="hidden sm:inline">Add supplement</span>
      </button>
      {open && (
        <ModalShell
          title="Add supplement"
          onClose={() => setOpen(false)}
          className="flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col rounded-xl bg-white p-4 shadow-xl outline-hidden sm:p-5 dark:bg-ink-900"
        >
          <div
            data-testid="supplement-add-panel"
            className="mt-4 min-h-0 overflow-y-auto px-1"
          >
            <SupplementForm
              action={addSupplement}
              allSupplements={allSupplements}
              stackItems={stackItems}
              pgxVariants={pgxVariants}
              trainingRestricted={trainingRestricted}
              initialSupply={initialSupply}
              onDone={() => setOpen(false)}
            />
          </div>
        </ModalShell>
      )}
    </div>
  );
}
