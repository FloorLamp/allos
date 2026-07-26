"use client";

import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { currentPathHref } from "@/lib/hrefs";

// Navigation-driven tab strip. Unlike `Tabs` (which mounts every panel and
// toggles visibility client-side), NavTabs renders a strip of tab buttons and a
// SINGLE active panel that the *server* already resolved from the URL — the
// parent constructs only the active tab's content and passes it as `children`.
//
// This is the fix for #105: passing every section as a `content` prop made all
// of them render (and run their queries) during the RSC pass on every request,
// regardless of `keepMounted`. By computing one panel server-side and switching
// tabs via a URL navigation, each view runs only the active tab's queries. The
// active tab is driven by `paramKey` (e.g. ?tab=body) so tabs stay deep-linkable
// and survive back/forward and reload.
//
// Each tab is a real Next `<Link>` (not an onClick button) so it renders a
// server-side `<a href>` — a click landing in the pre-hydration window does a
// native browser navigation instead of being silently swallowed by a
// not-yet-hydrated tree (#830; #730 was the test-only mask). Post-hydration Link
// does the soft nav; `replace` + `scroll={false}` preserve the prior behavior
// (no history stacking, no scroll jump).
export default function NavTabs({
  tabs,
  paramKey,
  activeId,
  children,
}: {
  tabs: { id: string; label: string }[];
  paramKey: string;
  // The tab the SERVER resolved for this request. Needed whenever the param
  // vocabulary is wider than the strip — a RETIRED tab name that maps onto a live
  // tab (`?tab=vitals` → Body, #1486), or an age-gated tab that fell back — because
  // the URL alone can't tell this component which strip entry is showing, and a
  // strip with nothing selected is a worse answer than the right one.
  activeId?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const ids = tabs.map((t) => t.id);

  // Highlight from the URL so a click updates the strip immediately (before the
  // server round-trip lands). A param that names no strip entry falls back to the
  // server's own resolution (`activeId`) and only then to the first tab, so the
  // strip and the rendered panel always agree — including for a retired alias
  // (`?tab=vitals` renders Body, so Body is the lit tab) and for a restricted
  // profile's ?tab=fitness (both fall back to the default).
  const fromUrl = searchParams.get(paramKey);
  const active =
    fromUrl && ids.includes(fromUrl) ? fromUrl : (activeId ?? tabs[0]?.id);

  function hrefFor(id: string) {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set(paramKey, id);
    return currentPathHref(`${pathname}?${params.toString()}`);
  }

  return (
    <div>
      <div
        role="tablist"
        className="mb-4 flex gap-0.5 overflow-x-auto border-b border-black/10 dark:border-white/10 sm:gap-1"
      >
        {tabs.map((t) => {
          const isActive = active === t.id;
          return (
            <Link
              key={t.id}
              href={hrefFor(t.id)}
              replace
              scroll={false}
              role="tab"
              aria-selected={isActive}
              // Phone-tight chips (#1489): at px-4 a five-chip strip measures
              // ~442px against a 358px content column, so the row scrolls and the
              // trailing tab sits off the edge — the failure the five-tab reorder
              // exists to remove. Below `sm` the chips give up padding (never type
              // size — the label is the thing being read); from `sm` up it is the
              // original chip.
              className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-1.5 py-2 text-sm font-medium transition sm:px-4 ${
                isActive
                  ? "border-brand-500 text-brand-700 dark:text-brand-400"
                  : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
      <div role="tabpanel">{children}</div>
    </div>
  );
}
