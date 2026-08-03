"use client";

import { createContext, useContext } from "react";
import type { RankedBiomarker } from "@/lib/biomarker-rank";

// Section-level supply of the canonical biomarker-name suggestions for the RecordForm
// combobox (issue #1177). Like ProviderOptionsContext: the native suggestion dropdown
// it replaces was rendered once per page and every canonical-name input referenced it
// by id; the combobox needs the strings in hand. RecordForm is nested (BiomarkersTable →
// RecordForm, ExtractedRecords → EditableRecordRow → RecordForm), so the two host
// pages wrap their subtree in this provider ONCE and RecordForm reads the list here.
//
// #1675: the rows arrive RELEVANCE-RANKED and group-tagged from
// `getRankedBiomarkerOptions`, so the two hosts (the Biomarkers add slot / row editor,
// and the import-review mapping field) share one order and one set of headers. Neither
// re-derives relevance in the component.
const CanonicalNamesContext = createContext<RankedBiomarker[]>([]);

export function CanonicalNamesProvider({
  options,
  children,
}: {
  options: RankedBiomarker[];
  children: React.ReactNode;
}) {
  return (
    <CanonicalNamesContext.Provider value={options}>
      {children}
    </CanonicalNamesContext.Provider>
  );
}

export function useCanonicalNames(): RankedBiomarker[] {
  return useContext(CanonicalNamesContext);
}
