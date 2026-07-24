"use client";

import { createContext, useContext } from "react";

// The situation vocabulary offered by the SupplementForm / MedicationForm situation
// picker (#1177). It is the SAME merged set the Supplements bar renders — the profile's
// saved vocabulary ∪ the built-in suggestions (mergedSituationOptions, #1294's seam) —
// so the item form and the bar can never disagree about what a situation is (#221). The
// old native suggestion dropdown offered only the canned four and never the profile's
// own custom situations; a shared context fixes the option source as a side effect of
// the widget
// migration. Supplied once by the host surface (Supplements tab, Medications pages),
// read by the forms wherever they're nested.
const SituationOptionsContext = createContext<string[]>([]);

export function SituationOptionsProvider({
  options,
  children,
}: {
  options: string[];
  children: React.ReactNode;
}) {
  return (
    <SituationOptionsContext.Provider value={options}>
      {children}
    </SituationOptionsContext.Provider>
  );
}

export function useSituationOptions(): string[] {
  return useContext(SituationOptionsContext);
}
