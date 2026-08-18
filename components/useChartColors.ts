"use client";

import { useEffect, useState } from "react";

// Recharts takes colors as plain JS values (SVG attributes / inline styles), so
// Tailwind's `dark:` variants can't reach them. This hook tracks the `dark`
// class on <html> and returns Botanical scaffolding colors for the live mode.
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
  // it is also the surface the #1445 color validation measures contrast against.
  surface: string;
}

const LIGHT_COLORS: ChartColors = {
  grid: "#d9e8de",
  axis: "#86a190",
  tick: "#4e6354",
  tooltipBg: "#f4f8f0",
  tooltipBorder: "#d9e8de",
  tooltipText: "#1e3226",
  line: "#ea580c",
  surface: "#f4f8f0",
};

const DARK_COLORS: ChartColors = {
  grid: "#263129",
  axis: "#4e6354",
  tick: "#86a190",
  tooltipBg: "#1a231d",
  tooltipBorder: "#263129",
  tooltipText: "#d9e8de",
  line: "#fb923c",
  surface: "#101711",
};

function isDark(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  );
}

export function useChartColors(): ChartColors {
  // Initialize from the live theme. Recharts renders client-only (no SVG in the
  // SSR markup), so reading the DOM here can't cause a hydration mismatch — and
  // it avoids a light-colored flash on dark-mode loads. The observer keeps it in
  // sync when the theme is toggled.
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const update = () => setDark(isDark());
    update();
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);
  return dark ? DARK_COLORS : LIGHT_COLORS;
}
