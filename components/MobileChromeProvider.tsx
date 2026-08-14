"use client";

import { createContext, useContext, useMemo } from "react";
import { usePathname } from "next/navigation";
import { useResettableState } from "./useResettableState";

// The phone chrome's shared open/closed state (issue #2651).
//
// The drawer and log sheet overlays live in MobileNav while their sole visible
// triggers — dock More and the puck — live in another subtree (#2745/#2746).
// The top bar lives inside <ShellChrome>, which TRANSFORMS itself to hide on
// scroll; the dock must not,
// because a transformed ancestor turns `position: fixed` into "fixed relative to
// that ancestor" and would drag the dock up the screen with the bar. So the dock
// is a sibling of <main>, not a descendant of the bar.
//
// Cross-subtree state over ONE overlay is exactly what a provider is for. A
// second drawer instance owned by the dock would put two copies of the whole
// navigation in the tree (and two
// `mobile-drawer` nodes for anything that queries by role), and a custom DOM
// event — the decoupling `openGlobalSearch` uses — would carry no state BACK, so
// the More button could not honestly report `aria-expanded`.
//
// The overlays themselves still live where they always did (the drawer and the
// quick-log sheet are rendered by MobileNav): this owns the boolean, not the UI.
//
// Navigation owns the lifetime of both, exactly as it did when MobileNav held
// this state locally — a new pathname gets a fresh closed draft during render
// rather than being closed by a follow-up effect.

interface MobileChromeApi {
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  logSheetOpen: boolean;
  setLogSheetOpen: (open: boolean) => void;
}

const Ctx = createContext<MobileChromeApi | null>(null);

export function useMobileChrome(): MobileChromeApi {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error(
      "useMobileChrome must be used within a MobileChromeProvider"
    );
  }
  return ctx;
}

export default function MobileChromeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useResettableState(false, pathname);
  const [logSheetOpen, setLogSheetOpen] = useResettableState(false, pathname);
  const api = useMemo<MobileChromeApi>(
    () => ({ drawerOpen, setDrawerOpen, logSheetOpen, setLogSheetOpen }),
    [drawerOpen, setDrawerOpen, logSheetOpen, setLogSheetOpen]
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
