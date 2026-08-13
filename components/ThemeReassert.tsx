"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { createLogger } from "@/lib/log";
import {
  isDarkTheme,
  isHydrationErrorMessage,
  PALETTE_STORAGE_KEY,
  paletteAttribute,
  THEME_STORAGE_KEY,
  themeReassertEvent,
} from "@/lib/theme";

// The theme boot's safety net (#2183). The `dark` class on <html> is set exactly
// once per document, by the inline boot script — so ONE hard navigation whose
// boot script fails to run (blocked inline script, an offline-shell document, a
// hydration-recovery root re-render dropping the boot-added class) used to leave
// the entire SPA session light until a manual toggle: `router.push` navigations
// inherit the document's class forever.
//
// This component re-asserts the class idempotently, post-hydration and on every
// App Router route change. The RULE is lib/theme.ts's `isDarkTheme` — imported,
// never re-derived (the deploy-skew doc's one-computation rule) — and the cost is
// one classList call per navigation. The boot script stays the first-paint
// authority (it is what prevents the flash on the happy path); this runs only
// after hydration, so there is no FOUC regression and no second theme source.
//
// Instrumentation, not guessing: when the re-assert finds the class MISSING but
// the rule says dark — the reported poisoned state — it logs ONE structured
// client event (route, nonce'd-script presence, SW-controlled flag, any
// hydration errors seen) through createLogger before healing, so the next report
// pins the trigger. Client console only: the browser bundle never registers the
// error-log sink, no endpoint is involved, and the event carries no health data.
// The poisoned-or-not decision and the event shape are pure (themeReassertEvent).
const log = createLogger("theme-reassert");

export default function ThemeReassert() {
  const pathname = usePathname();
  // Hydration-looking error messages seen on this document, oldest first. React
  // 19's recovery discards the server DOM and client-renders the root from
  // scratch — the leading candidate for dropping the boot-added class — and its
  // recoverable errors reach window's "error" listener via the default
  // onRecoverableError (reportError). A ref, not state: recording an error must
  // not itself schedule a render.
  const hydrationErrors = useRef<string[]>([]);

  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      const message =
        e.message || (e.error instanceof Error ? e.error.message : "");
      if (isHydrationErrorMessage(message)) {
        hydrationErrors.current.push(message);
      }
    };
    window.addEventListener("error", onError);
    return () => window.removeEventListener("error", onError);
  }, []);

  useEffect(() => {
    let dark: boolean;
    try {
      // The boot script's exact computation, from the one module that owns it.
      dark = isDarkTheme({
        stored: localStorage.getItem(THEME_STORAGE_KEY),
        prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
      });
    } catch {
      // Storage blocked entirely — the boot script's own catch posture.
      return;
    }
    const root = document.documentElement;
    const event = themeReassertEvent({
      route: pathname,
      expectedDark: dark,
      classPresent: root.classList.contains("dark"),
      // Browsers blank a nonce's VALUE after parsing, but the attribute stays —
      // presence is what distinguishes "script stripped/absent" from "script
      // delivered but never executed".
      bootScriptPresent: document.querySelector("script[nonce]") != null,
      swControlled: navigator.serviceWorker?.controller != null,
      hydrationErrors: hydrationErrors.current,
    });
    if (event) {
      log.warn("theme boot failed: dark expected but class missing", event);
    }
    // Idempotent both ways: heals the poisoned dark session AND clears a stale
    // class an explicit light choice disowns. No-op on the happy path.
    root.classList.toggle("dark", dark);
    // The palette attribute rides the same safety net (#2701): a document whose
    // boot script never ran would otherwise render the base palette forever.
    // paletteAttribute is the one rule — null means REMOVE, base is the absence.
    try {
      const attr = paletteAttribute(localStorage.getItem(PALETTE_STORAGE_KEY));
      if (attr) root.setAttribute("data-palette", attr);
      else root.removeAttribute("data-palette");
    } catch {
      // Storage blocked — same posture as the theme read above.
    }
  }, [pathname]);

  return null;
}
