"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { currentPathHref, type AppRoute } from "@/lib/hrefs";

type MobileTabColumns = 2 | 3 | 4;

const MOBILE_GRID_COLUMNS: Record<MobileTabColumns, string> = {
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
};

function stripClassName({
  prominentOnMobile,
  mobileColumns,
  mobileLayout,
  className,
  flush,
}: {
  prominentOnMobile: boolean;
  mobileColumns: MobileTabColumns;
  mobileLayout: "equal" | "scroll";
  className?: string;
  flush: boolean;
}) {
  return `overflow-x-auto overflow-y-hidden border-b border-black/10 dark:border-white/10 ${
    prominentOnMobile
      ? mobileLayout === "scroll"
        ? "flex gap-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:gap-1"
        : `grid ${MOBILE_GRID_COLUMNS[mobileColumns]} md:flex md:gap-1`
      : "flex gap-0.5 sm:gap-1"
  } ${className ?? (flush ? "mb-0" : "mb-4")}`;
}

function tabClassName({
  active,
  prominentOnMobile,
  mobileColumns,
  mobileLayout,
}: {
  active: boolean;
  prominentOnMobile: boolean;
  mobileColumns: MobileTabColumns;
  mobileLayout: "equal" | "scroll";
}) {
  return `-mb-px min-w-0 shrink-0 whitespace-nowrap border-b-2 text-center transition ${
    prominentOnMobile
      ? mobileLayout === "scroll"
        ? "px-4 py-3 text-sm font-semibold md:px-4 md:py-2 md:text-sm md:font-medium"
        : mobileColumns === 2
          ? "px-4 py-3 text-base font-semibold md:px-4 md:py-2 md:text-sm md:font-medium"
          : "px-1 py-3 text-sm font-semibold md:px-4 md:py-2 md:font-medium"
      : "px-1.5 py-2 text-sm font-medium sm:px-4"
  } ${
    active
      ? "border-brand-500 text-brand-700 dark:text-brand-400"
      : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
  }`;
}

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
// The strip on its own, without the panel (issue #1485 F). Trends' phone chrome
// collapses the strip and the range pills together into one context bar, which
// means the strip has to render inside that bar while the panel stays in the page
// — so the strip is a component rather than an inlined block, and NavTabs itself
// is now its one-plus-panel composition. Same markup, same testids, ONE
// implementation: a surface that wants the classic pairing keeps using NavTabs.
export function NavTabsStrip({
  tabs,
  paramKey,
  activeId,
  className,
  prominentOnMobile = false,
  mobileColumns = 2,
  mobileLayout = "equal",
  flush = false,
  testId,
}: {
  tabs: readonly { id: string; label: string }[];
  paramKey: string;
  activeId?: string;
  // Lets a host adjust only the strip's own spacing (the context bar drops the
  // bottom margin, which belongs to the bar). Never its type or chip styling.
  className?: string;
  prominentOnMobile?: boolean;
  mobileColumns?: MobileTabColumns;
  mobileLayout?: "equal" | "scroll";
  flush?: boolean;
  testId?: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const ids = tabs.map((t) => t.id);

  const fromUrl = searchParams.get(paramKey);
  const active =
    fromUrl && ids.includes(fromUrl) ? fromUrl : (activeId ?? tabs[0]?.id);
  const stripRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);

  // A direct link to a later tab (Goals, Routines, …) should not leave its
  // selected state off-screen in the phone's single-row strip.
  useEffect(() => {
    if (!prominentOnMobile || mobileLayout !== "scroll") return;
    if (window.matchMedia("(min-width: 768px)").matches) return;
    const strip = stripRef.current;
    const tab = activeRef.current;
    if (!strip || !tab) return;
    strip.scrollLeft =
      tab.offsetLeft - (strip.clientWidth - tab.clientWidth) / 2;
  }, [active, mobileLayout, prominentOnMobile]);

  function hrefFor(id: string) {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set(paramKey, id);
    return currentPathHref(`${pathname}?${params.toString()}`);
  }

  return (
    <div
      ref={stripRef}
      role="tablist"
      data-testid={testId}
      className={stripClassName({
        prominentOnMobile,
        mobileColumns,
        mobileLayout,
        className,
        flush,
      })}
    >
      {tabs.map((t) => {
        const isActive = active === t.id;
        return (
          <Link
            key={t.id}
            ref={isActive ? activeRef : undefined}
            href={hrefFor(t.id)}
            replace
            scroll={false}
            role="tab"
            aria-selected={isActive}
            className={tabClassName({
              active: isActive,
              prominentOnMobile,
              mobileColumns,
              mobileLayout,
            })}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}

export const NavTabStrip = NavTabsStrip;

// Route-driven counterpart to NavTabsStrip. Top-level route families such as
// Results use one URL per tab instead of a query parameter, but their responsive
// shell treatment and tab anatomy should remain identical.
export function RouteNavTabsStrip({
  tabs,
  className,
  prominentOnMobile = false,
  mobileColumns = 2,
  mobileLayout = "equal",
  flush = false,
  testId,
}: {
  tabs: readonly { href: AppRoute; label: string }[];
  className?: string;
  prominentOnMobile?: boolean;
  mobileColumns?: MobileTabColumns;
  mobileLayout?: "equal" | "scroll";
  flush?: boolean;
  testId?: string;
}) {
  const pathname = usePathname();

  return (
    <div
      role="tablist"
      data-testid={testId}
      className={stripClassName({
        prominentOnMobile,
        mobileColumns,
        mobileLayout,
        className,
        flush,
      })}
    >
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            role="tab"
            aria-selected={active}
            className={tabClassName({
              active,
              prominentOnMobile,
              mobileColumns,
              mobileLayout,
            })}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

export default function NavTabs({
  tabs,
  paramKey,
  activeId,
  children,
  prominentOnMobile = false,
}: {
  tabs: readonly { id: string; label: string }[];
  paramKey: string;
  // The tab the SERVER resolved for this request. Needed whenever the param
  // vocabulary is wider than the strip — a RETIRED tab name that maps onto a live
  // tab (`?tab=vitals` → Body, #1486), or an age-gated tab that fell back.
  activeId?: string;
  children: React.ReactNode;
  prominentOnMobile?: boolean;
}) {
  return (
    <div>
      <NavTabsStrip
        tabs={tabs}
        paramKey={paramKey}
        activeId={activeId}
        prominentOnMobile={prominentOnMobile}
      />
      <div role="tabpanel">{children}</div>
    </div>
  );
}
