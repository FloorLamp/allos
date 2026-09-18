"use client";

import {
  Activity,
  Suspense,
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import BottomSheet from "./BottomSheet";
import { LoggedViaSurface } from "./LoggedViaSurface";
import { useToast } from "./Toast";
import QuickDoseList from "./quick-entry/QuickDoseList";
import MeasurementsQuickAdd from "@/app/(app)/trends/MeasurementsQuickAdd";
import FoodLogBar from "@/app/(app)/nutrition/FoodLogBar";
import { FoodProjectionProvider } from "@/app/(app)/nutrition/FoodSuggestionsLayout";
import {
  loadQuickEntry,
  loadQuickEntryIntakeContext,
  type QuickEntryData,
  type QuickEntryIntakeContextResult,
} from "@/app/(app)/quick-entry-actions";
import type { MeasurementsQuickEntry } from "@/lib/quick-entry-measurements";
import type { QuickEntryForm, QuickEntryPrefill } from "@/lib/quick-log";
import type { SessionProfile } from "@/lib/auth";
import {
  DayContextBoundary,
  DayContextProvider,
  useLiveProfileClocks,
  useOptionalDayContext,
  type DayContextValue,
} from "./DayContext";
import BoundedDaySwitcher from "./BoundedDaySwitcher";
import { isWithinReach, SHEET_REACH } from "@/lib/log-manifest";
import { dayContextKey, type DayContextParts } from "@/lib/day-context-key";
import { shiftDateStr } from "@/lib/date";
import type { FoodSlotBoundaries } from "@/lib/food-slot";
import {
  BodyBoundary,
  loadBodies,
  QuickEntryError,
  QUICK_ENTRY_LOADING,
  QUIET_STATE_CLASS,
  type Bodies,
} from "./quick-entry/body-chunks";
import {
  useVisitResumeBoundary,
  useVisitResumeWatch,
  type VisitResumeWatch,
} from "./quick-entry/visit-resume";
import {
  QuickEntrySubjectPicker,
  QuickEntryTitleAdornment,
  sheetForEntry,
  type SheetChrome,
} from "./quick-entry/sheet-chrome";
import { formatRelativeTime, formatWeekdayDate } from "@/lib/format-date";
import { useFormatPrefs } from "./FormatPrefsProvider";
import { TimezoneProvider } from "./TimezoneProvider";
import { useTimezone } from "./TimezoneProvider";
import {
  captureLastGoodToken,
  clearLastGood,
  quickEntryOffline,
  recallLastGood,
  rememberLastGood,
  subscribeLastGoodInvalidation,
} from "@/lib/offline/quick-entry-read";
import { allIntents } from "@/lib/offline/queue-db";
import { allSnapshots } from "@/lib/offline/snapshot-db";
import { wipeDeviceForSignOut } from "./device-wipe";
import { ActiveProfileProvider } from "./ActiveProfileProvider";
import type { IntakeItemKind } from "@/lib/types";
import type { IntakeFormContext } from "@/lib/intake-form-context";

// The shared quick-entry overlay host (issue #1468).
//
// **Navigation is not a quick-log outcome.** The #1416 sheet shipped two-tier:
// activity opened its editor in place, but food / dose / weight were
// `router.push`es to their pages — so a sheet that promises "log from anywhere"
// left you on Nutrition in the middle of a morning check. Every sheet item now
// opens here instead, and after a save you are exactly where you started. That
// is the feature.
//
// ── What this is NOT ─────────────────────────────────────────────────────────
//
// It is not a second write path, and not a second set of forms. It mounts the
// EXISTING components — MeasurementsQuickAdd, FoodLogBar and SymptomLogBar, the very
// same instances the Trends, Nutrition and dashboard surfaces render — and they keep calling the very
// same Server Actions (addMeasurements / logFoodServing) with their own
// validation, offline queueing and write gates. Dose is the one row
// this file assembles (QuickDoseList), and it too only posts the existing
// `markTaken`. One component serves the page mount AND the overlay mount; there
// is deliberately no overlay COPY of any form to drift from its original (the
// responsive shared-content rule, one level up).
//
// Deep-link `FOCUS_PARAM` behavior on the pages is untouched — the palette and
// external links still land on the page and focus a field there. This is an
// additional mounting context, not a replacement for the pages.
//
// ── Lifecycle ────────────────────────────────────────────────────────────────
//
// TRANSACTIONAL, which is what earns it the BottomSheet (the #1428 decision
// rule): a half-typed weight entry is safe to discard, so scrim-tap / Escape /
// (with #1425) flick-away all mean "never mind". The activity editor is the
// counter-example and stays a DOCK — a live workout is a SESSION, "away" means
// still running, and dismissal must mean minimize, never discard. That is why
// `{kind:"activity"}` is still its own target rather than an overlay form.
//
// Explicit submit stays (#794): this is a MOUNT, not an autosave surface. Only
// the Settings cards save on blur.
//
// ── Cost ─────────────────────────────────────────────────────────────────────
//
// Mounted on every page, it gathers NOTHING until opened: the forms' props come
// from the `loadQuickEntry` read action on open (see quick-entry-actions.ts for
// why lazy is both cheaper and FRESHER than a layout-time snapshot). The
// eagerly-propped ActivityEditorProvider next door is the shape being avoided.

interface QuickEntryApi {
  // `subjectProfileId` (#4932): the container's own subject, when the opener sits
  // inside one (the dashboard cockpit, an episode/medication page, a subject-scoped
  // panel) — the sheet's title-row chip defaults to it instead of the acting
  // profile. Omitted (the dock, the palette, a keyboard shortcut — surfaces with no
  // subject of their own) leaves the chip on the acting profile, unchanged from
  // before this issue.
  open: (
    form: QuickEntryForm,
    prefill?: QuickEntryPrefill,
    subjectProfileId?: number
  ) => void;
  close: () => void;
  /**
   * The sheet's food-window splits, published by whoever gathered them (#5902).
   * `QuickLogMenu`'s open-time `loadLogSheetContext` is that gatherer and the only
   * caller; the provider keeps the last answer so the visit's resume check can ask
   * which window it opened in without a second read. `null` clears it — a sheet
   * that closed, or a gather that failed, leaves the day as the only boundary the
   * resume check can still compare.
   */
  noteSlotBoundaries: (boundaries: FoodSlotBoundaries | null) => void;
}

interface QuickEntryHostApi extends QuickEntryApi {
  open: (
    form: QuickEntryForm,
    prefill?: QuickEntryPrefill,
    subjectProfileId?: number,
    dayContext?: DayContextValue | null
  ) => void;
  visit: QuickEntryVisitHostApi;
  actingProfileId: number;
  writableProfiles: SessionProfile[];
  // The resume check's two event-time reads (#5902), owned by
  // components/quick-entry/visit-resume.ts.
  resume: VisitResumeWatch;
}

interface QuickEntrySession {
  id: number;
  form: QuickEntryForm;
  prefill: QuickEntryPrefill | null;
  subject: number;
  pickerOpen: boolean;
  host: HostView;
  bodies: Bodies;
  trigger: HTMLButtonElement | null;
  view: QuickEntryView;
  bodyActivation: number;
  addTriggerRef: { current: HTMLButtonElement | null };
  focusReturn: {
    activation: number;
    bodyActivation: number;
    preferred: HTMLButtonElement | null;
  } | null;
}

type QuickEntryIntakeContext =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; value: IntakeFormContext };

type QuickEntryView =
  | { kind: "body" }
  | {
      kind: "intake";
      intakeKind: IntakeItemKind;
      activation: number;
      trigger: HTMLButtonElement | null;
      context: QuickEntryIntakeContext;
    };

interface QuickEntryVisitState {
  identity: string;
  presentation: "direct" | "visit";
  generation: number;
  subject: number;
  activeId: number | null;
  entries: QuickEntrySession[];
  returnFocus: HTMLButtonElement | null;
  invalidated: boolean;
  completable: boolean;
}

interface QuickEntryVisitHostApi {
  state: QuickEntryVisitState;
  start: (identity: string) => void;
  open: (
    form: QuickEntryForm,
    trigger: HTMLButtonElement,
    dayContext: DayContextValue | null
  ) => void;
  back: () => void;
  beginClose: () => void;
  invalidate: () => void;
  complete: (entryId: number) => boolean;
  retry: (entryId: number) => void;
  selectDay: (entryId: number, day: string) => void;
  selectSubject: (entryId: number, profileId: number) => void;
  toggleSubjectPicker: (entryId: number) => void;
  openIntake: (
    entryId: number,
    kind: IntakeItemKind,
    trigger: HTMLButtonElement | null
  ) => void;
  exitIntake: (entryId: number) => void;
  acceptIntakeSave: (entryId: number, activation: number) => boolean;
  refreshDose: (entryId: number, bodyActivation: number) => void;
  focusDoseReturn: (entryId: number, activation: number) => void;
}

export interface QuickEntryVisit {
  identity: string;
  active: null | ({ id: number; form: QuickEntryForm } & SheetChrome);
  open: (form: QuickEntryForm, trigger: HTMLButtonElement) => void;
  back: () => void;
  beginClose: () => void;
  invalidated: boolean;
  returnFocus: HTMLButtonElement | null;
  titleAdornment: ReactNode;
  belowTitle: ReactNode;
}

// The prefill vocabulary lives beside the form vocabulary in lib/quick-log.ts
// (#2184: the palette's registry speaks it too); re-exported here for callers
// that reach it through the overlay host.
export type { QuickEntryPrefill };

const Ctx = createContext<QuickEntryHostApi | null>(null);

export function useQuickEntry(): QuickEntryApi {
  const ctx = useContext(Ctx);
  const dayContext = useOptionalDayContext();
  if (!ctx)
    throw new Error("useQuickEntry must be used within a QuickEntryProvider");
  return useMemo(
    () => ({
      close: ctx.close,
      noteSlotBoundaries: ctx.noteSlotBoundaries,
      open: (
        form: QuickEntryForm,
        prefill?: QuickEntryPrefill,
        subjectProfileId?: number
      ) => ctx.open(form, prefill, subjectProfileId, dayContext),
    }),
    [ctx, dayContext]
  );
}

export function useQuickEntryVisit(
  outerOpen: boolean,
  onInvalidated: () => void
): QuickEntryVisit {
  const ctx = useContext(Ctx);
  const dayContext = useOptionalDayContext();
  const ownerId = useId();
  const liveProfileClocks = useLiveProfileClocks();
  const [edge, setEdge] = useState(() => ({
    open: outerOpen,
    serial: outerOpen ? 1 : 0,
    identity: `${ownerId}:${outerOpen ? 1 : 0}`,
  }));
  if (!ctx)
    throw new Error(
      "useQuickEntryVisit must be used within a QuickEntryProvider"
    );

  if (edge.open !== outerOpen) {
    const serial = outerOpen ? edge.serial + 1 : edge.serial;
    setEdge({
      open: outerOpen,
      serial,
      identity: `${ownerId}:${serial}`,
    });
  }

  const identity =
    edge.open === outerOpen
      ? edge.identity
      : `${ownerId}:${outerOpen ? edge.serial + 1 : edge.serial}`;
  const currentVisit = ctx.visit.state.identity === identity;
  const startVisit = ctx.visit.start;
  const beginClose = ctx.visit.beginClose;

  useLayoutEffect(() => {
    if (outerOpen) startVisit(identity);
    else beginClose();
  }, [beginClose, identity, outerOpen, startVisit]);

  useLayoutEffect(() => {
    if (outerOpen && currentVisit && ctx.visit.state.invalidated)
      onInvalidated();
  }, [ctx.visit.state.invalidated, currentVisit, onInvalidated, outerOpen]);

  // THE SHEET DOES NOT SURVIVE A BOUNDARY IT CARES ABOUT (#5902). One listener,
  // here in the visit owner, so `QuickLogSheet` needs not one line of it and neither
  // does any future host that takes a visit. What it watches, why the day is derived
  // at event time and why a draft holds the sheet open: visit-resume.ts.
  //
  // The desktop panel reaches these forms through the provider's DIRECT overlay
  // rather than a visit, so it takes the same watch on its own `open` state and its
  // own draft subtree, keyed `"panel"` (see the provider below).
  useVisitResumeBoundary({
    watching: outerOpen && currentVisit,
    timeZone: liveProfileClocks.get(ctx.actingProfileId)?.timeZone ?? null,
    watch: ctx.resume,
    host: "visit",
    onCrossed: ctx.visit.invalidate,
  });

  const activeEntry = (currentVisit ? ctx.visit.state.entries : []).find(
    (entry) => entry.id === ctx.visit.state.activeId
  );
  const active = activeEntry
    ? {
        id: activeEntry.id,
        form: activeEntry.form,
        ...sheetForEntry(activeEntry),
      }
    : null;

  return {
    identity,
    active,
    open: (form, trigger) => ctx.visit.open(form, trigger, dayContext),
    back: ctx.visit.back,
    beginClose,
    invalidated: currentVisit && ctx.visit.state.invalidated,
    returnFocus: currentVisit ? ctx.visit.state.returnFocus : null,
    titleAdornment: activeEntry ? (
      <QuickEntryTitleAdornment
        session={activeEntry}
        writableProfiles={ctx.writableProfiles}
        onToggle={() => ctx.visit.toggleSubjectPicker(activeEntry.id)}
      />
    ) : null,
    belowTitle: activeEntry ? (
      <QuickEntrySubjectPicker
        session={activeEntry}
        writableProfiles={ctx.writableProfiles}
        onSelect={(profileId) =>
          ctx.visit.selectSubject(activeEntry.id, profileId)
        }
      />
    ) : null,
  };
}

// The measurements payload comes from the SHELL, everything else from the gather —
// one discriminated union either way, so the body below still switches on `form`.
type QuickEntryBody = QuickEntryData | MeasurementsQuickEntry;

type LoadState =
  | { status: "loading" }
  | {
      status: "ready";
      data: QuickEntryBody;
      gatheredKey?: string;
      sight: "read" | "device";
      asOf: string | null;
    }
  | { status: "error" };

type SheetDayContext =
  | { kind: "inherited"; value: DayContextValue }
  | { kind: "state"; parts: DayContextParts };

type LoadRequest =
  | { kind: "dayless" }
  | { kind: "inherited"; value: DayContextValue }
  | { kind: "selected"; parts: DayContextParts };

interface HostView {
  state: LoadState;
  sheetDay: SheetDayContext | null;
  request: LoadRequest | null;
}

interface LoadOwner {
  setHost: React.Dispatch<React.SetStateAction<HostView>>;
  current: (token: number) => boolean;
  nextToken: () => number;
}

export type QuickEntryRemountCause = "payload" | "context";

export function remounts(
  currentForm: QuickEntryBody["form"],
  nextForm: QuickEntryBody["form"],
  cause: QuickEntryRemountCause
): boolean {
  if (cause === "context") return true;
  switch (currentForm) {
    case "food":
    case "measurements":
    case "dose":
    case "practice":
    case "cycle":
    case "mood":
    case "stool":
    case "substance":
    case "symptom":
    case "document":
    case "unavailable":
      return currentForm !== nextForm;
    default: {
      const exhaustive: never = currentForm;
      return exhaustive;
    }
  }
}

function asOfCopy(fetchedAt: string | Date, why: string): string {
  return `As of ${formatRelativeTime(
    typeof fetchedAt === "string" ? fetchedAt : fetchedAt.toISOString()
  )} — ${why}`;
}

function quickEntryToday(data: QuickEntryBody): string | null {
  if (data.form === "measurements") return data.defaultDate;
  if (data.form === "cycle" || data.form === "document") return null;
  return data.today;
}

function contextDayLabel(
  day: string,
  today: string,
  prefs: ReturnType<typeof useFormatPrefs>
) {
  if (day === today) return "Today";
  if (day === shiftDateStr(today, -1)) return "Yesterday";
  return formatWeekdayDate(day, prefs);
}

function withLiveDayLabels(
  data: QuickEntryBody,
  today: string,
  prefs: ReturnType<typeof useFormatPrefs>
): QuickEntryBody {
  const label = (date: string) => contextDayLabel(date, today, prefs);
  switch (data.form) {
    case "food":
      return {
        ...data,
        days: data.days.map((day) => ({ ...day, label: label(day.date) })),
      };
    case "mood":
      return {
        ...data,
        days: data.days.map((day) => ({ ...day, label: label(day.date) })),
      };
    default:
      return data;
  }
}

// The stall bound a cold "Loading…" may sit under before the sheet admits the
// gather is not coming back (#3416 proposal 3) — long enough that an ordinary slow
// connection still finishes first, short enough that a dead one does not leave the
// sheet looking merely quiet.
const QUICK_ENTRY_LOAD_TIMEOUT_MS = 10_000;

export default function QuickEntryProvider({
  children,
  measurements,
  writableProfiles,
  actingProfileId,
}: {
  children: React.ReactNode;
  // Resolved in the app shell, not gathered on open (#4091): the measurements
  // form is the one body here a person is expected to reach with no connection,
  // and `loadQuickEntry` is a Server Action, which offline rejects. Server-rendered
  // inline is what made the dashboard's retired weight widget reachable in a gym
  // basement, and this prop is that same property, kept while the widget goes.
  measurements: MeasurementsQuickEntry;
  // The household members this login may WRITE (#4932, `writableProfileIdsForLogin`)
  // — resolved once in the app shell alongside `measurements`, never re-fetched on
  // open. The title-row chip's "Who is this for?" block lists exactly these,
  // current one selected; a login that can write exactly one profile (itself, in
  // the ordinary case) renders the chip with no chevron and no block.
  writableProfiles: SessionProfile[];
  actingProfileId: number;
}) {
  const toast = useToast();
  const liveProfileClocks = useLiveProfileClocks();
  const liveProfileClocksRef = useRef(liveProfileClocks);
  liveProfileClocksRef.current = liveProfileClocks;
  const [open, setOpen] = useState(false);
  const entrySerial = useRef(0);
  const intakeActivationSerial = useRef(0);
  const visitRequestRefs = useRef(new Map<string, number>());
  const [visitState, setVisitState] = useState<QuickEntryVisitState>({
    identity: "",
    presentation: "visit",
    generation: 0,
    subject: actingProfileId,
    activeId: null,
    entries: [],
    returnFocus: null,
    invalidated: false,
    completable: false,
  });
  const visitStateRef = useRef(visitState);
  visitStateRef.current = visitState;
  const updateVisit = useCallback(
    (
      update: (current: QuickEntryVisitState) => QuickEntryVisitState
    ): QuickEntryVisitState => {
      const next = update(visitStateRef.current);
      visitStateRef.current = next;
      setVisitState(next);
      return next;
    },
    []
  );

  const invalidateVisitRequests = useCallback(() => {
    for (const [key, token] of visitRequestRefs.current)
      visitRequestRefs.current.set(key, token + 1);
  }, []);

  // THE ONE INVALIDATION. Started as the last-good subscription's own closure;
  // named because #5902's resume crossing ends in exactly this state — the visit
  // emptied and flagged, which every host already turns into its close through
  // `onInvalidated`. A second close path is what naming it avoids.
  const invalidateVisit = useCallback(() => {
    invalidateVisitRequests();
    updateVisit((current) => ({
      ...current,
      activeId: null,
      entries: [],
      returnFocus: null,
      invalidated: true,
      completable: false,
    }));
  }, [invalidateVisitRequests, updateVisit]);

  useLayoutEffect(() => {
    const invalidate = () => {
      // The last-good invalidation reaches the DIRECT overlay too; a resume
      // crossing is the visit's business alone and leaves this sheet alone.
      setOpen(false);
      invalidateVisit();
    };
    return subscribeLastGoodInvalidation(invalidate);
  }, [invalidateVisit]);

  const resume = useVisitResumeWatch();

  // The store is emptied when this host TAKES OVER an identity: on mount (sign-out is
  // a client navigation, so the next sign-in mounts a new host in the same document)
  // and again whenever the acting profile changes under a mounted one.
  //
  // KEYED ON THE IDENTITY ALREADY CLEARED, not a bare "the effect ran" (#5922).
  // `clearLastGood` BROADCASTS, and the subscription above turns that broadcast into
  // `setOpen(false)` + an invalidated visit — so a second clear for an identity this
  // host has already cleared is not a free no-op, it tears down whatever is open.
  //
  // That second clear happens in `next dev` and only there. React StrictMode (Next's
  // development default; a production build never double-invokes) runs mount effects,
  // tears them down, and runs them again — and the passive effect that opens a
  // `?quick=` deep link (components/QuickShortcutHandler.tsx) lands BETWEEN the two
  // passes, so the re-run closed the overlay the deep link had just opened. The e2e
  // suite spawns every worker's server as `next start` with NODE_ENV=production
  // (e2e/fixtures.ts), which is why `/?quick=log-stool` was green at five call sites
  // in e2e/bristol-stool.spec.ts while the same URL opened nothing for a person on a
  // dev server. The ref survives the StrictMode remount exactly as the handler's own
  // `handled` ref does, so the second pass recognizes the identity and stays silent; a
  // real profile switch, and a real remount, still clear and still broadcast.
  const clearedFor = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (clearedFor.current === actingProfileId) return;
    clearedFor.current = actingProfileId;
    clearLastGood();
  }, [actingProfileId]);

  const close = useCallback(() => {
    invalidateVisitRequests();
    updateVisit((current) => ({ ...current, completable: false }));
    setOpen(false);
  }, [invalidateVisitRequests, updateVisit]);

  // THE PANEL DOES NOT SURVIVE ONE EITHER (#5902 slice 2, PM ruling 2026-09-16).
  // The desktop panel reaches these forms through this DIRECT overlay, so the visit's
  // watch in `useQuickEntryVisit` cannot see it — there is no visit to invalidate and
  // the draft lives in this host's own subtree. Same module, same two event-time
  // reads, same draft guard; only the `host` key and the close differ.
  //
  // THE CLOSE IS `close`, the overlay's own — the very callback the scrim tap and
  // Escape run — and NOT the last-good invalidation above, which additionally empties
  // and flags the visit. A resume crossing on the panel is the panel's business
  // alone. The two watches cannot double-fire: `openForm` takes the visit identity
  // for its direct session, which drops `currentVisit` for every sheet host, and
  // `startVisit` closes this overlay, so `open` and a live visit are never both true.
  useVisitResumeBoundary({
    watching: open,
    timeZone: liveProfileClocks.get(actingProfileId)?.timeZone ?? null,
    watch: resume,
    host: "panel",
    onCrossed: close,
  });

  // ONE GATHER, taking the subject (#4932's own wording: "loadQuickEntry has one
  // subject parameter and one gate; no second copy of the gather per subject").
  // Reused by a fresh open, a mid-sheet subject switch AND a retry (below), so none
  // of the three can diverge into its own reader of the same form.
  const loadFor = useCallback(
    function runLoad(
      next: QuickEntryForm,
      subjectId: number,
      token: number,
      request: LoadRequest,
      owner: LoadOwner
    ) {
      const hasDayContext = next !== "cycle" && next !== "document";
      const requestMatchesSubject =
        request.kind === "dayless" ||
        (request.kind === "inherited"
          ? request.value.parts.profileId === subjectId
          : request.parts.profileId === subjectId);
      const effectiveRequest: LoadRequest =
        hasDayContext && requestMatchesSubject ? request : { kind: "dayless" };
      const requestedParts =
        effectiveRequest.kind === "inherited"
          ? effectiveRequest.value.parts
          : effectiveRequest.kind === "selected"
            ? effectiveRequest.parts
            : null;
      const matchingInherited =
        effectiveRequest.kind === "inherited" && requestedParts
          ? effectiveRequest.value
          : null;
      const requestLiveClock = liveProfileClocksRef.current.get(subjectId);
      if (!requestLiveClock) {
        owner.setHost({
          request: effectiveRequest,
          sheetDay: null,
          state: { status: "error" },
        });
        return;
      }
      const requestLiveToday = requestLiveClock.today;
      const requestParts: DayContextParts = requestedParts ?? {
        profileId: subjectId,
        day: requestLiveToday,
        reach: SHEET_REACH,
      };
      const requestKey = dayContextKey(requestParts);

      if (next === "measurements") {
        const parts = requestParts;
        owner.setHost({
          request: effectiveRequest,
          sheetDay: matchingInherited
            ? { kind: "inherited", value: matchingInherited }
            : { kind: "state", parts },
          state: {
            status: "ready",
            gatheredKey: requestKey,
            sight: "read",
            asOf: null,
            data:
              subjectId === actingProfileId
                ? { ...measurements, defaultDate: parts.day }
                : {
                    form: "unavailable",
                    today: requestLiveToday,
                    message:
                      "Switch to this profile to log measurements from the sheet.",
                  },
          },
        });
        return;
      }

      let held = requestedParts
        ? recallLastGood(requestParts, next)
        : undefined;
      if (!held && effectiveRequest.kind === "dayless") {
        for (let ago = 0; ago <= SHEET_REACH.back; ago += 1) {
          const candidate = {
            profileId: subjectId,
            day: shiftDateStr(requestLiveToday, -ago),
            reach: SHEET_REACH,
          } satisfies DayContextParts;
          const entry = recallLastGood(candidate, next);
          if (
            entry &&
            (!hasDayContext || quickEntryToday(entry.data) === entry.parts.day)
          ) {
            held = entry;
            break;
          }
        }
      }
      if (
        effectiveRequest.kind === "dayless" &&
        held &&
        !isWithinReach(SHEET_REACH, requestLiveToday, held.parts.day)
      ) {
        held = undefined;
      }
      const shownParts = held?.parts ?? requestParts;
      const shownKey = dayContextKey(shownParts);
      const initialSheetDay: SheetDayContext | null = !hasDayContext
        ? null
        : matchingInherited
          ? { kind: "inherited", value: matchingInherited }
          : { kind: "state", parts: shownParts };
      owner.setHost({
        request: effectiveRequest,
        sheetDay: initialSheetDay,
        state: held
          ? {
              status: "ready",
              data: held.data,
              gatheredKey: shownKey,
              sight: "read",
              asOf: null,
            }
          : { status: "loading" },
      });

      const cacheToken = captureLastGoodToken();
      let expired = false;
      const current = () => owner.current(token) && !expired;
      const recover = async (recoveryToken: number) => {
        const recoveryNow = new Date();
        let snapshots: Awaited<ReturnType<typeof allSnapshots>>;
        let intents: Awaited<ReturnType<typeof allIntents>>;
        try {
          [snapshots, intents] = await Promise.all([
            allSnapshots(),
            allIntents(),
          ]);
        } catch {
          if (owner.current(recoveryToken))
            owner.setHost((view) => ({
              ...view,
              state: { status: "error" },
            }));
          return;
        }
        if (!owner.current(recoveryToken)) return;
        const recoveryLiveToday =
          liveProfileClocksRef.current.get(subjectId)?.today;
        if (!recoveryLiveToday) {
          clearLastGood();
          return;
        }
        if (
          (effectiveRequest.kind === "dayless" &&
            recoveryLiveToday !== requestLiveToday) ||
          (effectiveRequest.kind !== "dayless" &&
            !isWithinReach(
              requestParts.reach,
              recoveryLiveToday,
              requestParts.day
            ))
        ) {
          expired = true;
          const nextToken = owner.nextToken();
          runLoad(next, subjectId, nextToken, { kind: "dayless" }, owner);
          return;
        }
        const copy = quickEntryOffline(
          next,
          requestParts,
          actingProfileId,
          snapshots,
          intents,
          recoveryNow
        );
        owner.setHost({
          request: effectiveRequest,
          sheetDay: copy ? initialSheetDay : null,
          state: copy
            ? {
                status: "ready",
                data: copy.data,
                gatheredKey: requestKey,
                sight: "device",
                asOf:
                  copy.fetchedAt == null
                    ? copy.says
                    : asOfCopy(copy.fetchedAt, copy.says),
              }
            : { status: "error" },
        });
      };
      const expire = () => {
        if (!current()) return;
        expired = true;
        const recoveryToken = owner.nextToken();
        if (held) {
          owner.setHost({
            request: effectiveRequest,
            sheetDay: initialSheetDay,
            state: {
              status: "ready",
              data: held.data,
              gatheredKey: shownKey,
              sight: "read",
              asOf: asOfCopy(held.fetchedAt, "couldn't refresh."),
            },
          });
        } else {
          void recover(recoveryToken);
        }
      };
      const stallTimer = setTimeout(expire, QUICK_ENTRY_LOAD_TIMEOUT_MS);

      void loadQuickEntry(
        next,
        subjectId,
        requestedParts?.day,
        matchingInherited?.parts.reach.kind === "dated" ? "dated" : "sheet"
      ).then(
        (result) => {
          clearTimeout(stallTimer);
          if (!current()) return;
          if (result.kind === "refused") {
            // The server answered the authorization question. Do not reinterpret
            // that refusal as a dead link and paint device data under it.
            if (result.reason === "session") void wipeDeviceForSignOut();
            else clearLastGood();
            return;
          }
          const data = result.data;
          const gatheredToday = hasDayContext ? quickEntryToday(data) : null;
          const responseLiveToday =
            liveProfileClocksRef.current.get(subjectId)?.today;
          if (!responseLiveToday) {
            clearLastGood();
            return;
          }
          if (
            effectiveRequest.kind === "dayless" &&
            gatheredToday &&
            responseLiveToday !== requestLiveToday &&
            responseLiveToday !== gatheredToday
          ) {
            expired = true;
            const nextToken = owner.nextToken();
            runLoad(next, subjectId, nextToken, { kind: "dayless" }, owner);
            return;
          }
          if (
            effectiveRequest.kind === "dayless" &&
            gatheredToday &&
            !isWithinReach(SHEET_REACH, responseLiveToday, gatheredToday)
          ) {
            expire();
            return;
          }
          let nextSheetDay: SheetDayContext | null = null;
          let gatheredKey: string | undefined;
          const gatheredParts = gatheredToday
            ? (requestedParts ?? {
                profileId: subjectId,
                day: gatheredToday,
                reach: SHEET_REACH,
              })
            : !hasDayContext
              ? requestParts
              : null;
          if (gatheredParts) {
            gatheredKey = dayContextKey(gatheredParts);
            rememberLastGood(cacheToken, gatheredParts, next, data);
          }
          if (gatheredToday && gatheredParts) {
            nextSheetDay = matchingInherited
              ? { kind: "inherited", value: matchingInherited }
              : { kind: "state", parts: gatheredParts };
          }
          owner.setHost({
            request: effectiveRequest,
            sheetDay: nextSheetDay,
            state: {
              status: "ready",
              data,
              gatheredKey,
              sight: "read",
              asOf: null,
            },
          });
        },
        () => {
          clearTimeout(stallTimer);
          expire();
        }
      );
    },
    [actingProfileId, measurements]
  );

  const visitOwner = useCallback(
    (
      identity: string,
      entryId: number,
      lane: "body" | "intake" = "body"
    ): LoadOwner => {
      const key = `${identity}:${entryId}:${lane}`;
      return {
        setHost: (update) => {
          updateVisit((current) => {
            if (current.identity !== identity) return current;
            return {
              ...current,
              entries: current.entries.map((entry) =>
                entry.id === entryId
                  ? {
                      ...entry,
                      host:
                        typeof update === "function"
                          ? update(entry.host)
                          : update,
                    }
                  : entry
              ),
            };
          });
        },
        current: (token) =>
          visitStateRef.current.identity === identity &&
          visitRequestRefs.current.get(key) === token,
        nextToken: () => {
          const token = (visitRequestRefs.current.get(key) ?? 0) + 1;
          visitRequestRefs.current.set(key, token);
          return token;
        },
      };
    },
    [updateVisit]
  );

  const loadIntakeFor = useCallback(
    (
      identity: string,
      entryId: number,
      subject: number,
      intakeKind: IntakeItemKind,
      activation: number
    ) => {
      const owner = visitOwner(identity, entryId, "intake");
      const token = owner.nextToken();
      const current = () => {
        if (!owner.current(token)) return false;
        const state = visitStateRef.current;
        const entry = state.entries.find((item) => item.id === entryId);
        return (
          entry?.subject === subject &&
          entry.view.kind === "intake" &&
          entry.view.activation === activation &&
          entry.view.intakeKind === intakeKind
        );
      };
      const setContext = (context: QuickEntryIntakeContext) => {
        updateVisit((state) => {
          if (!current()) return state;
          return {
            ...state,
            entries: state.entries.map((entry) =>
              entry.id === entryId && entry.view.kind === "intake"
                ? { ...entry, view: { ...entry.view, context } }
                : entry
            ),
          };
        });
      };
      void loadQuickEntryIntakeContext(subject).then(
        (result: QuickEntryIntakeContextResult) => {
          if (!current()) return;
          if (result.kind === "refused") {
            if (result.reason === "session") void wipeDeviceForSignOut();
            else clearLastGood();
            return;
          }
          setContext({ status: "ready", value: result.context });
        },
        () => setContext({ status: "error" })
      );
    },
    [updateVisit, visitOwner]
  );

  const startVisit = useCallback(
    (identity: string) => {
      if (visitStateRef.current.identity === identity) return;
      invalidateVisitRequests();
      visitRequestRefs.current.clear();
      setOpen(false);
      updateVisit(() => ({
        identity,
        presentation: "visit",
        generation: 0,
        subject: actingProfileId,
        activeId: null,
        entries: [],
        returnFocus: null,
        invalidated: false,
        completable: true,
      }));
    },
    [actingProfileId, invalidateVisitRequests, updateVisit]
  );

  const beginVisitClose = useCallback(() => {
    invalidateVisitRequests();
    updateVisit((current) => ({ ...current, completable: false }));
  }, [invalidateVisitRequests, updateVisit]);

  const openVisitForm = useCallback(
    (
      next: QuickEntryForm,
      trigger: HTMLButtonElement,
      dayContext: DayContextValue | null
    ) => {
      const current = visitStateRef.current;
      const existing = current.entries.find((entry) => entry.form === next);
      if (existing) {
        updateVisit((state) => ({
          ...state,
          activeId: existing.id,
          entries: state.entries.map((entry) =>
            entry.id === existing.id
              ? { ...entry, trigger }
              : entry.id === state.activeId && entry.view.kind === "body"
                ? { ...entry, bodyActivation: entry.bodyActivation + 1 }
                : entry
          ),
          returnFocus: null,
        }));
        return;
      }

      const entryId = ++entrySerial.current;
      const entry: QuickEntrySession = {
        id: entryId,
        form: next,
        prefill: null,
        subject: current.subject,
        pickerOpen: false,
        host: {
          state: { status: "loading" },
          sheetDay: null,
          request: null,
        },
        bodies: loadBodies(0),
        trigger,
        view: { kind: "body" },
        bodyActivation: 0,
        addTriggerRef: { current: null },
        focusReturn: null,
      };
      updateVisit((state) => ({
        ...state,
        activeId: entryId,
        entries: [
          ...state.entries.map((item) =>
            item.id === state.activeId && item.view.kind === "body"
              ? { ...item, bodyActivation: item.bodyActivation + 1 }
              : item
          ),
          entry,
        ],
        returnFocus: null,
      }));
      const owner = visitOwner(current.identity, entryId);
      const token = owner.nextToken();
      loadFor(
        next,
        current.subject,
        token,
        dayContext
          ? { kind: "inherited", value: dayContext }
          : { kind: "dayless" },
        owner
      );
    },
    [loadFor, updateVisit, visitOwner]
  );

  const backVisit = useCallback(() => {
    updateVisit((current) => {
      const active = current.entries.find(
        (entry) => entry.id === current.activeId
      );
      if (active?.view.kind === "intake") {
        const intake = active.view;
        const key = `${current.identity}:${active.id}:intake`;
        visitRequestRefs.current.set(
          key,
          (visitRequestRefs.current.get(key) ?? 0) + 1
        );
        return {
          ...current,
          returnFocus: null,
          entries: current.entries.map((entry) =>
            entry.id === active.id
              ? {
                  ...entry,
                  view: { kind: "body" },
                  bodyActivation: entry.bodyActivation + 1,
                  focusReturn: {
                    activation: intake.activation,
                    bodyActivation: entry.bodyActivation + 1,
                    preferred: intake.trigger,
                  },
                }
              : entry
          ),
        };
      }
      return {
        ...current,
        activeId: null,
        returnFocus: active?.trigger ?? null,
        entries: current.entries.map((entry) =>
          entry.id === active?.id && entry.view.kind === "body"
            ? { ...entry, bodyActivation: entry.bodyActivation + 1 }
            : entry
        ),
      };
    });
  }, [updateVisit]);

  const completeVisitEntry = useCallback(
    (entryId: number) => {
      const current = visitStateRef.current;
      const entry = current.entries.find((item) => item.id === entryId);
      if (current.activeId === entryId) {
        if (!current.completable || entry?.view.kind !== "body") return false;
        invalidateVisitRequests();
        updateVisit((state) => ({ ...state, completable: false }));
        return true;
      }
      if (!current.completable) return false;
      const key = `${current.identity}:${entryId}:body`;
      visitRequestRefs.current.set(
        key,
        (visitRequestRefs.current.get(key) ?? 0) + 1
      );
      updateVisit((state) => ({
        ...state,
        entries: state.entries.filter((entry) => entry.id !== entryId),
      }));
      return false;
    },
    [invalidateVisitRequests, updateVisit]
  );

  const retryVisitEntry = useCallback(
    (entryId: number) => {
      const current = visitStateRef.current;
      const entry = current.entries.find((item) => item.id === entryId);
      if (!entry) return;
      if (entry.view.kind === "intake") {
        const activation = ++intakeActivationSerial.current;
        updateVisit((state) => ({
          ...state,
          entries: state.entries.map((item) =>
            item.id === entryId
              ? {
                  ...item,
                  bodies: loadBodies(item.bodies.attempt + 1),
                  view: {
                    ...entry.view,
                    activation,
                    context: { status: "loading" },
                  },
                }
              : item
          ),
        }));
        loadIntakeFor(
          current.identity,
          entryId,
          entry.subject,
          entry.view.intakeKind,
          activation
        );
        return;
      }
      updateVisit((state) => ({
        ...state,
        entries: state.entries.map((item) =>
          item.id === entryId
            ? { ...item, bodies: loadBodies(item.bodies.attempt + 1) }
            : item
        ),
      }));
      const owner = visitOwner(current.identity, entryId);
      loadFor(
        entry.form,
        entry.subject,
        owner.nextToken(),
        entry.host.request ?? { kind: "dayless" },
        owner
      );
    },
    [loadFor, loadIntakeFor, updateVisit, visitOwner]
  );

  const openIntake = useCallback(
    (
      entryId: number,
      intakeKind: IntakeItemKind,
      trigger: HTMLButtonElement | null
    ) => {
      const current = visitStateRef.current;
      const entry = current.entries.find((item) => item.id === entryId);
      if (!entry || current.activeId !== entryId || entry.form !== "dose")
        return;
      const activation = ++intakeActivationSerial.current;
      updateVisit((state) => ({
        ...state,
        returnFocus: null,
        entries: state.entries.map((item) =>
          item.id === entryId
            ? {
                ...item,
                view: {
                  kind: "intake",
                  intakeKind,
                  activation,
                  trigger,
                  context: { status: "loading" },
                },
                focusReturn: null,
              }
            : item
        ),
      }));
      loadIntakeFor(
        current.identity,
        entryId,
        entry.subject,
        intakeKind,
        activation
      );
    },
    [loadIntakeFor, updateVisit]
  );

  const exitIntake = useCallback(
    (entryId: number) => {
      const current = visitStateRef.current;
      const entry = current.entries.find((item) => item.id === entryId);
      if (!entry || entry.view.kind !== "intake") return;
      const intake = entry.view;
      const key = `${current.identity}:${entryId}:intake`;
      visitRequestRefs.current.set(
        key,
        (visitRequestRefs.current.get(key) ?? 0) + 1
      );
      updateVisit((state) => ({
        ...state,
        returnFocus: null,
        entries: state.entries.map((item) =>
          item.id === entryId
            ? {
                ...item,
                view: { kind: "body" },
                bodyActivation: item.bodyActivation + 1,
                focusReturn: {
                  activation: intake.activation,
                  bodyActivation: item.bodyActivation + 1,
                  preferred: intake.trigger,
                },
              }
            : item
        ),
      }));
    },
    [updateVisit]
  );

  const refreshDose = useCallback(
    (entryId: number, bodyActivation: number) => {
      const current = visitStateRef.current;
      const entry = current.entries.find((item) => item.id === entryId);
      if (
        !entry ||
        entry.form !== "dose" ||
        entry.view.kind !== "body" ||
        entry.bodyActivation !== bodyActivation ||
        current.activeId !== entryId ||
        !current.completable
      )
        return;
      const owner = visitOwner(current.identity, entryId);
      loadFor(
        "dose",
        entry.subject,
        owner.nextToken(),
        entry.host.request ?? { kind: "dayless" },
        owner
      );
    },
    [loadFor, visitOwner]
  );

  const focusDoseReturn = useCallback(
    (entryId: number, activation: number) => {
      const current = visitStateRef.current;
      const entry = current.entries.find((item) => item.id === entryId);
      if (
        !current.completable ||
        current.activeId !== entryId ||
        entry?.view.kind !== "body" ||
        entry.focusReturn?.activation !== activation ||
        entry.focusReturn.bodyActivation !== entry.bodyActivation
      )
        return;
      const target = entry.focusReturn.preferred?.isConnected
        ? entry.focusReturn.preferred
        : entry.addTriggerRef.current;
      if (!target?.isConnected) return;
      target.focus();
      updateVisit((state) => ({
        ...state,
        entries: state.entries.map((item) =>
          item.id === entryId && item.focusReturn?.activation === activation
            ? { ...item, focusReturn: null }
            : item
        ),
      }));
    },
    [updateVisit]
  );

  const acceptIntakeSave = useCallback(
    (entryId: number, activation: number) => {
      let accepted = false;
      let refresh = false;
      updateVisit((current) => {
        const entry = current.entries.find((item) => item.id === entryId);
        if (
          !current.completable ||
          current.activeId !== entryId ||
          entry?.view.kind !== "intake" ||
          entry.view.activation !== activation
        )
          return current;
        const intake = entry.view;
        accepted = true;
        refresh = true;
        return {
          ...current,
          returnFocus: null,
          entries: current.entries.map((item) =>
            item.id === entryId
              ? {
                  ...item,
                  view: { kind: "body" },
                  bodyActivation: item.bodyActivation + 1,
                  focusReturn: {
                    activation: intake.activation,
                    bodyActivation: item.bodyActivation + 1,
                    preferred: intake.trigger,
                  },
                }
              : item
          ),
        };
      });
      if (refresh) {
        const bodyActivation =
          visitStateRef.current.entries.find((item) => item.id === entryId)
            ?.bodyActivation ?? -1;
        queueMicrotask(() => refreshDose(entryId, bodyActivation));
      }
      return accepted;
    },
    [refreshDose, updateVisit]
  );

  const selectVisitDay = useCallback(
    (entryId: number, day: string) => {
      const current = visitStateRef.current;
      const entry = current.entries.find((item) => item.id === entryId);
      if (!entry) return;
      updateVisit((state) => ({
        ...state,
        entries: state.entries.map((item) =>
          item.id === entryId
            ? { ...item, bodyActivation: item.bodyActivation + 1 }
            : item
        ),
      }));
      const owner = visitOwner(current.identity, entryId);
      loadFor(
        entry.form,
        entry.subject,
        owner.nextToken(),
        {
          kind: "selected",
          parts: {
            profileId: entry.subject,
            day,
            reach: SHEET_REACH,
          },
        },
        owner
      );
    },
    [loadFor, updateVisit, visitOwner]
  );

  const toggleVisitSubjectPicker = useCallback(
    (entryId: number) => {
      updateVisit((current) => ({
        ...current,
        entries: current.entries.map((entry) =>
          entry.id === entryId
            ? { ...entry, pickerOpen: !entry.pickerOpen }
            : entry
        ),
      }));
    },
    [updateVisit]
  );

  const selectVisitSubject = useCallback(
    (entryId: number, profileId: number) => {
      const current = visitStateRef.current;
      const previous = current.entries.find((entry) => entry.id === entryId);
      if (!previous) return;
      if (profileId === previous.subject) {
        updateVisit((state) => ({
          ...state,
          entries: state.entries.map((entry) =>
            entry.id === entryId ? { ...entry, pickerOpen: false } : entry
          ),
        }));
        return;
      }

      const identity = current.identity;
      // ONLY THIS ENTRY'S OWN IN-FLIGHT GATHERS (#5624), the way a completion drops
      // one entry's: the visit-wide invalidation this used to run belonged to the
      // whole-visit reset below, and would strand a sibling's load once the sibling
      // survived the switch.
      for (const lane of ["body", "intake"] as const) {
        const key = `${identity}:${entryId}:${lane}`;
        visitRequestRefs.current.set(
          key,
          (visitRequestRefs.current.get(key) ?? 0) + 1
        );
      }
      const nextId = ++entrySerial.current;
      const intake =
        previous.view.kind === "intake"
          ? {
              kind: "intake" as const,
              intakeKind: previous.view.intakeKind,
              activation: ++intakeActivationSerial.current,
              trigger: previous.view.trigger,
              context: { status: "loading" as const },
            }
          : ({ kind: "body" } as const);
      const next: QuickEntrySession = {
        ...previous,
        id: nextId,
        subject: profileId,
        prefill: null,
        pickerOpen: false,
        host: {
          state: { status: "loading" },
          sheetDay: null,
          request: null,
        },
        bodies: loadBodies(0),
        view: intake,
        bodyActivation: 0,
        addTriggerRef: { current: null },
        focusReturn: null,
      };
      // THE SWITCHED ENTRY IS REPLACED IN PLACE, NOT THE VISIT (#5624). Every other
      // form opened in this visit holds a draft of its own, which is the whole point
      // of the stack (#3274, kept by #5616) — so `entries` is mapped, as
      // `openVisitForm` and `retryVisitEntry` map it, rather than rebuilt. Only
      // `subject` (what a form opened next defaults to) and `activeId` (the new
      // entry) genuinely move. `generation` keys every body in the visit, so bumping
      // it remounted the siblings too; the switched form's own body still remounts,
      // because this entry carries a NEW id, which is what discards its staged input.
      updateVisit((state) => ({
        ...state,
        subject: profileId,
        activeId: nextId,
        entries: state.entries.map((entry) =>
          entry.id === entryId ? next : entry
        ),
        returnFocus: null,
      }));
      const owner = visitOwner(identity, nextId);
      loadFor(
        next.form,
        profileId,
        owner.nextToken(),
        { kind: "dayless" },
        owner
      );
      if (intake.kind === "intake") {
        loadIntakeFor(
          identity,
          nextId,
          profileId,
          intake.intakeKind,
          intake.activation
        );
      }
      const name = writableProfiles.find((p) => p.id === profileId)?.name;
      toast(
        name
          ? `Switched — now logging for ${name}.`
          : "Switched who this is for."
      );
    },
    [loadFor, loadIntakeFor, toast, updateVisit, visitOwner, writableProfiles]
  );

  const openForm = useCallback(
    (
      next: QuickEntryForm,
      nextPrefill?: QuickEntryPrefill,
      subjectProfileId?: number,
      dayContext?: DayContextValue | null
    ) => {
      const current = visitStateRef.current;
      const retainedBodies =
        current.presentation === "direct" ? current.entries[0]?.bodies : null;
      invalidateVisitRequests();
      visitRequestRefs.current.clear();
      const entryId = ++entrySerial.current;
      const identity = `direct:${entryId}`;
      const resolvedSubject = subjectProfileId ?? actingProfileId;
      const intakeKind =
        next === "dose" ? nextPrefill?.doseIntakeKind : undefined;
      const intakeView = intakeKind
        ? {
            kind: "intake" as const,
            intakeKind,
            activation: ++intakeActivationSerial.current,
            trigger: null,
            context: { status: "loading" as const },
          }
        : ({ kind: "body" } as const);
      const entry: QuickEntrySession = {
        id: entryId,
        form: next,
        prefill: nextPrefill ?? null,
        subject: resolvedSubject,
        pickerOpen: false,
        host: {
          state: { status: "loading" },
          sheetDay: null,
          request: null,
        },
        // The direct sheet may reopen while BottomSheet is still exiting. Reuse
        // its body types so React keeps the mounted form and the existing held
        // draft through that canceled exit, as the pre-visit host did. A retry
        // already replaces this entry's bodies, so that identity carries forward.
        bodies: retainedBodies ?? loadBodies(0),
        trigger: null,
        view: intakeView,
        bodyActivation: 0,
        addTriggerRef: { current: null },
        focusReturn: null,
      };
      updateVisit(() => ({
        identity,
        presentation: "direct",
        generation: 0,
        subject: resolvedSubject,
        activeId: entryId,
        entries: [entry],
        returnFocus: null,
        invalidated: false,
        completable: true,
      }));
      setOpen(true);
      const owner = visitOwner(identity, entryId);
      loadFor(
        next,
        resolvedSubject,
        owner.nextToken(),
        dayContext
          ? { kind: "inherited", value: dayContext }
          : { kind: "dayless" },
        owner
      );
      if (intakeView.kind === "intake") {
        loadIntakeFor(
          identity,
          entryId,
          resolvedSubject,
          intakeView.intakeKind,
          intakeView.activation
        );
      }
    },
    [
      actingProfileId,
      invalidateVisitRequests,
      loadFor,
      loadIntakeFor,
      updateVisit,
      visitOwner,
    ]
  );

  const api = useMemo<QuickEntryHostApi>(
    () => ({
      open: openForm,
      close,
      noteSlotBoundaries: resume.noteSlotBoundaries,
      actingProfileId,
      writableProfiles,
      resume,
      visit: {
        state: visitState,
        start: startVisit,
        open: openVisitForm,
        back: backVisit,
        beginClose: beginVisitClose,
        invalidate: invalidateVisit,
        complete: completeVisitEntry,
        retry: retryVisitEntry,
        selectDay: selectVisitDay,
        selectSubject: selectVisitSubject,
        toggleSubjectPicker: toggleVisitSubjectPicker,
        openIntake,
        exitIntake,
        acceptIntakeSave,
        refreshDose,
        focusDoseReturn,
      },
    }),
    [
      backVisit,
      actingProfileId,
      beginVisitClose,
      close,
      completeVisitEntry,
      openForm,
      openIntake,
      openVisitForm,
      exitIntake,
      acceptIntakeSave,
      invalidateVisit,
      resume,
      refreshDose,
      focusDoseReturn,
      retryVisitEntry,
      selectVisitDay,
      selectVisitSubject,
      startVisit,
      toggleVisitSubjectPicker,
      visitState,
      writableProfiles,
    ]
  );

  const directEntry =
    visitState.presentation === "direct"
      ? (visitState.entries.find((entry) => entry.id === visitState.activeId) ??
        null)
      : null;
  const sheet = directEntry ? sheetForEntry(directEntry) : null;
  const chip = directEntry ? (
    <QuickEntryTitleAdornment
      session={directEntry}
      writableProfiles={writableProfiles}
      onToggle={() => toggleVisitSubjectPicker(directEntry.id)}
    />
  ) : null;
  const picker = directEntry ? (
    <QuickEntrySubjectPicker
      session={directEntry}
      writableProfiles={writableProfiles}
      onSelect={(profileId) => selectVisitSubject(directEntry.id, profileId)}
    />
  ) : null;

  return (
    <Ctx.Provider value={api}>
      {children}
      {sheet && directEntry && (
        <BottomSheet
          open={open}
          onClose={close}
          title={sheet.title}
          size={sheet.size}
          testId="quick-entry-sheet"
          // A sheet on the phone (where this opens from the quick-log sheet) and
          // a centered card from `md` up, so the palette's future adoption of the
          // same host doesn't need a second presentation.
          presentation="dialog"
          titleAdornment={chip}
          belowTitle={picker}
        >
          {/* EVERY control inside this sheet is the quick-log sheet (#3087). The
              bodies below — the food bar, the measurements form, the dose list, the
              substance row, the practice list — are the SAME components their domain
              pages mount, posting the SAME Server Actions, so the server can only
              tell the sheet from the page if the sheet says so. Declared once here,
              at the region root, rather than on each body. */}
          {/* A NODE for the resume check's draft question, the direct overlay's
              half of what `QuickEntryVisitBodies` is for the visit (#5902).
              `display: contents`, so it generates no box; the callback is inline
              for the same react-hooks/refs reason recorded there. */}
          <div
            className="contents"
            ref={(node) => resume.attachBodies("panel", node)}
          >
            <QuickEntrySessionBody
              form={directEntry.form}
              prefill={directEntry.prefill}
              subject={directEntry.subject}
              view={directEntry.view}
              host={directEntry.host}
              bodies={directEntry.bodies}
              actingProfileId={actingProfileId}
              onDone={() => {
                if (completeVisitEntry(directEntry.id)) close();
              }}
              onRetry={() => retryVisitEntry(directEntry.id)}
              onSelectDay={(day) => selectVisitDay(directEntry.id, day)}
              canAdd={writableProfiles.some(
                (profile) => profile.id === directEntry.subject
              )}
              onOpenIntake={(kind, trigger) =>
                openIntake(directEntry.id, kind, trigger)
              }
              onExitIntake={() => exitIntake(directEntry.id)}
              onIntakeSaved={(activation) =>
                acceptIntakeSave(directEntry.id, activation)
              }
              onRefreshDose={() =>
                refreshDose(directEntry.id, directEntry.bodyActivation)
              }
              addTriggerRef={directEntry.addTriggerRef}
              focusReturn={directEntry.focusReturn}
              onFocusReturn={(activation) =>
                focusDoseReturn(directEntry.id, activation)
              }
            />
          </div>
        </BottomSheet>
      )}
    </Ctx.Provider>
  );
}

function QuickEntrySessionBody({
  form,
  prefill,
  subject,
  view,
  host,
  bodies,
  actingProfileId,
  onDone,
  onRetry,
  onSelectDay,
  canAdd,
  onOpenIntake,
  onExitIntake,
  onIntakeSaved,
  onRefreshDose,
  addTriggerRef,
  focusReturn,
  onFocusReturn,
}: {
  form: QuickEntryForm;
  prefill: QuickEntryPrefill | null;
  subject: number;
  view: QuickEntryView;
  host: HostView;
  bodies: Bodies;
  actingProfileId: number;
  onDone: () => void;
  onRetry: () => void;
  onSelectDay: (day: string) => void;
  canAdd: boolean;
  onOpenIntake: (
    kind: IntakeItemKind,
    trigger: HTMLButtonElement | null
  ) => void;
  onExitIntake: () => void;
  onIntakeSaved: (activation: number) => boolean;
  onRefreshDose: () => void;
  addTriggerRef: { current: HTMLButtonElement | null };
  focusReturn: QuickEntrySession["focusReturn"];
  onFocusReturn: (activation: number) => void;
}) {
  const formatPrefs = useFormatPrefs();
  const liveProfileClocks = useLiveProfileClocks();
  const subjectClock = liveProfileClocks.get(subject);
  const subjectToday = subjectClock?.today;
  const state = useMemo(() => {
    if (!subjectToday) return { status: "error" } as const;
    return host.state.status === "ready"
      ? {
          ...host.state,
          data: withLiveDayLabels(host.state.data, subjectToday, formatPrefs),
        }
      : host.state;
  }, [formatPrefs, host.state, subjectToday]);
  const inheritedDayValue =
    host.sheetDay?.kind === "inherited" && subjectToday
      ? {
          ...host.sheetDay.value,
          today: subjectToday,
          isPrimaryDay: host.sheetDay.value.parts.day === subjectToday,
        }
      : null;
  const subjectProfileId = subject === actingProfileId ? undefined : subject;
  useLayoutEffect(() => {
    if (view.kind === "body" && focusReturn)
      onFocusReturn(focusReturn.activation);
  }, [focusReturn, onFocusReturn, view.kind]);
  const content = (identity: string) => (
    <QuickEntrySessionContent
      identity={identity}
      form={form}
      subject={subject}
      view={view}
      state={state}
      bodies={bodies}
      prefill={prefill}
      onDone={onDone}
      onRetry={onRetry}
      subjectProfileId={subjectProfileId}
      canAdd={canAdd}
      onOpenIntake={onOpenIntake}
      onExitIntake={onExitIntake}
      onIntakeSaved={onIntakeSaved}
      onRefreshDose={onRefreshDose}
      addTriggerRef={addTriggerRef}
      focusReturn={focusReturn}
      onFocusReturn={onFocusReturn}
    />
  );

  return (
    <LoggedViaSurface value="quick-log">
      {subjectClock ? (
        <TimezoneProvider tz={subjectClock.timeZone}>
          {inheritedDayValue ? (
            <DayContextBoundary value={inheritedDayValue}>
              {content(inheritedDayValue.key)}
            </DayContextBoundary>
          ) : host.sheetDay?.kind === "state" ? (
            <DayContextProvider
              profileId={host.sheetDay.parts.profileId}
              today={subjectClock.today}
              reach={SHEET_REACH}
              backing={{ kind: "state", initialDay: host.sheetDay.parts.day }}
              onSelectedDayChange={onSelectDay}
            >
              {view.kind === "body" ? <BoundedDaySwitcher /> : null}
              {content(dayContextKey(host.sheetDay.parts))}
            </DayContextProvider>
          ) : (
            content(`${subject}:unscoped`)
          )}
        </TimezoneProvider>
      ) : (
        <p role="alert" className={QUIET_STATE_CLASS}>
          Couldn&apos;t open that form.
        </p>
      )}
    </LoggedViaSurface>
  );
}

function QuickEntrySessionContent({
  identity,
  form,
  subject,
  view,
  state,
  bodies,
  prefill,
  onDone,
  onRetry,
  subjectProfileId,
  canAdd,
  onOpenIntake,
  onExitIntake,
  onIntakeSaved,
  onRefreshDose,
  addTriggerRef,
  focusReturn,
  onFocusReturn,
}: React.ComponentProps<typeof QuickEntryBody> & {
  identity: string;
  form: QuickEntryForm;
  subject: number;
  view: QuickEntryView;
  canAdd: boolean;
  onOpenIntake: (
    kind: IntakeItemKind,
    trigger: HTMLButtonElement | null
  ) => void;
  onExitIntake: () => void;
  onIntakeSaved: (activation: number) => boolean;
  onRefreshDose: () => void;
  addTriggerRef: { current: HTMLButtonElement | null };
  focusReturn: QuickEntrySession["focusReturn"];
  onFocusReturn: (activation: number) => void;
}) {
  const { IntakeItemForm } = bodies;
  return (
    <>
      <Activity mode={view.kind === "body" ? "visible" : "hidden"}>
        <QuickEntryBodyMount
          identity={identity}
          form={form}
          subject={subject}
          state={state}
          bodies={bodies}
          prefill={prefill}
          onDone={onDone}
          onRetry={onRetry}
          subjectProfileId={subjectProfileId}
          canAdd={canAdd}
          onOpenIntake={onOpenIntake}
          onRefreshDose={onRefreshDose}
          addTriggerRef={addTriggerRef}
          focusReturn={focusReturn}
          onFocusReturn={onFocusReturn}
        />
      </Activity>
      {view.kind === "intake" ? (
        <div data-testid="quick-entry-intake" data-kind={view.intakeKind}>
          {view.context.status === "loading" ? (
            <p data-testid="quick-entry-loading" className={QUIET_STATE_CLASS}>
              Loading…
            </p>
          ) : view.context.status === "error" ? (
            <QuickEntryError onRetry={onRetry} />
          ) : (
            <BodyBoundary key={bodies.attempt} onRetry={onRetry}>
              <Suspense
                fallback={
                  <p
                    data-testid="quick-entry-loading"
                    className={QUIET_STATE_CLASS}
                  >
                    Loading…
                  </p>
                }
              >
                <ActiveProfileProvider profileId={subject}>
                  <IntakeItemForm
                    intakeContext={view.context.value}
                    kind={view.intakeKind}
                    subjectProfileId={subject}
                    autoFocusName
                    onDone={onExitIntake}
                    onSaved={() => onIntakeSaved(view.activation)}
                  />
                </ActiveProfileProvider>
              </Suspense>
            </BodyBoundary>
          )}
        </div>
      ) : null}
    </>
  );
}

export function QuickEntryVisitBodies({
  identity,
  onDone,
}: {
  identity: string;
  onDone: () => void;
}) {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error(
      "QuickEntryVisitBodies must be used within a QuickEntryProvider"
    );
  const { state } = ctx.visit;
  if (state.identity !== identity) return null;
  // `display: contents`, so the wrapper generates no box and the bodies remain the
  // sheet's own children for layout. It exists to be a NODE: the resume check
  // (#5902) asks the dirty-form registry whether this subtree holds unsaved input,
  // and that question needs a root. Nothing else reads it.
  //
  // The mount callback is spelled INLINE because react-hooks/refs treats a bound
  // ref-ish callback as a ref and then reads the sibling bodies' own
  // `addTriggerRef` props as render-time ref access. Re-running it per render costs
  // two assignments to a box nothing renders from.
  const bodies = state.entries.map((entry) => (
    <Activity
      key={`${state.identity}:${state.generation}:${entry.id}`}
      mode={state.activeId === entry.id ? "visible" : "hidden"}
    >
      <QuickEntrySessionBody
        form={entry.form}
        prefill={entry.prefill}
        subject={entry.subject}
        view={entry.view}
        host={entry.host}
        bodies={entry.bodies}
        actingProfileId={ctx.actingProfileId}
        onDone={() => {
          if (ctx.visit.complete(entry.id)) onDone();
        }}
        onRetry={() => ctx.visit.retry(entry.id)}
        onSelectDay={(day) => ctx.visit.selectDay(entry.id, day)}
        canAdd={ctx.writableProfiles.some(
          (profile) => profile.id === entry.subject
        )}
        onOpenIntake={(kind, trigger) =>
          ctx.visit.openIntake(entry.id, kind, trigger)
        }
        onExitIntake={() => ctx.visit.exitIntake(entry.id)}
        onIntakeSaved={(activation) =>
          ctx.visit.acceptIntakeSave(entry.id, activation)
        }
        onRefreshDose={() =>
          ctx.visit.refreshDose(entry.id, entry.bodyActivation)
        }
        addTriggerRef={entry.addTriggerRef}
        focusReturn={entry.focusReturn}
        onFocusReturn={(activation) =>
          ctx.visit.focusDoseReturn(entry.id, activation)
        }
      />
    </Activity>
  ));
  return (
    <div
      className="contents"
      ref={(node) => ctx.resume.attachBodies("visit", node)}
    >
      {bodies}
    </div>
  );
}

function QuickEntryBodyMount({
  identity,
  form,
  subject,
  ...props
}: React.ComponentProps<typeof QuickEntryBody> & {
  identity: string;
  form: QuickEntryForm;
  subject: number;
}) {
  const dayContext = useOptionalDayContext();
  const currentState =
    dayContext &&
    props.state.status === "ready" &&
    props.state.gatheredKey != null &&
    props.state.gatheredKey !== dayContext.key
      ? ({ status: "loading" } as const)
      : props.state;
  const nextForm =
    currentState.status === "ready" ? currentState.data.form : null;
  const [mount, setMount] = useState({
    form: nextForm,
    identity,
    generation: 0,
  });
  if (
    nextForm != null &&
    (mount.form !== nextForm || mount.identity !== identity)
  ) {
    const cause: QuickEntryRemountCause =
      mount.identity === identity ? "payload" : "context";
    setMount({
      form: nextForm,
      identity,
      generation:
        mount.form == null || remounts(mount.form, nextForm, cause)
          ? mount.generation + 1
          : mount.generation,
    });
  }
  return (
    <div
      key={mount.generation}
      data-testid="quick-entry-body"
      data-form={form}
      data-subject-profile-id={subject}
      data-body-sight={
        currentState.status === "ready" ? currentState.sight : undefined
      }
    >
      {currentState.status === "ready" && currentState.asOf ? (
        <p data-testid="quick-entry-asof" className={QUIET_STATE_CLASS}>
          {currentState.asOf}
        </p>
      ) : null}
      <BodyBoundary key={props.bodies.attempt} onRetry={props.onRetry}>
        <Suspense fallback={QUICK_ENTRY_LOADING}>
          <QuickEntryBody {...props} state={currentState} />
        </Suspense>
      </BodyBoundary>
    </div>
  );
}

function QuickEntryBody({
  state,
  prefill,
  onDone,
  onRetry,
  subjectProfileId,
  bodies,
  canAdd,
  onOpenIntake,
  onRefreshDose,
  addTriggerRef,
  focusReturn,
  onFocusReturn,
}: {
  state: LoadState;
  prefill: QuickEntryPrefill | null;
  onDone: () => void;
  // #3416 proposal 3: re-runs the SAME gather in place — the error state's Retry
  // button. Never called from any other branch; a ready form has nothing to retry
  // and a loading one is already trying.
  onRetry: () => void;
  // The chosen subject (#4932), already narrowed to "explicit and non-acting" by
  // the caller — every form below carries it through to its own write(s), gated
  // server-side by `gateItemProfile` (or, for the two forms whose write cannot yet
  // follow a subject — measurements, cycle — `loadFor`/`loadQuickEntry` already
  // turned a non-acting subject into the `unavailable` case above this switch).
  subjectProfileId?: number;
  bodies: Bodies;
  canAdd: boolean;
  onOpenIntake: (
    kind: IntakeItemKind,
    trigger: HTMLButtonElement | null
  ) => void;
  onRefreshDose: () => void;
  addTriggerRef: { current: HTMLButtonElement | null };
  focusReturn: QuickEntrySession["focusReturn"];
  onFocusReturn: (activation: number) => void;
}) {
  const dayContext = useOptionalDayContext();
  const subjectTimeZone = useTimezone();
  if (state.status === "loading") return QUICK_ENTRY_LOADING;
  if (state.status === "error") {
    return <QuickEntryError onRetry={onRetry} />;
  }

  const data = state.data;
  const selectedDay = dayContext?.parts.day;
  const profileToday = dayContext?.today ?? quickEntryToday(data);
  const {
    UploadForm,
    QuickPracticeList,
    QuickCyclePanel,
    MoodForm,
    StoolTypeControl,
    QuickSubstanceList,
    QuickSymptomPanel,
  } = bodies;
  switch (data.form) {
    case "measurements":
      return (
        <MeasurementsQuickAdd
          // The whole field set, spread (#4424 ruling 1): `measurementsQuickEntry`
          // answers "what does this form need on day D" for every surface that mounts
          // it, so the sheet and the record's add door cannot list different props.
          {...data}
          defaultGroup={prefill?.measurementGroup}
          onSaved={onDone}
          // Always undefined in THIS mount: `loadFor` already turned any
          // non-acting subject into the "unavailable" case above this switch, so
          // `data.form === "measurements"` is reached only for the acting
          // profile. Passed anyway, and by the same name every sibling form
          // uses, so the prop never silently reads `data.profileId` (the
          // memory-key field) as a write signal — see MeasurementsQuickAdd's own
          // comment on the two fields.
          subjectProfileId={subjectProfileId}
        />
      );
    case "food":
      // No `onSaved`: the food bar is INCREMENTAL by design — each +/- tap is its
      // own write, so there is no single "saved" moment to close on. The user
      // logs however many servings they mean to and dismisses the sheet. (Its
      // taps already refresh the page behind, so "stay put" still holds.)
      return (
        <FoodProjectionProvider
          today={profileToday ?? data.today}
          days={data.days}
        >
          <FoodLogBar
            today={profileToday ?? data.today}
            days={data.days}
            groupsBySlot={data.groupsBySlot}
            proteinRankBySlot={data.proteinRankBySlot}
            slot={data.slot}
            slotBoundaries={data.slotBoundaries}
            initialFoodGroup={prefill?.foodGroup}
            proteinQuickAdd={
              // Ranked in for a protein-tracking profile (#1980), rendered at the
              // position the one ranking put it in. A profile with no scoop size to
              // re-offer gets no control here — the Food tab remains the complete
              // surface where direct grams are first entered. #4932: also withheld
              // for a chosen non-acting subject — the control has no subject of its
              // own to post (invariant 2), while the serving rows beside it do.
              data.proteinPreset != null && subjectProfileId == null
                ? {
                    initialGramsByDate: {
                      [selectedDay ?? data.today]: data.proteinGrams,
                    },
                    lastPreset: data.proteinPreset,
                  }
                : undefined
            }
            subjectProfileId={subjectProfileId}
            showDayContext={false}
          />
        </FoodProjectionProvider>
      );
    case "dose":
      return (
        // THE GATHERED PAYLOAD IS THE LIST'S SERVER HALF, so it is spread whole
        // rather than re-listed field by field: `others` (#5808) is the third field
        // this mount had to remember, and a forgotten one costs a silently missing
        // section. The two fields below are the ones this host genuinely decides —
        // the subject's zone and the live day — and they override the spread.
        <QuickDoseList
          {...data}
          profileToday={profileToday ?? data.today}
          prn={data.prn ? { ...data.prn, tz: subjectTimeZone } : undefined}
          onDone={onDone}
          subjectProfileId={subjectProfileId}
          selectedDay={selectedDay ?? data.today}
          canAdd={canAdd}
          onAdd={onOpenIntake}
          onPrnLogged={onRefreshDose}
          addFocusRef={addTriggerRef}
          focusReturnActivation={focusReturn?.activation}
          onReturnFocus={onFocusReturn}
        />
      );
    case "cycle":
      // The SAME <PeriodOfferButton> the Cycle page control and the dashboard phase
      // widget render, over the SAME server-resolved cycleControlState — a third
      // RENDERER of one state, never a third implementation. A successful tap closes:
      // start/end/reopen is one transaction with a real end, and #1468's contract is
      // that it lands you back where you were. No subject prop: a non-acting subject
      // never reaches this case (`loadFor` turns it into `unavailable` above).
      //
      // SPREAD WHOLE, for the reason the dose case states: `ttc` (#5810) is the second
      // field this mount would have to remember, and it is present only for a profile
      // that declared a TTC start — a forgotten prop would be a silently missing half
      // for exactly the profile the gate is for.
      return <QuickCyclePanel {...data} onDone={onDone} />;
    case "mood":
      // The SAME MoodValencePicker + logMood write the dashboard card runs, with
      // the shared sheet day above — a second mounting context, never a second
      // write path. A successful tap closes (a check-in is a transaction with an end).
      return (
        <MoodForm
          days={data.days}
          showCalm={data.showCalm}
          dayUnseen={data.dayUnseen}
          onDone={onDone}
          subjectProfileId={subjectProfileId}
        />
      );
    case "practice":
      // No `onSaved`: like the food bar, practice logging has no single "saved"
      // moment — multi-session days are the point and a morning check may log two
      // different practices. The user dismisses when they're done; the taps already
      // refresh the page behind, so "stay put" still holds.
      //
      // `onDone` is threaded anyway for the #3066 ZERO STATE only, where the body is
      // the create form rather than a log list — declaring a first practice IS a
      // transaction with an end. The list branch ignores it. A non-acting subject
      // with an EMPTY list never reaches this case either (`loadFor`'s gather turns
      // it into `unavailable` — the bootstrap create is acting-profile-only).
      return (
        <QuickPracticeList
          practices={data.practices}
          today={selectedDay ?? data.today}
          onDone={onDone}
          subjectProfileId={subjectProfileId}
        />
      );
    case "stool":
      // No `onSaved`: like the food bar and the practice list, stool logging has no
      // single "saved" moment — several movements a day is ordinary and a mis-tap is
      // corrected by tapping again. The tap revalidates behind the sheet, so "stay
      // where you were" still holds.
      return (
        <StoolTypeControl
          todayCount={data.todayCount}
          today={selectedDay ?? data.today}
          subjectProfileId={subjectProfileId}
        />
      );
    case "substance":
      // No `onSaved`: like the food bar and the practice list, substance logging has
      // no single "saved" moment — several uses in an evening is ordinary. The tap
      // revalidates behind the sheet, so "stay where you were" still holds.
      return (
        <QuickSubstanceList
          substances={data.substances}
          date={selectedDay ?? data.today}
          subjectProfileId={subjectProfileId}
        />
      );
    case "symptom":
      // The SAME SymptomLogBar the dashboard's well-day card mounts, over the SAME
      // symptom actions — a fifth mounting context, never a fifth write path. No
      // `onSaved`: a symptom day is a working SET (add one, raise it later, note it,
      // then the illness bridge), so there is no single saved moment to close on. The
      // taps revalidate behind the sheet, so "stay where you were" still holds.
      return (
        <QuickSymptomPanel
          today={selectedDay ?? data.today}
          severities={data.severities}
          notes={data.notes}
          customNames={data.customNames}
          rankedKeys={data.rankedKeys}
          temperatureUnit={data.temperatureUnit}
          timeZone={subjectTimeZone}
          textIntakeEnabled={data.textIntakeEnabled}
          trackingIllness={data.trackingIllness}
          subjectProfileId={subjectProfileId}
        />
      );
    case "document":
      // The SAME UploadForm Data → File upload renders — same ingest engine, same
      // gates, same per-profile storage and dedup, and the #1423 camera input rides
      // along. A successful upload closes the sheet: filing a document is a
      // transaction with a real end, and #1468's contract is that it lands you back
      // on the page you were on. The confirmation toast (with its "Track in Review"
      // action) is posted by the form itself and outlives the sheet.
      return (
        <UploadForm
          demo={data.demo}
          onUploaded={onDone}
          subjectProfileId={subjectProfileId}
        />
      );
    case "unavailable":
      return (
        <p data-testid="quick-entry-unavailable" className={QUIET_STATE_CLASS}>
          {data.message}
        </p>
      );
  }
}
