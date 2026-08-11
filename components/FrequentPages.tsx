"use client";

import { useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconHistory } from "@tabler/icons-react";
import {
  PAGE_VISITS_KEY,
  frequentPages,
  parsePageVisits,
  recordPageVisit,
  type TrackedPage,
} from "@/lib/recent-pages";

const PAGE_VISITS_CHANGED = "allos:page-visits-changed";
let visitsSnapshot: string | null | undefined;

function readVisitsSnapshot(): string | null {
  if (visitsSnapshot !== undefined) return visitsSnapshot;
  try {
    visitsSnapshot = window.localStorage.getItem(PAGE_VISITS_KEY);
  } catch {
    visitsSnapshot = null;
  }
  return visitsSnapshot;
}

function serverVisitsSnapshot(): null {
  return null;
}

function subscribeVisits(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== PAGE_VISITS_KEY) return;
    visitsSnapshot = event.newValue;
    onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(PAGE_VISITS_CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(PAGE_VISITS_CHANGED, onChange);
  };
}

function publishVisits(raw: string): void {
  visitsSnapshot = raw;
  window.dispatchEvent(new Event(PAGE_VISITS_CHANGED));
}

// "Frequent" shortcuts at the top of the shared sidebar content (issue #1416,
// section E3) — the browser half over the pure tally in lib/recent-pages.ts.
//
// Rendered inside the ONE shared <SidebarContent>, so the desktop sidebar and
// the mobile drawer show the same shortcuts (the responsive-surfaces rule); the
// phone is where it pays off most, since the drawer is otherwise a full tree to
// scroll.
//
// Storage is `localStorage`, per device, never the DB: visit counts are a
// display preference, not health data, and the allowlist in lib/recent-pages.ts
// keeps the stored keys to a bounded set of top-level routes. Nothing renders
// until after mount (SSR emits nothing), so there is no hydration mismatch and
// no server round-trip.
export default function FrequentPages({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const storedSnapshot = useSyncExternalStore(
    subscribeVisits,
    readVisitsSnapshot,
    serverVisitsSnapshot
  );
  const pages: TrackedPage[] = frequentPages(parsePageVisits(storedSnapshot), {
    currentPath: pathname,
  });

  useEffect(() => {
    let stored;
    try {
      stored = parsePageVisits(window.localStorage.getItem(PAGE_VISITS_KEY));
    } catch {
      // Private-mode / disabled storage: the feature simply doesn't exist here.
      return;
    }
    const next = recordPageVisit(stored, pathname, Date.now());
    if (next !== stored) {
      const raw = JSON.stringify(next);
      try {
        window.localStorage.setItem(PAGE_VISITS_KEY, raw);
      } catch {
        // Quota or a locked store — keep learning for this page lifetime even
        // though the tally cannot survive a reload.
      }
      publishVisits(raw);
    }
  }, [pathname]);

  if (pages.length === 0) return null;

  return (
    <div data-testid="frequent-pages" className="flex flex-col gap-1">
      <div className="section-label flex items-center gap-1.5 px-2">
        <IconHistory className="h-3.5 w-3.5" stroke={1.75} />
        Frequent
      </div>
      <div className="flex flex-wrap gap-1.5">
        {pages.map((page) => (
          <Link
            key={page.href}
            href={page.href}
            onClick={onNavigate}
            data-testid={`frequent-page-${page.href}`}
            className="press rounded-full border border-black/10 bg-white/70 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 dark:border-white/10 dark:bg-ink-850 dark:text-slate-300 dark:hover:bg-ink-750"
          >
            {page.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
