"use client";

import { createContext, useContext } from "react";
import type { Provider } from "@/lib/types";

// Section-level supply of the shared provider registry rows for the ProviderCombobox
// (issue #1176). The native suggestion dropdown it replaces was rendered ONCE per page
// and every provider input referenced it by id; a combobox instead needs the rows in
// hand. Threading them through every List → row → edit-form would be noisy, so a
// section wraps its subtree in this provider ONCE (mirroring where the datalist used
// to sit) and each ProviderCombobox reads the rows from context — the add form and
// the deeply-nested edit forms alike, with no per-form prop.
const ProviderOptionsContext = createContext<Provider[]>([]);

export function ProviderOptionsProvider({
  providers,
  children,
}: {
  providers: Provider[];
  children: React.ReactNode;
}) {
  return (
    <ProviderOptionsContext.Provider value={providers}>
      {children}
    </ProviderOptionsContext.Provider>
  );
}

export function useProviderOptions(): Provider[] {
  return useContext(ProviderOptionsContext);
}
