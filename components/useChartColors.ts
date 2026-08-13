"use client";

import { useEffect, useState } from "react";
import {
  PALETTES,
  paletteHex,
  type AppearancePalette,
} from "@/lib/chart-colors";

// Recharts takes colors as plain JS values (SVG attributes / inline styles), so
// Tailwind's `dark:` variants can't reach them. This hook tracks the `dark`
// class AND the `data-palette` attribute on <html> (#2701) and returns
// scaffolding colors for the live palette × mode.
export interface ChartColors {
  grid: string;
  axis: string;
  tick: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  // BiomarkerChart's value line + dots (dark navy in light mode would vanish on
  // a dark background).
  line: string;
  // The card surface the chart is drawn on. Used to HOLLOW a dot (surface fill +
  // colored stroke) and to cut the 2px gap between stacked bar segments — both
  // need to paint the background back over a mark, so they need its color, and
  // it is also the surface the #1445 palette validation measures contrast against.
  surface: string;
}

// Scaffolding derives from the SAME token map the cell ramps use
// (lib/chart-colors PALETTES), so the axis greys and tooltip surfaces follow
// the palette instead of restating the retired Vitals slate. The value line
// stays the warm orange pair in every palette: it exists to pop against the
// green optimal band, and that job is palette-independent.
function colorsFor(palette: AppearancePalette, dark: boolean): ChartColors {
  const hex = (token: string) => paletteHex(palette, token);
  const surface = PALETTES[palette].chartSurface[dark ? "dark" : "light"];
  if (dark) {
    return {
      grid: hex("ink-700"),
      axis: hex("slate-500"),
      tick: hex("slate-400"),
      tooltipBg: hex("ink-750"),
      tooltipBorder: hex("ink-700"),
      tooltipText: hex("slate-200"),
      line: "#fb923c", // orange-400 — vivid on dark, pops against the optimal band
      surface,
    };
  }
  return {
    grid: hex("slate-200"),
    axis: hex("slate-400"),
    tick: hex("slate-500"),
    tooltipBg: surface,
    tooltipBorder: hex("slate-200"),
    tooltipText: hex("slate-800"),
    line: "#ea580c", // orange-600 — pops against the green optimal band
    surface,
  };
}

function isDark(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  );
}

function livePalette(): AppearancePalette {
  if (typeof document === "undefined") return "botanical";
  const raw = document.documentElement.getAttribute("data-palette");
  return raw === "almanac" || raw === "floodlight" ? raw : "botanical";
}

export function useChartColors(): ChartColors {
  // Initialize from the live theme. Recharts renders client-only (no SVG in the
  // SSR markup), so reading the DOM here can't cause a hydration mismatch — and
  // it avoids a light-colored flash on dark-mode loads. The observer keeps it in
  // sync when the theme or the palette is toggled.
  const [dark, setDark] = useState(isDark);
  const [palette, setPalette] = useState<AppearancePalette>(livePalette);
  useEffect(() => {
    const update = () => {
      setDark(isDark());
      setPalette(livePalette());
    };
    update();
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-palette"],
    });
    return () => obs.disconnect();
  }, []);
  return colorsFor(palette, dark);
}
