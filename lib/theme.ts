// The ONE theme decision, and the one palette that cannot use it.
//
// Everywhere in the app, "is it dark?" is answered by a `dark` class on <html> and
// then by Tailwind's `dark:` variants — set before first paint by the inline boot
// script in app/layout.tsx, kept live by components/ThemeToggle.tsx. Those two used
// to hold two hand-copied transcriptions of the same rule ("stay in sync", said both
// comments); the rule itself now lives here and both read it.
//
// `app/global-error.tsx` is the surface that needs the decision as DATA rather than
// as a class. It replaces the ROOT LAYOUT when something above the route group
// throws, which means it replaces the boot script too — no `dark` class is ever set,
// and globals.css may not have loaded, so `dark:` variants have nothing to key on.
// Its inline styles were the right instinct; what they were missing was this. Reading
// the same storage key the boot script reads is the point: a second theme source
// would be a second answer to a question the user already answered once (#1906).

/** Where the user's choice lives. Mirrored in the boot script's inline source. */
export const THEME_STORAGE_KEY = "theme";

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
