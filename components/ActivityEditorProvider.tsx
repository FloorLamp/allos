"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useHistoryBackClose } from "./useHistoryBackClose";
import {
  startWorkout,
  discardWorkout,
} from "@/app/(app)/training/activity-actions";
import { trainingActivityPageHref } from "@/lib/hrefs";
import type { UnitPrefs } from "@/lib/settings";
import type { ActivitySuggestions, ExerciseHistoryMap } from "@/lib/queries";
import type { FormDeloadContext } from "@/lib/routines";
import type { FormRecoveringContext } from "@/lib/injuries";
import type { PlateauFormHint } from "@/lib/rule-findings";
import type { Equipment } from "@/lib/types";
import type { WorkoutPresence } from "@/lib/workout-presence";
import { workoutOffer, type WorkoutOffer } from "@/lib/workout-offer";
import ActivityOverlay from "./ActivityOverlay";
import ActivityForm, { type ActivityEditData } from "./ActivityForm";
import WorkoutDock from "./WorkoutDock";
import {
  buildActivityTypePrefill,
  buildRepeatPrefill,
  activityEditDataHasStrength,
  todayStr,
} from "./activity-form/model";
import { useTimezone } from "./TimezoneProvider";
import { resumeContinuation } from "./resume-continuation";
import type { PracticeType } from "@/lib/protocol-practice";

// The training LOG TAB hosts the inline docked editor (TrainingLogView registers a
// dock column), so the app-wide bottom bar is suppressed while that view is mounted —
// the session is already visible in the page column. Everywhere else the minimized
// bar carries it. Mount-based, not route-based (#2893 review): /training now lands on
// Overview by default, and a pathname test would hide the bar on tabs that have no
// dock, stranding a fresh-loaded live session with no resume affordance.

interface ActivityEditorApi {
  openCreate: (prefill?: { type?: PracticeType; date?: string }) => void;
  // Start a LIVE workout (issue #340): opens a fresh create form (date=today,
  // start=now) in the in-gym layout — the rest timer + set check-off flow. A
  //
  // #1893: with a session ALREADY live this RESUMES it (reopens the docked session,
  // epoch untouched) instead of clearing state and re-stamping the start instant. The
  // guard lives here as well as on the affordances so a stale caller cannot stomp an
  // in-progress session either — defence in depth, not a substitute for rendering
  // `workoutOffer`.
  openLive: () => void;
  // Whether live workout mode is available.
  canStartWorkout: boolean;
  // Whether this profile may create workout-oriented activity records at all.
  // Existing records remain editable and an existing live session resumable.
  trainingRelevant: boolean;
  // Strength-specific creation/programming eligibility for the acting profile.
  // Existing strength records remain editable and a running session resumable.
  strengthTrainingAvailable: boolean;
  // The ONE start-vs-resume derivation every workout entry point renders (#1893/#221):
  // the bolt, the palette's live action, the Training Log aside, and the routine card all
  // take their LABEL from here, and the open* calls above enforce the same state. See
  // lib/workout-offer.ts.
  workoutOffer: WorkoutOffer;
  // "Log this session" (#740): open a CREATE form pre-filled with a resolved
  // routine session (the day's slots as exercises + prescribed sets) IN live mode,
  // so a routine day goes straight into the in-gym flow.
  //
  // #1893: guarded exactly like openLive — a running session is resumed, never
  // restarted, so the coaching card cannot discard a workout in progress.
  openSession: (prefill: ActivityEditData) => void;
  openEdit: (data: ActivityEditData) => void;
  // "Log again" / "Repeat last": open a CREATE form pre-filled from a stored
  // activity (title, exercises, sets) with the date reset to today (issue #29).
  openRepeat: (data: ActivityEditData) => void;
  // Repeat the single most recent activity — the palette command / mobile quick
  // action so repeat-last isn't desktop-only (issue #337). No-op when nothing's
  // been logged; `hasLastActivity` gates the affordance.
  openRepeatLast: () => void;
  hasLastActivity: boolean;
  // Not-self subject name (issue #1013): set when the acting profile — which owns
  // every workout logged here — is NOT the login's own profile, so the live editor's
  // action ("Finish workout — Mia") and the dock name whose session it is. Null when
  // acting as self / no own-profile is set. The fastest-tapping surface in the app is
  // exactly where a wrong-profile write happens, so it carries the subject stamp.
  subjectName: string | null;
  close: () => void;
  // Whether an editor is currently open, and what it's editing — so a page can
  // hand the editor a column to dock into and react to it being active.
  open: boolean;
  // Collapsed to the dock bar but still MOUNTED (the rest timer keeps ticking).
  // Exposed so the live panel can drop its screen wake lock while the session is
  // pocketed (#1422) — "open" alone can't express that, and the mount-tied release
  // never fires here by design.
  minimized: boolean;
  editData: ActivityEditData | null;
  // Register a DOM node for the editor to render into inline instead of the
  // overlay. Pass null to unregister. `scope` marks a PAGE dock that only hosts
  // edits of that one activity (the activity detail page); omit it for a
  // general column that hosts any create/edit (the training log).
  registerDock: (el: HTMLElement | null, scope?: number | null) => void;
}

const Ctx = createContext<ActivityEditorApi | null>(null);

export function useActivityEditor(): ActivityEditorApi {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error(
      "useActivityEditor must be used within ActivityEditorProvider"
    );
  return ctx;
}

export default function ActivityEditorProvider({
  units,
  suggestions,
  history,
  equipment,
  recentActivityEquipment = [],
  bodyweightKg,
  trainingRelevant,
  strengthTrainingAvailable,
  lastActivity = null,
  deloadContext,
  recoveringContext = { temperedRegions: [], constraints: [] },
  plateauHints = [],
  presence,
  liveEditData = null,
  liveStartEpochMs = null,
  subjectName = null,
  children,
}: {
  units: UnitPrefs;
  suggestions: ActivitySuggestions;
  history: ExerciseHistoryMap;
  equipment: Equipment[];
  // Recently-used session gear, most-recent-first (issues #342/#339) — defaults the
  // form's activity-level equipment picker, narrowed per-activity by the form.
  recentActivityEquipment?: number[];
  bodyweightKg: number | null;
  trainingRelevant: boolean;
  strengthTrainingAvailable: boolean;
  // The single most recent activity (issue #337), seeding the "Repeat last
  // activity" palette command / mobile quick action. null when nothing's logged.
  lastActivity?: ActivityEditData | null;
  // Deload/plateau inputs for the strength editor (#923): whether the active routine
  // is in its deload week (+ which lifts to shave), and the active plateau hints.
  deloadContext: FormDeloadContext;
  // The recovering-injury regions the form tempers by (#1144), gathered server-side from
  // the SAME temperedRegions the Analyze/detail panel reads — so the live logger and its
  // deep-link target agree on the injury axis (#221/#1115).
  recoveringContext?: FormRecoveringContext;
  plateauHints?: PlateauFormHint[];
  // Derived workout presence for the acting profile (#921), gathered server-side —
  // the source that HYDRATES the minimized dock on a fresh load / another device, so
  // an in-progress session is never invisible after a reload.
  presence?: WorkoutPresence;
  // The active session's editor data, for reopening the live editor from the dock.
  liveEditData?: ActivityEditData | null;
  // The active session's start instant (epoch ms), so the dock ticks elapsed off the
  // real start after a reload (client rest-timer state is honestly lost there).
  liveStartEpochMs?: number | null;
  // The acting profile's not-self subject name (issue #1013): the disambiguated name
  // when the acting profile isn't the login's own, else null. Resolved server-side
  // (writeSubjectName) and surfaced on the live editor + dock.
  subjectName?: string | null;
  children: React.ReactNode;
}) {
  const tz = useTimezone();
  const [mountedAt] = useState(Date.now);
  const [open, setOpen] = useState(false);
  // Minimized-but-MOUNTED: the live overlay collapses to the bottom bar without
  // unmounting ActivityForm, so the running rest timer + elapsed clock survive
  // (unmounting would silently kill them — the #921 regression this fixes). The form
  // stays mounted (rendered hidden); the bar is the affordance to restore it.
  const [minimized, setMinimized] = useState(false);
  // The mounted live session's start instant (epoch ms) for the minimized bar.
  const [liveStartEpoch, setLiveStartEpoch] = useState<number | null>(null);
  const [editData, setEditData] = useState<ActivityEditData | null>(null);
  // Whether the currently-open editor is in live workout mode (issue #340).
  const [live, setLive] = useState(false);
  // Repeat-last prefill: seeds a create form. Bumped `repeatNonce` forces a fresh
  // remount so tapping "Log again" twice on the same source re-seeds cleanly.
  const [prefill, setPrefill] = useState<ActivityEditData | null>(null);
  const [createDate, setCreateDate] = useState<string | null>(null);
  const [repeatNonce, setRepeatNonce] = useState(0);
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  // Whether the currently-open editor should render into the dock. Captured
  // when the editor opens (from whether a dock existed then) and held for that
  // session, so a dock that registers mid-edit can't yank an open overlay
  // editor into it — which would re-parent the form to a new portal, remounting
  // it back to a blank state and dropping the user's unfinished input. This
  // happens on the training log page's 0→1-activities transition: with no activities
  // the page shows an empty state (no dock), so "Log activity" opens the
  // overlay; the first auto-save's server re-render mounts TrainingLogView, which
  // registers the dock. A ref mirrors it so open* can read the live dock
  // presence without taking dockEl as a dependency (which would churn the
  // memoized api on every dock registration).
  const [docked, setDocked] = useState(false);
  const dockElRef = useRef<HTMLElement | null>(null);
  // What the dock is FOR (#2870 step 2 review): null = a general dock (the
  // training log's column hosts any create/edit), an activity id = a page dock
  // that only hosts edits of that record — global openers (palette create,
  // repeat-last, a live resume) must not portal an unrelated form under it.
  const dockScopeRef = useRef<number | null>(null);
  // Mirror of `docked` so registerDock's unregister can tell whether the dock
  // is actually hosting the open editor without taking state as a dependency.
  const dockedRef = useRef(false);
  const updateDocked = useCallback((v: boolean) => {
    dockedRef.current = v;
    setDocked(v);
  }, []);
  const router = useRouter();

  const registerDock = useCallback(
    (el: HTMLElement | null, scope: number | null = null) => {
      dockElRef.current = el;
      dockScopeRef.current = el ? scope : null;
      setDockEl(el);
      // The dock is going away (navigating off its page, or a breakpoint
      // crossing). Close the editor IT IS HOSTING rather than letting it pop
      // back as an overlay on the next page; the docked ActivityForm flushes
      // any pending auto-save on unmount. An editor the dock never hosted —
      // the overlay, a minimized live session with its running clock — is none
      // of the dock's business and survives the unregister.
      if (!el && dockedRef.current) {
        updateDocked(false);
        setOpen(false);
      }
    },
    [updateDocked]
  );

  // Resume the acting profile's active session in the live editor from the dock —
  // hydrated from the persisted #451 draft (getActivityEditData). Docks into the
  // training log column when one is present, else the overlay. The elapsed baseline comes
  // from the SERVER's recorded start (`liveStartEpochMs`), never a fresh Date.now(),
  // so a reload mid-workout resumes the same clock.
  const resumeLive = useCallback(() => {
    if (!liveEditData) return;
    setEditData(liveEditData);
    setPrefill(null);
    setLive(true);
    setLiveStartEpoch(liveStartEpochMs ?? Date.now());
    setMinimized(false);
    // Live NEVER docks (#2870 step 3) — resume included. It used to borrow the
    // log column when one was present, but the resume now navigates to the
    // session's page, and a docked form dies with the dock it borrowed (the
    // log unmounts on that very navigation, and its unregister closes whatever
    // it hosts). The overlay is navigation-proof and reads as its own screen.
    updateDocked(false);
    setOpen(true);
    // One URL (#2870 step 3): resuming also stands the tab on the session's
    // canonical page, so minimizing reveals the record-in-progress and
    // finishing settles where the reader already is. scroll: false on every
    // live navigation — the page beneath an overlay must not steal focus from
    // the open form (Next's focus-and-scroll reset would blur it, closing an
    // open combobox mid-pick).
    router.push(trainingActivityPageHref(liveEditData.id), { scroll: false });
  }, [liveEditData, liveStartEpochMs, updateDocked, router]);

  // CREATE-AT-START (#2870 step 3). Starting a session opens the live editor
  // IMMEDIATELY (rowless, exactly the pre-step shape — nothing may stand
  // between the tap and the form) while the row-create runs alongside. When it
  // returns, the form ADOPTS the created id through the autosave's own
  // created-row channel — no re-key, no remount, nothing typed in the gap can
  // be lost — so every save UPDATEs the row. Navigation to the session's
  // canonical page is driven by ROW OWNERSHIP, not by the create's timing: the
  // form reports the first row it owns (adopted, or minted by its own first
  // save on a dead connection), and THAT is when the tab moves to the page —
  // so a slow round-trip still converges on one URL, and a gym dead spot
  // degrades to exactly the pre-step session whose page appears at first save.
  // A create that returns after the form already owns a DIFFERENT row (or
  // after the session was replaced) is discarded — never a husk beside the
  // form's own row.
  const [liveRowId, setLiveRowId] = useState<number | null>(null);
  const liveSessionSeqRef = useRef(0);
  const liveOwnedRowIdRef = useRef<number | null>(null);
  const onLiveRowOwned = useCallback(
    (id: number) => {
      liveOwnedRowIdRef.current = id;
      // One URL: the session has a page now — stand the tab on it. scroll:
      // false — the page beneath an overlay must not steal focus from the open
      // form (Next's focus-and-scroll reset would blur it, closing an open
      // combobox mid-pick).
      router.push(trainingActivityPageHref(id), { scroll: false });
    },
    [router]
  );
  // Closing a live session that never logged anything abandons its
  // create-at-start row: discard IF EMPTY (server-checked — a just-flushed set
  // keeps the row, and the form's close path flushes before onClose runs).
  // Without this, the empty draft keeps presence "active" for 90 minutes and
  // the resume bar haunts every page offering a session with nothing in it.
  const abandonEmptyLiveRow = useCallback(() => {
    if (!live) return;
    // The session is over: invalidate any still-in-flight create so it
    // discards itself instead of stranding an orphan row nobody adopted.
    liveSessionSeqRef.current++;
    const id = liveOwnedRowIdRef.current ?? editData?.id ?? null;
    if (id == null) return;
    const fd = new FormData();
    fd.set("activity_id", String(id));
    fd.set("if_empty", "1");
    void discardWorkout(fd)
      .then((out) => {
        if (out.kind !== "discarded") return;
        // The page beneath may BE the discarded row's — don't strand the
        // reader on a just-deleted activity; the hub is where they started.
        if (window.location.pathname === `/training/activity/${id}`)
          router.replace(trainingRelevant ? "/training" : "/timeline");
      })
      .catch(() => {});
  }, [live, editData, router, trainingRelevant]);

  const leaveDeletedActivityPage = useCallback(
    (id: number) => {
      if (window.location.pathname === `/training/activity/${id}`)
        router.replace(trainingRelevant ? "/training" : "/timeline");
    },
    [router, trainingRelevant]
  );

  const startLiveSession = useCallback(
    (
      kind: { type: "strength" | "cardio"; title: string },
      prefillData: ActivityEditData | null
    ) => {
      setCreateDate(null);
      setEditData(null);
      setPrefill(prefillData);
      setLive(true);
      setLiveRowId(null);
      liveOwnedRowIdRef.current = null;
      const seq = ++liveSessionSeqRef.current;
      setLiveStartEpoch(Date.now());
      setMinimized(false);
      if (prefillData) setRepeatNonce((n) => n + 1);
      // Live mode is a focused, full-attention flow — never dock it; the
      // overlay reads as its own screen over whatever page is beneath.
      updateDocked(false);
      setOpen(true);

      const fd = new FormData();
      fd.set("type", kind.type);
      fd.set("title", kind.title);
      void startWorkout(fd)
        .catch(() => null)
        .then((res) => {
          if (!res || !res.ok) return;
          const replaced = liveSessionSeqRef.current !== seq;
          const owned = liveOwnedRowIdRef.current;
          if (replaced || (owned != null && owned !== res.id)) {
            const fd2 = new FormData();
            fd2.set("activity_id", String(res.id));
            void discardWorkout(fd2).catch(() => {});
            return;
          }
          setLiveRowId(res.id);
        });
    },
    [updateDocked]
  );

  // REOPEN WHAT THE DEPLOY CLOSED (#2471). The tab reloaded ITSELF to take a new
  // build, so the editor that was on screen a second ago is gone with the document —
  // and unlike a user's own refresh, nobody asked for that. The one-shot marker
  // written just before the reload names what to bring back; `useFormDraft` then
  // applies the draft into it without a banner, because the tap that would have
  // applied it already happened (see components/resume-continuation.ts).
  //
  // WHAT THIS DELIBERATELY DOES NOT DO. A marker naming a STORED row is consumed but
  // not acted on here: this provider holds the live session's edit data and nothing
  // else, so reopening an arbitrary activity would need a fetch it has no business
  // making. That row's draft is untouched and still offered the moment the user opens
  // it — the pre-#2471 behaviour, which is the honest fallback for a case that cannot
  // be proven safe rather than a silent partial reopen.
  const reopenedRef = useRef(false);
  useEffect(() => {
    if (reopenedRef.current) return;
    const marker = resumeContinuation();
    if (!marker || marker.formKey !== "activity") return;
    reopenedRef.current = true;
    // A stored row this provider has no edit data for cannot be reopened here — but
    // a LIVE session always can, whatever its row id, because presence supplies it.
    if (!marker.live && marker.recordId != null) return;
    if (marker.live && marker.recordId != null && !liveEditData) return;
    // Reopening is a response to state this document booted with, not a render this
    // one derives — queue it with the other post-commit work rather than cascading a
    // second render straight out of the effect body.
    queueMicrotask(() => {
      if (!marker.live) {
        setEditData(null);
        setCreateDate(null);
        setPrefill(null);
        setLive(false);
        setLiveStartEpoch(null);
        setMinimized(false);
        updateDocked(dockElRef.current != null && dockScopeRef.current == null);
        setOpen(true);
        return;
      }
      // Live mode rides its existing rails: presence still decides that a session
      // exists, and the marker only spares the user the "Resume workout" tap.
      if (liveEditData) {
        resumeLive();
        return;
      }
      // A live session the deploy caught before its first save has no server row to
      // resume from — the create form in live mode IS the session, and its draft is
      // the whole of it.
      setEditData(null);
      setCreateDate(null);
      setPrefill(null);
      setLive(true);
      setLiveStartEpoch(Date.now());
      setMinimized(false);
      updateDocked(false);
      setOpen(true);
    });
  }, [liveEditData, resumeLive, updateDocked]);

  // A fresh-load active session: nothing is mounted in this client, but the
  // server-hydrated #921 presence says one is running and its draft is reopenable.
  const hydrationActive =
    !open && presence?.state === "active" && liveEditData != null;

  // THE start-vs-resume offer (#1893), derived once from the two facts the provider
  // already holds and handed to every entry point through the context. `open && live`
  // is the mounted case — minimizing sets `minimized` but keeps `open` true and the
  // form MOUNTED, which is exactly why a "Start workout" tap could stomp it.
  const offer = useMemo(
    () => workoutOffer({ mounted: open && live, hydrated: hydrationActive }),
    [open, live, hydrationActive]
  );

  // Perform the resume the offer describes. Mounted: un-hide the still-running form,
  // leaving `liveStartEpoch` ALONE — that epoch is what the dock's elapsed timer ticks
  // off, so re-stamping it is the corruption. Hydrated: reopen from the persisted draft
  // at the server's recorded start.
  const resumeOffer = useCallback(() => {
    if (offer.kind !== "resume") return;
    if (offer.from === "mounted") {
      setMinimized(false);
      setOpen(true);
      // One URL (#2870 step 3): a mounted resume also returns to the session's
      // page when its row exists (a rowless-fallback session has none — it
      // just un-hides where it stands).
      const rowId = editData?.id ?? liveRowId;
      if (rowId)
        router.push(trainingActivityPageHref(rowId), { scroll: false });
      return;
    }
    resumeLive();
  }, [offer, resumeLive, editData, liveRowId, router]);

  // Memoized so always-mounted consumers (e.g. MobileNav's quick-log button)
  // only re-render when open/editData actually change — not on every provider
  // render (dock registration churns on training log mount/unmount). `offer` is a
  // dependency ON PURPOSE: the bolt's label must flip the moment a session goes live.
  const api: ActivityEditorApi = useMemo(
    () => ({
      openCreate: (createPrefill) => {
        if (!trainingRelevant) return;
        if (createPrefill?.type === "strength" && !strengthTrainingAvailable)
          return;
        setEditData(null);
        setCreateDate(createPrefill?.date ?? null);
        setPrefill(
          createPrefill?.type
            ? buildActivityTypePrefill(createPrefill.type, todayStr(tz))
            : null
        );
        setLive(false);
        setLiveStartEpoch(null);
        setMinimized(false);
        if (createPrefill?.type || createPrefill?.date)
          setRepeatNonce((n) => n + 1);
        // A create form docks only into a GENERAL dock — a page dock is scoped
        // to its own record's edits (see registerDock), so a palette "New
        // activity" on the activity page opens the overlay, visible where the
        // tap happened, not portaled under an unrelated record.
        updateDocked(dockElRef.current != null && dockScopeRef.current == null);
        setOpen(true);
      },
      openLive: () => {
        // A session is already running (#1893): reopen it. Never clear the editor and
        // never re-stamp liveStartEpoch — that would silently reset the running
        // session's clock and drop its in-flight sets.
        if (offer.kind === "resume") {
          resumeOffer();
          return;
        }
        if (!trainingRelevant || !strengthTrainingAvailable) return;
        startLiveSession({ type: "strength", title: "" }, null);
      },
      canStartWorkout:
        (trainingRelevant && strengthTrainingAvailable) ||
        offer.kind === "resume",
      trainingRelevant,
      strengthTrainingAvailable,
      workoutOffer: offer,
      openSession: (prefillData) => {
        // Same guard as openLive (#1893): the routine card's "Log this session" must
        // not discard a workout already in progress. The running session wins; the
        // routine slate is still one tap away once it is finished.
        if (offer.kind === "resume") {
          resumeOffer();
          return;
        }
        if (!trainingRelevant) return;
        if (prefillData.type !== "cardio" && !strengthTrainingAvailable) return;
        startLiveSession(
          {
            type: prefillData.type === "cardio" ? "cardio" : "strength",
            title: prefillData.title,
          },
          prefillData
        );
      },
      openEdit: (data) => {
        setEditData(data);
        setCreateDate(null);
        setPrefill(null);
        setLive(false);
        setLiveStartEpoch(null);
        setMinimized(false);
        // A general dock hosts any edit; a scoped page dock only its own record.
        updateDocked(
          dockElRef.current != null &&
            (dockScopeRef.current == null || dockScopeRef.current === data.id)
        );
        setOpen(true);
      },
      openRepeat: (data) => {
        if (!trainingRelevant) return;
        if (activityEditDataHasStrength(data) && !strengthTrainingAvailable)
          return;
        setEditData(null);
        setCreateDate(null);
        setPrefill(buildRepeatPrefill(data, todayStr(tz)));
        setLive(false);
        setLiveStartEpoch(null);
        setMinimized(false);
        setRepeatNonce((n) => n + 1);
        updateDocked(dockElRef.current != null && dockScopeRef.current == null);
        setOpen(true);
      },
      openRepeatLast: () => {
        if (!trainingRelevant || !lastActivity) return;
        if (
          activityEditDataHasStrength(lastActivity) &&
          !strengthTrainingAvailable
        )
          return;
        setEditData(null);
        setCreateDate(null);
        setPrefill(buildRepeatPrefill(lastActivity, todayStr(tz)));
        setLive(false);
        setLiveStartEpoch(null);
        setMinimized(false);
        setRepeatNonce((n) => n + 1);
        updateDocked(dockElRef.current != null && dockScopeRef.current == null);
        setOpen(true);
      },
      hasLastActivity:
        trainingRelevant &&
        lastActivity != null &&
        (strengthTrainingAvailable ||
          !activityEditDataHasStrength(lastActivity)),
      subjectName,
      close: () => {
        setMinimized(false);
        setOpen(false);
        abandonEmptyLiveRow();
      },
      open,
      minimized,
      editData,
      registerDock,
    }),
    [
      open,
      minimized,
      editData,
      registerDock,
      tz,
      lastActivity,
      trainingRelevant,
      strengthTrainingAvailable,
      subjectName,
      offer,
      resumeOffer,
      startLiveSession,
      abandonEmptyLiveRow,
      updateDocked,
    ]
  );

  // Collapse the live overlay to the bar WITHOUT unmounting the form.
  const minimizeLive = useCallback(() => setMinimized(true), []);

  // The editor renders into the dock only when it was opened with one present
  // (see `docked`) and that dock is still mounted; otherwise it's the overlay.
  const showDock = docked && dockEl != null;

  // The bar shows for a client-minimized live session (mounted, hidden) and
  // for a fresh-load active session — EVERYWHERE, the Log tab included
  // (#2897): the old Log-view suppression existed because a live session used
  // to dock inline in that page's column; live never docks now (#2870 step 3),
  // so the bar is the one resume affordance every page shares. A docked-open
  // editor never shows the bar.
  const showBar = (minimized && !showDock) || hydrationActive;
  // Elapsed baseline + copy for the bar: the mounted session's own start when
  // minimized, else the server-hydrated start.
  const barStartEpoch = minimized
    ? (liveStartEpoch ?? liveStartEpochMs ?? mountedAt)
    : (liveStartEpochMs ?? mountedAt);
  const barLabel =
    (minimized ? editData?.title : null) || presence?.title || "Resume";

  // On mobile the overlay reads as its own page (full-screen below sm), so hold
  // a history entry while it's open: the phone's back button/gesture closes the
  // form instead of leaving the page. From sm up — and for the docked editor —
  // history is left alone. This lives on the provider (mounted once, keyed to
  // `open`) rather than ActivityOverlay: a mount-tied effect would push/pop on
  // StrictMode's dev double-mount.
  useHistoryBackClose(
    open && !showDock,
    () => setOpen(false),
    () => !window.matchMedia("(min-width: 640px)").matches
  );

  // Remount fresh each time so state initializes from editData/prefill. The
  // nonce keeps repeated "Log again" taps from reusing a stale mount.
  const formKey = editData
    ? `edit-${editData.id}`
    : prefill
      ? `repeat-${repeatNonce}`
      : live
        ? "live"
        : createDate
          ? `create-${repeatNonce}`
          : "create";

  return (
    <Ctx.Provider value={api}>
      {children}
      {open &&
        (showDock ? (
          createPortal(
            <ActivityForm
              key={formKey}
              units={units}
              suggestions={suggestions}
              history={history}
              equipment={equipment}
              recentActivityEquipment={recentActivityEquipment}
              bodyweightKg={bodyweightKg}
              strengthTrainingAvailable={strengthTrainingAvailable}
              editData={editData}
              prefill={prefill}
              initialDate={createDate ?? undefined}
              live={live}
              adoptRowId={live ? liveRowId : null}
              onRowOwned={live ? onLiveRowOwned : undefined}
              deloadContext={deloadContext}
              recoveringContext={recoveringContext}
              plateauHints={plateauHints}
              onClose={() => setOpen(false)}
              onDeleted={leaveDeletedActivityPage}
            />,
            dockEl
          )
        ) : (
          <ActivityOverlay
            key={formKey}
            units={units}
            suggestions={suggestions}
            history={history}
            equipment={equipment}
            recentActivityEquipment={recentActivityEquipment}
            bodyweightKg={bodyweightKg}
            strengthTrainingAvailable={strengthTrainingAvailable}
            editData={editData}
            prefill={prefill}
            initialDate={createDate ?? undefined}
            live={live}
            adoptRowId={live ? liveRowId : null}
            onRowOwned={live ? onLiveRowOwned : undefined}
            deloadContext={deloadContext}
            recoveringContext={recoveringContext}
            plateauHints={plateauHints}
            // While minimized the overlay stays MOUNTED but hidden — the running
            // rest timer + elapsed clock keep ticking; the bar restores it.
            hidden={minimized}
            // A live session gets the explicit minimize chevron (collapse without
            // unmounting). The backdrop/Done still fully close; a still-active
            // session then re-hydrates the bar from presence, so it's never lost.
            onMinimize={live ? minimizeLive : undefined}
            onClose={() => {
              setMinimized(false);
              setOpen(false);
              abandonEmptyLiveRow();
            }}
            onDeleted={leaveDeletedActivityPage}
          />
        ))}
      {/* Spacer so the fixed bottom bar never overlaps the last of the page
          content — the layout "gains bottom padding while the dock is present". */}
      {showBar && <div className="h-20 shrink-0" aria-hidden="true" />}
      {showBar && (
        <WorkoutDock
          label={barLabel}
          startEpochMs={barStartEpoch}
          live={minimized ? live : true}
          stale={presence?.stale ?? false}
          ownerName={subjectName}
          onOpen={
            minimized
              ? () => {
                  setMinimized(false);
                  // One URL (#2870 step 3): un-pocketing also returns to the
                  // session's page when its row exists (a rowless-fallback
                  // session has no page yet — it just un-hides in place).
                  const rowId = editData?.id ?? (live ? liveRowId : null);
                  if (rowId)
                    router.push(trainingActivityPageHref(rowId), {
                      scroll: false,
                    });
                }
              : resumeLive
          }
        />
      )}
    </Ctx.Provider>
  );
}

// The dock-host discipline, owned here so every host obeys it once instead of
// re-deriving it (#2870 step 2 review; #2897 plans a third host). Register only
// a REAL dock: passing null means "the dock went away" and closes a docked
// editor, so registering during first paint — where the media query hasn't
// settled and `wide` still holds its false initial — would force-close an
// editor that survived navigation as the overlay. `scope` marks a page dock
// that only hosts edits of that one record; omit it for a general column (the
// training log). Returns the ref the host renders as the dock element, plus the
// settled match for the host's own layout decisions.
export function useEditorDock(query: string, scope?: number) {
  const { registerDock } = useActivityEditor();
  const dockRef = useRef<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  useEffect(() => {
    if (!wide) return;
    registerDock(dockRef.current, scope ?? null);
    return () => registerDock(null);
  }, [registerDock, wide, scope]);
  return { dockRef, wide };
}
