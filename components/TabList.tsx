"use client";

import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useScrollFade } from "@/components/ScrollFade";
import { currentPathHref, type AppRoute } from "@/lib/hrefs";

type IdTab = { id: string; label: string };
type Presentation = {
  kind: "prominent";
  mobileColumns?: 2 | 3 | 4;
  mobileLayout?: "equal" | "scroll";
};
type Common = {
  ariaLabel: string;
  presentation?: Presentation;
  testId?: string;
};
type ButtonProps = Common & {
  binding: "button";
  tabs: readonly IdTab[];
  children: (panels: readonly TabPanelState[]) => ReactNode;
  panelId?: never;
  paramKey?: never;
  activeId?: never;
};
type QueryProps = Common & {
  binding: "link";
  tabs: readonly (IdTab & { href?: never })[];
  panelId: string;
  paramKey: string;
  activeId?: string;
};
type RouteProps = Common & {
  binding: "link";
  tabs: readonly (IdTab & { href: AppRoute })[];
  panelId: string;
  paramKey?: never;
  activeId?: never;
};
export type TabListProps = ButtonProps | QueryProps | RouteProps;

export type TabPanelState = {
  id: string;
  panelId: string;
  tabId: string;
  active: boolean;
};

const COLUMNS = { 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4" };

function stripClass(p?: Presentation) {
  const base =
    "overflow-x-auto overflow-y-hidden border-b border-black/10 scrollbar-none [&::-webkit-scrollbar]:hidden dark:border-white/10";
  if (!p) return `${base} flex gap-0.5 sm:gap-1`;
  return `${base} ${
    p.mobileLayout === "scroll"
      ? "flex gap-0 pr-px md:gap-1 md:pr-0"
      : `grid ${COLUMNS[p.mobileColumns ?? 2]} md:flex md:gap-1`
  }`;
}

function tabClass(active: boolean, p?: Presentation) {
  const scroll = p?.mobileLayout === "scroll";
  const size = !p
    ? "px-1.5 py-2 text-sm font-medium sm:px-4"
    : scroll
      ? "px-2.5 py-3 text-sm font-semibold md:px-4 md:py-2 md:text-sm md:font-medium"
      : (p.mobileColumns ?? 2) === 2
        ? "px-4 py-3 text-base font-semibold md:px-4 md:py-2 md:text-sm md:font-medium"
        : "px-1 py-3 text-sm font-semibold md:px-4 md:py-2 md:text-sm md:font-medium";
  return `-mb-px ${scroll ? "min-w-max flex-1 shrink-0 md:flex-none" : "min-w-0 shrink-0"} whitespace-nowrap border-b-2 text-center transition focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-ink-950 ${size} ${
    active
      ? "border-brand-500 text-brand-700 dark:text-brand-400"
      : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
  }`;
}

function domId(listId: string, kind: "tab" | "panel", index: number) {
  return `${listId}-${kind}-${index}`;
}

type RenderTab = IdTab & { href?: AppRoute };
type TabProps = {
  tab: RenderTab;
  active: boolean;
  tabId: string;
  panelId: string;
  presentation?: Presentation;
  replace?: boolean;
  onSelect?: (id: string) => void;
  setRef: (node: HTMLElement | null) => void;
};

function Tab(props: TabProps) {
  const { tab, active, tabId, panelId, presentation, setRef } = props;
  const shared = {
    id: tabId,
    role: "tab",
    "aria-selected": active,
    "aria-controls": panelId,
    tabIndex: active ? 0 : -1,
    className: tabClass(active, presentation),
  } as const;
  return tab.href ? (
    <Link
      {...shared}
      ref={setRef}
      href={tab.href}
      replace={props.replace}
      scroll={props.replace ? false : undefined}
      aria-current={active ? "page" : undefined}
    >
      {tab.label}
    </Link>
  ) : (
    <button
      {...shared}
      ref={setRef}
      type="button"
      onClick={() => props.onSelect?.(tab.id)}
    >
      {tab.label}
    </button>
  );
}

function Strip({
  tabs,
  activeId,
  panelId,
  presentation,
  ariaLabel,
  testId,
  replace,
  onSelect,
  idBase,
}: Common & {
  tabs: readonly RenderTab[];
  activeId?: string;
  panelId: (index: number) => string;
  presentation?: Presentation;
  replace?: boolean;
  onSelect?: (id: string) => void;
  idBase?: string;
}) {
  const generatedId = useId();
  const listId = idBase ?? generatedId;
  const stripRef = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLElement | null)[]>([]);
  const activeIndex = tabs.findIndex((tab) => tab.id === activeId);
  const { update, fadeProps } = useScrollFade(stripRef);

  useEffect(() => {
    if (
      presentation?.mobileLayout !== "scroll" ||
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(min-width: 768px)").matches
    )
      return;
    const strip = stripRef.current;
    const tab = refs.current[activeIndex];
    if (!strip || !tab) return;
    const reveal = () => {
      const s = strip.getBoundingClientRect();
      const t = tab.getBoundingClientRect();
      strip.scrollLeft += t.left - s.left - (strip.clientWidth - t.width) / 2;
    };
    reveal();
    const frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [activeIndex, presentation]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const current = refs.current.indexOf(event.target as HTMLElement);
    if (current < 0 || tabs.length === 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
            tabs.length;
    refs.current[next]?.focus();
    refs.current[next]?.click();
  }

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label={ariaLabel}
      data-testid={testId}
      onKeyDown={onKeyDown}
      onScroll={update}
      className={stripClass(presentation)}
      {...fadeProps}
    >
      {tabs.map((tab, index) => (
        <Tab
          key={tab.id}
          tab={tab}
          active={tab.id === activeId}
          tabId={domId(listId, "tab", index)}
          panelId={panelId(index)}
          presentation={presentation}
          replace={replace}
          onSelect={onSelect}
          setRef={(node) => {
            refs.current[index] = node;
          }}
        />
      ))}
    </div>
  );
}

function ButtonList(props: ButtonProps) {
  const listId = useId();
  const [selected, setSelected] = useState(props.tabs[0]?.id);
  const activeId = props.tabs.some((tab) => tab.id === selected)
    ? selected
    : props.tabs[0]?.id;
  const panels = props.tabs.map((tab, index) => ({
    id: tab.id,
    panelId: domId(listId, "panel", index),
    tabId: domId(listId, "tab", index),
    active: tab.id === activeId,
  }));
  return (
    <>
      <Strip
        {...props}
        activeId={activeId}
        panelId={(index) => domId(listId, "panel", index)}
        presentation={props.presentation}
        onSelect={setSelected}
        idBase={listId}
      />
      {props.children(panels)}
    </>
  );
}

function QueryList(props: QueryProps) {
  const pathname = usePathname();
  const search = useSearchParams();
  const fromUrl = search.get(props.paramKey);
  const activeId =
    fromUrl && props.tabs.some((tab) => tab.id === fromUrl)
      ? fromUrl
      : (props.activeId ?? props.tabs[0]?.id);
  const tabs = props.tabs.map((tab) => {
    const params = new URLSearchParams(search.toString());
    params.set(props.paramKey, tab.id);
    return { ...tab, href: currentPathHref(`${pathname}?${params}`) };
  });
  return (
    <Strip
      {...props}
      tabs={tabs}
      activeId={activeId}
      panelId={() => props.panelId}
      presentation={props.presentation}
      replace
    />
  );
}

function RouteList(props: RouteProps) {
  const pathname = usePathname();
  const activeId =
    props.tabs.find(
      (tab) => pathname === tab.href || pathname.startsWith(`${tab.href}/`)
    )?.id ?? props.tabs[0]?.id;
  return (
    <Strip
      {...props}
      activeId={activeId}
      panelId={() => props.panelId}
      presentation={props.presentation}
    />
  );
}

export default function TabList(props: TabListProps) {
  if (props.binding === "button") return <ButtonList {...props} />;
  if (props.paramKey !== undefined) return <QueryList {...props} />;
  return <RouteList {...props} />;
}
