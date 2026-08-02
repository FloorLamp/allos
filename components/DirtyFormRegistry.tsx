"use client";

import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  EMPTY_DIRTY_FORM_STATE,
  formHasUnsavedInput,
  isAnyFormDirty,
  reduceDirtyForms,
  refreshIsOwed,
  type DirtyFormEvent,
  type DirtyFormState,
  type TrackedField,
} from "@/lib/dirty-forms";

// The dirty-form registry (issue #1878) — the REACT/DOM half. Every decision it
// makes lives in the pure lib/dirty-forms.ts; this file owns listeners, the field
// bookkeeping those listeners feed, and the one `router.refresh()` the pure
// transition asks for. Read that module first: the three rules (chrome-initiated
// only, deferred-never-dropped, dirty-means-edited) are stated there.
//
// WHY DOCUMENT-LEVEL LISTENERS AND NOT A PER-FORM HOOK. The shape this fix
// replaced — wire each form individually — protects only the forms someone
// remembers to wire, which is exactly the whack-a-mole the issue exists to stop
// (it is also why the #1699 local-draft shape was not chosen as the primary fix;
// drafts remain the better answer for the highest-traffic forms because they
// RECOVER text across a tab close, which no deferral can). Four capture-phase
// listeners on `document` cover every `<form>` in the app, present and future,
// with no per-form work at all.
//
// WHAT COUNTS AS A FIELD. A named, enabled, user-editable control inside a
// `<form>`. Named, because the harm this prevents is losing input that WOULD HAVE
// BEEN SUBMITTED, and an unnamed control submits nothing — a filter box or a
// combobox's search input must not be able to hold the whole app's background
// refreshes hostage. Inside a form, for the same reason: the command palette and
// page-level search boxes are not unsaved records.
//
// PHI DISCIPLINE. Field values are health data. They are read, compared in
// memory, and dropped; nothing here persists, transmits or logs a value, and the
// observability marker below exposes COUNTS only, never content.

const NON_INPUT_TYPES = new Set([
  "hidden",
  "submit",
  "reset",
  "button",
  "image",
  // A file input's value cannot be restored by anything we do, and its DOM value
  // is a fake path — comparing it would only produce noise.
  "file",
]);

// Separator for comparing a multi-select's selected values as one string. A NUL
// cannot occur inside an option value, so the join is unambiguous. Written as an
// escape on purpose: a literal NUL byte in a source file makes git treat it as
// binary and every diff of this file unreadable.
const MULTI_VALUE_SEP = "\u0000";

type TrackableElement =
  HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** Per-field bookkeeping: what it held before the user's first edit, and whether they have edited it. */
interface FieldRecord {
  baseline: string;
  touched: boolean;
}

/** Per-form bookkeeping. Dropped wholesale on submit, reset, or unmount. */
interface FormRecord {
  id: string;
  form: HTMLFormElement;
  fields: Map<TrackableElement, FieldRecord>;
}

/**
 * Whether one tracked form currently holds unsaved input. THE one computation —
 * every caller (the listeners, the owed-refresh recheck) routes through here, so
 * nothing can re-derive "is this dirty" a second way.
 */
function recordIsDirty(record: FormRecord): boolean {
  const fields: TrackedField[] = [];
  for (const [field, meta] of record.fields) {
    if (!field.isConnected) continue;
    fields.push({
      touched: meta.touched,
      current: currentValue(field),
      baseline: meta.baseline,
      serverValue: serverValue(field),
    });
  }
  return formHasUnsavedInput(fields);
}

function isTrackable(el: EventTarget | null): el is TrackableElement {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return false;
  const field = el as TrackableElement;
  if (!field.name) return false;
  if (field.disabled) return false;
  if (field instanceof HTMLInputElement && NON_INPUT_TYPES.has(field.type)) {
    return false;
  }
  if (field instanceof HTMLInputElement && field.readOnly) return false;
  if (field instanceof HTMLTextAreaElement && field.readOnly) return false;
  // An explicit opt-out for a control whose value is UI state rather than a
  // pending record (nothing needs it today; it is here so a future one has an
  // answer that is not "disable the registry").
  if (field.closest("[data-dirty-track='off']")) return false;
  return !!field.form;
}

/** The control's value right now, as one comparable string. */
function currentValue(field: TrackableElement): string {
  if (field instanceof HTMLInputElement) {
    if (field.type === "checkbox" || field.type === "radio") {
      return field.checked ? "1" : "";
    }
    return field.value;
  }
  if (field instanceof HTMLSelectElement) {
    return Array.from(field.selectedOptions)
      .map((o) => o.value)
      .join(MULTI_VALUE_SEP);
  }
  return field.value;
}

/**
 * The value the SERVER most recently rendered into the control. React writes it
 * into the DOM default on every update, so an autosave that revalidates moves
 * this to the saved value and the field stops counting as unsaved input.
 */
function serverValue(field: TrackableElement): string {
  if (field instanceof HTMLInputElement) {
    if (field.type === "checkbox" || field.type === "radio") {
      return field.defaultChecked ? "1" : "";
    }
    return field.defaultValue;
  }
  if (field instanceof HTMLSelectElement) {
    return Array.from(field.options)
      .filter((o) => o.defaultSelected)
      .map((o) => o.value)
      .join(MULTI_VALUE_SEP);
  }
  return field.defaultValue;
}

export interface DirtyFormApi {
  /**
   * Repaint the current page on the CHROME's initiative — a background sync
   * landed, a poll saw a job finish. Defers while any form holds unsaved input
   * and runs once the last of them releases.
   *
   * NOT for a refresh the user asked for. Pull-to-refresh, and the repaint that
   * follows the user's own submit, call `router.refresh()` directly: silently
   * ignoring a gesture whose entire meaning is "give me current data" would be
   * its own bug. That distinction is this opt-in, never a heuristic.
   */
  requestChromeRefresh: () => void;
}

const Ctx = createContext<DirtyFormApi | null>(null);

/**
 * The chrome's refresh. Call it exactly where a background actor would otherwise
 * have called `router.refresh()`.
 *
 * Falls back to a direct `router.refresh()` when no provider is mounted, so a
 * component that also renders outside the authenticated shell keeps working —
 * unprotected, but never broken.
 */
export function useChromeRefresh(): () => void {
  const api = useContext(Ctx);
  const router = useRouter();
  return useCallback(() => {
    if (api) api.requestChromeRefresh();
    else startTransition(() => router.refresh());
  }, [api, router]);
}

/**
 * How often, while a refresh is OWED, the registry re-checks whether the forms
 * have gone clean without firing an event we listen for. The realistic case is an
 * autosave form whose write lands (and revalidates the field's server value)
 * after the blur that triggered it — without this the owed refresh would wait for
 * the user's next keystroke, and "deferred" would drift toward "dropped". Runs
 * only while something is owed, so an idle page schedules nothing.
 */
const OWED_RECHECK_MS = 1000;

export default function DirtyFormProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const stateRef = useRef<DirtyFormState>(EMPTY_DIRTY_FORM_STATE);
  // Mirrors stateRef for the observability marker only. The listeners read and
  // write the ref, so a dropped render can never desynchronize the decision.
  const [state, setState] = useState<DirtyFormState>(EMPTY_DIRTY_FORM_STATE);
  // Refreshes this registry has actually run. The e2e contract: "did the deferred
  // repaint eventually land?" is otherwise invisible from outside.
  const [refreshes, setRefreshes] = useState(0);
  const records = useRef(new Map<HTMLFormElement, FormRecord>());
  const nextId = useRef(0);

  const dispatch = useCallback(
    (event: DirtyFormEvent, { defer = false } = {}) => {
      const { state: next, refreshNow } = reduceDirtyForms(
        stateRef.current,
        event
      );
      stateRef.current = next;
      setState(next);
      if (!refreshNow) return;
      const run = () => {
        setRefreshes((n) => n + 1);
        // A transition, like PullToRefresh: the repaint is never urgent, and a
        // non-transition refresh can drop a re-suspending boundary to its
        // fallback — which would unmount exactly the subtree this protects.
        startTransition(() => router.refresh());
      };
      // A release triggered by `submit` runs while the form's own action is
      // starting; hand the repaint to the next task so it can never interleave
      // with React collecting that FormData.
      if (defer) setTimeout(run, 0);
      else run();
    },
    [router]
  );

  useEffect(() => {
    const recordFor = (form: HTMLFormElement): FormRecord => {
      const existing = records.current.get(form);
      if (existing) return existing;
      const created: FormRecord = {
        id: `form-${(nextId.current += 1)}`,
        form,
        fields: new Map(),
      };
      records.current.set(form, created);
      return created;
    };

    const evaluate = (record: FormRecord) => {
      dispatch({
        type: recordIsDirty(record) ? "dirty" : "clean",
        formId: record.id,
      });
    };

    // A form that unmounted mid-edit must not hold the app's refreshes hostage
    // forever — it can never release by itself again.
    const prune = () => {
      for (const [form, record] of records.current) {
        if (form.isConnected) continue;
        records.current.delete(form);
        dispatch({ type: "clean", formId: record.id });
      }
    };

    const release = (form: HTMLFormElement, defer: boolean) => {
      const record = records.current.get(form);
      if (!record) return;
      records.current.delete(form);
      dispatch({ type: "clean", formId: record.id }, { defer });
    };

    // Focus is NOT dirtiness. It is only where a field's pre-edit baseline comes
    // from, which is what lets a controlled field rendering a real value (a date
    // defaulted to today) stay clean until the user actually changes it.
    const onFocusIn = (e: Event) => {
      const field = e.target;
      if (!isTrackable(field)) return;
      const record = recordFor(field.form!);
      if (!record.fields.has(field)) {
        record.fields.set(field, {
          baseline: currentValue(field),
          touched: false,
        });
      }
    };

    const onEdit = (e: Event) => {
      const field = e.target;
      if (!isTrackable(field)) return;
      const record = recordFor(field.form!);
      const meta = record.fields.get(field);
      if (meta) meta.touched = true;
      else {
        // Edited without ever being focused (autofill, a programmatic set). The
        // server value is the best available "before", and it is the right one:
        // restoring the field to what the server rendered is not unsaved input.
        record.fields.set(field, {
          baseline: serverValue(field),
          touched: true,
        });
      }
      prune();
      evaluate(record);
    };

    const onFocusOut = (e: Event) => {
      const field = e.target;
      if (!isTrackable(field)) return;
      const record = records.current.get(field.form!);
      if (!record) return;
      prune();
      evaluate(record);
    };

    const onSubmit = (e: Event) => {
      if (e.target instanceof HTMLFormElement) release(e.target, true);
    };

    const onReset = (e: Event) => {
      if (e.target instanceof HTMLFormElement) release(e.target, false);
    };

    // Capture phase throughout: `focusin`/`input`/`change` bubble, but `reset`
    // and (in a form nested under one) `submit` are easiest to catch uniformly on
    // the way down, and capture also runs before React's own root listeners.
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("input", onEdit, true);
    document.addEventListener("change", onEdit, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("reset", onReset, true);
    return () => {
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("input", onEdit, true);
      document.removeEventListener("change", onEdit, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("reset", onReset, true);
    };
  }, [dispatch]);

  // The owed-refresh safety net (rule 2). Only while something is owed.
  const owed = refreshIsOwed(state);
  useEffect(() => {
    if (!owed) return;
    const timer = setInterval(() => {
      for (const [form, record] of records.current) {
        if (form.isConnected && recordIsDirty(record)) continue;
        records.current.delete(form);
        dispatch({ type: "clean", formId: record.id });
      }
    }, OWED_RECHECK_MS);
    return () => clearInterval(timer);
  }, [owed, dispatch]);

  // Stable identity: consumers must not re-render every time the counters move.
  const value = useMemo<DirtyFormApi>(
    () => ({
      requestChromeRefresh: () => dispatch({ type: "chrome-refresh" }),
    }),
    [dispatch]
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {/*
        Counts only, never content. This is the observable contract the browser
        tier asserts against — "was that repaint deferred, and did it eventually
        land?" is invisible from outside otherwise (the same reason
        PullToRefresh exposes `data-refreshes`).
      */}
      <span
        hidden
        data-testid="dirty-form-registry"
        data-dirty={state.dirty.length}
        data-owed={state.owed}
        data-refreshes={refreshes}
        data-any-dirty={isAnyFormDirty(state) ? "true" : "false"}
      />
    </Ctx.Provider>
  );
}
