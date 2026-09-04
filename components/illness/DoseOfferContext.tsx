"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

// ONE DOSE PROMPT AT A TIME (#4712, owner ruling 2026-09-04 11:20 UTC, part 2).
//
// Both surfaces that host the temperature fold — the dashboard cockpit and the episode
// page — also carry a PERSISTENT Meds section a few lines below it, and
// `antipyreticPrnMeds` is `prnMeds` narrowed (lib/prn-defaults.ts), so the fold's dose
// offer could never show a chip the section was not already showing. That is why the
// dose half of the ruled block was suppressed on both mounts and rendered nowhere.
// The ruling resolves it the other way round: the PERSISTENT SECTION YIELDS while the
// fold is offering, so the antipyretic's chip is in exactly one place at any moment,
// and the section comes back when the offer is taken or dismissed.
//
// The fold's offer is client state inside `SymptomLogBar` and the Meds section is a
// server-rendered sibling, so the signal lives ABOVE both — the same shape
// `CockpitDayContext` uses for the day a card is standing on, and for the same reason:
// a toggle inside one child that governs a sibling is what regresses.
//
// FALLBACK, NOT A FLAG. A bar mounted without a provider (the quick-entry sheet, the
// day view, the cycles page) has no persistent Meds section beside it, so there is
// nothing to yield and `useDoseOfferSignal` hands it a no-op.
interface DoseOfferSignal {
  live: boolean;
  setLive: (live: boolean) => void;
}

const DoseOfferContext = createContext<DoseOfferSignal | null>(null);

export function DoseOfferProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState(false);
  return (
    <DoseOfferContext.Provider value={{ live, setLive }}>
      {children}
    </DoseOfferContext.Provider>
  );
}

// The fold says whether its dose offer is on screen. Called from the same handlers
// that raise and clear the offer itself, so the signal cannot drift from the block.
export function useDoseOfferSignal(): (live: boolean) => void {
  return useContext(DoseOfferContext)?.setLive ?? (() => {});
}

// The persistent Meds section, wrapped by its host. It is REMOVED while the fold's
// dose offer is live rather than hidden, because a hidden chip is still a second
// `cockpit-med-chip-<id>` in the tree for one medication — the strict-mode collision
// that found this conflict in the first place.
export function YieldToDoseOffer({ children }: { children: ReactNode }) {
  const signal = useContext(DoseOfferContext);
  return signal?.live ? null : <>{children}</>;
}
