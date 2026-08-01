"use client";

import { createContext, useContext } from "react";
import { curatedMedicationOptions } from "@/lib/medication-rank";
import { medicationBrandOptions } from "@/lib/medication-info";
import { curatedSupplementOptions } from "@/lib/supplement-rank";
import type { IntakeCatalogOptions } from "@/lib/queries/intake-options";

// Section-level supply of the RANKED medication / supplement picker options (#1677),
// mirroring how the provider registry and the situation vocabulary already reach these
// same forms (ProviderOptionsContext / SituationOptionsContext).
//
// Ordering is a per-PROFILE fact — it depends on what this profile actually takes — so
// it can't be a module constant the way the flat catalogs were. A host surface resolves
// it once at its auth boundary (`getIntakeCatalogOptions`) and wraps its subtree; the
// add form, the quick-add, and every deeply nested edit form read the same arrays, so
// they can never disagree about the picker's first eight rows (#221).
//
// The fallback is the CURATED order (the profile-independent tier of the same ranking),
// not an empty list: a surface that hasn't wrapped yet still gets a sane picker rather
// than none.
const IntakeOptionsContext = createContext<IntakeCatalogOptions | null>(null);

let fallback: IntakeCatalogOptions | null = null;
function curatedFallback(): IntakeCatalogOptions {
  if (!fallback) {
    fallback = {
      medications: curatedMedicationOptions(),
      medicationBrands: medicationBrandOptions(),
      supplements: curatedSupplementOptions(),
    };
  }
  return fallback;
}

export function IntakeOptionsProvider({
  options,
  children,
}: {
  options: IntakeCatalogOptions;
  children: React.ReactNode;
}) {
  return (
    <IntakeOptionsContext.Provider value={options}>
      {children}
    </IntakeOptionsContext.Provider>
  );
}

export function useIntakeOptions(): IntakeCatalogOptions {
  return useContext(IntakeOptionsContext) ?? curatedFallback();
}
