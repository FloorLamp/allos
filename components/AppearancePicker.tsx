"use client";

import { useSyncExternalStore } from "react";
import {
  normalizePaletteChoice,
  PALETTE_CHOICES,
  PALETTE_STORAGE_KEY,
  paletteAttribute,
  type PaletteChoice,
} from "@/lib/theme";
import { useHydrated } from "./useHydrated";

// Settings → Display → Appearance (#2701): the palette picker. DEVICE-scoped,
// exactly like the theme toggle — the choice lives in localStorage beside the
// `theme` key, is stamped pre-paint by the boot script, and is re-asserted by
// ThemeReassert. Per-login sync is deferred.
//
// The picker itself follows ThemeToggle's storage discipline: one storage key,
// read through useSyncExternalStore so two mounted pickers (or another tab)
// stay in agreement, and the DOM attribute applied through the ONE rule
// (paletteAttribute) so "base palette" is the ABSENCE of the attribute.

const PALETTE_CHANGE_EVENT = "allos:palette-change";

interface PaletteMeta {
  label: string;
  description: string;
  // Light-mode-forward swatch preview colors (the palette's own tokens,
  // restated as literals — a preview must show the palette you are NOT in).
  canvas: string;
  surface: string;
  border: string;
  accent: string;
  // A hint of the palette's display voice on the swatch label.
  labelStyle?: React.CSSProperties;
}

const PALETTE_META: Record<PaletteChoice, PaletteMeta> = {
  botanical: {
    label: "Botanical",
    description: "Tone-on-tone green, soft and calm. The default.",
    canvas: "#ecf3e7",
    surface: "#f4f8f0",
    border: "#ccdcc4",
    accent: "#166534",
  },
  almanac: {
    label: "Almanac",
    description: "Warm paper, ruled lines, serif headings.",
    canvas: "#f8f5ee",
    surface: "#fdfbf5",
    border: "#c9c0a6",
    accent: "#3f6212",
    labelStyle: {
      fontFamily: '"Iowan Old Style", "Palatino Linotype", Georgia, serif',
    },
  },
  floodlight: {
    label: "Floodlight",
    description: "Sharp corners, hard amber shadows, deliberately fun.",
    canvas: "#fdfdfb",
    surface: "#ffffff",
    border: "#1a1917",
    accent: "#fbbf24",
    labelStyle: { fontStyle: "italic", fontWeight: 800 },
  },
};

function paletteSnapshot(): PaletteChoice {
  return normalizePaletteChoice(localStorage.getItem(PALETTE_STORAGE_KEY));
}

function serverPaletteSnapshot(): PaletteChoice {
  return "botanical";
}

function subscribeToPalette(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === PALETTE_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(PALETTE_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(PALETTE_CHANGE_EVENT, onChange);
  };
}

// Apply by the ONE rule (lib/theme.ts): base = no attribute, so a stale
// attribute is removed rather than overwritten with a third value.
function apply(choice: PaletteChoice) {
  const attr = paletteAttribute(choice);
  if (attr) document.documentElement.setAttribute("data-palette", attr);
  else document.documentElement.removeAttribute("data-palette");
}

export default function AppearancePicker() {
  const palette = useSyncExternalStore(
    subscribeToPalette,
    paletteSnapshot,
    serverPaletteSnapshot
  );
  const mounted = useHydrated();

  function choose(next: PaletteChoice) {
    localStorage.setItem(PALETTE_STORAGE_KEY, next);
    window.dispatchEvent(new Event(PALETTE_CHANGE_EVENT));
    apply(next);
  }

  return (
    <section className="card" data-testid="appearance-picker">
      <h2 className="text-base font-semibold">Appearance</h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        The palette for this device. Light and dark mode follow the theme toggle
        either way.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {PALETTE_CHOICES.map((choice) => {
          const meta = PALETTE_META[choice];
          // Until mounted, render the server's answer (base) to avoid a
          // hydration mismatch; the real selection paints post-hydration.
          const selected = mounted && palette === choice;
          return (
            <button
              key={choice}
              type="button"
              onClick={() => choose(choice)}
              aria-pressed={selected}
              data-testid={`appearance-palette-${choice}`}
              className={`rounded-lg border p-3 text-left transition ${
                selected
                  ? "border-brand-500 ring-1 ring-brand-500"
                  : "border-black/10 hover:bg-slate-100 dark:border-white/10 dark:hover:bg-ink-750"
              }`}
            >
              {/* Mini swatch: canvas strip with a surface card and accent dot. */}
              <span
                aria-hidden
                className="flex h-10 w-full items-center gap-1.5 rounded-md px-2"
                style={{
                  background: meta.canvas,
                  border: `1px solid ${meta.border}`,
                }}
              >
                <span
                  className="h-6 flex-1 rounded-sm"
                  style={{
                    background: meta.surface,
                    border: `1px solid ${meta.border}`,
                  }}
                />
                <span
                  className="h-3 w-3 rounded-full"
                  style={{ background: meta.accent }}
                />
              </span>
              <span
                className="mt-2 block text-sm font-medium"
                style={meta.labelStyle}
              >
                {meta.label}
              </span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                {meta.description}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
