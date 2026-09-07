"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

// ONE PANEL OPEN PER CARD (#5487 fix 1).
//
// The cockpit's height was six independent `useState` booleans in two children —
// the symptom picker, the temperature fold, a med panel and the add-medication
// fold — each a private claim on the card, so a screenshot could carry a med
// detail panel and the full create form at once. Every one of #4752's approved
// boards shows exactly ONE thing open, or none.
//
// So which panel is open is CARD state, the third thing on this card that wanted
// to be and was not: `CockpitDayContext` holds the day the card stands on and
// `DoseOfferContext` holds whether the fold is offering a dose, both for the
// reason `DoseOfferContext`'s header states — a toggle inside one child that
// governs a sibling is what regresses. `IllnessNowGroup` already runs the
// household accordion one-at-a-time the same way (`openOtherKey`).
//
// FALLBACK, NOT A FLAG (the `CockpitDayContext` shape). A bar mounted without a
// provider — the quick-entry sheet, the Timeline's day view, the cycles page —
// is one control with no siblings to coordinate, so it keeps the same rule over
// its own local state rather than taking a second code path.
//
// A PANEL INSIDE A PANEL IS NESTED, and that is one fact with two consequences
// (#5487 fixes 1 and 2). The fever offer lives INSIDE the temperature fold
// (#4712) and mounts the dose control inside its own inset box: joining the
// card's accordion would let taking that dose close the fold the offer lives in,
// and drawing its own frame would put a third border inside a card that draws
// none of its own (#4076). Wrapping such a mount in a nested provider says both.
interface CockpitPanels {
  openKey: string | null;
  setOpenKey: (key: string | null) => void;
  // Whether this scope is itself inside another card panel.
  nested: boolean;
}

const CockpitPanelContext = createContext<CockpitPanels | null>(null);

export function CockpitPanelProvider({ children }: { children: ReactNode }) {
  const parent = useContext(CockpitPanelContext);
  const [openKey, setOpenKey] = useState<string | null>(null);
  return (
    <CockpitPanelContext.Provider
      value={{ openKey, setOpenKey, nested: parent !== null }}
    >
      {children}
    </CockpitPanelContext.Provider>
  );
}

// The card's open panel, or this control's own when it stands outside a card.
export function useCockpitPanels(): CockpitPanels {
  const card = useContext(CockpitPanelContext);
  const [openKey, setOpenKey] = useState<string | null>(null);
  return card ?? { openKey, setOpenKey, nested: false };
}

// The card's panels, named. A medication's panel is named by its item id, so the
// chip that opens it and the panel that answers it are one value.
export const SYMPTOM_PICKER_PANEL = "symptom-picker";
export const TEMPERATURE_PANEL = "temperature";
export const ADD_MEDICATION_PANEL = "add-medication";
export const medicationPanel = (itemId: number) => `medication:${itemId}`;
