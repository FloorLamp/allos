"use client";

import { useState } from "react";
import { IconPlus, IconX } from "@tabler/icons-react";
import { PageHeader } from "@/components/ui";
import SharedSuppliesLink from "@/components/intake/SharedSuppliesLink";
import DoseLedgerLink from "@/components/intake/DoseLedgerLink";
import IntakeItemForm from "@/components/IntakeItemForm";
import type { InteractionItem } from "@/lib/drug-interactions";
import type { PgxVariantInput } from "@/lib/pgx";
import type { PediatricFormContext } from "@/lib/prn-dosing";
import type { FormResult } from "@/lib/types";
import type { SupplyOption } from "@/lib/supply-product";

export default function MedicationAddWorkspace({
  subtitle,
  cabinetCount,
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
  // Shared bottles the caller can see in the medicine cabinet (#1522). Resolved at
  // the page's auth boundary (countVisiblePools(scope.ids)) and passed as a plain
  // number — the cabinet door beside "Add medication" replaced its nav row.
  cabinetCount: number;
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
        // The action group takes its OWN LINE on a phone (#1522 follow-up, restated
        // by #3403). Three affordances do not fit 390px beside "Medications" and its
        // subtitle, and the app shell clips horizontal overflow — an un-wrapping row
        // would push the Add button off-screen entirely rather than scroll to it. The
        // group used to buy that by SHRINKING and wrapping inside itself while the page
        // title shrank beside it; `stackActionBelowSm` gives it the whole line instead,
        // so the title gets the full width too and the group still wraps within it —
        // `PageHeader` deliberately withholds `shrink-0` from a STACKED action for
        // exactly this. Beside the title from `sm` up, exactly as before. One content
        // tree, both viewports.
        stackActionBelowSm
        action={
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            <DoseLedgerLink kind="medication" />
            <SharedSuppliesLink count={cabinetCount} />
            <button
              type="button"
              className={`${open ? "btn-ghost" : "btn"} whitespace-nowrap`}
              aria-expanded={open}
              aria-controls="medication-add-panel"
              data-testid="medication-add-toggle"
              onClick={() => setOpen((value) => !value)}
            >
              {open ? (
                <IconX className="h-4 w-4" stroke={1.75} />
              ) : (
                <IconPlus className="h-4 w-4" stroke={2} />
              )}
              {open ? "Close" : "Add medication"}
            </button>
          </div>
        }
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
