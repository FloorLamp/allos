"use client";

import { useCallback, useRef } from "react";
import BottomSheet, { type SheetPresentation } from "./BottomSheet";
import { useOptionalConfirm } from "./ConfirmDialog";
import { useUnsavedInputWithin } from "./DirtyFormRegistry";
import type { OverlaySize } from "./overlay";

// The app's dialog host — now a THIN WRAPPER over the one responsive dialog
// primitive (components/BottomSheet.tsx, `presentation="dialog"`).
//
// ── Why this file still exists (issue #2774) ─────────────────────────────────
//
// It used to be the app's SECOND dialog primitive, and that was the defect. It
// rendered its own portal, its own backdrop and its own `fixed inset-0
// overflow-y-auto` scroller — so the app had two "centred card on desktop"
// implementations with different chrome, insets, widths and scroll ownership,
// which is the hand-mirrored-second-engine shape docs/internals/overlays.md
// names, one layer above where #1469 fixed it. Three costs, each observed:
//
//   1. Phones got a centred floating card outside the sheet idiom every other
//      phone surface converged on (#1425/#1469) — a desktop shape at thumb
//      distance, with no safe-area posture and no gesture system.
//   2. THE PAGE SCROLLED BEHIND IT. The scroller was a full-viewport container
//      over an UNLOCKED body, so a drag (or wheel) it declined chained out to
//      the document and on release the page sat somewhere other than where the
//      dialog was opened from.
//   3. Width was hardcoded per host: a `className` override at every call site,
//      `max-w-sm` through `max-w-5xl`, so "how wide is a dialog?" had thirty
//      answers.
//
// All three retire at once by having ONE primitive. It is a wrapper rather than
// a deletion so that the 34 call sites keep their import and their two-prop
// shape: what changed is what "modal" RENDERS as, which is exactly the surface
// area #2774 asked to change.
//
// What a consumer gets from here that a raw BottomSheet does not:
//
//   * `presentation="dialog"` by default — a sheet below `md`, a centred card
//     above — plus the explicit Close control a card needs (a sheet has its drag
//     handle and its scrim; a centred card has neither).
//   * A DECLARED SIZE instead of a `className` width (see OverlaySize).
//   * The dirty-discard guard below.
//
// ── Discarding a dirty form (issue #2774, consequence B) ─────────────────────
//
// The sheet's transactional contract is discard-on-flick (#1428), which is right
// for a half-typed weight and wrong for five typed minutes of family history.
// The forms behind THIS host are the second kind, so a gesture dismissal — a
// flick on the handle, a tap on the scrim — asks first when the hosted form
// holds unsaved input, through the app's existing ConfirmDialog. A clean form
// still dismisses in one gesture: the confirm appears only when there is
// something to lose, which is what keeps it from becoming a click-through.
//
// ESCAPE IS ON THIS PATH TOO (owner ruling, #3420). It was not, on the reading
// that a keypress on a named key is a targeted action rather than an accident —
// which still governs a dialog holding NOTHING unsaved, where Escape closes
// outright with no prompt, because that is what `onGestureDismiss` below does when
// the guard answers clean. It stopped governing a dialog holding unsaved work the
// moment #3417 made Escape reachable on the four fact-hosting forms: one keystroke
// destroyed exactly the typing a scrim tap two pixels away would have asked about.
// The registry already knew the difference, so the question is asked only when
// there is something to lose. The accepted cost is a keyboard user who expects
// Escape to always close now sometimes getting a question.
//
// THE CLOSE BUTTON IS UNTOUCHED and still closes without a prompt. It is the
// control the person aimed at, and a confirm on it would be the ask-before-acting
// pattern the house grammar declines. That half of #2774 is narrowed, not repealed
// — docs/internals/overlays.md states the amended rule.
//
// ── The forms this guard could not see (issue #3356) ─────────────────────────
//
// `useUnsavedInputWithin` used to mean "any NAMED control inside a `<form>` in this
// panel". A form that composes its FormData by hand out of React state has none, so
// the guard answered "clean" about it however much had been typed, and a flick threw
// it away with nothing asking. Such a form now publishes `data-unsaved` and is
// believed. The resolution rule is `lib/dirty-forms.ts#unsavedAnswerForForm`: anything
// that believes there is unsaved work wins, so a declaration can only ADD a form to
// this guard, never take one out. A rule that let a form declare itself clean over its
// own named fields would hand every form a blessed way to disarm the guard silently,
// which is #3352 with better manners.
//
// THE SWEEP, RECORDED (the issue asked for the result, not just the fix). Every
// ModalShell host on 2026-08-20, and which side of the line it fell on:
//
//   REGISTRY-COVERED — named controls the browser composes, guarded all along:
//     EncounterDetailEdit (EncounterForm), ProtocolControls + ProtocolFormModal
//     (ProtocolForm), GoalsManager (GoalForm), LogMeasurementsPanel +
//     MetricMeasurementPanel (MeasurementsQuickAdd), AddPracticeButton
//     (PracticeEditor), LogPracticeButton, EpisodeEditor, EpisodeControls,
//     ConsumptionSection, PassportControls, ImmunizationRecordActions,
//     MedicationListActions.
//
//   HAND-COMPOSED — invisible to the registry, and the reason this exists. All of
//   them declare now (#3371 closed the three #3356 left):
//     SleepMoodEditDialog — not a `<form>` at all. It declares `data-unsaved` off its
//       own state, and e2e/sleep-page.spec.ts pins the gesture dismiss.
//     ProviderAffiliations — THE ONE A grep MISSES, and the reason "count the
//       `name=`s" is the wrong check. It looks covered: a `<form>` carrying
//       `name="name"`. That name lands on `ProviderCombobox`, whose named input is
//       `type="hidden"` — excluded outright — while the VISIBLE field the person
//       types into carries no name at all. The right question is not "does this file
//       contain `name=`?" but "is any name on a control the registry will TRACK?".
//       It declares off the combobox's own `onChange`, which reports what would post.
//     AddSupplementModal + EditableSupplementRow (IntakeItemForm — ONE `name=` in
//       1770 lines, on a provider combobox, so effectively none).
//     RoutinesManager (RoutineBuilder — a `<form>` with zero `name=`).
//       Those last two, and every future draft-backed form, are answered by
//       `components/useFormDraft.ts` rather than by a bespoke adopter each: the hook
//       already computes "has the content moved off the mount snapshot", which is
//       exactly the question, so it publishes it.
//     FoodLogBar (DietaryPreferencesForm — hand-composed, but it AUTOSAVES, so it
//       has nothing unsaved to lose and is owed no guard).
//
//   NOTHING TO LOSE — no typed input to discard, so no guard is owed:
//     CommandPalette (a search box, deliberately untracked), RawPayloadDialog and
//     ActivityPartsList's guide (read-only), PhotoCapture (a camera),
//     BodyMetricRowMenu, SupplementInsightBadges, FoodSuggestionsLayout,
//     ProgressPhotosView, AddEntryPanel (a shell around whatever form it is given),
//     EndEpisodeReconcile and ReopenEpisodeReconcile (checkbox selections over rows
//     that already exist — nothing was typed).
export default function ModalShell({
  title,
  onClose,
  children,
  size = "md",
  presentation = "dialog",
  fullScreenBelowMd = false,
  initialFocusRef,
  testId = "modal-shell",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  // How wide the card gets from `sm` up. Replaces the per-host `className`
  // width overrides (#2774); content stays intrinsic per #2014.
  size?: OverlaySize;
  // Only a RECORDED anatomy exception passes this — a surface with no bottom
  // edge to flick toward at any width (the command palette, the camera
  // fallback). Each one is registered in
  // lib/__tests__/overlay-motion-chokepoint.test.ts with its justification.
  presentation?: Extract<SheetPresentation, "dialog" | "centered">;
  // Fill the phone viewport instead of floating a card in it, below `md` only
  // (#3423). Passes straight through to BottomSheet, which documents the whole
  // decision; a `dialog` presentation is already a sheet at that width and has
  // no use for it.
  fullScreenBelowMd?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  testId?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const confirm = useOptionalConfirm();
  const hasUnsavedInputWithin = useUnsavedInputWithin();

  // Reached by a flick, a scrim tap, and Escape (#3420) — never by the Close
  // button.
  const onGestureDismiss = useCallback(() => {
    if (!confirm || !hasUnsavedInputWithin(panelRef.current)) {
      onClose();
      return;
    }
    void confirm({
      title: "Discard your changes?",
      message: "This form has entries you have not saved yet.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      danger: true,
    }).then((ok) => {
      if (ok) onClose();
    });
    // REFUSED, for now. The dialog is staying open behind the confirm, so the
    // panel must come back to rest — without this a flick leaves the form parked
    // off the bottom edge, and "Keep editing" keeps the typing and loses the
    // surface it was typed into.
    return false;
  }, [confirm, hasUnsavedInputWithin, onClose]);

  return (
    <BottomSheet
      // A consumer renders `{open && <ModalShell/>}`, so mounting IS opening.
      // The exit animation therefore does not play here (the element is gone
      // before it could) — the same as this host has always behaved, and not
      // worth pushing an `open` prop through 34 call sites to gain.
      open
      onClose={onClose}
      onGestureDismiss={onGestureDismiss}
      title={title}
      presentation={presentation}
      fullScreenBelowMd={fullScreenBelowMd}
      size={size}
      showClose
      testId={testId}
      panelRef={panelRef}
      initialFocusRef={initialFocusRef}
    >
      {children}
    </BottomSheet>
  );
}
