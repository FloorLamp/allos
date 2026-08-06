// The ONE theme decision, and the one palette that cannot use it.
//
// Everywhere in the app, "is it dark?" is answered by a `dark` class on <html> and
// then by Tailwind's `dark:` variants — set before first paint by the inline boot
// script (THEME_BOOT_SCRIPT below, inlined by app/layout.tsx), kept live by
// components/ThemeToggle.tsx, and re-asserted post-hydration and on route changes
// by components/ThemeReassert.tsx (#2183), so one hard navigation whose boot
// script never ran cannot poison the whole SPA session. The boot script and the
// toggle used to hold two hand-copied transcriptions of the same rule ("stay in
// sync", said both comments); the rule itself now lives here and every consumer
// reads it.
//
// `app/global-error.tsx` is the surface that needs the decision as DATA rather than
// as a class. It replaces the ROOT LAYOUT when something above the route group
// throws, which means it replaces the boot script too — no `dark` class is ever set,
// and globals.css may not have loaded, so `dark:` variants have nothing to key on.
// Its inline styles were the right instinct; what they were missing was this. Reading
// the same storage key the boot script reads is the point: a second theme source
// would be a second answer to a question the user already answered once (#1906).

/** Where the user's choice lives. Interpolated into the boot script's source. */
export const THEME_STORAGE_KEY = "theme";

/**
 * The pre-paint boot script (#2183). One place the rule has to be RETYPED rather
 * than imported: this is a string of source that must execute before any bundle
 * does, so it cannot call `isDarkTheme` — but it lives HERE, beside the rule it
 * transcribes, and `lib/__tests__/theme.test.ts` executes it against `isDarkTheme`
 * across the whole stored × prefersDark matrix so the two cannot drift. (That pin
 * caught a real one on arrival: the old copy's `t || 'system'` read an
 * unrecognised stored value as light, where `normalizeThemeChoice` means system —
 * hence `t !== 'light'`, the same "anything unrecognised defers to the OS".)
 *
 * app/layout.tsx inlines it (nonce'd, in <head>) so the class is set before first
 * paint — the no-FOUC happy path. It runs ONCE per document; the safety net under
 * it is components/ThemeReassert.tsx, which re-applies the same rule (imported,
 * not retyped) post-hydration and on every route change, so one hard navigation
 * whose boot script never ran cannot leave the whole SPA session light (#2183).
 */
export const THEME_BOOT_SCRIPT = `
(function () {
  try {
    var t = localStorage.getItem('${THEME_STORAGE_KEY}');
    var dark = t === 'dark' || (t !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) {}
})();
`;

export type ThemeChoice = "light" | "dark" | "system";

/** Anything unrecognised — absent, corrupt, from a future build — means "system". */
export function normalizeThemeChoice(
  raw: string | null | undefined
): ThemeChoice {
  return raw === "light" || raw === "dark" ? raw : "system";
}

/**
 * The effective scheme: an explicit choice wins, "system" defers to the OS.
 *
 * Pure on purpose — the caller supplies the stored string and the media query's
 * answer, so the rule is testable without a DOM and identical in every caller.
 */
export function isDarkTheme({
  stored,
  prefersDark,
}: {
  stored: string | null | undefined;
  prefersDark: boolean;
}): boolean {
  const choice = normalizeThemeChoice(stored);
  return choice === "dark" || (choice === "system" && prefersDark);
}

/**
 * Inline colours for the top-level error card (#1906).
 *
 * Values are the same ones the stylesheet uses, restated as literals because this is
 * the one surface that cannot reach the stylesheet: the light page is globals.css's
 * `#e4ece6` body and a white panel; the dark page is its `#090c0b` body with the
 * `ink-800`/`ink-750` surfaces and slate text the rest of the dark theme uses. The
 * brand green stays put in both — a primary action that changes colour with the
 * scheme reads as a different button, and this one is the same button.
 */
export type ErrorCardPalette = {
  page: string;
  panel: string;
  panelShadow: string;
  heading: string;
  body: string;
  muted: string;
  primaryBackground: string;
  primaryText: string;
  secondaryBackground: string;
  secondaryText: string;
  secondaryBorder: string;
};

const LIGHT_ERROR_CARD: ErrorCardPalette = {
  page: "#e4ece6",
  panel: "#ffffff",
  panelShadow: "0 10px 30px rgba(15,23,42,0.15)",
  heading: "#1e293b",
  body: "#64748b",
  muted: "#94a3b8",
  primaryBackground: "#16a34a",
  primaryText: "#ffffff",
  secondaryBackground: "#ffffff",
  secondaryText: "#334155",
  secondaryBorder: "rgba(15,23,42,0.12)",
};

const DARK_ERROR_CARD: ErrorCardPalette = {
  page: "#090c0b",
  panel: "#141a17",
  panelShadow: "0 10px 30px rgba(0,0,0,0.45)",
  heading: "#f1f5f9",
  body: "#94a3b8",
  muted: "#64748b",
  primaryBackground: "#16a34a",
  primaryText: "#ffffff",
  secondaryBackground: "#1a211d",
  secondaryText: "#e2e8f0",
  secondaryBorder: "rgba(255,255,255,0.12)",
};

export function errorCardPalette(dark: boolean): ErrorCardPalette {
  return dark ? DARK_ERROR_CARD : LIGHT_ERROR_CARD;
}

// ── The re-assert diagnostic (#2183) ─────────────────────────────────────────
//
// The reported bug: one hard navigation whose boot script never ran left the
// whole session light until a manual toggle. The re-assert heals that; this pair
// of pure functions is the instrumentation that pins the TRIGGER on the next
// occurrence instead of guessing at it. Both are pure so the decision — what
// counts as poisoned, what the event carries — is testable without a DOM.

/**
 * Does a window error message look like a React hydration failure? The #2183
 * follow-up theory is a hydration-recovery root re-render silently dropping the
 * boot-added class, so the diagnostic records any hydration error seen on the
 * page alongside the light-session event. React 19's recoverable errors reach
 * `window`'s "error" listener via its default `onRecoverableError` (reportError);
 * every wording it uses ("Hydration failed…", "An error occurred during
 * hydration", "…error while hydrating") names the act, so one stem matches all
 * of them without matching ordinary errors.
 */
export function isHydrationErrorMessage(
  message: string | null | undefined
): boolean {
  return /hydrat/i.test(message ?? "");
}

/** What the re-assert observed, gathered impurely by ThemeReassert. */
export interface ThemeReassertObservation {
  /** The App Router pathname the re-assert ran on. */
  route: string;
  /** What the ONE rule (isDarkTheme) says the document should be. */
  expectedDark: boolean;
  /** Whether `<html>` actually carries the `dark` class right now. */
  classPresent: boolean;
  /** Whether an inline nonce'd script survived into this document at all. */
  bootScriptPresent: boolean;
  /** Whether a service worker controls this document (offline-shell candidate). */
  swControlled: boolean;
  /** Hydration-looking error messages seen on this page, oldest first. */
  hydrationErrors: string[];
}

// Bound the event: a page minting hydration errors in a loop must not balloon
// one diagnostic line. Newest errors win — they are the ones adjacent in time to
// the light landing being reported.
const REASSERT_MAX_HYDRATION_ERRORS = 3;
const REASSERT_MAX_ERROR_CHARS = 300;

/**
 * The one structured client event (#2183): non-null exactly when the boot
 * failed in the reported direction — storage says dark, the class is missing.
 * The healthy path, an explicit light theme, and the impossible inverse (a
 * class present that storage disowns — the toggle's own writes, which the
 * re-assert also corrects) log nothing: the event exists to convert "sometimes
 * light" into a pinned trigger, not to narrate every render. No health data —
 * route and document facts only.
 */
export function themeReassertEvent(
  obs: ThemeReassertObservation
): Record<string, unknown> | null {
  if (!obs.expectedDark || obs.classPresent) return null;
  return {
    route: obs.route,
    bootScriptPresent: obs.bootScriptPresent,
    swControlled: obs.swControlled,
    hydrationErrors: obs.hydrationErrors
      .slice(-REASSERT_MAX_HYDRATION_ERRORS)
      .map((m) => m.slice(0, REASSERT_MAX_ERROR_CHARS)),
  };
}
