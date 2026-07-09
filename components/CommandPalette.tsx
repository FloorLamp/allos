"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  IconArrowRight,
  IconBarbell,
  IconChartLine,
  IconCornerDownLeft,
  IconFileText,
  IconPill,
  IconSearch,
  IconTarget,
  IconVaccine,
} from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import { useLockBodyScroll } from "@/components/useLockBodyScroll";
import { runGlobalSearch } from "@/app/(app)/search-actions";
import {
  flattenHits,
  type SearchDomain,
  type SearchGroup,
} from "@/lib/search-rank";

// Global command palette (issue #133). Mounted once from the app layout; renders
// nothing until opened by Cmd/Ctrl-K or the SEARCH_OPEN_EVENT dispatched by the
// sidebar's search trigger. A single input drives a debounced fetch of the
// read-only search action (active profile only), results are grouped by domain,
// and arrows + Enter navigate. Esc closes (handled by ModalShell). v1 is
// navigation-only — selecting a result just routes to it.

// Custom event the shared sidebar's search button fires to open the palette,
// so the trigger and the listener stay decoupled (no shared context provider).
export const SEARCH_OPEN_EVENT = "allos:open-search";

export function openGlobalSearch() {
  window.dispatchEvent(new Event(SEARCH_OPEN_EVENT));
}

const DOMAIN_ICONS: Record<
  SearchDomain,
  (props: { className?: string }) => React.ReactNode
> = {
  biomarker: (p) => <IconChartLine {...p} />,
  document: (p) => <IconFileText {...p} />,
  activity: (p) => <IconBarbell {...p} />,
  supplement: (p) => <IconPill {...p} />,
  immunization: (p) => <IconVaccine {...p} />,
  goal: (p) => <IconTarget {...p} />,
  page: (p) => <IconArrowRight {...p} />,
};

export default function CommandPalette({
  profileName,
}: {
  profileName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const flat = flattenHits(groups);

  // Open on Cmd/Ctrl-K anywhere, and on the sidebar trigger's custom event.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(SEARCH_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SEARCH_OPEN_EVENT, onOpen);
    };
  }, []);

  useLockBodyScroll(open);

  // Reset state when the palette closes so it opens fresh next time.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setGroups([]);
      setHighlight(0);
      setLoading(false);
    }
  }, [open]);

  // Debounced fetch. A per-request token drops stale responses so a slow earlier
  // query can't overwrite a newer one's results.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q === "") {
      setGroups([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await runGlobalSearch(q);
        if (!cancelled) {
          setGroups(res);
          setHighlight(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, open]);

  // Keep the highlighted row scrolled into view as the arrows walk the list.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${highlight}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router]
  );

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      const hit = flat[highlight];
      if (hit) {
        e.preventDefault();
        go(hit.href);
      }
    }
  }

  if (!open) return null;

  const q = query.trim();
  let flatIndex = -1;

  return (
    <ModalShell
      title="Search"
      onClose={() => setOpen(false)}
      initialFocusRef={inputRef}
      className="mt-4 flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl bg-white p-4 shadow-xl outline-none sm:mt-8 sm:p-5 dark:bg-ink-900"
    >
      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        <div className="relative">
          <IconSearch
            className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400 dark:text-slate-500"
            stroke={1.75}
          />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded
            aria-controls="command-palette-results"
            aria-autocomplete="list"
            aria-label="Search all data"
            autoComplete="off"
            value={query}
            placeholder="Search biomarkers, documents, activities…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            className="input w-full pl-10"
          />
        </div>
        <p className="mt-2 px-1 text-xs text-slate-500 dark:text-slate-400">
          Searching{" "}
          <span className="font-medium text-slate-700 dark:text-slate-300">
            {profileName}
          </span>
          ’s data · arrows to move, Enter to open
        </p>

        <div
          id="command-palette-results"
          ref={listRef}
          role="listbox"
          aria-label="Search results"
          className="mt-3 min-h-0 flex-1 overflow-y-auto"
        >
          {q === "" ? (
            <p className="px-1 py-6 text-center text-sm text-slate-400 dark:text-slate-500">
              Type to search across every domain.
            </p>
          ) : groups.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-slate-400 dark:text-slate-500">
              {loading ? "Searching…" : `No matches for “${q}”.`}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.domain} className="mb-2">
                <div className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                  {group.label}
                </div>
                <ul>
                  {group.hits.map((hit) => {
                    flatIndex += 1;
                    const idx = flatIndex;
                    const active = idx === highlight;
                    const Icon = DOMAIN_ICONS[hit.domain];
                    return (
                      <li key={hit.key}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={active}
                          data-idx={idx}
                          onMouseEnter={() => setHighlight(idx)}
                          onClick={() => go(hit.href)}
                          className={`flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left ${
                            active
                              ? "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                              : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-ink-800"
                          }`}
                        >
                          <Icon className="h-4 w-4 shrink-0 opacity-70" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {hit.title}
                            </span>
                            {hit.subtitle && (
                              <span className="block truncate text-xs text-slate-400 dark:text-slate-500">
                                {hit.subtitle}
                              </span>
                            )}
                          </span>
                          {active && (
                            <IconCornerDownLeft className="h-4 w-4 shrink-0 opacity-60" />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>
    </ModalShell>
  );
}
