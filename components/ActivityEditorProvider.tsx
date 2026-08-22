"use client";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { useHistoryBackClose } from "./useHistoryBackClose";
import {
  startWorkout,
  discardWorkout,
} from "@/app/(app)/training/activity-actions";
import { trainingActivityPageHref } from "@/lib/hrefs";
import type { AppRoute } from "@/lib/hrefs";
import type { UnitPrefs } from "@/lib/settings";
import type { ActivitySuggestions, ExerciseHistoryMap } from "@/lib/queries";
import type { FormDeloadContext } from "@/lib/routines";
import type { FormRecoveringContext } from "@/lib/injuries";
import type { PlateauFormHint } from "@/lib/rule-findings";
import type { RpeTracking } from "@/lib/rpe";
import type { Equipment } from "@/lib/types";
import type { WorkoutPresence } from "@/lib/workout-presence";
import { workoutOffer, type WorkoutOffer } from "@/lib/workout-offer";
import ActivityOverlay from "./ActivityOverlay";
import type { ActivityEditData } from "./ActivityForm";
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

// This provider owns the activity workspace everywhere. Pages open it but never
// re-parent it into page-specific chrome, so create, edit, repeat, and live sessions
// keep one presentation and one lifecycle.

interface ActivityEditorApi {
  openCreate: (prefill?: { type?: PracticeType; date?: string }) => void;
  // Start a LIVE workout (issue #340): opens a fresh create form (date=today,
  // start=now) in the in-gym layout — the rest timer + set check-off flow. A
  //
  // #1893: with a session ALREADY live this RESUMES it (reopens the workspace,
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
  leaveFor: (href: AppRoute) => Promise<void>;
  // Whether an editor is currently open, and what it's editing.
  open: boolean;
  // Collapsed to the dock bar but still MOUNTED (the rest timer keeps ticking).
  // Exposed so the live panel can drop its screen wake lock while the session is
  // pocketed (#1422) — "open" alone can't express that, and the mount-tied release
  // never fires here by design.
  minimized: boolean;
  editData: ActivityEditData | null;
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
  rpeTracking = null,
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
  // The profile's opted-into RPE scale, or null (#3335) — see lib/rpe-tracking.ts.
  rpeTracking?: RpeTracking | null;
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
  const [dismissedPresenceId, setDismissedPresenceId] = useState<number | null>(
    null
  );
  // Whether the currently-open editor is in live workout mode (issue #340).
  const [live, setLive] = useState(false);
  // Repeat-last prefill: seeds a create form. Bumped `repeatNonce` forces a fresh
  // remount so tapping "Log again" twice on the same source re-seeds cleanly.
  const [prefill, setPrefill] = useState<ActivityEditData | null>(null);
  const [createDate, setCreateDate] = useState<string | null>(null);
  // Which surface started this workout (#3087): the provider is mounted in the app
  // shell, so a start from the quick-log sheet and one from a page differ only here.
  const stampLoggedVia = useLoggedViaStamp();
  const [repeatNonce, setRepeatNonce] = useState(0);
  const router = useRouter();
  const requestCloseRef = useRef<
    ((beforeClose?: () => void) => Promise<boolean>) | null
  >(null);
  const markEditorLinkFollowedRef = useRef<() => void>(() => {});
  const [liveRowId, setLiveRowId] = useState<number | null>(null);
  // THE IN-FLIGHT HALF OF CREATE-AT-START (#3441). `liveRowId` says which row the
  // session owns; this says the question is still open — the POST that mints it has
  // gone out and not answered. The form's autosave reads it and defers a rowless
  // save rather than inserting a row of its own, which is what turned one live
  // session into two activities. Owned HERE, beside the create it describes, because
  // this is the only place that knows the request exists: every entry point
  // (`openLive`, `openSession`, and so every caller of either) reaches the create
  // through `startLiveSession`, so there is one seam to hold, not one per caller.
  const [liveCreatePending, setLiveCreatePending] = useState(false);
  const liveSessionSeqRef = useRef(0);
  const liveOwnedRowIdRef = useRef<number | null>(null);
  // Finish changes the editor out of live PRESENTATION before the finished form
  // closes. Keep cleanup eligibility as separate session provenance so an empty
  // create-at-start row is still discarded after recap Save -> Done.
  const liveCleanupPendingRef = useRef(false);

  const leaveFor = useCallback(
    async (href: AppRoute) => {
      if (live) {
        markEditorLinkFollowedRef.current();
        setMinimized(true);
        router.push(href);
        return;
      }
      const closed = requestCloseRef.current
        ? await requestCloseRef.current(() =>
            markEditorLinkFollowedRef.current()
          )
        : true;
      if (!closed) return;
      if (!requestCloseRef.current) {
        markEditorLinkFollowedRef.current();
        setOpen(false);
      }
      router.push(href);
    },
    [live, router]
  );

  // Resume the acting profile's active session in the shared activity workspace.
  // The elapsed baseline comes
  // from the SERVER's recorded start (`liveStartEpochMs`), never a fresh Date.now(),
  // so a reload mid-workout resumes the same clock.
  const resumeLive = useCallback(() => {
    if (!liveEditData) return;
    liveCleanupPendingRef.current = true;
    liveOwnedRowIdRef.current = liveEditData.id;
    setEditData(liveEditData);
    setPrefill(null);
    setLive(true);
    setLiveStartEpoch(liveStartEpochMs ?? Date.now());
    setMinimized(false);
    setOpen(true);
  }, [liveEditData, liveStartEpochMs]);

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
    if (!liveCleanupPendingRef.current) return;
    liveCleanupPendingRef.current = false;
    // The session is over: invalidate any still-in-flight create so it
    // discards itself instead of stranding an orphan row nobody adopted.
    liveSessionSeqRef.current++;
    // …and release the form's create gate with it (#3441): after this the create
    // can never be adopted, so waiting for it would only hold back the close-path
    // flush that carries the last edit.
    setLiveCreatePending(false);
    const id = liveOwnedRowIdRef.current ?? editData?.id ?? null;
    liveOwnedRowIdRef.current = null;
    if (id == null) return;
    const fd = new FormData();
    fd.set("activity_id", String(id));
    fd.set("if_empty", "1");
    void discardWorkout(fd)
      .then((out) => {
        if (out.kind !== "discarded") return;
        setDismissedPresenceId(id);
        // The page beneath may BE the discarded row's — don't strand the
        // reader on a just-deleted activity; the hub is where they started.
        if (window.location.pathname === `/training/activity/${id}`)
          router.replace(trainingRelevant ? "/training" : "/timeline");
      })
      .catch(() => {});
  }, [editData, router, trainingRelevant]);

  const leaveDeletedActivityPage = useCallback(
    (id: number) => {
      // A running workspace closes through its minimize path. Deletion is the
      // exception: the session no longer exists, so clear both the mounted
      // workspace and its dock before suppressing stale server-hydrated presence.
      setMinimized(false);
      setOpen(false);
      liveCleanupPendingRef.current = false;
      liveOwnedRowIdRef.current = null;
      setLiveCreatePending(false);
      setDismissedPresenceId(id);
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
      setLiveCreatePending(true);
      liveOwnedRowIdRef.current = null;
      liveCleanupPendingRef.current = true;
      const seq = ++liveSessionSeqRef.current;
      setLiveStartEpoch(Date.now());
      setMinimized(false);
      // Give every live session a fresh form instance. The nonce then remains
      // stable when Finish turns live mode off, so the completed activity stays
      // mounted for its recap instead of remounting as a blank create form.
      setRepeatNonce((n) => n + 1);
      setOpen(true);

      const fd = stampLoggedVia(new FormData());
      fd.set("type", kind.type);
      fd.set("title", kind.title);
      void startWorkout(fd)
        .catch(() => null)
        .then((res) => {
          // CLEAR THE GATE ON EVERY LEG, and only for the session that opened it
          // (#3441). A refusal or a dead connection must release the form to mint
          // its own row — that rowless fallback is what makes a gym dead spot
          // degrade to the pre-step session rather than to no session at all. The
          // seq check is what stops a stale create's answer from unlatching a gate
          // a NEWER session just closed.
          if (liveSessionSeqRef.current === seq) setLiveCreatePending(false);
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
    [stampLoggedVia]
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
      liveCleanupPendingRef.current = true;
      liveOwnedRowIdRef.current = null;
      setLiveStartEpoch(Date.now());
      setMinimized(false);
      setOpen(true);
    });
  }, [liveEditData, resumeLive]);

  // A fresh-load active session: nothing is mounted in this client, but the
  // server-hydrated #921 presence says one is running and its draft is reopenable.
  const hydrationActive =
    !open &&
    presence?.state === "active" &&
    presence.activityId !== dismissedPresenceId &&
    liveEditData != null;

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
      return;
    }
    resumeLive();
  }, [offer, resumeLive]);

  // A live-origin workspace owns this editor until it is explicitly closed or
  // deleted. Active/minimized sessions resume; after Finish has switched off the
  // live presentation, competing entry points leave the completed workspace in
  // place so its eventual close can still clean up an empty create-at-start row.
  const preserveCurrentWorkout = useCallback(() => {
    if (offer.kind === "resume") {
      resumeOffer();
      return true;
    }
    return liveCleanupPendingRef.current;
  }, [offer, resumeOffer]);

  // Memoized so always-mounted consumers (e.g. MobileNav's quick-log button)
  // only re-render when open/editData actually change — not on every provider
  // render (dock registration churns on training log mount/unmount). `offer` is a
  // dependency ON PURPOSE: the bolt's label must flip the moment a session goes live.
  const api: ActivityEditorApi = useMemo(
    () => ({
      openCreate: (createPrefill) => {
        if (preserveCurrentWorkout()) return;
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
        liveCleanupPendingRef.current = false;
        liveOwnedRowIdRef.current = null;
        setLiveStartEpoch(null);
        setMinimized(false);
        if (createPrefill?.type || createPrefill?.date)
          setRepeatNonce((n) => n + 1);
        setOpen(true);
      },
      openLive: () => {
        // A session is already running (#1893): reopen it. Never clear the editor and
        // never re-stamp liveStartEpoch — that would silently reset the running
        // session's clock and drop its in-flight sets.
        if (preserveCurrentWorkout()) return;
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
        if (preserveCurrentWorkout()) return;
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
        if (preserveCurrentWorkout()) return;
        setEditData(data);
        setCreateDate(null);
        setPrefill(null);
        setLive(false);
        liveCleanupPendingRef.current = false;
        liveOwnedRowIdRef.current = null;
        setLiveStartEpoch(null);
        setMinimized(false);
        setOpen(true);
      },
      openRepeat: (data) => {
        if (preserveCurrentWorkout()) return;
        if (!trainingRelevant) return;
        if (activityEditDataHasStrength(data) && !strengthTrainingAvailable)
          return;
        setEditData(null);
        setCreateDate(null);
        setPrefill(buildRepeatPrefill(data, todayStr(tz)));
        setLive(false);
        liveCleanupPendingRef.current = false;
        liveOwnedRowIdRef.current = null;
        setLiveStartEpoch(null);
        setMinimized(false);
        setRepeatNonce((n) => n + 1);
        setOpen(true);
      },
      openRepeatLast: () => {
        if (preserveCurrentWorkout()) return;
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
        liveCleanupPendingRef.current = false;
        liveOwnedRowIdRef.current = null;
        setLiveStartEpoch(null);
        setMinimized(false);
        setRepeatNonce((n) => n + 1);
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
      leaveFor,
      open,
      minimized,
      editData,
    }),
    [
      open,
      minimized,
      editData,
      tz,
      lastActivity,
      trainingRelevant,
      strengthTrainingAvailable,
      subjectName,
      offer,
      startLiveSession,
      preserveCurrentWorkout,
      abandonEmptyLiveRow,
      leaveFor,
    ]
  );

  // Collapse the live overlay to the bar WITHOUT unmounting the form.
  const minimizeLive = useCallback(() => setMinimized(true), []);

  // The bar shows for a client-minimized live session (mounted, hidden) and
  // for a fresh-load active session — EVERYWHERE, the Log tab included
  // (#2897): the old Log-view suppression existed because a live session used
  // to dock inline in that page's column; live never docks now (#2870 step 3),
  // so the bar is the one resume affordance every page shares.
  const showBar = minimized || hydrationActive;
  // Elapsed baseline + copy for the bar: the mounted session's own start when
  // minimized, else the server-hydrated start.
  const barStartEpoch = minimized
    ? (liveStartEpoch ?? liveStartEpochMs ?? mountedAt)
    : (liveStartEpochMs ?? mountedAt);
  const barLabel =
    (minimized ? editData?.title : null) || presence?.title || "Resume";

  // On mobile the overlay reads as its own page (full-screen below sm), so hold
  // a history entry while it's open: the phone's back button/gesture closes the
  // form instead of leaving the page. From sm up history is left alone. This
  // lives on the provider (mounted once, keyed to
  // `open`) rather than ActivityOverlay: a mount-tied effect would push/pop on
  // StrictMode's dev double-mount.
  const markEditorLinkFollowed = useHistoryBackClose(
    open && !minimized,
    () => {
      if (live) {
        minimizeLive();
        return true;
      }
      if (requestCloseRef.current) return requestCloseRef.current();
      setOpen(false);
      return true;
    },
    () => !window.matchMedia("(min-width: 640px)").matches
  );
  useEffect(() => {
    markEditorLinkFollowedRef.current = markEditorLinkFollowed;
  }, [markEditorLinkFollowed]);

  // Remount fresh each time so state initializes from editData/prefill. The
  // nonce keeps repeated "Log again" taps from reusing a stale mount.
  const formKey = editData
    ? `edit-${editData.id}`
    : prefill
      ? `repeat-${repeatNonce}`
      : `create-${repeatNonce}`;

  return (
    <Ctx.Provider value={api}>
      {children}
      {open && (
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
          adoptPending={live && liveCreatePending}
          onRowOwned={live ? onLiveRowOwned : undefined}
          deloadContext={deloadContext}
          recoveringContext={recoveringContext}
          plateauHints={plateauHints}
          rpeTracking={rpeTracking}
          // While minimized the workspace stays MOUNTED but hidden — the running
          // rest timer + elapsed clock keep ticking; the bar restores it.
          hidden={minimized}
          onMinimize={live ? minimizeLive : undefined}
          onLiveFinished={() => {
            setLive(false);
            setLiveStartEpoch(null);
          }}
          onClose={() => {
            setMinimized(false);
            setOpen(false);
            abandonEmptyLiveRow();
          }}
          onCloseRequestReady={(requestClose) => {
            requestCloseRef.current = requestClose;
          }}
          onDeleted={leaveDeletedActivityPage}
        />
      )}
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
                }
              : resumeLive
          }
        />
      )}
    </Ctx.Provider>
  );
}
