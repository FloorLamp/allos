"use client";

import { useState } from "react";
import { IconPlus, IconX } from "@tabler/icons-react";
import { PageHeader } from "@/components/ui";
import { useCreateActionLabel } from "@/components/CreateAction";
import IntakeItemForm from "@/components/IntakeItemForm";
import type { InteractionItem } from "@/lib/drug-interactions";
import type { PgxVariantInput } from "@/lib/pgx";
import type { PediatricFormContext } from "@/lib/prn-dosing";
import type { FormResult } from "@/lib/types";
import type { SupplyOption } from "@/lib/supply-product";

export function MedicationCreateControl({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const label = useCreateActionLabel();
  return (
    <button
      type="button"
      className={`${open ? "btn-ghost" : "btn"} whitespace-nowrap`}
      aria-expanded={open}
      aria-controls="medication-add-panel"
      data-testid="medication-add-toggle"
      onClick={onToggle}
    >
      {open ? (
        <IconX className="h-4 w-4" stroke={1.75} />
      ) : (
        <IconPlus className="h-4 w-4" stroke={2} />
      )}
      {open ? "Close" : label}
    </button>
  );
}

export default function MedicationAddWorkspace({
  subtitle,
  action,
  allIntakeItems,
  stackItems,
  pgxVariants,
  pediatric,
  age,
  todayStr,
  conditions,
  initialSupply = null,
}: {
  subtitle: string;
  action: (formData: FormData) => Promise<FormResult>;
  allIntakeItems: { id: number; name: string }[];
  stackItems: InteractionItem[];
  pgxVariants: PgxVariantInput[];
  pediatric?: PediatricFormContext;
  age: number | null;
  todayStr: string;
  conditions: { id: number; name: string }[];
  // Arrived from the cabinet's "Add for another person" (#1705). One form carries the
  // shared-supply control the seed shows up in, so the bottle is never linked invisibly.
  initialSupply?: SupplyOption | null;
}) {
  const [open, setOpen] = useState(initialSupply != null);

  function close() {
    setOpen(false);
  }

  return (
    <div data-testid="medication-add-workspace">
      <PageHeader
        title="Medications"
        subtitle={subtitle}
        // ONE affordance in the header now (#3479, owner-approved 2026-08-21). It
        // carried three — the dose-ledger door, the cabinet door, and this primary —
        // and below `sm` the group took its own line and wrapped INSIDE that line into
        // two right-aligned rows, leaving ~150px of ragged chrome with an empty left
        // half between the subtitle and the first card. The two quiet doors moved into
        // the cards they serve (Today carries "Dose history", Current medications
        // carries the cabinet), which is the pattern this page already demonstrated
        // with print/share.
        //
        // `stackActionBelowSm` STAYS, and it is not vestigial: it is the #1522
        // follow-up rule restated by #3403, and with a single 152px button beside a
        // title and a counts subtitle at 390px the group would still be sharing a line
        // it does not fit on. The rule is untouched; only its content shrank.
        stackActionBelowSm
        createAction={{
          kind: "medication",
          control: (
            <MedicationCreateControl
              open={open}
              onToggle={() => setOpen((value) => !value)}
            />
          ),
        }}
      />

      {open ? (
        <section
          id="medication-add-panel"
          className="card relative z-20 mb-5"
          data-testid="medication-add-panel"
        >
          <div>
            <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
              Add medication
            </h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Start with the name — everything else is a tap away.
            </p>
          </div>

          {/* ONE form (#3216). The quick/full tab pair is gone: the quick door existed
              because the full form front-loaded every field, and a summary-first form
              has no wall to route around. Prescribing, schedule, refill and safety all
              live behind their own fact, reached only if you disagree with it. */}
          <div className="mt-4">
            <IntakeItemForm
              action={action}
              kind="medication"
              allIntakeItems={allIntakeItems}
              stackItems={stackItems}
              pgxVariants={pgxVariants}
              pediatric={pediatric}
              age={age}
              todayStr={todayStr}
              conditions={conditions}
              initialSupply={initialSupply}
              onDone={close}
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}
