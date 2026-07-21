"use client";

import { useState } from "react";
import { IconPlus, IconX } from "@tabler/icons-react";
import { PageHeader } from "@/components/ui";
import MedicationForm from "@/components/MedicationForm";
import QuickAddMedication from "@/components/QuickAddMedication";
import type { InteractionItem } from "@/lib/drug-interactions";
import type { PgxVariantInput } from "@/lib/pgx";
import type { PediatricFormContext } from "@/lib/prn-dosing";
import type { FormResult } from "@/lib/types";

type AddMode = "quick" | "full";

export default function MedicationAddWorkspace({
  subtitle,
  action,
  allSupplements,
  stackItems,
  pgxVariants,
  trainingRestricted,
  pediatric,
  age,
  todayStr,
  conditions,
}: {
  subtitle: string;
  action: (formData: FormData) => Promise<FormResult>;
  allSupplements: { id: number; name: string }[];
  stackItems: InteractionItem[];
  pgxVariants: PgxVariantInput[];
  trainingRestricted: boolean;
  pediatric?: PediatricFormContext;
  age: number | null;
  todayStr: string;
  conditions: { id: number; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AddMode>("quick");

  function close() {
    setOpen(false);
    setMode("quick");
  }

  return (
    <div data-testid="medication-add-workspace">
      <PageHeader
        title="Medications"
        subtitle={subtitle}
        action={
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
              Choose a quick entry or add full prescribing and schedule details.
            </p>
          </div>

          <div
            className="mt-4 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 text-sm dark:bg-ink-800"
            role="tablist"
            aria-label="Medication entry type"
          >
            {(
              [
                ["quick", "Quick add"],
                ["full", "Full details"],
              ] as const
            ).map(([value, label]) => {
              const active = mode === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={`medication-add-${value}`}
                  onClick={() => setMode(value)}
                  className={`rounded-md px-3 py-1.5 font-medium transition ${
                    active
                      ? "bg-white text-slate-900 shadow-sm dark:bg-ink-900 dark:text-slate-100"
                      : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div className="mt-4" role="tabpanel">
            {mode === "quick" ? (
              <>
                <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
                  Name and dose, with optional as-needed reminders.
                </p>
                <QuickAddMedication
                  action={action}
                  pediatric={pediatric}
                  onDone={close}
                />
              </>
            ) : (
              <>
                <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
                  Prescription, schedule, refill, and safety details.
                </p>
                <MedicationForm
                  action={action}
                  allSupplements={allSupplements}
                  stackItems={stackItems}
                  pgxVariants={pgxVariants}
                  trainingRestricted={trainingRestricted}
                  pediatric={pediatric}
                  age={age}
                  todayStr={todayStr}
                  conditions={conditions}
                  onDone={close}
                />
              </>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
