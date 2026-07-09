"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

// Generic tab shell. Panels are server-rendered and passed in as slots; all
// stay mounted (visibility toggled) so switching tabs preserves panel state
// (e.g. a paste in progress).
//
// When `paramKey` is set, the active tab is driven by that URL query param
// (e.g. ?tab=log) so tabs are deep-linkable and survive back/forward and
// reload; otherwise the selection is local state.
export default function Tabs({
  tabs,
  paramKey,
}: {
  tabs: {
    id: string;
    label: string;
    content: React.ReactNode;
    keepMounted?: boolean;
  }[];
  paramKey?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const ids = tabs.map((t) => t.id);

  const [localActive, setLocalActive] = useState(tabs[0]?.id);
  const fromUrl = paramKey ? searchParams.get(paramKey) : null;
  const urlActive = fromUrl && ids.includes(fromUrl) ? fromUrl : tabs[0]?.id;
  const active = paramKey ? urlActive : localActive;

  function selectTab(id: string) {
    if (!paramKey) {
      setLocalActive(id);
      return;
    }
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set(paramKey, id);
    // replace (not push) to avoid stacking history on every tab click; keep the
    // scroll position so switching tabs doesn't jump to the top.
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-black/10 dark:border-white/10">
        {tabs.map((t) => {
          const isActive = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
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
      {tabs.map((t) => {
        const isActive = active === t.id;
        const keepMounted = t.keepMounted ?? true;
        if (!isActive && !keepMounted) return null;
        return (
          <div key={t.id} className={isActive ? "" : "hidden"}>
            {t.content}
          </div>
        );
      })}
    </div>
  );
}
