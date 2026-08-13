import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  errorCardPalette,
  isDarkTheme,
  isHydrationErrorMessage,
  normalizePaletteChoice,
  normalizeThemeChoice,
  PALETTE_CHOICES,
  PALETTE_STORAGE_KEY,
  paletteAttribute,
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
  themeReassertEvent,
  type ThemeReassertObservation,
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

describe("errorCardPalette (#1906, extended to palettes by #2701)", () => {
  for (const appearance of PALETTE_CHOICES) {
    const light = errorCardPalette(false, appearance);
    const dark = errorCardPalette(true, appearance);

    it(`gives the ${appearance} dark scheme a genuinely dark card, not the light one`, () => {
      // The reported symptom was "the app switches to light mode and things look
      // broken" — a hard-coded light panel over a dark-mode app. These are the two
      // colours that produced it.
      expect(dark.page).not.toBe(light.page);
      expect(dark.panel).not.toBe(light.panel);
      expect(dark.heading).not.toBe(light.heading);
    });

    it(`${appearance} actually inverts, rather than merely differing`, () => {
      // A palette that differed but stayed bright would pass the test above while
      // reproducing the bug, so assert the direction: dark surfaces below light
      // text, light surfaces below dark text.
      expect(luminance(dark.page)).toBeLessThan(luminance(light.page));
      expect(luminance(dark.panel)).toBeLessThan(luminance(dark.heading));
      expect(luminance(light.panel)).toBeGreaterThan(luminance(light.heading));
    });

    it(`keeps the ${appearance} primary action readable in both schemes`, () => {
      // The palettes deliberately re-step the primary per mode (Floodlight even
      // inverts it), so "same hex both modes" stopped being the invariant with
      // #2701. What must hold instead: the label is legible on the fill.
      for (const card of [light, dark]) {
        expect(
          contrast(card.primaryText, card.primaryBackground)
        ).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`matches the ${appearance} page backgrounds the stylesheet already uses`, () => {
      // Not decorative duplication: this card replaces globals.css, so its page
      // colours have to be the ones the rest of the app paints under this
      // palette, or an error looks like a different app.
      const css = fs.readFileSync(path.join(REPO, "app/globals.css"), "utf8");
      expect(css).toContain(light.page);
      expect(css).toContain(dark.page);
    });
  }
});

describe("normalizePaletteChoice / paletteAttribute (#2701)", () => {
  it("keeps the three palettes and collapses everything else to the base", () => {
    expect(normalizePaletteChoice("botanical")).toBe("botanical");
    expect(normalizePaletteChoice("almanac")).toBe("almanac");
    expect(normalizePaletteChoice("floodlight")).toBe("floodlight");
    expect(normalizePaletteChoice(null)).toBe("botanical");
    expect(normalizePaletteChoice("")).toBe("botanical");
    expect(normalizePaletteChoice("vitals")).toBe("botanical");
  });

  it("answers the base palette as NO attribute, never a third value", () => {
    // The base tokens carry no [data-palette] scope in globals.css, so a stale
    // attribute must be REMOVED — an html[data-palette="botanical"] would match
    // nothing today and silently shadow the base the day someone adds it.
    expect(paletteAttribute("botanical")).toBeNull();
    expect(paletteAttribute(null)).toBeNull();
    expect(paletteAttribute("nonsense")).toBeNull();
    expect(paletteAttribute("almanac")).toBe("almanac");
    expect(paletteAttribute("floodlight")).toBe("floodlight");
  });
});

describe("one theme source", () => {
  it("is the key the pre-paint boot script reads", () => {
    // The boot script is a STRING of source that must run before any bundle, so it
    // cannot import the rule — but it interpolates this key, and the matrix test
    // below executes it against the rule itself. If they ever diverge, the error
    // card reads a preference nobody wrote.
    expect(THEME_BOOT_SCRIPT).toContain(
      `localStorage.getItem('${THEME_STORAGE_KEY}')`
    );
    expect(THEME_STORAGE_KEY).toBe("theme");
  });

  it("is the script the root layout actually inlines", () => {
    // The one-computation pin only binds anything if the layout ships THIS string
    // rather than a re-typed copy (#2183).
    const layout = fs.readFileSync(path.join(REPO, "app/layout.tsx"), "utf8");
    expect(layout).toContain("THEME_BOOT_SCRIPT");
    expect(layout).not.toContain("localStorage.getItem(");
  });
});

describe("THEME_BOOT_SCRIPT ≡ isDarkTheme (#2183)", () => {
  // Execute the boot script's source against stubbed browser globals and compare
  // its classList decision with the imported rule, across the full matrix — the
  // one-computation pin for the one place the rule is retyped rather than
  // imported. The re-assert component imports isDarkTheme outright, so this test
  // is what keeps boot and re-assert answering identically.
  function runBootScript(
    stored: string | null,
    prefersDark: boolean,
    storedPalette: string | null = null
  ): { dark: boolean | null; palette: string | null } {
    let applied: boolean | null = null;
    // Starts non-null so a run that REMOVES the attribute is distinguishable
    // from one that never touched it.
    let attribute: string | null = "stale";
    const run = new Function(
      "localStorage",
      "window",
      "document",
      THEME_BOOT_SCRIPT
    );
    run(
      {
        getItem: (k: string) =>
          k === THEME_STORAGE_KEY
            ? stored
            : k === PALETTE_STORAGE_KEY
              ? storedPalette
              : null,
      },
      {
        matchMedia: (q: string) => ({
          matches: q === "(prefers-color-scheme: dark)" && prefersDark,
        }),
      },
      {
        documentElement: {
          classList: {
            toggle: (cls: string, on: boolean) => {
              if (cls === "dark") applied = on;
            },
          },
          setAttribute: (name: string, value: string) => {
            if (name === "data-palette") attribute = value;
          },
          removeAttribute: (name: string) => {
            if (name === "data-palette") attribute = null;
          },
        },
      }
    );
    return { dark: applied, palette: attribute };
  }

  it("decides exactly as isDarkTheme for every stored × prefersDark case", () => {
    for (const stored of [null, "", "light", "dark", "system", "midnight"]) {
      for (const prefersDark of [true, false]) {
        expect(
          runBootScript(stored, prefersDark).dark,
          `stored=${JSON.stringify(stored)} prefersDark=${prefersDark}`
        ).toBe(isDarkTheme({ stored, prefersDark }));
      }
    }
  });

  it("stamps data-palette exactly as paletteAttribute for every stored palette (#2701)", () => {
    for (const storedPalette of [
      null,
      "",
      "botanical",
      "almanac",
      "floodlight",
      "vitals",
    ]) {
      expect(
        runBootScript("dark", true, storedPalette).palette,
        `storedPalette=${JSON.stringify(storedPalette)}`
      ).toBe(paletteAttribute(storedPalette));
    }
  });

  it("swallows a storage failure rather than throwing before first paint", () => {
    const run = new Function(
      "localStorage",
      "window",
      "document",
      THEME_BOOT_SCRIPT
    );
    expect(() =>
      run(
        {
          getItem: () => {
            throw new Error("denied");
          },
        },
        {},
        { documentElement: { classList: { toggle: () => {} } } }
      )
    ).not.toThrow();
  });
});

describe("themeReassertEvent (#2183)", () => {
  const base: ThemeReassertObservation = {
    route: "/wellness",
    expectedDark: true,
    classPresent: false,
    bootScriptPresent: true,
    swControlled: false,
    hydrationErrors: [],
  };

  it("fires exactly on the poisoned signature: dark expected, class missing", () => {
    expect(themeReassertEvent(base)).toEqual({
      route: "/wellness",
      bootScriptPresent: true,
      swControlled: false,
      hydrationErrors: [],
    });
  });

  it("is silent on the healthy path and for an explicit light theme", () => {
    expect(themeReassertEvent({ ...base, classPresent: true })).toBeNull();
    expect(themeReassertEvent({ ...base, expectedDark: false })).toBeNull();
    expect(
      themeReassertEvent({
        ...base,
        expectedDark: false,
        classPresent: true,
      })
    ).toBeNull();
  });

  it("carries the trigger-pinning facts and no health data", () => {
    const event = themeReassertEvent({
      ...base,
      bootScriptPresent: false,
      swControlled: true,
      hydrationErrors: ["Hydration failed because…"],
    });
    expect(event).toEqual({
      route: "/wellness",
      bootScriptPresent: false,
      swControlled: true,
      hydrationErrors: ["Hydration failed because…"],
    });
  });

  it("keeps only the newest hydration errors, capped in length", () => {
    const event = themeReassertEvent({
      ...base,
      hydrationErrors: ["one", "two", "three", "four", "x".repeat(500)],
    });
    const errors = (event as { hydrationErrors: string[] }).hydrationErrors;
    expect(errors).toHaveLength(3);
    expect(errors[0]).toBe("three");
    expect(errors[2]).toHaveLength(300);
  });
});

describe("isHydrationErrorMessage (#2183)", () => {
  it("matches every React hydration wording", () => {
    for (const msg of [
      "Hydration failed because the server rendered HTML didn't match the client.",
      "An error occurred during hydration. The server HTML was replaced with client content.",
      "There was an error while hydrating this Suspense boundary.",
    ]) {
      expect(isHydrationErrorMessage(msg), msg).toBe(true);
    }
  });

  it("rejects ordinary errors and empty input", () => {
    expect(isHydrationErrorMessage("Failed to fetch")).toBe(false);
    expect(isHydrationErrorMessage("TypeError: x is not a function")).toBe(
      false
    );
    expect(isHydrationErrorMessage("")).toBe(false);
    expect(isHydrationErrorMessage(null)).toBe(false);
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

/** WCAG contrast ratio (with proper sRGB linearization, unlike the rough
 *  luminance above — a 4.5:1 gate needs the real formula). */
function contrast(a: string, b: string): number {
  const lin = (hex: string): number => {
    const value = hex.replace("#", "");
    const channel = (i: number) => {
      const c = parseInt(value.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  };
  const [hi, lo] = [lin(a), lin(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
