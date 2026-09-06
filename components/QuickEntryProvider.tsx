"use client";

import {
  Component,
  Suspense,
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import { IconChevronDown } from "@tabler/icons-react";
import BottomSheet from "./BottomSheet";
import { LoggedViaSurface } from "./LoggedViaSurface";
import Avatar from "./Avatar";
import { useToast } from "./Toast";
import { useTimezone } from "./TimezoneProvider";
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
import { dateStrInTz } from "@/lib/date";
import {
  dayContextKey,
  type DayContextKey,
  type DayContextParts,
  type TapReach,
} from "@/lib/day-context-key";
import { formatRelativeTime } from "@/lib/format-date";
import {
  clearLastGood,
  quickEntryOffline,
  recallLastGood,
  rememberLastGood,
} from "@/lib/offline/quick-entry-read";
import { allIntents } from "@/lib/offline/queue-db";
import { allSnapshots } from "@/lib/offline/snapshot-db";

// The newest bodies load ON DEMAND (#1525/#1633/#1892). This host is mounted on every
// route, and its promise is that it COSTS NOTHING until opened — a promise about
// JavaScript as much as about queries. The forms it already carried are small and
// shared with pages the shell links to anyway; the upload form and the practice list
// each drag in machinery (the file/camera inputs and the toast lifecycle, the
// practice button's modal and date field) that no page-load should pay for. Both are
// only rendered AFTER `loadQuickEntry` resolves, so the chunk fetch overlaps a round
// trip that was already happening and costs nothing perceptible.
//
// A FACTORY, NOT SEVEN MODULE CONSTANTS, because a chunk fetch can fail (#3416
// proposal 4 — the first open of one of these bodies on bad wifi). `dynamic()` is
// `React.lazy` underneath, and a lazy whose import rejected stays rejected for the
// life of that instance: re-rendering it re-throws the same error without asking the
// network again. So the retry state's button cannot re-mount the SAME components — it
// mints a fresh set, whose imports ask again (and, once the chunk is cached by the
// service worker, resolve at once). Called once at mount and once per retry.
function loadBodies(attempt: number) {
  return {
    attempt,
    UploadForm: dynamic(() => import("./UploadForm")),
    QuickPracticeList: dynamic(() => import("./quick-entry/QuickPracticeList")),
    // Same rule, third body (#1892): the period panel drags in the shared offer
    // button and, through it, the cycle Server Actions' client references.
    // Static-importing it would put that on the initial JS of EVERY route — including
    // routes with no cycle surface at all — which is exactly the promise this host
    // makes above. Hydration latency is not free: a wider hydration window is what
    // turns a pre-hydration `.fill()` on a controlled input into a silently stale save
    // (see settledFill in e2e/helpers.ts), so the cost of breaking this rule is paid by
    // other pages' flakes.
    QuickCyclePanel: dynamic(() => import("./quick-entry/QuickCyclePanel")),
    // Same rule, fourth body (#2130): the mood check-in drags in the shared ledger
    // hook and the mood action's client reference; loaded only once opened.
    MoodForm: dynamic(() => import("./mood/MoodForm")),
    // Same rule, fifth body (#2785): the stool picker drags in the shared ledger
    // hook, the seven inline glyphs and the stool action's client reference; loaded
    // on open.
    StoolTypeControl: dynamic(() => import("./stool/StoolTypeControl")),
    // Same rule, sixth body (#3327): the substance list drags in the shared ledger
    // hook and the substance action's client reference; loaded on open.
    QuickSubstanceList: dynamic(
      () => import("./quick-entry/QuickSubstanceList")
    ),
    // Same rule, seventh body (#4064), and the heaviest of them: the symptom bar
    // drags in the shared combobox, the optimistic ledger, the undo toast lifecycle
    // and five symptom actions' client references. Loaded on open, after the gather
    // it needs anyway.
    QuickSymptomPanel: dynamic(() => import("./quick-entry/QuickSymptomPanel")),
  };
}

type Bodies = ReturnType<typeof loadBodies>;

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
  // `asOf` is the #2908 as-of line, set exactly when what is shown did not just come
  // from the server: a last-good copy whose revalidate FAILED, or the device's own
  // copy. Null for a fresh gather — and for a last-good render while its revalidate
  // is still in flight, since online that settles within the round trip.
  | { status: "ready"; data: QuickEntryBody; asOf: string | null }
  | { status: "error" };

// The stall bound a cold "Loading…" may sit under before the sheet stops waiting
// for the gather (#3416 proposal 3) — long enough that an ordinary slow connection
// still finishes first, short enough that a dead one does not leave the sheet looking
// merely quiet. Firing it INVALIDATES THE REQUEST, nothing more: the Server Action
// may still be executing, and if its answer arrives while this context is still the
// one on screen it is applied (fresh beats a copy). Nothing here cancels server work.
const QUICK_ENTRY_LOAD_TIMEOUT_MS = 10_000;

// THE SHEET'S REACH — the day context it stands on (#5211), which is #5211's to mint
// as `SHEET_REACH` in lib/log-manifest.ts once its provider lands; until then it is
// declared HERE, once, as what this host actually offers today: every body is handed
// the profile's today and no day switcher sits above them, so the host's own reach
// is `today`. When #5211 widens it, the key below moves with it and every held entry
// under the old shape becomes a miss (clause 5) — nothing to migrate, because nothing
// durable is keyed by it.
const SHEET_REACH: TapReach = { kind: "today" };

// ONE OPEN, ONE REQUEST. Minted when a form is asked for and compared by identity when
// its answers come back, so a response — the gather's, the stall timer's, the device
// copy's — is applied only if THIS is still the request on screen. `key` is the
// #5211 identity it was issued for (clause 3: captured at request time, never read
// at response time); `settled` records that the server itself answered, so a slower
// recovery path never paints a copy over the real thing.
interface Request {
  readonly key: DayContextKey;
  readonly parts: DayContextParts;
  readonly form: QuickEntryForm;
  settled: boolean;
}

function asOfCopy(fetchedAt: string | Date, why: string): string {
  return `As of ${formatRelativeTime(
    typeof fetchedAt === "string" ? fetchedAt : fetchedAt.toISOString()
  )} — ${why}`;
}

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
  // The acting profile's zone (the shell's one `TimezoneProvider`), which is what the
  // sheet's day is minted in below. A chosen non-acting subject in another zone is
  // keyed by THIS zone's day: the shell holds no other, and the key is a cache key
  // (a miss on their midnight, refetched; never a record). #5211's provider owns the
  // day from then on.
  const tz = useTimezone();
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
  // The request on screen (see `Request`). Tapping weight then dose before the first
  // gather returns must not paint the weight form into the dose sheet; a subject
  // switch or a new day mints a new one and the old answer is discarded WHOLE.
  const requestRef = useRef<Request | null>(null);
  // The dynamic bodies, re-minted by Retry (see `loadBodies`).
  const [bodies, setBodies] = useState(() => loadBodies(0));

  const close = useCallback(() => {
    setOpen(false);
    setPickerOpen(false);
  }, []);

  // LAST-GOOD (#3416/#4454) lives in lib/offline/quick-entry-read.ts, keyed by the
  // #5211 day-context key (subject, day, reach) plus the form — so a cached read for
  // Mia can never paint as Alex's, and a today copy can never fill a yesterday form.
  // Dropped whenever the ACTING profile changes (here) and by the device wipe
  // (components/device-wipe.ts) — the same boundary ProfileSwitchWatcher and logout
  // enforce for the offline read snapshots, extended to this in-memory one.
  const priorActingProfileId = useRef(actingProfileId);
  useLayoutEffect(() => {
    if (priorActingProfileId.current !== actingProfileId) {
      priorActingProfileId.current = actingProfileId;
      clearLastGood();
    }
  }, [actingProfileId]);

  // ONE GATHER, taking the subject (#4932's own wording: "loadQuickEntry has one
  // subject parameter and one gate; no second copy of the gather per subject").
  // Reused by a fresh open, a mid-sheet subject switch AND a retry (below), so none
  // of the three can diverge into its own reader of the same form.
  const loadFor = useCallback(
    (next: QuickEntryForm, subjectId: number) => {
      const parts: DayContextParts = {
        profileId: subjectId,
        day: dateStrInTz(tz),
        reach: SHEET_REACH,
      };
      const request: Request = {
        key: dayContextKey(parts),
        parts,
        form: next,
        settled: false,
      };
      requestRef.current = request;
      const current = () => requestRef.current === request;
      // NO ROUND TRIP for measurements — the props are already here (#4091), and
      // that gather is resolved for the ACTING profile only (no subject-keyed
      // version exists). #4932 invariant 2: a form that cannot follow the subject
      // end to end shows the unavailable shape rather than a partial context, so a
      // chosen subject other than the acting profile gets that instead of the
      // wrong person's age gates and defaults.
      if (next === "measurements") {
        setState({
          status: "ready",
          asOf: null,
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
      const held = recallLastGood(parts, next);
      // LAST-GOOD RENDER, REVALIDATE BEHIND IT (#3416 proposal 1). A held copy from
      // an earlier successful open of this SAME context renders immediately instead
      // of a loading state that would be a lie about what the sheet already knows;
      // the fetch below still runs regardless — the SAME one gather an open always
      // made (#3369: no extra query for having a cache).
      setState(
        held
          ? { status: "ready", data: held.data, asOf: null }
          : { status: "loading" }
      );
      // COLD FAILURE FALLS BACK TO THE DEVICE'S OWN COPY (#3416 proposal 2): the
      // #2908 snapshots for the forms that map onto one, the device's own day and
      // queue for mood and stool, and the retry state for everything else. Read
      // only on the way to that state — an open that succeeds never touches
      // IndexedDB — and applied only while this request is still on screen AND the
      // server has not answered in the meantime.
      const recover = async () => {
        const [snapshots, intents] = await Promise.all([
          allSnapshots(),
          allIntents(),
        ]);
        if (!current() || request.settled) return;
        const copy = quickEntryOffline(
          next,
          parts,
          actingProfileId,
          snapshots,
          intents
        );
        setState(
          copy
            ? {
                status: "ready",
                data: copy.data,
                asOf:
                  copy.fetchedAt == null
                    ? "Offline — showing only what's queued on this device."
                    : asOfCopy(copy.fetchedAt, "this device's offline copy."),
              }
            : { status: "error" }
        );
      };
      // THE STALL BOUND (#3416 proposal 3): with no last-good on screen, a gather
      // that never settles must not leave "Loading…" up forever. ~10s, so a
      // slow-but-real network still finishes ahead of it in the ordinary case.
      const stallTimer = held
        ? null
        : setTimeout(() => void recover(), QUICK_ENTRY_LOAD_TIMEOUT_MS);
      void loadQuickEntry(next, subjectId).then(
        (data) => {
          if (stallTimer != null) clearTimeout(stallTimer);
          // DISCARDED WHOLE if the context moved (#5211 clause 3): never merged,
          // never remembered under the key it was not issued for.
          if (!current()) return;
          request.settled = true;
          rememberLastGood(parts, next, data);
          setState({ status: "ready", data, asOf: null });
        },
        () => {
          if (stallTimer != null) clearTimeout(stallTimer);
          if (!current()) return;
          // A FAILED REVALIDATE BEHIND A LAST-GOOD RENDER KEEPS WHAT IS ALREADY
          // SHOWN (#3416 proposal 1) — the person is mid-use of a form that just
          // proved it still has an answer — and SAYS SO: what is on screen did not
          // just come from the server, so it carries the #2908 as-of line from here.
          if (held)
            setState({
              status: "ready",
              data: held.data,
              asOf: asOfCopy(held.fetchedAt, "couldn't refresh."),
            });
          else void recover();
        }
      );
    },
    [actingProfileId, measurements, tz]
  );

  const openForm = useCallback(
    (
      next: QuickEntryForm,
      nextPrefill?: QuickEntryPrefill,
      subjectProfileId?: number
    ) => {
      const resolvedSubject = subjectProfileId ?? actingProfileId;
      setForm(next);
      setPrefill(nextPrefill ?? null);
      setSubject(resolvedSubject);
      setPickerOpen(false);
      setOpen(true);
      loadFor(next, resolvedSubject);
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
      loadFor(form, profileId);
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
  // closing it. ONE mechanism for both failures: a body whose chunk failed to fetch
  // reaches the same state (`BodyBoundary` below), and the same button re-mints the
  // bodies so the import is asked again. No-op once the sheet has no form.
  const retry = useCallback(() => {
    if (form == null) return;
    setBodies((prior) => loadBodies(prior.attempt + 1));
    loadFor(form, subject);
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
              {state.status === "ready" && state.asOf ? (
                <p
                  data-testid="quick-entry-asof"
                  className="mb-2 text-xs text-slate-500 dark:text-slate-400"
                >
                  {state.asOf}
                </p>
              ) : null}
              <BodyBoundary key={bodies.attempt} onRetry={retry}>
                <QuickEntryBody
                  state={state}
                  bodies={bodies}
                  prefill={prefill}
                  onDone={close}
                  onRetry={retry}
                  subjectProfileId={subjectId}
                />
              </BodyBoundary>
            </div>
          </LoggedViaSurface>
        </BottomSheet>
      )}
    </Ctx.Provider>
  );
}

// The retry state: what a cold failure, a stalled gather and a failed chunk fetch all
// render (#3416 proposal 3). The copy stops instructing "close this and try again" —
// the button does the trying.
function RetryState({ onRetry }: { onRetry: () => void }) {
  return (
    <div data-testid="quick-entry-error" className="py-6">
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

function Loading() {
  return (
    <p
      data-testid="quick-entry-loading"
      className="py-6 text-sm text-slate-500 dark:text-slate-400"
    >
      Loading…
    </p>
  );
}

// A body whose chunk failed to fetch throws from its lazy import (#3416 proposal 4):
// without this the nearest boundary was the ROUTE's, which replaced the whole page
// under an open sheet. Here it is the same retry state the gather's failures render;
// the host re-mounts it under a new key per Retry (see `loadBodies` for why the
// bodies have to be re-minted too). The Suspense boundary is the same body's LOADING
// half: a chunk still on its way shows the same "Loading…" a gather does, rather
// than whatever boundary happens to sit above the sheet.
class BodyBoundary extends Component<
  { onRetry: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    return this.state.failed ? (
      <RetryState onRetry={this.props.onRetry} />
    ) : (
      <Suspense fallback={<Loading />}>{this.props.children}</Suspense>
    );
  }
}

function QuickEntryBody({
  state,
  bodies,
  prefill,
  onDone,
  onRetry,
  subjectProfileId,
}: {
  state: LoadState;
  bodies: Bodies;
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
  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <RetryState onRetry={onRetry} />;

  const data = state.data;
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
