"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBandage,
  IconBarbell,
  IconBodyScan,
  IconBolt,
  IconBuildingHospital,
  IconCalendarEvent,
  IconCalendarPlus,
  IconCamera,
  IconChartLine,
  IconClipboardList,
  IconCornerDownLeft,
  IconDental,
  IconDna2,
  IconFileText,
  IconFlask2,
  IconHeartbeat,
  IconHeartHandshake,
  IconMedicalCross,
  IconMoodSmile,
  IconPill,
  IconSalad,
  IconScale,
  IconSearch,
  IconSparkles,
  IconStethoscope,
  IconTarget,
  IconTimelineEvent,
  IconTools,
  IconVaccine,
  IconVirus,
} from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import { useLockBodyScroll } from "@/components/useLockBodyScroll";
import { useToast } from "@/components/Toast";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import {
  runGlobalSearch,
  askRecordsAction,
  type AskRecordsResult,
} from "@/app/(app)/search-actions";
import { DOMAIN_LABEL, type RecordCitation } from "@/lib/record-qa";
import NotesText from "@/components/NotesText";
import { LoggedViaSurface } from "@/components/LoggedViaSurface";
import { stampWebOrigin, type WebLoggedVia } from "@/lib/logged-via";
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
import {
  parseQuickLog,
  type QuickLogCommand,
  type QuickLogPracticeOption,
} from "@/lib/palette-quick-log";
import { useQuickEntry } from "@/components/QuickEntryProvider";
import { loadQuickEntry } from "@/app/(app)/quick-entry-actions";
import type { WeightUnit } from "@/lib/settings";
import type { AppRoute } from "@/lib/hrefs";
import { useResettableState } from "@/components/useResettableState";

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
  "clinical-result": (p) => <IconChartLine {...p} />,
  imaging: (p) => <IconBodyScan {...p} />,
  genomic: (p) => <IconDna2 {...p} />,
  document: (p) => <IconFileText {...p} />,
  condition: (p) => <IconStethoscope {...p} />,
  allergy: (p) => <IconAlertTriangle {...p} />,
  procedure: (p) => <IconMedicalCross {...p} />,
  immunization: (p) => <IconVaccine {...p} />,
  encounter: (p) => <IconCalendarEvent {...p} />,
  appointment: (p) => <IconCalendarPlus {...p} />,
  // Each new domain (#1595) wears the glyph its own surface wears — the providers
  // directory's hospital, the Illness-episodes nav virus, the protocol list's flask,
  // the Wellness nav's sparkles — so a result reads as the page it leads to.
  provider: (p) => <IconBuildingHospital {...p} />,
  episode: (p) => <IconVirus {...p} />,
  dental: (p) => <IconDental {...p} />,
  skin: (p) => <IconBandage {...p} />,
  activity: (p) => <IconBarbell {...p} />,
  // THE RECORD'S OWN GLYPH (#5006). One group holds all seven logged kinds, so it
  // wears the icon the record itself wears in the nav and the dock (`IconTimelineEvent`,
  // components/Nav.tsx) — the hit's subtitle names the kind.
  logged: (p) => <IconTimelineEvent {...p} />,
  supplement: (p) => <IconPill {...p} />,
  protocol: (p) => <IconFlask2 {...p} />,
  practice: (p) => <IconSparkles {...p} />,
  equipment: (p) => <IconTools {...p} />,
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
  camera: (p) => <IconCamera {...p} />,
  sparkles: (p) => <IconSparkles {...p} />,
  salad: (p) => <IconSalad {...p} />,
  pill: (p) => <IconPill {...p} />,
  mood: (p) => <IconMoodSmile {...p} />,
  document: (p) => <IconFileText {...p} />,
};

// The palette's flat, navigable item model — quick-log preview, then create
// actions, then search hits. `highlight` indexes into the array these produce.
type PaletteItem =
  | { kind: "quicklog"; log: QuickLogCommand }
  | { kind: "action"; action: PaletteAction }
  | { kind: "hit"; hit: SearchHit };

// The palette's own surface, named once so its declaration to descendants, the stamp
// on its own posts, and the surface it opens the activity editor from cannot drift
// apart (#3087). The palette is not mounted inside the region it declares, so the
// third of those has to be told rather than read.
const PALETTE_SURFACE: WebLoggedVia = "quick-log";

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
    trainingRelevant,
    workoutOffer,
  } = useActivityEditor(PALETTE_SURFACE);
  const { open: openQuickEntry } = useQuickEntry();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim();
  // Search results belong to exactly one normalized query. A new query gets an
  // immediate empty/loading snapshot during render; only its async response can
  // settle it, so an older query never flashes while the debounce runs.
  const [search, setSearch] = useResettableState<{
    groups: SearchGroup[];
    loading: boolean;
  }>({ groups: [], loading: q !== "" }, q);
  const { groups, loading } = search;
  const [committing, setCommitting] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // The tracked practices this profile can quick-log by name (#1633). Gathered ON OPEN
  // rather than propped from the layout: the palette is mounted on every route and this
  // is a per-profile read, so a layout-time snapshot would tax ~60 routes for a list
  // that matters only once the palette is up (the quick-entry overlay's own reasoning).
  // It only feeds the PREVIEW row — `paletteQuickLog` re-derives the set server-side
  // before it writes anything.
  const [practices, setPractices] = useState<QuickLogPracticeOption[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Grounded record Q&A (#878, Phase 2): the answer for the current question, or null
  // until the user asks. Pointer-only (never part of the arrow/Enter flat list), so the
  // existing keyboard navigation is untouched.
  const [asking, setAsking] = useResettableState(false, q);
  const [ask, setAsk] = useResettableState<Extract<
    AskRecordsResult,
    { ok: true }
  > | null>(null, q);
  const [askError, setAskError] = useResettableState<string | null>(null, q);

  // Derived synchronously from the query: the quick-log preview (or null) and the
  // matching create actions. An empty query shows all actions as a resting menu.
  const quickLog = useMemo(
    () => (q ? parseQuickLog(query, weightUnit, practices) : null),
    [query, q, weightUnit, practices]
  );
  // Drop the "Repeat last activity" action when nothing's been logged — there's
  // no last activity to repeat (issue #337).
  const actions = useMemo(
    () =>
      matchPaletteActions(query).filter(
        (a) =>
          (a.target.kind !== "repeat" || hasLastActivity) &&
          (trainingRelevant ||
            (a.target.kind !== "activity" && a.target.kind !== "repeat")) &&
          // The provider can still withhold live mode for a read-only context.
          (a.target.kind !== "live" || canStartWorkout)
      ),
    [query, hasLastActivity, canStartWorkout, trainingRelevant]
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
  // Keep the stored cursor valid before rendering or handling Enter. React retries
  // this component immediately, so no row observes an out-of-range highlight.
  const lastItem = Math.max(items.length - 1, 0);
  if (highlight > lastItem) setHighlight(lastItem);

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

  // Gather the tracked practices once per open, through the SAME read the quick-entry
  // overlay's practice row uses — so "which practices can I log from a quick surface?"
  // has one answer, not one per surface. A failure leaves the list empty: `log sauna`
  // simply falls through to search, which is the honest degradation for a preview.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void loadQuickEntry("practice").then(
      (data) => {
        if (cancelled) return;
        setPractices(
          data.form === "practice"
            ? data.practices.map((p) => ({
                identity: p.identity,
                name: p.name,
              }))
            : []
        );
      },
      () => {
        if (!cancelled) setPractices([]);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Debounced fetch. A per-request token drops stale responses so a slow earlier
  // query can't overwrite a newer one's results.
  useEffect(() => {
    if (!open || q === "") return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await runGlobalSearch(q);
        if (!cancelled) {
          setSearch({ groups: res, loading: false });
        }
      } catch {
        if (!cancelled) setSearch({ groups: [], loading: false });
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open, setSearch]);

  // Keep the highlighted row scrolled into view as the arrows walk the list.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${highlight}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const close = useCallback(() => {
    // Closing is the event that ends this palette session. Clear its drafts in the
    // same batched interaction so the next open starts fresh without a reset effect.
    setQuery("");
    setHighlight(0);
    setCommitting(false);
    setPractices([]);
    setOpen(false);
  }, []);

  // Ask the grounded record Q&A about the current query (#878, Phase 2). Read-only:
  // it retrieves the active profile's own matching rows and narrates a linked answer
  // (or, keyless, the same rows with an honest offline line; empty retrieval → a hard
  // "nothing found"). Pointer-only, so the arrow/Enter navigation stays untouched.
  const runAsk = useCallback(async () => {
    const question = q;
    if (!question || asking) return;
    setAsking(true);
    setAskError(null);
    try {
      const fd = new FormData();
      fd.set("question", question);
      const res = await askRecordsAction(fd);
      if (res.ok) setAsk(res);
      else setAskError(res.error);
    } finally {
      setAsking(false);
    }
  }, [q, asking, setAsk, setAskError, setAsking]);

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
      } else if (action.target.kind === "overlay") {
        // In place, exactly as the quick-log sheet opens it (#1468): a palette action
        // that files a document or logs a weight must leave you on the page you were
        // reading (#2184). The prefill is the context the PICK implies (#2014 — "Log
        // weight" opens the weight group), overriding the form's last-written-group
        // memory, which stays for context-free opens (#2068).
        const { form, prefill } = action.target;
        close();
        openQuickEntry(form, prefill);
      } else {
        // A matching data search may already be in flight by the time an action
        // is picked. Its Server Action response can race an App Router push and
        // restore the palette's current route, so create-surface actions use a
        // document navigation. Pointer and keyboard activation then share one
        // deterministic path, and the new page naturally resets the palette.
        window.location.assign(action.target.href);
      }
    },
    [close, openCreate, openLive, openRepeatLast, openQuickEntry]
  );

  const commitQuickLog = useCallback(
    async (log: QuickLogCommand) => {
      if (log.error || committing) return;
      setCommitting(true);
      try {
        // The unit the previewed row was parsed and printed in — carried so the
        // authoritative re-parse reads an unsuffixed number the same way (#3853).
        const res = await paletteQuickLog(query, weightUnit);
        toast(res.message, { tone: res.ok ? "success" : "error" });
        if (res.ok) {
          close();
        }
      } finally {
        setCommitting(false);
      }
    },
    [query, weightUnit, committing, toast, close]
  );

  // Run a per-hit contextual action (#662). A navigate action (add-result) just
  // routes to its prefilled form; a write action (log-dose/refill/complete) submits
  // the entity id to the EXISTING gated Server Action — the same write path the
  // med/appointment pages use, so the auth gate is never bypassed. We answer from
  // the action's typed outcome — including the duplicate-style "already" answers —
  // never with an unconditional success toast (#2134).
  const runHitAction = useCallback(
    async (action: HitAction) => {
      if (action.kind === "add-result") {
        if (action.href) go(action.href);
        return;
      }
      if (committing) return;
      setCommitting(true);
      try {
        // The palette names its OWN surface rather than reading the region: it is
        // `quick-log` wherever it opens, including over a domain page that declares
        // itself something else.
        const fd = stampWebOrigin(new FormData(), PALETTE_SURFACE);
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
          const res = await completeAppointment(fd);
          toast(
            res.ok
              ? res.outcome === "already"
                ? "Appointment already completed"
                : "Appointment completed"
              : res.error,
            { tone: res.ok ? "success" : "error" }
          );
          if (!res.ok) return;
        }
        close();
      } finally {
        setCommitting(false);
      }
    },
    [committing, close, go, toast]
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

  // THE ROW MEETS THE TAP FLOOR WHERE A FINGER IS DOING THE TAPPING (#644,
  // #3423). `px-2 py-2` around `text-sm` is a ~36px row: fine under a mouse,
  // eight pixels under the floor on a phone. `min-h-11` is 44px below `md` and
  // releases from `md` up, so the desktop list keeps its compact density and the
  // palette does not become a phone list on a keyboard surface.
  //
  // NOT `py-3` INSTEAD: a two-line row (a hit with a subtitle) is already past
  // 44px, and raising its padding would push it to ~60px. `min-h` raises the
  // short rows and leaves the tall ones exactly where they are.
  const rowClass = (active: boolean) =>
    `flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-2 text-left md:min-h-0 ${
      active
        ? "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
        : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-ink-800"
    }`;

  // THE HIGHLIGHT HAS TO BE REACHABLE BY THE POINTER THAT IS ACTUALLY THERE.
  // `onMouseEnter` alone is a pointer-only signal: a touch device never fires a
  // hover, so on a phone the highlight was a state nothing could enter — and the
  // "↵" glyph and "Enter to save" copy hang off exactly that state. Every row
  // therefore also claims the highlight on FOCUS (keyboard tab, and the focus a
  // tap gives a button) and on POINTER-DOWN (the first event a touch delivers,
  // before the click that runs the row).
  //
  // Synthesized-hover devices are why this is not simply "replace mouseenter":
  // a stylus and a hybrid laptop fire both, and setting the same index twice is
  // a no-op React bails out of.
  const highlightOn = (index: number) => ({
    onMouseEnter: () => setHighlight(index),
    onFocus: () => setHighlight(index),
    onPointerDown: () => setHighlight(index),
  });

  return (
    // THE PALETTE IS A QUICK-LOG SURFACE (#3087), for its own writes and for anything
    // it renders. It posts the same `logMedicationAdministration` the medications
    // page's own form posts — and `paletteQuickLog`, twelve lines up, has always
    // stamped `quick-log` — so declaring the region here keeps the palette's write
    // paths saying one thing. The constant, rather than the hook, because a component
    // is not inside the provider it renders.
    <LoggedViaSurface value={PALETTE_SURFACE}>
      <ModalShell
        title="Search"
        onClose={close}
        initialFocusRef={inputRef}
        // A RECORDED anatomy exception to the #2774 convergence, not a preference:
        // the palette is a keyboard surface whose whole body is a virtualized
        // result list under a search field. It has no bottom edge to flick toward
        // at any width, and a phone sheet whose content is the software keyboard
        // plus a scrolling list is the one shape the sheet idiom does not improve.
        // #1469 scoped it out on the same grounds; the justification lives in
        // lib/__tests__/overlay-motion-chokepoint.test.ts.
        presentation="centered"
        // ...BUT "NOT A SHEET" NEVER DEFENDED A CENTRED CARD (#3423). The
        // exception above rules out the bottom edge, and that reasoning still
        // holds at every width. What it does not license is a floating
        // `max-h-[85dvh]` card inset by `p-4` on a 430px screen with the software
        // keyboard taking most of what is left — a desktop dialog wearing a
        // phone's worst-case viewport.
        //
        // Below `md` the palette becomes the phone idiom for its own content: a
        // FULL-SCREEN SEARCH SURFACE, field at the top under a named Cancel,
        // results filling everything beneath. From `md` up nothing moves. The
        // shape is components/BottomSheet.tsx's — the same portal, scrim, focus
        // trap, scroll lock and Escape seam this surface already had — so the
        // phone presentation is not a new overlay to classify.
        fullScreenBelowMd
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
              // WHAT THE SOFTWARE KEYBOARD OFFERS, AND WHAT IT DOES TO THE QUERY
              // (#3423). Without these the phone shows a generic "return" key over
              // a search field and capitalises the first letter, so a typed
              // `weight 82.5` reads back as `Weight 82.5`.
              //
              // Recorded because it invites a wrong fix: the capitalisation is an
              // APPEARANCE bug and never a parse one. `parseQuickLog` in
              // lib/palette-quick-log.ts lowercases the keyword and matches the
              // unit case-insensitively, so the entry committed either way. Nobody
              // should go "fix" the parser on the strength of this line.
              enterKeyHint="search"
              inputMode="search"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
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
            ’s data
            {/* THE INSTRUCTION NAMES KEYS THE READER CAN PRESS, AND ONLY THOSE
              (#3423). The scope half — whose data this searches — is a claim
              about the DATA and stays at every width; it is the only sentence on
              the surface that says the search is profile-scoped. The navigation
              half describes a keyboard, so it renders where one exists. Two
              spellings of a HINT, not two copies of an action list: nothing here
              is a control, so #2305's one-authoring rule is not in play. The
              same shape components/SidebarContent.tsx already uses for its ⌘K. */}
            <span className="hidden md:inline">
              {" · arrows to move, Enter to run"}
            </span>
          </p>

          <div
            id="command-palette-results"
            ref={listRef}
            role="listbox"
            aria-label="Results"
            className="mt-3 min-h-0 flex-1 overflow-y-auto"
          >
            {/* Ask your records (#878, Phase 2) — grounded Q&A over the active profile's
              OWN rows. Pointer-only: a trigger to narrate a linked answer, and the
              answer panel. Never part of the arrow/Enter list. */}
            {q !== "" && (
              <div className="mb-2" data-testid="ask-records">
                <div className="px-2 pb-1 pt-2 section-label">Ask</div>
                <button
                  type="button"
                  onClick={() => void runAsk()}
                  disabled={asking}
                  data-testid="ask-records-trigger"
                  className={`${rowClass(false)} disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  <IconSparkles className="h-4 w-4 shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      Ask about your records
                    </span>
                    <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                      {asking
                        ? "Looking through your records…"
                        : `Answer “${q}” from your own records`}
                    </span>
                  </span>
                </button>

                {askError && (
                  <p className="mt-1 px-2 text-xs text-rose-600 dark:text-rose-400">
                    {askError}
                  </p>
                )}

                {ask && (
                  <div
                    data-testid="ask-records-panel"
                    className="mt-1 rounded-lg border border-black/10 bg-slate-50 p-3 dark:border-white/10 dark:bg-ink-850"
                  >
                    <NotesText
                      notes={ask.answer}
                      as="div"
                      data-testid="ask-records-answer"
                      className="text-sm text-slate-700 dark:text-slate-200"
                    />
                    {ask.citations.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {ask.citations.map((c: RecordCitation) => (
                          <li key={c.index}>
                            <button
                              type="button"
                              onClick={() => go(c.href)}
                              data-testid="ask-records-citation"
                              className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-800"
                            >
                              <span className="shrink-0 rounded-sm bg-slate-200 px-1 font-mono text-xs text-slate-600 dark:bg-ink-700 dark:text-slate-300">
                                {c.index}
                              </span>
                              <span className="min-w-0 flex-1 truncate">
                                <span className="font-medium">{c.title}</span>
                                <span className="text-slate-500 dark:text-slate-400">
                                  {" · "}
                                  {DOMAIN_LABEL[c.domain]}
                                  {c.date ? ` · ${c.date}` : ""}
                                </span>
                              </span>
                              <IconArrowRight className="h-3.5 w-3.5 shrink-0 opacity-50" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )}

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
                  {...highlightOn(quickLogIdx)}
                  onClick={() => void commitQuickLog(quickLog)}
                  className={`${rowClass(highlight === quickLogIdx)} disabled:cursor-not-allowed`}
                >
                  <IconBolt className="h-4 w-4 shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {quickLog.error ?? quickLog.label}
                    </span>
                    <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                      {quickLog.error ? (
                        "Fix the value to log it"
                      ) : committing ? (
                        "Saving…"
                      ) : (
                        // THE COMMIT AFFORDANCE IS SHAPED LIKE THE GESTURE THAT
                        // REACHES IT (#3423). "Enter to save" is a correct
                        // instruction on a keyboard and a dead end on a phone,
                        // where the row is a thing you tap. Same row, same commit
                        // path, same `commitQuickLog` — only the verb changes.
                        <>
                          <span className="md:hidden">Tap to save</span>
                          <span className="hidden md:inline">
                            Enter to save
                          </span>
                        </>
                      )}
                    </span>
                  </span>
                  {highlight === quickLogIdx && !quickLog.error && (
                    // The "↵" glyph draws where a Return key exists. It is a
                    // PICTURE OF A KEY, so on a phone it points at hardware the
                    // reader does not have — the row's own "Tap to save" is the
                    // affordance there.
                    <IconCornerDownLeft className="hidden h-4 w-4 shrink-0 opacity-60 md:block" />
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
                    // The live-workout action renders the SHARED offer state (#1893):
                    // while a session is running it reads "Resume workout", because
                    // openLive reopens the docked session rather than resetting its
                    // clock. Every other action's label is its own.
                    const label =
                      action.target.kind === "live"
                        ? workoutOffer.label
                        : action.label;
                    return (
                      <li key={action.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={active}
                          data-idx={itemIdx}
                          data-testid={`palette-action-${action.id}`}
                          {...highlightOn(itemIdx)}
                          onClick={() => runAction(action)}
                          className={rowClass(active)}
                        >
                          <Icon className="h-4 w-4 shrink-0 opacity-70" />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {label}
                          </span>
                          {active && (
                            <IconCornerDownLeft className="hidden h-4 w-4 shrink-0 opacity-60 md:block" />
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
                  highlightOn={highlightOn}
                  onPick={go}
                  onAction={runHitAction}
                  committing={committing}
                  rowClass={rowClass}
                />
              ))}
          </div>
        </div>
      </ModalShell>
    </LoggedViaSurface>
  );
}

function SearchResults({
  groups,
  base,
  highlight,
  highlightOn,
  onPick,
  onAction,
  committing,
  rowClass,
}: {
  groups: SearchGroup[];
  base: number;
  highlight: number;
  // The three handlers that claim the highlight for a row — hover, focus and
  // pointer-down. Handed over as ONE spread rather than as `setHighlight`, so a
  // row here cannot quietly go back to being hover-only (#3423).
  highlightOn: (index: number) => {
    onMouseEnter: () => void;
    onFocus: () => void;
    onPointerDown: () => void;
  };
  onPick: (href: AppRoute) => void;
  onAction: (action: HitAction) => void;
  committing: boolean;
  rowClass: (active: boolean) => string;
}) {
  return (
    <>
      {groups.map((group, groupIndex) => (
        // Named by its DOMAIN, so a test can address the group a hit came from: the
        // record's rows and the entity that names them share a title on purpose
        // ("Moonlight breathwork" is a session and a practice), and which one a tap
        // opens is the difference between the entry and its list.
        <div
          key={group.domain}
          data-testid={`palette-group-${group.domain}`}
          className="mb-2"
        >
          <div className="px-2 pb-1 pt-2 section-label">{group.label}</div>
          <ul>
            {group.hits.map((hit, hitIndex) => {
              const itemIdx =
                base +
                groups
                  .slice(0, groupIndex)
                  .reduce((count, prior) => count + prior.hits.length, 0) +
                hitIndex;
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
                    {...highlightOn(itemIdx)}
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
                      <IconCornerDownLeft className="hidden h-4 w-4 shrink-0 opacity-60 md:block" />
                    )}
                  </button>
                  {actions.map((action) => (
                    <button
                      key={`${hit.key}:${action.kind}`}
                      type="button"
                      data-testid={`palette-hit-action-${action.kind}`}
                      disabled={committing}
                      onClick={() => onAction(action)}
                      className="min-h-11 shrink-0 self-center rounded-md border border-black/10 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 md:min-h-0 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-800 dark:hover:text-slate-100"
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
