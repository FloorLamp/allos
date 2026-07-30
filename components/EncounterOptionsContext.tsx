"use client";

import { createContext, useContext } from "react";
import type { LinkedEncounterRef } from "@/lib/queries";

// Section-level supply of the visits a form may link to (issue #1526) — the
// ProviderOptionsContext precedent, one domain over: a section reads the list ONCE on
// the server (getEncounterPickerOptions) and wraps its subtree, so the add form and
// every deeply-nested per-row edit form read it from context with no prop chain.
//
// UNLIKE providers, which are a GLOBAL registry, visits are profile-owned — so this
// carries one list PER profile in the view-set, keyed by profile id. A multi-view row
// belonging to another member must offer THAT member's visits, never the acting
// profile's (offering them would be a cross-profile leak in the option text, and the
// write path would reject the id anyway).
export interface EncounterOptions {
  actingProfileId: number;
  byProfile: Record<number, readonly LinkedEncounterRef[]>;
}

const EMPTY: EncounterOptions = { actingProfileId: 0, byProfile: {} };

const EncounterOptionsContext = createContext<EncounterOptions>(EMPTY);

export function EncounterOptionsProvider({
  options,
  children,
}: {
  options: EncounterOptions;
  children: React.ReactNode;
}) {
  return (
    <EncounterOptionsContext.Provider value={options}>
      {children}
    </EncounterOptionsContext.Provider>
  );
}

// The visits offerable for one row's profile. `profileId` is the ROW's own profile (the
// multi-view case); omitted means the acting profile, which is the only one a
// single-view surface renders.
export function useEncounterOptions(
  profileId?: number
): readonly LinkedEncounterRef[] {
  const { actingProfileId, byProfile } = useContext(EncounterOptionsContext);
  return byProfile[profileId ?? actingProfileId] ?? [];
}
