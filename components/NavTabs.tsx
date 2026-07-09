"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

// Navigation-driven tab strip. Unlike `Tabs` (which mounts every panel and
// toggles visibility client-side), NavTabs renders a strip of tab buttons and a
// SINGLE active panel that the *server* already resolved from the URL — the
// parent constructs only the active tab's content and passes it as `children`.
//
// This is the fix for #105: passing every section as a `content` prop made all
// of them render (and run their queries) during the RSC pass on every request,
// regardless of `keepMounted`. By computing one panel server-side and switching
// tabs via a URL navigation (router.replace), each view runs only the active
// tab's queries. The active tab is driven by `paramKey` (e.g. ?tab=body) so tabs
// stay deep-linkable and survive back/forward and reload.
export default function NavTabs({
  tabs,
  paramKey,
  children,
}: {
  tabs: { id: string; label: string }[];
  paramKey: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const ids = tabs.map((t) => t.id);

  // Highlight from the URL so a click updates the strip immediately (before the
  // server round-trip lands). An unknown/absent param falls back to the first
  // tab — the same default the server uses — so the strip and the rendered panel
  // always agree (a restricted profile's ?tab=fitness isn't in `ids`, so both
  // fall back to the default tab).
  const fromUrl = searchParams.get(paramKey);
  const active = fromUrl && ids.includes(fromUrl) ? fromUrl : tabs[0]?.id;

  function selectTab(id: string) {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set(paramKey, id);
    // replace (not push) to avoid stacking history on every tab click; keep the
    // scroll position so switching tabs doesn't jump to the top.
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <div>
      <div
        role="tablist"
        className="mb-4 flex gap-1 border-b border-black/10 dark:border-white/10"
      >
        {tabs.map((t) => {
          const isActive = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => selectTab(t.id)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
                isActive
                  ? "border-brand-500 text-brand-700 dark:text-brand-400"
                  : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel">{children}</div>
    </div>
  );
}
