"use client";

import { useState } from "react";
import QuickAddMedication from "@/components/QuickAddMedication";
import { addSupplement } from "@/app/(app)/nutrition/supplement-actions";
import type { PediatricFormContext } from "@/lib/prn-dosing";

// The symptom card's inline OTC quick-add (issue #843, door C). "Taking something for
// it?" reveals the compact medication quick-add right where you're logging symptoms —
// so reaching for ibuprofen is one collapse away from the fever entry, not a trip to
// the full medication form. Creates the SAME intake_items row via the SAME addSupplement
// action; collapses on success.
export default function SymptomMedQuickAdd({
  pediatric,
}: {
  pediatric?: PediatricFormContext;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        data-testid="symptom-med-quickadd-open"
        onClick={() => setOpen(true)}
        className="mt-3 text-xs font-medium text-brand-700 hover:underline dark:text-brand-300"
      >
        Taking something for it?
      </button>
    );
  }

  return (
    <div
      data-testid="symptom-med-quickadd"
      className="mt-3 rounded-md border border-black/10 p-2.5 dark:border-white/15"
    >
      <p className="mb-2 text-xs font-medium text-slate-600 dark:text-slate-300">
        Taking something for it?
      </p>
      <QuickAddMedication
        action={addSupplement}
        pediatric={pediatric}
        onDone={() => setOpen(false)}
      />
    </div>
  );
}
