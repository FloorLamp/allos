"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBarbell,
  IconBolt,
  IconCalendarEvent,
  IconCalendarPlus,
  IconChartLine,
  IconClipboardList,
  IconCornerDownLeft,
  IconFileText,
  IconHeartbeat,
  IconHeartHandshake,
  IconMedicalCross,
  IconPill,
  IconScale,
  IconSearch,
  IconStethoscope,
  IconTarget,
  IconVaccine,
} from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import { useLockBodyScroll } from "@/components/useLockBodyScroll";
import { useToast } from "@/components/Toast";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import { runGlobalSearch } from "@/app/(app)/search-actions";
import { paletteQuickLog } from "@/app/(app)/palette-actions";
import { logMedicationAdministration } from "@/app/(app)/medications/actions";
import { refillMedication } from "@/app/(app)/medications/actions";
import { completeAppointment } from "@/app/(app)/encounters/appointment-actions";
import {
  flattenHits,
  type HitAction,
  type SearchDomain,
  type SearchGroup,
  type SearchHit,
} from "@/lib/search-rank";
import { matchPaletteActions, type PaletteAction } from "@/lib/palette-actions";
import { parseQuickLog, type QuickLogWeight } from "@/lib/palette-quick-log";
import type { WeightUnit } from "@/lib/settings";
import type { AppRoute } from "@/lib/hrefs";

// Global command palette (extended for create actions in #29).
// Mounted once from the app layout; renders nothing until opened by Cmd/Ctrl-K or
// the SEARCH_OPEN_EVENT dispatched by the sidebar's search trigger. A single input
// drives (1) inline quick-log parsing (`weight 82.5` → a body-metrics entry Enter
// commits directly), (2) create ACTIONS that open the right form, and (3) a
// debounced fetch of the read-only search action (active profile only). Arrows +
// Enter walk one flat list across all three; Esc closes (handled by ModalShell).

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
  condition: (p) => <IconStethoscope {...p} />,
  allergy: (p) => <IconAlertTriangle {...p} />,
  procedure: (p) => <IconMedicalCross {...p} />,
  immunization: (p) => <IconVaccine {...p} />,
  encounter: (p) => <IconCalendarEvent {...p} />,
  appointment: (p) => <IconCalendarPlus {...p} />,
  activity: (p) => <IconBarbell {...p} />,
  supplement: (p) => <IconPill {...p} />,
  "family-history": (p) => <IconHeartHandshake {...p} />,
  "care-plan": (p) => <IconClipboardList {...p} />,
  "care-goal": (p) => <IconTarget {...p} />,
  goal: (p) => <IconTarget {...p} />,
  page: (p) => <IconArrowRight {...p} />,
};

const ACTION_ICONS: Record<
  PaletteAction["icon"],
  (props: { className?: string }) => React.ReactNode
> = {
  barbell: (p) => <IconBarbell {...p} />,
  scale: (p) => <IconScale {...p} />,
  heart: (p) => <IconHeartbeat {...p} />,
  calendar: (p) => <IconCalendarPlus {...p} />,
  chart: (p) => <IconChartLine {...p} />,
};

// The palette's flat, navigable item model — quick-log preview, then create
// actions, then search hits. `highlight` indexes into the array these produce.
type PaletteItem =
  | { kind: "quicklog"; log: QuickLogWeight }
  | { kind: "action"; action: PaletteAction }
  | { kind: "hit"; hit: SearchHit };

export default function CommandPalette({
  profileName,
  weightUnit,
}: {
  profileName: string;
  weightUnit: WeightUnit;
}) {
  const router = useRouter();
  const toast = useToast();
  const {
    openCreate,
    openLive,
    openRepeatLast,
    hasLastActivity,
    canStartWorkout,
  } = useActivityEditor();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.trim();

  // Derived synchronously from the query: the quick-log preview (or null) and the
  // matching create actions. An empty query shows all actions as a resting menu.
  const quickLog = useMemo(
    () => (q ? parseQuickLog(query, weightUnit) : null),
    [query, q, weightUnit]
  );
  // Drop the "Repeat last activity" action when nothing's been logged — there's
  // no last activity to repeat (issue #337).
  const actions = useMemo(
    () =>
      matchPaletteActions(query).filter(
        (a) =>
          (a.target.kind !== "repeat" || hasLastActivity) &&
          // Live workout is strength-centric; hidden for age-restricted profiles
          // (#489/#340).
          (a.target.kind !== "live" || canStartWorkout)
      ),
    [query, hasLastActivity, canStartWorkout]
  );
  const hits = useMemo(() => flattenHits(groups), [groups]);

  // The flat item list arrows/Enter walk, in render order.
  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    if (quickLog) out.push({ kind: "quicklog", log: quickLog });
    for (const action of actions) out.push({ kind: "action", action });
    for (const hit of hits) out.push({ kind: "hit", hit });
    return out;
  }, [quickLog, actions, hits]);

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
      setCommitting(false);
    }
  }, [open]);

  // Debounced fetch. A per-request token drops stale responses so a slow earlier
  // query can't overwrite a newer one's results.
  useEffect(() => {
    if (!open) return;
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
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open]);

  // Keep the highlight in range as the item list changes (typing shrinks/grows it).
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(items.length - 1, 0)));
  }, [items.length]);

  // Keep the highlighted row scrolled into view as the arrows walk the list.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${highlight}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const close = useCallback(() => setOpen(false), []);

  const go = useCallback(
    (href: AppRoute) => {
      close();
      router.push(href);
    },
    [router, close]
  );

  const runAction = useCallback(
    (action: PaletteAction) => {
      if (action.target.kind === "activity") {
        close();
        openCreate();
      } else if (action.target.kind === "live") {
        close();
        openLive();
      } else if (action.target.kind === "repeat") {
        close();
        openRepeatLast();
      } else {
        go(action.target.href);
      }
    },
    [close, openCreate, openLive, openRepeatLast, go]
  );

  const commitQuickLog = useCallback(
    async (log: QuickLogWeight) => {
      if (log.error || committing) return;
      setCommitting(true);
      try {
        const res = await paletteQuickLog(query);
        toast(res.message, { tone: res.ok ? "success" : "error" });
        if (res.ok) {
          close();
          router.refresh();
        }
      } finally {
        setCommitting(false);
      }
    },
    [query, committing, toast, close, router]
  );

  // Run a per-hit contextual action (#662). A navigate action (add-result) just
  // routes to its prefilled form; a write action (log-dose/refill/complete) submits
  // the entity id to the EXISTING gated Server Action — the same write path the
  // med/appointment pages use, so the auth gate is never bypassed. We answer from
  // the action's typed outcome (completeAppointment returns void → treated as done).
  const runHitAction = useCallback(
    async (action: HitAction) => {
      if (action.kind === "add-result") {
        if (action.href) go(action.href);
        return;
      }
      if (committing) return;
      setCommitting(true);
      try {
        const fd = new FormData();
        fd.set("id", String(action.entityId));
        if (action.kind === "log-dose") {
          const res = await logMedicationAdministration(fd);
          toast(
            res.ok
              ? res.outcome === "duplicate"
                ? "Dose already logged just now"
                : "Dose logged"
              : res.error,
            {
              tone: res.ok ? "success" : "error",
            }
          );
          if (!res.ok) return;
        } else if (action.kind === "refill") {
          const res = await refillMedication(fd);
          toast(res.ok ? "Refill recorded" : res.error, {
            tone: res.ok ? "success" : "error",
          });
          if (!res.ok) return;
        } else {
          await completeAppointment(fd);
          toast("Appointment completed", { tone: "success" });
        }
        close();
        router.refresh();
      } finally {
        setCommitting(false);
      }
    },
    [committing, close, go, router, toast]
  );

  const runItem = useCallback(
    (item: PaletteItem | undefined) => {
      if (!item) return;
      if (item.kind === "quicklog") void commitQuickLog(item.log);
      else if (item.kind === "action") runAction(item.action);
      else go(item.hit.href);
    },
    [commitQuickLog, runAction, go]
  );

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      const item = items[highlight];
      if (item) {
        e.preventDefault();
        runItem(item);
      }
    }
  }

  if (!open) return null;

  // Running index across the three sections so arrows/Enter and the highlight
  // ring stay in sync with `items`.
  let idx = -1;
  const quickLogIdx = quickLog ? (idx += 1) : -1;
  const actionStart = idx + 1;

  const rowClass = (active: boolean) =>
    `flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left ${
      active
        ? "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
        : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-ink-800"
    }`;

  return (
    <ModalShell
      title="Search"
      onClose={close}
      initialFocusRef={inputRef}
      className="mt-4 flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl bg-white p-4 shadow-xl outline-none sm:mt-8 sm:p-5 dark:bg-ink-900"
    >
      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        <div className="relative">
          <IconSearch
            className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-500 dark:text-slate-400"
            stroke={1.75}
          />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded
            aria-controls="command-palette-results"
            aria-autocomplete="list"
            aria-label="Search or run a command"
            autoComplete="off"
            value={query}
            placeholder="Search, or try “weight 82.5”, “log workout”…"
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
          ’s data · arrows to move, Enter to run
        </p>

        <div
          id="command-palette-results"
          ref={listRef}
          role="listbox"
          aria-label="Results"
          className="mt-3 min-h-0 flex-1 overflow-y-auto"
        >
          {/* Quick log — the inline `weight 82.5` fast path. */}
          {quickLog && (
            <div className="mb-2">
              <div className="px-2 pb-1 pt-2 section-label">Quick log</div>
              <button
                type="button"
                role="option"
                aria-selected={highlight === quickLogIdx}
                data-idx={quickLogIdx}
                data-testid="palette-quicklog"
                disabled={!!quickLog.error || committing}
                onMouseEnter={() => setHighlight(quickLogIdx)}
                onClick={() => void commitQuickLog(quickLog)}
                className={`${rowClass(highlight === quickLogIdx)} disabled:cursor-not-allowed`}
              >
                <IconBolt className="h-4 w-4 shrink-0 opacity-70" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {quickLog.error ?? quickLog.label}
                  </span>
                  <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                    {quickLog.error
                      ? "Fix the value to log it"
                      : committing
                        ? "Saving…"
                        : "Enter to save"}
                  </span>
                </span>
                {highlight === quickLogIdx && !quickLog.error && (
                  <IconCornerDownLeft className="h-4 w-4 shrink-0 opacity-60" />
                )}
              </button>
            </div>
          )}

          {/* Create actions. */}
          {actions.length > 0 && (
            <div className="mb-2">
              <div className="px-2 pb-1 pt-2 section-label">Actions</div>
              <ul>
                {actions.map((action, i) => {
                  const itemIdx = actionStart + i;
                  const active = itemIdx === highlight;
                  const Icon = ACTION_ICONS[action.icon];
                  return (
                    <li key={action.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        data-idx={itemIdx}
                        data-testid={`palette-action-${action.id}`}
                        onMouseEnter={() => setHighlight(itemIdx)}
                        onClick={() => runAction(action)}
                        className={rowClass(active)}
                      >
                        <Icon className="h-4 w-4 shrink-0 opacity-70" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {action.label}
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
          )}

          {/* Search results. */}
          {q !== "" &&
            (groups.length === 0 ? (
              // Only show "no matches" once nothing else stands in for a result.
              actions.length === 0 &&
              !quickLog && (
                <p className="px-1 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                  {loading ? "Searching…" : `No matches for “${q}”.`}
                </p>
              )
            ) : (
              <SearchResults
                groups={groups}
                base={actionStart + actions.length}
                highlight={highlight}
                setHighlight={setHighlight}
                onPick={go}
                onAction={runHitAction}
                committing={committing}
                rowClass={rowClass}
              />
            ))}
        </div>
      </div>
    </ModalShell>
  );
}

function SearchResults({
  groups,
  base,
  highlight,
  setHighlight,
  onPick,
  onAction,
  committing,
  rowClass,
}: {
  groups: SearchGroup[];
  base: number;
  highlight: number;
  setHighlight: (i: number) => void;
  onPick: (href: AppRoute) => void;
  onAction: (action: HitAction) => void;
  committing: boolean;
  rowClass: (active: boolean) => string;
}) {
  let flatIndex = base - 1;
  return (
    <>
      {groups.map((group) => (
        <div key={group.domain} className="mb-2">
          <div className="px-2 pb-1 pt-2 section-label">{group.label}</div>
          <ul>
            {group.hits.map((hit) => {
              flatIndex += 1;
              const itemIdx = flatIndex;
              const active = itemIdx === highlight;
              const Icon = DOMAIN_ICONS[hit.domain];
              const actions = hit.actions ?? [];
              // The whole row navigates (a nested <button> would be invalid HTML),
              // so the row is a flex container: a navigate button that fills it plus
              // any per-hit action chips as sibling buttons (#662). Arrow/Enter still
              // walk one flat list of NAVIGATE targets; the chips are pointer-only.
              return (
                <li key={hit.key} className={`flex items-stretch gap-1`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-idx={itemIdx}
                    onMouseEnter={() => setHighlight(itemIdx)}
                    onClick={() => onPick(hit.href)}
                    className={`${rowClass(active)} min-w-0 flex-1`}
                  >
                    <Icon className="h-4 w-4 shrink-0 opacity-70" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {hit.title}
                      </span>
                      {hit.subtitle && (
                        <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                          {hit.subtitle}
                        </span>
                      )}
                    </span>
                    {active && actions.length === 0 && (
                      <IconCornerDownLeft className="h-4 w-4 shrink-0 opacity-60" />
                    )}
                  </button>
                  {actions.map((action) => (
                    <button
                      key={`${hit.key}:${action.kind}`}
                      type="button"
                      data-testid={`palette-hit-action-${action.kind}`}
                      disabled={committing}
                      onClick={() => onAction(action)}
                      className="shrink-0 self-center rounded-md border border-black/10 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-800 dark:hover:text-slate-100"
                    >
                      {action.label}
                    </button>
                  ))}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}
