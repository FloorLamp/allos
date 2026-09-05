"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import { IconChevronDown } from "@tabler/icons-react";
import BottomSheet from "./BottomSheet";
import { LoggedViaSurface } from "./LoggedViaSurface";
import Avatar from "./Avatar";
import { useToast } from "./Toast";
import QuickDoseList from "./quick-entry/QuickDoseList";
import MeasurementsQuickAdd from "@/app/(app)/trends/MeasurementsQuickAdd";
import FoodLogBar from "@/app/(app)/nutrition/FoodLogBar";
import { FoodSelectedDateProvider } from "@/app/(app)/nutrition/FoodSuggestionsLayout";
import {
  loadQuickEntry,
  type QuickEntryData,
} from "@/app/(app)/quick-entry-actions";
import type { MeasurementsQuickEntry } from "@/lib/quick-entry-measurements";
import type { QuickEntryForm, QuickEntryPrefill } from "@/lib/quick-log";
import type { SessionProfile } from "@/lib/auth";
import type { OverlaySize } from "./overlay";

// The newest bodies load ON DEMAND (#1525/#1633/#1892). This host is mounted on every
// route, and its promise is that it COSTS NOTHING until opened — a promise about
// JavaScript as much as about queries. The forms it already carried are small and
// shared with pages the shell links to anyway; the upload form and the practice list
// each drag in machinery (the file/camera inputs and the toast lifecycle, the
// practice button's modal and date field) that no page-load should pay for. Both are
// only rendered AFTER `loadQuickEntry` resolves, so the chunk fetch overlaps a round
// trip that was already happening and costs nothing perceptible.
const UploadForm = dynamic(() => import("./UploadForm"));
const QuickPracticeList = dynamic(
  () => import("./quick-entry/QuickPracticeList")
);
// Same rule, third body (#1892): the period panel drags in the shared offer button
// and, through it, the cycle Server Actions' client references. Static-importing it
// would put that on the initial JS of EVERY route — including routes with no cycle
// surface at all — which is exactly the promise this host makes above. Hydration
// latency is not free: a wider hydration window is what turns a pre-hydration
// `.fill()` on a controlled input into a silently stale save (see settledFill in
// e2e/helpers.ts), so the cost of breaking this rule is paid by other pages' flakes.
const QuickCyclePanel = dynamic(() => import("./quick-entry/QuickCyclePanel"));
// Same rule, fourth body (#2130): the mood check-in drags in the shared ledger
// hook and the mood action's client reference; loaded only once opened.
const MoodForm = dynamic(() => import("./mood/MoodForm"));
// Same rule, fifth body (#2785): the stool picker drags in the shared ledger hook,
// the seven inline glyphs and the stool action's client reference; loaded on open.
const StoolTypeControl = dynamic(() => import("./stool/StoolTypeControl"));
// Same rule, sixth body (#3327): the substance list drags in the shared ledger hook
// and the substance action's client reference; loaded on open.
const QuickSubstanceList = dynamic(
  () => import("./quick-entry/QuickSubstanceList")
);
// Same rule, seventh body (#4064), and the heaviest of them: the symptom bar drags in
// the shared combobox, the optimistic ledger, the undo toast lifecycle and five symptom
// actions' client references. Loaded on open, after the gather it needs anyway.
const QuickSymptomPanel = dynamic(
  () => import("./quick-entry/QuickSymptomPanel")
);

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
}

// The prefill vocabulary lives beside the form vocabulary in lib/quick-log.ts
// (#2184: the palette's registry speaks it too); re-exported here for callers
// that reach it through the overlay host.
export type { QuickEntryPrefill };

const Ctx = createContext<QuickEntryApi | null>(null);

export function useQuickEntry(): QuickEntryApi {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error("useQuickEntry must be used within a QuickEntryProvider");
  return ctx;
}

// The sheet's accessible name per form, whether the mounted form already renders
// that heading itself (in which case the sheet's copy is screen-reader only, so the
// panel doesn't print the same sentence twice), and HOW WIDE the panel gets from
// `sm` up.
//
// THE SIZE IS DECLARED PER FORM, NOT PER HOST (#4977 item 1). One `BottomSheet`
// mounts every body in this registry, so a width set on the mount below is a width
// set for all of them — and the bodies genuinely differ: a dose list is a column of
// rows, the measurements grid is a multi-column tool. #2774's three buckets are the
// vocabulary for exactly that difference, so each form names the one its content is,
// here, beside the title it already names. Every entry but `measurements` declares
// `sm`, which is the sheet's historical default and therefore the width each of them
// renders at today; measurements declares `lg`, the bucket
// `OVERLAY_PANEL_MAX_WIDTH`'s own note already assigns to "the measurements grid".
const SHEET: Record<
  QuickEntryForm,
  { title: string; ownsHeading: boolean; size: OverlaySize }
> = {
  food: { title: "Log food", ownsHeading: true, size: "sm" },
  // #1486/#1506: weight and vitals merged into ONE form (and one sheet row).
  // #3361: the form is mounted `presentation="modal"` below, so it renders no
  // heading of its own and the sheet prints this one.
  //
  // `lg` (#4977 item 1): the form's grid is INTRINSIC since #2014 — it asks its
  // container (`repeat(auto-fit, minmax(10.5rem, 1fr))`) rather than the window — so
  // the only thing standing between this mount and the two-row Vitals group the
  // Trends modal already renders was a container that never said how wide it was.
  // Nothing in the form changes; it flows to four fields a row on its own.
  measurements: { title: "Log measurements", ownsHeading: false, size: "lg" },
  dose: { title: "Log dose", ownsHeading: false, size: "sm" },
  practice: { title: "Log practice", ownsHeading: false, size: "sm" },
  // #1892: the sheet's period row. The panel owns no heading — the verb is on the
  // button, which is the point.
  cycle: { title: "Log period", ownsHeading: false, size: "sm" },
  // #2130: the sheet's mood row — the same check-in write, a second mount.
  mood: { title: "Log mood", ownsHeading: false, size: "sm" },
  // #2785: the sheet's stool row. The panel owns no heading — the seven buttons ARE
  // the question, and a printed one above them would say it twice.
  stool: { title: "Log stool form", ownsHeading: false, size: "sm" },
  // #3327: the sheet's substance row. The panel owns no heading — the rows ARE the
  // question, and each carries its own verb.
  substance: { title: "Log substance", ownsHeading: false, size: "sm" },
  // #4064: the sheet's symptom row. The panel owns no heading — the bar's own
  // "Daily symptoms" label is suppressed the way the illness cockpit suppresses it,
  // so the sheet prints the one heading.
  symptom: { title: "Log symptom", ownsHeading: false, size: "sm" },
  document: { title: "Add document", ownsHeading: false, size: "sm" },
};

// The measurements payload comes from the SHELL, everything else from the gather —
// one discriminated union either way, so the body below still switches on `form`.
type QuickEntryBody = QuickEntryData | MeasurementsQuickEntry;

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: QuickEntryBody }
  | { status: "error" };

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
  const [open, setOpen] = useState(false);
  // The form is RETAINED after close so the panel keeps its content through the
  // sheet's exit animation instead of blanking on the way out.
  const [form, setForm] = useState<QuickEntryForm | null>(null);
  const [prefill, setPrefill] = useState<QuickEntryPrefill | null>(null);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // The sheet's chosen subject (#4932) — never null once a form has opened: it
  // resolves to the opener's subject, else the acting profile, on every open. Never
  // persisted past close (Out of scope, #4932): the NEXT open recomputes it fresh,
  // it is not read back in.
  const [subject, setSubject] = useState(actingProfileId);
  // The "Who is this for?" block (#4932). Toggled by the chip; nothing else opens
  // it and it never opens on its own.
  const [pickerOpen, setPickerOpen] = useState(false);
  // Ignore a response that lost its race — tapping weight then dose before the
  // first gather returns must not paint the weight form into the dose sheet.
  const requestRef = useRef(0);

  const close = useCallback(() => {
    setOpen(false);
    setPickerOpen(false);
  }, []);

  // LAST-GOOD, PER (FORM, SUBJECT) (#3416/#4454). Held in a ref, not state: it is
  // read synchronously inside `loadFor` and never itself drives a render — only the
  // `ready`/`error` state transitions below do. Keyed on the subject (#4932's Refs:
  // "the subject joins #3416's snapshot key") so a cached read for Mia can never
  // paint as Alex's, and cleared whenever the ACTING profile changes (below) — the
  // same device-local wipe boundary ProfileSwitchWatcher enforces for the offline
  // read snapshots, extended to this in-memory one.
  const lastGoodRef = useRef(new Map<string, QuickEntryData>());
  const priorActingProfileId = useRef(actingProfileId);
  useLayoutEffect(() => {
    if (priorActingProfileId.current !== actingProfileId) {
      priorActingProfileId.current = actingProfileId;
      lastGoodRef.current.clear();
    }
  }, [actingProfileId]);

  // ONE GATHER, taking the subject (#4932's own wording: "loadQuickEntry has one
  // subject parameter and one gate; no second copy of the gather per subject").
  // Reused by a fresh open, a mid-sheet subject switch AND a retry (below), so none
  // of the three can diverge into its own reader of the same form.
  const loadFor = useCallback(
    (next: QuickEntryForm, subjectId: number, token: number) => {
      // NO ROUND TRIP for measurements — the props are already here (#4091), and
      // that gather is resolved for the ACTING profile only (no subject-keyed
      // version exists). #4932 invariant 2: a form that cannot follow the subject
      // end to end shows the unavailable shape rather than a partial context, so a
      // chosen subject other than the acting profile gets that instead of the
      // wrong person's age gates and defaults.
      if (next === "measurements") {
        setState({
          status: "ready",
          data:
            subjectId === actingProfileId
              ? measurements
              : {
                  form: "unavailable",
                  message:
                    "Switch to this profile to log measurements from the sheet.",
                },
        });
        return;
      }
      const key = `${next}:${subjectId}`;
      const cached = lastGoodRef.current.get(key);
      // LAST-GOOD RENDER, REVALIDATE BEHIND IT (#3416 proposal 1). A held copy from
      // an earlier successful open of this SAME (form, subject) pair renders
      // immediately instead of a loading state that would be a lie about what the
      // sheet already knows; the fetch below still runs regardless — the SAME one
      // gather an open always made (#3369: no extra query for having a cache).
      setState(
        cached ? { status: "ready", data: cached } : { status: "loading" }
      );
      // THE STALL BOUND (#3416 proposal 3): with no last-good to fall back on, a
      // gather that never settles must not leave "Loading…" up forever. ~10s, so a
      // slow-but-real network still finishes ahead of it in the ordinary case.
      const stallTimer = cached
        ? null
        : setTimeout(() => {
            if (requestRef.current === token) setState({ status: "error" });
          }, QUICK_ENTRY_LOAD_TIMEOUT_MS);
      void loadQuickEntry(next, subjectId).then(
        (data) => {
          if (stallTimer != null) clearTimeout(stallTimer);
          if (requestRef.current !== token) return;
          lastGoodRef.current.set(key, data);
          setState({ status: "ready", data });
        },
        () => {
          if (stallTimer != null) clearTimeout(stallTimer);
          if (requestRef.current !== token) return;
          // A FAILED REVALIDATE BEHIND A LAST-GOOD RENDER KEEPS WHAT IS ALREADY
          // SHOWN (#3416 proposal 1) — the person is mid-use of a form that just
          // proved it still has yesterday's answer; only a COLD failure (nothing
          // cached yet) reaches the error state.
          if (!cached) setState({ status: "error" });
        }
      );
    },
    [actingProfileId, measurements]
  );

  const openForm = useCallback(
    (
      next: QuickEntryForm,
      nextPrefill?: QuickEntryPrefill,
      subjectProfileId?: number
    ) => {
      const token = ++requestRef.current;
      const resolvedSubject = subjectProfileId ?? actingProfileId;
      setForm(next);
      setPrefill(nextPrefill ?? null);
      setSubject(resolvedSubject);
      setPickerOpen(false);
      setOpen(true);
      loadFor(next, resolvedSubject, token);
    },
    [actingProfileId, loadFor]
  );

  // Tapping the chip toggles the block; tapping it again while open closes it
  // unchanged (#4932). A login with exactly one writable profile never gets a
  // chevron to tap (rendered below), so this is unreachable for it.
  const toggleSubjectPicker = useCallback(() => {
    setPickerOpen((o) => !o);
  }, []);

  // Picking a household member (#4932): collapses the block, re-runs the gather for
  // the new subject, and discards anything staged in the current form — the form
  // body remounts under a `key` that includes `subject` (below), which is what
  // actually clears typed state; this just says so. Picking the SAME member the
  // chip already names just closes the block (no reload, nothing to discard).
  const selectSubject = useCallback(
    (profileId: number) => {
      setPickerOpen(false);
      if (profileId === subject || form == null) return;
      setSubject(profileId);
      setPrefill(null);
      const token = ++requestRef.current;
      loadFor(form, profileId, token);
      const name = writableProfiles.find((p) => p.id === profileId)?.name;
      toast(
        name
          ? `Switched — now logging for ${name}. Anything typed for the last person was discarded.`
          : "Switched who this is for. Anything typed for the last person was discarded."
      );
    },
    [subject, form, loadFor, writableProfiles, toast]
  );

  // Re-runs the SAME gather (#3416 proposal 3) — the error state's Retry button, and
  // the one thing that gets the sheet out of a stalled/cold-failed open without
  // closing it. No-op once the sheet has no form (already closed).
  const retry = useCallback(() => {
    if (form == null) return;
    const token = ++requestRef.current;
    loadFor(form, subject, token);
  }, [form, subject, loadFor]);

  const api = useMemo<QuickEntryApi>(
    () => ({ open: openForm, close }),
    [openForm, close]
  );

  const sheet = form ? SHEET[form] : null;
  // The subject to POST (#4932): explicit only when it differs from the acting
  // profile, so the acting-profile path stays byte-identical to before this issue
  // (no stray `profile_id` field on the ordinary tap).
  const subjectId = subject === actingProfileId ? undefined : subject;
  const subjectInfo = writableProfiles.find((p) => p.id === subject);
  // A login with exactly one writable profile gets no chevron and no block — there
  // is nothing to switch to (#4932).
  const singleWritableProfile = writableProfiles.length <= 1;

  const chip = subjectInfo ? (
    singleWritableProfile ? (
      <span
        data-testid="quick-entry-subject-chip"
        className="inline-flex min-w-0 items-center gap-1 rounded-full border border-black/10 bg-slate-50 py-0.5 pl-0.5 pr-2 text-xs font-medium text-slate-600 dark:border-white/10 dark:bg-ink-850 dark:text-slate-300"
      >
        <Avatar profile={subjectInfo} size="sm" />
        <span className="truncate">{subjectInfo.name}</span>
      </span>
    ) : (
      <button
        type="button"
        data-testid="quick-entry-subject-chip"
        aria-expanded={pickerOpen}
        aria-label={`Logging for ${subjectInfo.name}. Change who this is for.`}
        onClick={toggleSubjectPicker}
        className="inline-flex min-w-0 items-center gap-1 rounded-full border border-black/10 bg-slate-50 py-0.5 pl-0.5 pr-1.5 text-xs font-medium text-slate-600 hover:border-black/20 dark:border-white/10 dark:bg-ink-850 dark:text-slate-300 dark:hover:border-white/20"
      >
        <Avatar profile={subjectInfo} size="sm" />
        <span className="truncate">{subjectInfo.name}</span>
        <IconChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform dark:text-slate-400 ${
            pickerOpen ? "rotate-180" : ""
          }`}
          aria-hidden
        />
      </button>
    )
  ) : null;

  const picker =
    pickerOpen && !singleWritableProfile ? (
      <div
        data-testid="quick-entry-subject-picker"
        className="mb-2 rounded-lg border border-(--border) bg-surface p-2"
      >
        <p className="mb-1.5 px-1 text-xs font-medium text-slate-500 dark:text-slate-400">
          Who is this for?
        </p>
        <ul className="flex flex-col gap-0.5">
          {writableProfiles.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                data-testid={`quick-entry-subject-option-${p.id}`}
                aria-current={p.id === subject ? "true" : undefined}
                onClick={() => selectSubject(p.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                  p.id === subject
                    ? "bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-200"
                    : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-ink-850"
                }`}
              >
                <Avatar profile={p} size="sm" />
                <span className="truncate">{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  return (
    <Ctx.Provider value={api}>
      {children}
      {sheet && (
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
          titleHidden={sheet.ownsHeading}
          titleAdornment={chip}
          belowTitle={picker}
        >
          {/* EVERY control inside this sheet is the quick-log sheet (#3087). The
              bodies below — the food bar, the measurements form, the dose list, the
              substance row, the practice list — are the SAME components their domain
              pages mount, posting the SAME Server Actions, so the server can only
              tell the sheet from the page if the sheet says so. Declared once here,
              at the region root, rather than on each body. */}
          <LoggedViaSurface value="quick-log">
            {/* Keyed on the subject (#4932): switching who this is for remounts the
                body fresh, which is what actually discards a staged, half-typed
                entry rather than leaving it to paint under the new subject's name. */}
            <div
              key={subject}
              data-testid="quick-entry-body"
              data-form={form}
              data-subject-profile-id={subject}
            >
              <QuickEntryBody
                state={state}
                prefill={prefill}
                onDone={close}
                onRetry={retry}
                subjectProfileId={subjectId}
              />
            </div>
          </LoggedViaSurface>
        </BottomSheet>
      )}
    </Ctx.Provider>
  );
}

function QuickEntryBody({
  state,
  prefill,
  onDone,
  onRetry,
  subjectProfileId,
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
}) {
  if (state.status === "loading") {
    return (
      <p
        data-testid="quick-entry-loading"
        className="py-6 text-sm text-slate-500 dark:text-slate-400"
      >
        Loading…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <div data-testid="quick-entry-error" className="py-6">
        {/* #3416 proposal 3: the copy stops instructing "close this and try
            again" — the button does the trying. A stalled gather (past
            QUICK_ENTRY_LOAD_TIMEOUT_MS) reaches here exactly like a hard
            rejection; both are the same "try again" ask to the person looking
            at the sheet. */}
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          Couldn&apos;t open that form.
        </p>
        <button
          type="button"
          data-testid="quick-entry-retry"
          onClick={onRetry}
          className="btn-ghost mt-2"
        >
          Retry
        </button>
      </div>
    );
  }

  const data = state.data;
  switch (data.form) {
    case "measurements":
      return (
        <MeasurementsQuickAdd
          // The whole field set, spread (#4424 ruling 1): `measurementsQuickEntry`
          // answers "what does this form need on day D" for every surface that mounts
          // it, so the sheet and the record's add door cannot list different props.
          {...data}
          // A dialog body renders content, never chrome (#3361). Without this the
          // form falls back to `presentation="card"` and draws its own card
          // border and `<h2>` inside a panel that already draws both — the same
          // escape hatch its two ModalShell mounts already pass.
          presentation="modal"
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
        <FoodSelectedDateProvider today={data.today} days={data.days}>
          <FoodLogBar
            today={data.today}
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
                    initialGramsByDate: { [data.today]: data.proteinToday },
                    lastPreset: data.proteinPreset,
                  }
                : undefined
            }
            subjectProfileId={subjectProfileId}
          />
        </FoodSelectedDateProvider>
      );
    case "dose":
      return (
        <QuickDoseList
          today={data.today}
          doses={data.doses}
          prn={data.prn}
          pastDays={data.pastDays}
          onDone={onDone}
          subjectProfileId={subjectProfileId}
        />
      );
    case "cycle":
      // The SAME <PeriodOfferButton> the Cycle page control and the dashboard phase
      // widget render, over the SAME server-resolved cycleControlState — a third
      // RENDERER of one state, never a third implementation. A successful tap closes:
      // start/end/reopen is one transaction with a real end, and #1468's contract is
      // that it lands you back where you were. No subject prop: a non-acting subject
      // never reaches this case (`loadFor` turns it into `unavailable` above).
      return <QuickCyclePanel state={data.state} onDone={onDone} />;
    case "mood":
      // The SAME MoodValencePicker + logMood write the dashboard card runs, with
      // the #2128 day chips — a second mounting context, never a second write
      // path. A successful tap closes (a check-in is a transaction with an end).
      return (
        <MoodForm
          days={data.days}
          showCalm={data.showCalm}
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
          today={data.today}
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
          today={data.today}
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
          today={data.today}
          severities={data.severities}
          notes={data.notes}
          customNames={data.customNames}
          rankedKeys={data.rankedKeys}
          temperatureUnit={data.temperatureUnit}
          timeZone={data.timeZone}
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
        <p
          data-testid="quick-entry-unavailable"
          className="py-4 text-sm text-slate-500 dark:text-slate-400"
        >
          {data.message}
        </p>
      );
  }
}
