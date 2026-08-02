import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  errorCardPalette,
  isDarkTheme,
  normalizeThemeChoice,
  THEME_STORAGE_KEY,
} from "@/lib/theme";

// The one theme rule (app/layout.tsx's boot script, components/ThemeToggle.tsx) and
// the one surface that needs it as DATA rather than as a `dark` class:
// app/global-error.tsx, which replaces the root layout — boot script included — and
// so used to paint a hard-coded LIGHT card over a dark-mode app (issue #1906).

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("isDarkTheme", () => {
  it("honours an explicit choice over the OS preference, both ways", () => {
    expect(isDarkTheme({ stored: "dark", prefersDark: false })).toBe(true);
    expect(isDarkTheme({ stored: "light", prefersDark: true })).toBe(false);
  });

  it("defers to the OS on 'system'", () => {
    expect(isDarkTheme({ stored: "system", prefersDark: true })).toBe(true);
    expect(isDarkTheme({ stored: "system", prefersDark: false })).toBe(false);
  });

  it("treats an absent or unrecognised value as 'system'", () => {
    for (const stored of [null, undefined, "", "DARK", "midnight"]) {
      expect(isDarkTheme({ stored, prefersDark: true })).toBe(true);
      expect(isDarkTheme({ stored, prefersDark: false })).toBe(false);
    }
  });
});

describe("normalizeThemeChoice", () => {
  it("keeps the two explicit choices and collapses everything else", () => {
    expect(normalizeThemeChoice("light")).toBe("light");
    expect(normalizeThemeChoice("dark")).toBe("dark");
    expect(normalizeThemeChoice("system")).toBe("system");
    expect(normalizeThemeChoice(null)).toBe("system");
    expect(normalizeThemeChoice("nonsense")).toBe("system");
  });
});

describe("errorCardPalette (#1906)", () => {
  const light = errorCardPalette(false);
  const dark = errorCardPalette(true);

  it("gives the dark scheme a genuinely dark card, not the light one", () => {
    // The reported symptom was "the app switches to light mode and things look
    // broken" — a hard-coded light panel over a dark-mode app. These are the two
    // colours that produced it.
    expect(dark.page).not.toBe(light.page);
    expect(dark.panel).not.toBe(light.panel);
    expect(dark.heading).not.toBe(light.heading);
  });

  it("actually inverts, rather than merely differing", () => {
    // A palette that differed but stayed bright would pass the test above while
    // reproducing the bug, so assert the direction: dark surfaces below light text,
    // light surfaces below dark text.
    expect(luminance(dark.page)).toBeLessThan(luminance(light.page));
    expect(luminance(dark.panel)).toBeLessThan(luminance(dark.heading));
    expect(luminance(light.panel)).toBeGreaterThan(luminance(light.heading));
  });

  it("keeps the primary action the same button in both schemes", () => {
    // The brand green is the app's primary everywhere; a primary that changed colour
    // with the scheme would read as a different action.
    expect(dark.primaryBackground).toBe(light.primaryBackground);
    expect(dark.primaryText).toBe(light.primaryText);
  });

  it("matches the page backgrounds the stylesheet and viewport tint already use", () => {
    // Not decorative duplication: this card replaces globals.css, so its two page
    // colours have to be the ones the rest of the app paints, or an error looks like
    // a different app.
    const css = fs.readFileSync(path.join(REPO, "app/globals.css"), "utf8");
    expect(css).toContain(light.page);
    expect(css).toContain(dark.page);
  });
});

describe("one theme source", () => {
  it("is the key the pre-paint boot script reads", () => {
    // The boot script is a STRING of source that must run before any bundle, so it
    // cannot import the rule — but it can and does interpolate this key. If they ever
    // diverge, the error card reads a preference nobody wrote.
    const layout = fs.readFileSync(path.join(REPO, "app/layout.tsx"), "utf8");
    expect(layout).toContain("localStorage.getItem('${THEME_STORAGE_KEY}')");
    expect(THEME_STORAGE_KEY).toBe("theme");
  });
});

/** Rough relative luminance, enough to say "this is the dark one". */
function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
