"use client";

import { useEffect, useState } from "react";

// Recharts takes colors as plain JS values (SVG attributes / inline styles), so
// Tailwind's `dark:` variants can't reach them. This hook tracks the `dark` class
// on <html> and returns theme-appropriate chart colors instead.
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
  dotHollowFill: string;
}

const LIGHT: ChartColors = {
  grid: "#e2e8f0", // slate-200
  axis: "#94a3b8", // slate-400
  tick: "#64748b", // slate-500
  tooltipBg: "#ffffff",
  tooltipBorder: "#e2e8f0", // slate-200
  tooltipText: "#1e293b", // slate-800
  line: "#ea580c", // orange-600 (Vitals secondary) — pops against the green optimal band
  dotHollowFill: "#ffffff", // card surface, so bounded dots read as hollow
};

const DARK: ChartColors = {
  grid: "#334155", // slate-700
  axis: "#64748b", // slate-500
  tick: "#94a3b8", // slate-400
  tooltipBg: "#1e293b", // slate-800
  tooltipBorder: "#334155", // slate-700
  tooltipText: "#e2e8f0", // slate-200
  line: "#fb923c", // orange-400 (Vitals secondary) — vivid on dark, pops against the green optimal band
  dotHollowFill: "#0f172a", // slate-900 = the card surface, so bounded dots read as hollow
};

function isDark(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  );
}

export function useChartColors(): ChartColors {
  // Initialize from the live theme. Recharts renders client-only (no SVG in the
  // SSR markup), so reading the class here can't cause a hydration mismatch — and
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
  return dark ? DARK : LIGHT;
}
