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
import QuickDoseList from "./quick-entry/QuickDoseList";
import MeasurementsQuickAdd from "@/app/(app)/trends/MeasurementsQuickAdd";
import FoodLogBar from "@/app/(app)/nutrition/FoodLogBar";
import { FoodSelectedDateProvider } from "@/app/(app)/nutrition/FoodSuggestionsLayout";
import {
  loadQuickEntry,
  type QuickEntryData,
} from "@/app/(app)/quick-entry-actions";
import type { QuickEntryForm } from "@/lib/quick-log";

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
// EXISTING components — MeasurementsQuickAdd and FoodLogBar, the very same
// instances the Trends and Nutrition pages render — and they keep calling the very
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

export interface QuickEntryPrefill {
  foodGroup?: string;
}

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
  measurements: { title: "Log measurements", ownsHeading: true },
  dose: { title: "Log dose", ownsHeading: false },
  practice: { title: "Log practice", ownsHeading: false },
  // #1892: the sheet's period row. The panel owns no heading — the verb is on the
  // button, which is the point.
  cycle: { title: "Log period", ownsHeading: false },
  document: { title: "Add document", ownsHeading: false },
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: QuickEntryData }
  | { status: "error" };

export default function QuickEntryProvider({
  children,
}: {
  children: React.ReactNode;
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
      setState({ status: "loading" });
      setOpen(true);
      void loadQuickEntry(next).then(
        (data) => {
          if (requestRef.current === token) setState({ status: "ready", data });
        },
        () => {
          if (requestRef.current === token) setState({ status: "error" });
        }
      );
    },
    []
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
          <div data-testid="quick-entry-body" data-form={form}>
            <QuickEntryBody state={state} prefill={prefill} onDone={close} />
          </div>
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
          weightUnit={data.weightUnit}
          defaultDate={data.defaultDate}
          temperatureUnit={data.temperatureUnit}
          showBodyFat={data.showBodyFat}
          showGrowth={data.showGrowth}
          showHeadCirc={data.showHeadCirc}
          onSaved={onDone}
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
            excludedGroups={data.excludedGroups}
            slot={data.slot}
            initialFoodGroup={prefill?.foodGroup}
          />
        </FoodSelectedDateProvider>
      );
    case "dose":
      return <QuickDoseList doses={data.doses} onDone={onDone} />;
    case "cycle":
      // The SAME <PeriodOfferButton> the Cycle page control and the dashboard phase
      // widget render, over the SAME server-resolved cycleControlState — a third
      // RENDERER of one state, never a third implementation. A successful tap closes:
      // start/end/reopen is one transaction with a real end, and #1468's contract is
      // that it lands you back where you were.
      return <QuickCyclePanel state={data.state} onDone={onDone} />;
    case "practice":
      // No `onSaved`: like the food bar, practice logging has no single "saved"
      // moment — multi-session days are the point and a morning check may log two
      // different practices. The user dismisses when they're done; the taps already
      // refresh the page behind, so "stay put" still holds.
      return <QuickPracticeList practices={data.practices} />;
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
