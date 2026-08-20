// The dirty-form registry (issue #1878) — the PURE half.
//
// THE BUG THIS EXISTS FOR. Any app-chrome `router.refresh()` re-renders the
// Server Components under whatever the user currently has on screen. When that
// lands on a mounted record form, an uncontrolled input (or a controlled one whose
// subtree gets remounted by the new tree) loses whatever was typed into it — with
// no warning and no recovery. The observed case (#1552 → #1877) filled the
// Add-visit form, took a background refresh between the fill and the submit, and
// created the appointment TITLELESS: the write "succeeded" with a hollow row.
//
// THE COMPLEMENT OF docs/internals/server-action-refresh.md. That document governs
// when a refresh is CORRECT. This one governs when a correct refresh may LAND. The
// two never disagree because this module adds no refresh and removes none: it only
// delays the ones that already exist, and only the ones the chrome initiates.
//
// THE THREE RULES, all of which live here so nothing re-derives them:
//
//   1. CHROME-INITIATED ONLY. A refresh the USER asked for must never be deferred —
//      pull-to-refresh is a gesture whose entire meaning is "give me current data",
//      and so is the repaint that follows the user's own submit. The distinction is
//      an opt-in at the CALL SITE (components/DirtyFormRegistry.tsx's
//      `useChromeRefresh`), never a heuristic in here: a chrome refresh routes
//      through the registry, a user refresh keeps calling `router.refresh()`.
//
//   2. A DEFERRED REFRESH IS NEVER A DROPPED ONE. Someone can fill half a form and
//      walk away, and the data behind the page keeps ageing. So the state REMEMBERS
//      that a refresh is owed and runs it when the last form releases. Several
//      owed refreshes coalesce into ONE — `owed` counts them for observability, but
//      the drain fires a single refresh (a refresh is idempotent; running it N times
//      would just be the doubled-fetch the sibling doc exists to prevent).
//
//   3. DIRTY MEANS GENUINELY-UNSAVED INPUT, NOT FOCUS AND NOT MOUNT. A form that
//      registered on mount and never released would suppress every background
//      refresh for the life of the page — the failure mode that would make this
//      cure worse than the disease. Hence `fieldHoldsUnsavedInput` below: a field
//      counts only once the user has actually EDITED it, only while it still differs
//      from what it held before that edit, and only while it differs from the value
//      the server last rendered into it (which is what an autosave that revalidates
//      updates — so a saved field stops being unsaved input without anyone
//      announcing it).
//
//      THAT LAST CLAUSE NEEDS A SERVER VALUE, AND THE DOM DOES NOT SIMPLY HAVE ONE
//      (#3352). React syncs the DOM `defaultValue` onto a CONTROLLED field to match
//      its `value`, so reading that property gives back a mirror of `current` and
//      the clause can only ever answer "clean". `resolveServerValue` below is how
//      that is worked out instead, and why it is a decision rather than a read.
//
// One question, one computation (#221): "is any form dirty right now" is
// `isAnyFormDirty` over this state, and nothing else answers it.

/**
 * One tracked form field, reduced to the four strings/flags the decision needs.
 * The DOM half (components/DirtyFormRegistry.tsx) produces these; this module
 * never touches an element.
 */
export interface TrackedField {
  /**
   * The user has fired an `input`/`change` on this field since the form last
   * released. Untouched fields can never make a form dirty — that is rule 3.
   */
  touched: boolean;
  /** The field's value right now. */
  current: string;
  /**
   * What the field held BEFORE the user's first edit of it (captured on focus).
   * Typing and then deleting back to this value is not unsaved input — it is the
   * release-on-blur-empty case, generalized to "blur-back-to-where-it-started".
   */
  baseline: string;
  /**
   * The value the SERVER most recently rendered into the field. A field whose
   * current value equals it is saved, not pending: this is what lets an autosave
   * form that revalidates release itself without a second mechanism.
   *
   * NOT simply the DOM `defaultValue` — see `resolveServerValue`, which is how the
   * DOM half works this out, and why it cannot just read one property.
   */
  serverValue: string;
}

/** Whether ONE field currently holds input the server does not have. */
export function fieldHoldsUnsavedInput(field: TrackedField): boolean {
  if (!field.touched) return false;
  if (field.current === field.baseline) return false;
  return field.current !== field.serverValue;
}

/**
 * WHAT THE SERVER RENDERED, given what the DOM can actually see (#3352).
 *
 * The DOM half used to answer this with the raw `defaultValue`, which is right for
 * a field the DOM owns and WRONG for one React owns: React syncs `defaultValue`
 * onto a controlled field to match its `value`. So for every controlled field in a
 * named form, `current !== serverValue` compared a value against a copy of itself,
 * answered "clean" forever, and the discard guard was silently absent — someone
 * typed, dismissed, and lost the entry with nothing asking.
 *
 * THE AMBIGUITY IS IRREDUCIBLE, and pretending otherwise is how the bug survived.
 * Once the live default equals the current value, two different histories produce
 * byte-identical DOM:
 *
 *   1. React mirrored a controlled `value` onto the default. Nothing is saved.
 *   2. An autosave wrote the typed value and the server re-rendered it. It IS saved.
 *
 * There is no third property to read that separates them, and no timing rule that
 * survives contact with a real browser — measured, not assumed: React 19 does not
 * commit a discrete `input` event synchronously, so "did the default move in the
 * same task as the keystroke?" cannot be asked from an event listener at all.
 *
 * SO THIS RESOLVES IT BY CONSEQUENCE RATHER THAN BY EVIDENCE. Reading the
 * ambiguous default as "the server has it" is the old bug: it drops the guard and
 * loses what somebody typed, silently. Reading it as "React is mirroring" costs at
 * most ONE EXTRA CONFIRM on a form that had in fact already saved — a question,
 * answerable with "Discard", that loses nothing. The cheaper mistake wins.
 *
 * A form that would rather be believed can say so: `data-server-value` on the
 * control states what the server holds, and the DOM half prefers it over all of
 * this. That is the supported way for a controlled autosaving field to release.
 */
export function resolveServerValue(field: {
  /** The DOM `defaultValue` right now. */
  readonly liveDefault: string;
  /** The DOM `defaultValue` when this field first registered, before any edit. */
  readonly atRegistration: string;
  /** The field's value right now. */
  readonly current: string;
  /** Has the user edited this field since the form last released? */
  readonly touched: boolean;
}): string {
  // Untouched, or the default has not moved: nothing is ambiguous and the live
  // default is the answer — including a genuine server re-render arriving under a
  // field nobody has touched.
  if (!field.touched || field.liveDefault === field.atRegistration) {
    return field.liveDefault;
  }
  // The default moved, but NOT onto what the user typed. Only the server can have
  // done that, so believe it — this is what keeps a background revalidation from
  // being mistaken for a mirror.
  if (field.liveDefault !== field.current) return field.liveDefault;
  // The default moved onto exactly what the user typed: the ambiguous case above.
  // Answer with what the server had before any of this, so the field can still be
  // dirty. This is the whole of the #3352 fix.
  return field.atRegistration;
}

/** Whether a form currently holds input the server does not have. */
export function formHasUnsavedInput(fields: readonly TrackedField[]): boolean {
  return fields.some(fieldHoldsUnsavedInput);
}

/**
 * The registry's whole state: which forms hold unsaved input, and how many
 * chrome refreshes are owed to the moment the last of them releases.
 */
export interface DirtyFormState {
  /** Form ids currently holding unsaved input, in registration order. */
  readonly dirty: readonly string[];
  /**
   * Chrome refreshes requested while at least one form was dirty. Counted rather
   * than flagged so "three background ticks collapsed into one repaint" is
   * assertable; the drain always fires exactly one refresh.
   */
  readonly owed: number;
}

export const EMPTY_DIRTY_FORM_STATE: DirtyFormState = { dirty: [], owed: 0 };

export type DirtyFormEvent =
  /** A form started holding unsaved input (idempotent). */
  | { type: "dirty"; formId: string }
  /** A form released — submitted, reset, edited back to clean, or unmounted. */
  | { type: "clean"; formId: string }
  /** App chrome wants to repaint the current page. */
  | { type: "chrome-refresh" };

export interface DirtyFormTransition {
  readonly state: DirtyFormState;
  /**
   * Whether the caller must run ONE `router.refresh()` now. Never more than one
   * per transition, however many were owed.
   */
  readonly refreshNow: boolean;
}

/** Whether any form currently holds unsaved input. THE answer to that question. */
export function isAnyFormDirty(state: DirtyFormState): boolean {
  return state.dirty.length > 0;
}

/** Whether a chrome refresh is waiting on the forms to release. */
export function refreshIsOwed(state: DirtyFormState): boolean {
  return state.owed > 0;
}

/**
 * The registry's state machine. Total and pure; the React binding owns only the
 * DOM listeners and the `router.refresh()` the `refreshNow` answer asks for.
 */
export function reduceDirtyForms(
  state: DirtyFormState,
  event: DirtyFormEvent
): DirtyFormTransition {
  switch (event.type) {
    case "dirty": {
      if (state.dirty.includes(event.formId)) {
        return { state, refreshNow: false };
      }
      return {
        state: { dirty: [...state.dirty, event.formId], owed: state.owed },
        refreshNow: false,
      };
    }
    case "clean": {
      if (!state.dirty.includes(event.formId)) {
        return { state, refreshNow: false };
      }
      const dirty = state.dirty.filter((id) => id !== event.formId);
      // The LAST release drains: while any other form still holds unsaved input,
      // the owed refresh keeps waiting (it would wipe that form too).
      if (dirty.length > 0 || state.owed === 0) {
        return { state: { dirty, owed: state.owed }, refreshNow: false };
      }
      return { state: { dirty, owed: 0 }, refreshNow: true };
    }
    case "chrome-refresh": {
      // Nothing to protect — this is the ordinary case, and it must stay
      // indistinguishable from calling router.refresh() directly.
      if (state.dirty.length === 0) return { state, refreshNow: true };
      // Remembered, not dropped (rule 2).
      return {
        state: { dirty: state.dirty, owed: state.owed + 1 },
        refreshNow: false,
      };
    }
  }
}
