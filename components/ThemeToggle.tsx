"use client";

import { useEffect, useState } from "react";
import {
  isDarkTheme,
  normalizeThemeChoice,
  THEME_STORAGE_KEY,
  type ThemeChoice,
} from "@/lib/theme";

type Theme = ThemeChoice;

const ORDER: Theme[] = ["system", "light", "dark"];

const LABELS: Record<Theme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

// Apply the effective theme by toggling the `dark` class on <html>, so a toggle
// takes effect without a reload. The RULE is lib/theme.ts's — shared with the boot
// script in layout.tsx and with app/global-error.tsx, which needs the same answer as
// data because it has no stylesheet to apply a class to (#1906).
function apply(theme: Theme) {
  const dark = isDarkTheme({
    stored: theme,
    prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
  });
  document.documentElement.classList.toggle("dark", dark);
}

function Icon({ theme }: { theme: Theme }) {
  if (theme === "light") {
    // sun
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="h-4 w-4"
      >
        <circle cx="12" cy="12" r="4" />
        <path
          d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (theme === "dark") {
    // moon
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
        <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
      </svg>
    );
  }
  // system / monitor
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-4 w-4"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" strokeLinecap="round" />
    </svg>
  );
}

// `bare` drops btn-ghost's own border/background for placement inside an
// already-bordered container (e.g. the sidebar footer box).
export default function ThemeToggle({ bare = false }: { bare?: boolean }) {
  const [theme, setTheme] = useState<Theme>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTheme(normalizeThemeChoice(localStorage.getItem(THEME_STORAGE_KEY)));
    setMounted(true);
    // Keep "system" in sync if the OS preference changes while the app is open.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (
        normalizeThemeChoice(localStorage.getItem(THEME_STORAGE_KEY)) ===
        "system"
      ) {
        apply("system");
      }
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
    setTheme(next);
    localStorage.setItem(THEME_STORAGE_KEY, next);
    apply(next);
  }

  return (
    <button
      type="button"
      onClick={cycle}
      // Avoid a hydration mismatch on the label: render a stable placeholder until mounted.
      suppressHydrationWarning
      className={
        bare
          ? "flex w-full items-center justify-start gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-white dark:text-slate-200 dark:hover:bg-ink-750"
          : "btn-ghost w-full justify-start"
      }
      title="Toggle color theme"
      aria-label={`Color theme: ${LABELS[theme]}`}
    >
      {/* Until mounted, render the same icon/label the server did (system) to
          avoid a hydration mismatch and a post-mount icon flip. */}
      <Icon theme={mounted ? theme : "system"} />
      <span>{mounted ? LABELS[theme] : "Theme"}</span>
    </button>
  );
}
