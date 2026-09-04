"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { IntradayView } from "@/lib/intraday-layout";

// ONE ZOOM AND ONE CROSSHAIR FOR THE DAY, NOT ONE PER CHART (#4950).
//
// `components/IntradayPanel.tsx` mounts `IntradayChart` TWICE — `variant="compact"`
// under `sm:hidden` and `variant="wide"` under `hidden sm:block` — and both are in the
// DOM at once. That was harmless while the view and the cursor were private: only the
// visible one receives pointer events, so only it ever moved.
//
// It stops being harmless the moment anything OUTSIDE the chart reads them. The owner's
// amendment makes the add row read the window off "the current view", and with two
// owners there are two views and no way for the page to know which one the viewport is
// showing. Every cheaper channel — a `window` CustomEvent like `revealShellChrome`, or a
// context each chart WRITES into — has the same collision, and survives today only
// because a hidden chart happens to receive no events. That is true because of a CSS
// class, and it would go quietly false the first time someone changes the breakpoint or
// renders both; the failure is an add row offering clocks from the chart nobody is
// looking at.
//
// So the state is lifted and the charts become readers of it. There is one window
// because there is one view, and "which variant is showing?" stops being a question
// anyone has to answer.
//
// NO PROVIDER IS ALSO A VALID MOUNT. A chart rendered outside the day page — a test, a
// future surface — keeps a private pair, so this cannot make an isolated chart depend on
// a wrapper it does not have. Both hooks are called unconditionally either way, which is
// what keeps that fallback inside the rules of hooks.
export interface IntradayInteraction {
  /** The zoom window, or null at full day. */
  view: IntradayView | null;
  setView: Dispatch<SetStateAction<IntradayView | null>>;
  /** The crosshair's minute, or null when the pointer is away. */
  cursor: number | null;
  setCursor: Dispatch<SetStateAction<number | null>>;
}

const IntradayInteractionContext = createContext<IntradayInteraction | null>(
  null
);

export function IntradayInteractionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [view, setView] = useState<IntradayView | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const value = useMemo(
    () => ({ view, setView, cursor, setCursor }),
    [view, cursor]
  );
  return (
    <IntradayInteractionContext.Provider value={value}>
      {children}
    </IntradayInteractionContext.Provider>
  );
}

/** The shared pair when a provider is above, a private pair when none is. */
export function useIntradayInteraction(): IntradayInteraction {
  const shared = useContext(IntradayInteractionContext);
  const [view, setView] = useState<IntradayView | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const own = useMemo(
    () => ({ view, setView, cursor, setCursor }),
    [view, cursor]
  );
  return shared ?? own;
}
