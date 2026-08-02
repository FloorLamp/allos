"use client";

import { useEffect, useState } from "react";
import { errorCardPalette, isDarkTheme, THEME_STORAGE_KEY } from "@/lib/theme";
import {
  nextSkewGuard,
  parseSkewGuard,
  SKEW_RECOVERY_KEY,
  skewRecoveryPlan,
  UPDATE_PENDING_KEY,
  updatePendingFromMarker,
} from "@/lib/sw-update";

// Top-level error boundary. Unlike app/(app)/error.tsx this replaces the root layout
// when the layout itself (or something above the route group) throws, so it renders
// its own <html>/<body>. Tailwind/globals may not be applied at this point, so the
// card is styled with inline styles to stay legible in the worst case.
//
// THREE THINGS THIS PAGE GOT WRONG UNDER DEPLOYMENT SKEW (issue #1906). The owner's
// repro — dark mode, a pending update, a client-side navigation — produced "the app
// switches to light mode and things look broken", which was three defects at once:
//
//   1. Replacing the root layout also replaces the THEME-BOOT SCRIPT, so no `dark`
//      class is ever set; a hard-coded light card then reads as the app flipping
//      theme on top of whatever else went wrong. The palette is now chosen from the
//      same stored theme the boot script reads — one theme source, not two.
//   2. "Try again" called `reset()`: a re-render of the same stale runtime, reaching
//      for the same chunks the deploy deleted, failing identically every time. The
//      primary action is a HARD RELOAD now, which is the one recovery skew has.
//   3. The card should not have been the first thing shown at all. A recognisable
//      chunk-load failure while an update is pending is not an "unexpected error" —
//      it is the known stale-build state, and it is recovered below before anything
//      renders. The card stays for the ordinary crash, and for a reload that did not
//      help.
//
// The decisions (is this skew? has the guard an attempt left? is it dark?) live in
// lib/sw-update.ts and lib/theme.ts, so the registrar and this boundary answer the
// same questions with the same code and both are unit-tested without a browser.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Lazy initializer rather than an effect: the palette is decided on the very first
  // client render, so the card never paints light-then-dark. Server-rendered output
  // (no window) falls back to light and is corrected at hydration, which is what the
  // suppressHydrationWarning below covers — the same trade the root layout makes.
  const [dark, setDark] = useState(() => detectDark());
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    setDark(detectDark());
  }, []);

  useEffect(() => {
    let pendingRaw: string | null = null;
    let guardRaw: string | null = null;
    try {
      pendingRaw = sessionStorage.getItem(UPDATE_PENDING_KEY);
      guardRaw = sessionStorage.getItem(SKEW_RECOVERY_KEY);
    } catch {
      // No storage means no marker and no guard. Without a guard a reload could
      // spin, so this context gets the card — the honest fallback.
      return;
    }
    const now = Date.now();
    const guard = parseSkewGuard(guardRaw);
    if (
      skewRecoveryPlan({
        error,
        updatePending: updatePendingFromMarker(pendingRaw),
        guard,
        now,
      }) !== "hard-reload"
    ) {
      return;
    }
    try {
      // Record the attempt BEFORE taking it. If the write fails we do not navigate:
      // an unrecorded attempt is an unguarded one, and an unguarded reload on a
      // genuinely broken deploy is an invisible infinite redirect.
      sessionStorage.setItem(
        SKEW_RECOVERY_KEY,
        JSON.stringify(nextSkewGuard(guard, now))
      );
    } catch {
      return;
    }
    setRecovering(true);
    hardReload();
  }, [error]);

  const palette = errorCardPalette(dark);

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        data-testid="global-error"
        data-theme={dark ? "dark" : "light"}
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: palette.page,
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          color: palette.heading,
        }}
      >
        <div
          data-testid="global-error-card"
          style={{
            maxWidth: "28rem",
            margin: "1rem",
            padding: "2rem",
            borderRadius: "0.75rem",
            background: palette.panel,
            boxShadow: palette.panelShadow,
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: "1.125rem", fontWeight: 700, margin: 0 }}>
            {recovering ? "Updating…" : "Something went wrong"}
          </h1>
          <p
            style={{
              marginTop: "0.5rem",
              fontSize: "0.875rem",
              color: palette.body,
            }}
          >
            {recovering
              ? "A newer version of Allos is available. Loading it now."
              : "The app hit an unexpected error. Reloading picks up the latest version — if it keeps happening, the reference below can help with debugging."}
          </p>
          {error.digest && !recovering && (
            <p
              style={{
                marginTop: "0.5rem",
                fontFamily: "ui-monospace, monospace",
                fontSize: "0.75rem",
                color: palette.muted,
              }}
            >
              Reference: {error.digest}
            </p>
          )}
          {!recovering && (
            <div
              style={{
                marginTop: "1.25rem",
                display: "flex",
                gap: "0.5rem",
                justifyContent: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                data-testid="global-error-reload"
                onClick={hardReload}
                style={{
                  padding: "0.5rem 1rem",
                  borderRadius: "0.5rem",
                  border: "none",
                  background: palette.primaryBackground,
                  color: palette.primaryText,
                  fontSize: "0.875rem",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Reload the app
              </button>
              {/* `reset()` survives as the SECONDARY action, not the primary. It
                  cannot resolve deployment skew — that is the whole point of #1906 —
                  but this card is also the fallback for the ordinary crash, where a
                  root-layout read blipped and a re-render is the cheap,
                  non-destructive thing to try before throwing the document away.
                  Demoting it costs nothing; deleting it would remove the only action
                  that keeps client state. */}
              <button
                type="button"
                data-testid="global-error-reset"
                onClick={reset}
                style={{
                  padding: "0.5rem 1rem",
                  borderRadius: "0.5rem",
                  border: `1px solid ${palette.secondaryBorder}`,
                  background: palette.secondaryBackground,
                  color: palette.secondaryText,
                  fontSize: "0.875rem",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </body>
    </html>
  );
}

// The same decision the boot script makes, from the same storage key.
function detectDark(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return isDarkTheme({
      stored: localStorage.getItem(THEME_STORAGE_KEY),
      prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    });
  } catch {
    // Storage denied — the media query alone is still a better guess than "light".
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {
      return false;
    }
  }
}

/**
 * A genuine full-document load, and deliberately not a soft refresh.
 *
 * The repo's rule about `router.refresh()` after a revalidating Server Action
 * (docs/internals/server-action-refresh.md) is about a DIFFERENT thing: avoiding a
 * redundant second fetch of a page the action response already carried. Nothing of
 * the sort applies here. This tab is running a build whose assets no longer exist on
 * the server; only tearing the document down and asking the server again lands on the
 * new build. A soft refresh reuses the same stale runtime and cannot work, so please
 * do not "optimize" this into one.
 */
function hardReload(): void {
  // The URL bar already holds the destination the user was navigating to, so
  // reloading it IS the hard navigation to that destination.
  window.location.reload();
}
