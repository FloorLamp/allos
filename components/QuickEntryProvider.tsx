"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import BottomSheet from "./BottomSheet";
import { BOTTOM_EDGE_NOTICE_CLEARANCE } from "./overlay/tokens";
import { LoggedViaSurface } from "./LoggedViaSurface";
import QuickDoseList from "./quick-entry/QuickDoseList";
import MeasurementsQuickAdd from "@/app/(app)/trends/MeasurementsQuickAdd";
import FoodLogBar from "@/app/(app)/nutrition/FoodLogBar";
import ProteinQuickAdd from "@/app/(app)/nutrition/ProteinQuickAdd";
import { FoodSelectedDateProvider } from "@/app/(app)/nutrition/FoodSuggestionsLayout";
import {
  loadQuickEntry,
  type QuickEntryData,
} from "@/app/(app)/quick-entry-actions";
import type { MeasurementsQuickEntry } from "@/lib/quick-entry-measurements";
import type { QuickEntryForm, QuickEntryPrefill } from "@/lib/quick-log";

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
const QuickMoodCheckin = dynamic(
  () => import("./quick-entry/QuickMoodCheckin")
);
// Same rule, fifth body (#2785): the stool picker drags in the shared ledger hook,
// the seven inline glyphs and the stool action's client reference; loaded on open.
const QuickStoolForm = dynamic(() => import("./quick-entry/QuickStoolForm"));
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
  open: (form: QuickEntryForm, prefill?: QuickEntryPrefill) => void;
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

// The sheet's accessible name per form, and whether the mounted form already
// renders that heading itself (in which case the sheet's copy is screen-reader
// only, so the panel doesn't print the same sentence twice).
const SHEET: Record<QuickEntryForm, { title: string; ownsHeading: boolean }> = {
  food: { title: "Log food", ownsHeading: true },
  // #1486/#1506: weight and vitals merged into ONE form (and one sheet row).
  // #3361: the form is mounted `presentation="modal"` below, so it renders no
  // heading of its own and the sheet prints this one.
  measurements: { title: "Log measurements", ownsHeading: false },
  dose: { title: "Log dose", ownsHeading: false },
  practice: { title: "Log practice", ownsHeading: false },
  // #1892: the sheet's period row. The panel owns no heading — the verb is on the
  // button, which is the point.
  cycle: { title: "Log period", ownsHeading: false },
  // #2130: the sheet's mood row — the same check-in write, a second mount.
  mood: { title: "Log mood", ownsHeading: false },
  // #2785: the sheet's stool row. The panel owns no heading — the seven buttons ARE
  // the question, and a printed one above them would say it twice.
  stool: { title: "Log stool form", ownsHeading: false },
  // #3327: the sheet's substance row. The panel owns no heading — the rows ARE the
  // question, and each carries its own verb.
  substance: { title: "Log substance", ownsHeading: false },
  // #4064: the sheet's symptom row. The panel owns no heading — the bar's own
  // "Daily symptoms" label is suppressed the way the illness cockpit suppresses it,
  // so the sheet prints the one heading.
  symptom: { title: "Log symptom", ownsHeading: false },
  document: { title: "Add document", ownsHeading: false },
};

// The measurements payload comes from the SHELL, everything else from the gather —
// one discriminated union either way, so the body below still switches on `form`.
type QuickEntryBody = QuickEntryData | MeasurementsQuickEntry;

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: QuickEntryBody }
  | { status: "error" };

export default function QuickEntryProvider({
  children,
  measurements,
}: {
  children: React.ReactNode;
  // Resolved in the app shell, not gathered on open (#4091): the measurements
  // form is the one body here a person is expected to reach with no connection,
  // and `loadQuickEntry` is a Server Action, which offline rejects. Server-rendered
  // inline is what made the dashboard's retired weight widget reachable in a gym
  // basement, and this prop is that same property, kept while the widget goes.
  measurements: MeasurementsQuickEntry;
}) {
  const [open, setOpen] = useState(false);
  // The form is RETAINED after close so the panel keeps its content through the
  // sheet's exit animation instead of blanking on the way out.
  const [form, setForm] = useState<QuickEntryForm | null>(null);
  const [prefill, setPrefill] = useState<QuickEntryPrefill | null>(null);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Ignore a response that lost its race — tapping weight then dose before the
  // first gather returns must not paint the weight form into the dose sheet.
  const requestRef = useRef(0);

  const close = useCallback(() => setOpen(false), []);

  const openForm = useCallback(
    (next: QuickEntryForm, nextPrefill?: QuickEntryPrefill) => {
      const token = ++requestRef.current;
      setForm(next);
      setPrefill(nextPrefill ?? null);
      setOpen(true);
      // NO ROUND TRIP for measurements — the props are already here, so the form
      // mounts on the same tick and offline changes nothing about opening it. This
      // is the whole of the #4091 fix; a `loading` state would be a lie and an
      // `error` state is what the Server Action produced with no signal.
      if (next === "measurements") {
        setState({ status: "ready", data: measurements });
        return;
      }
      setState({ status: "loading" });
      void loadQuickEntry(next).then(
        (data) => {
          if (requestRef.current === token) setState({ status: "ready", data });
        },
        () => {
          if (requestRef.current === token) setState({ status: "error" });
        }
      );
    },
    [measurements]
  );

  const api = useMemo<QuickEntryApi>(
    () => ({ open: openForm, close }),
    [openForm, close]
  );

  const sheet = form ? SHEET[form] : null;

  return (
    <Ctx.Provider value={api}>
      {children}
      {sheet && (
        <BottomSheet
          open={open}
          onClose={close}
          title={sheet.title}
          testId="quick-entry-sheet"
          // A sheet on the phone (where this opens from the quick-log sheet) and
          // a centered card from `md` up, so the palette's future adoption of the
          // same host doesn't need a second presentation.
          presentation="dialog"
          titleHidden={sheet.ownsHeading}
        >
          {/* EVERY control inside this sheet is the quick-log sheet (#3087). The
              bodies below — the food bar, the measurements form, the dose list, the
              substance row, the practice list — are the SAME components their domain
              pages mount, posting the SAME Server Actions, so the server can only
              tell the sheet from the page if the sheet says so. Declared once here,
              at the region root, rather than on each body. */}
          <LoggedViaSurface value="quick-log">
            <div data-testid="quick-entry-body" data-form={form}>
              <QuickEntryBody state={state} prefill={prefill} onDone={close} />
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
}: {
  state: LoadState;
  prefill: QuickEntryPrefill | null;
  onDone: () => void;
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
      <p
        role="alert"
        data-testid="quick-entry-error"
        className="py-6 text-sm text-rose-600 dark:text-rose-400"
      >
        Couldn&apos;t open that form. Close this and try again.
      </p>
    );
  }

  const data = state.data;
  switch (data.form) {
    case "measurements":
      return (
        <MeasurementsQuickAdd
          // A dialog body renders content, never chrome (#3361). Without this the
          // form falls back to `presentation="card"` and draws its own card
          // border and `<h2>` inside a panel that already draws both — the same
          // escape hatch its two ModalShell mounts already pass.
          presentation="modal"
          weightUnit={data.weightUnit}
          defaultDate={data.defaultDate}
          defaultStatedAt={data.statedAt}
          temperatureUnit={data.temperatureUnit}
          showBodyFat={data.showBodyFat}
          showGrowth={data.showGrowth}
          showHeadCirc={data.showHeadCirc}
          profileId={data.profileId}
          defaultGroup={prefill?.measurementGroup}
          onSaved={onDone}
        />
      );
    case "food":
      // No `onSaved`: the food bar is INCREMENTAL by design — each +/- tap is its
      // own write, so there is no single "saved" moment to close on. The user
      // logs however many servings they mean to and dismisses the sheet. (Its
      // taps already refresh the page behind, so "stay put" still holds.)
      return (
        // CLEARANCE FOR THE TOAST THIS LIST RAISES (#4334 owns the real fix).
        //
        // The failure it buys margin against is a swallowed write, not a cosmetic
        // one: three quick taps on a serving row, the second lands on the toast the
        // first raised, and the person logs two servings while a confirmation on
        // screen says three. Measured at 390x844 — the add control at y 677-709
        // against a toast band at 693-771, and `elementFromPoint` at the control's
        // centre returning the toast.
        //
        // WHY PADDING AND NOT `scroll-margin`, which I tried first and measured
        // failing: nothing scrolls. The row is already in view, so a scroll-into-view
        // hint never fires. This panel is BOTTOM-ANCHORED, so its content height is
        // what sets where the rows come to rest — taller content grows the panel
        // upward and lifts the rows clear. #3987 densified this list by ~88px, which
        // is what lowered them into the band.
        //
        // AND IT IS CLEARANCE, NOT A CONTRACT. `main` cleared the same band by 4px,
        // which nothing owned and nothing asserted; this list was always one content
        // change away and mine was the change that arrived. A padding number is the
        // same luck with a wider margin. The invariant — a bottom-anchored surface
        // CLAIMS the edge so notices move out of its way — is #4334, along with the
        // guard that cannot currently see this surface at all. Do not read this as
        // the fix.
        <div className={BOTTOM_EDGE_NOTICE_CLEARANCE}>
          <FoodSelectedDateProvider today={data.today} days={data.days}>
            <FoodLogBar
              today={data.today}
              days={data.days}
              groupsBySlot={data.groupsBySlot}
              proteinRankBySlot={data.proteinRankBySlot}
              excludedGroups={data.excludedGroups}
              slot={data.slot}
              slotBoundaries={data.slotBoundaries}
              initialFoodGroup={prefill?.foodGroup}
              proteinQuickAdd={
                // Ranked in for a protein-tracking profile (#1980), rendered at the
                // position the one ranking put it in. A profile with no scoop size to
                // re-offer gets no control here — the Food tab remains the complete
                // surface where direct grams are first entered.
                data.proteinPreset != null ? (
                  <ProteinQuickAdd
                    today={data.today}
                    initialGrams={data.proteinToday}
                    lastPreset={data.proteinPreset}
                  />
                ) : undefined
              }
            />
          </FoodSelectedDateProvider>
        </div>
      );
    case "dose":
      return (
        <QuickDoseList
          today={data.today}
          doses={data.doses}
          pastDays={data.pastDays}
          onDone={onDone}
        />
      );
    case "cycle":
      // The SAME <PeriodOfferButton> the Cycle page control and the dashboard phase
      // widget render, over the SAME server-resolved cycleControlState — a third
      // RENDERER of one state, never a third implementation. A successful tap closes:
      // start/end/reopen is one transaction with a real end, and #1468's contract is
      // that it lands you back where you were.
      return <QuickCyclePanel state={data.state} onDone={onDone} />;
    case "mood":
      // The SAME MoodValencePicker + logMood write the dashboard card runs, with
      // the #2128 day chips — a second mounting context, never a second write
      // path. A successful tap closes (a check-in is a transaction with an end).
      return <QuickMoodCheckin days={data.days} onDone={onDone} />;
    case "practice":
      // No `onSaved`: like the food bar, practice logging has no single "saved"
      // moment — multi-session days are the point and a morning check may log two
      // different practices. The user dismisses when they're done; the taps already
      // refresh the page behind, so "stay put" still holds.
      //
      // `onDone` is threaded anyway for the #3066 ZERO STATE only, where the body is
      // the create form rather than a log list — declaring a first practice IS a
      // transaction with an end. The list branch ignores it.
      return (
        <QuickPracticeList
          practices={data.practices}
          today={data.today}
          onDone={onDone}
        />
      );
    case "stool":
      // No `onSaved`: like the food bar and the practice list, stool logging has no
      // single "saved" moment — several movements a day is ordinary and a mis-tap is
      // corrected by tapping again. The tap revalidates behind the sheet, so "stay
      // where you were" still holds.
      return <QuickStoolForm todayCount={data.todayCount} today={data.today} />;
    case "substance":
      // No `onSaved`: like the food bar and the practice list, substance logging has
      // no single "saved" moment — several uses in an evening is ordinary. The tap
      // revalidates behind the sheet, so "stay where you were" still holds.
      return <QuickSubstanceList substances={data.substances} />;
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
          textIntakeEnabled={data.textIntakeEnabled}
          trackingIllness={data.trackingIllness}
        />
      );
    case "document":
      // The SAME UploadForm Data → File upload renders — same ingest engine, same
      // gates, same per-profile storage and dedup, and the #1423 camera input rides
      // along. A successful upload closes the sheet: filing a document is a
      // transaction with a real end, and #1468's contract is that it lands you back
      // on the page you were on. The confirmation toast (with its "Track in Review"
      // action) is posted by the form itself and outlives the sheet.
      return <UploadForm demo={data.demo} onUploaded={onDone} />;
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
