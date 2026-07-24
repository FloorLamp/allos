"use client";

import { createContext, useContext } from "react";

// Section-level supply of the canonical biomarker-name suggestions for the RecordForm
// combobox (issue #1177). Like ProviderOptionsContext: the native suggestion dropdown
// it replaces was rendered once per page and every canonical-name input referenced it
// by id; the combobox needs the strings in hand. RecordForm is nested (BiomarkersTable →
// RecordForm, ExtractedRecords → EditableRecordRow → RecordForm), so the two host
// pages wrap their subtree in this provider ONCE and RecordForm reads the list here.
const CanonicalNamesContext = createContext<string[]>([]);

export function CanonicalNamesProvider({
  names,
  children,
}: {
  names: string[];
  children: React.ReactNode;
}) {
  return (
    <CanonicalNamesContext.Provider value={names}>
      {children}
    </CanonicalNamesContext.Provider>
  );
}

export function useCanonicalNames(): string[] {
  return useContext(CanonicalNamesContext);
}
