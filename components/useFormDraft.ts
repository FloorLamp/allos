"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteDraft,
  getDraft,
  purgeExpiredDrafts,
  putDraft,
} from "@/lib/offline/draft-db";
import {
  draftConflictsWithInput,
  draftKey,
  draftSig,
  fieldMultimap,
  shouldOfferDraft,
  shouldPersistDraft,
  type DraftField,
  type DraftFormKey,
  type FormDraft,
} from "@/lib/offline/drafts";
import { useActiveProfileId } from "./ActiveProfileProvider";
import {
  markUnsavedWork,
  type ResumePointer,
  type UnsavedWorkEntry,
} from "@/lib/offline/unsaved-work";
import { useLatestRef } from "./useLatestRef";
import { takeResumeContinuationFor } from "./resume-continuation";
import { shouldAutoApplyDraft } from "@/lib/sw-update";

// The React binding for local form drafts (issue #1699): autosave on change,
// restore only on an explicit tap, clear on successful save.
//
// It works on two kinds of form state at once, because the app has both:
//
//   * NAMED DOM FIELDS — everything a `<form action={...}>` submits. Captured with
//     `new FormData(form)` and restored by writing values back through the native
//     value setter plus a bubbling input/change event, which is what makes a
//     CONTROLLED React input take the restored value (setting `.value` alone would
//     be reverted on the next render).
//   * `extra` — state with no named field of its own: the activity editor's parts
//     list, a dose-row array serialized into FormData at submit time, picker state.
//     Opaque JSON handed back to `onRestore` so the form applies it with its own
//     setters. Restored FIRST, so dynamic rows exist before field values land.
//
// A form supplies either or both. Nothing is ever applied without the user's tap:
// the hook reports an `offer`, the form renders <DraftRestoreBanner>, and the user
// chooses Resume or Discard.
//
// THE ONE ARGUED EXCEPTION (#2471). When the tab reloaded ITSELF to take a deploy,
// the tap has already happened: the user typed this draft seconds ago, in this tab,
// and the app — not they — chose to throw the document away. A one-shot continuation
// marker written immediately before that reload (`components/resume-continuation.ts`)
// names one form and one record, and `shouldAutoApplyDraft` decides whether this
// mount is that continuation. Every other mount, including a revisit in another tab
// or the next day, still gets the offer. An explicit-submission form gets the same
// restore and no more: the content comes back, and the user's own submit is still
// the write.
//
// THIS HOOK ALSO REPORTS THE FLUSH (#2471). A form registered as unsaved work hands
// `lib/offline/unsaved-work.ts` a `capture` callback: cancel the debounce, write the
// draft, resolve when it is durable, and say what should be reopened. The automatic
// reload awaits every one of them before it writes a marker, so the reload can never
// land on top of an unflushed keystroke.
//
// See lib/offline/drafts.ts for the draft/offline-queue boundary and the PHI rules.

/** How long after the last edit a draft is written. */
const AUTOSAVE_DEBOUNCE_MS = 600;

export interface FormDraftApi {
  /** A restorable draft for this form, or null. Render the banner off this. */
  offer: { savedAt: number } | null;
  /** Apply the offered draft (the user's tap). */
  resume: () => void;
  /** Throw the offered draft away (the user's tap). */
  discard: () => void;
  /**
   * Drop this form's draft because the work is now durably somewhere else — a
   * successful submit, or a write handed to the offline queue. MANDATORY on every
   * success path: a draft that outlives its submitted record is #1699 inverted.
   */
  clear: () => void;
}

function isRestorable(
  el: Element
): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  );
}

/** Fields we never persist: file pickers (unserializable) and passwords. */
function isExcluded(el: HTMLElement): boolean {
  return (
    el instanceof HTMLInputElement &&
    (el.type === "file" || el.type === "password")
  );
}

function collectFields(form: HTMLFormElement | null): DraftField[] {
  if (!form) return [];
  const excluded = new Set<string>();
  for (const el of Array.from(form.elements)) {
    if (el instanceof HTMLElement && isExcluded(el)) {
      const named = el as HTMLInputElement;
      if (named.name) excluded.add(named.name);
    }
  }
  const out: DraftField[] = [];
  for (const [name, value] of new FormData(form).entries()) {
    if (typeof value !== "string") continue; // a File never leaves the page
    if (excluded.has(name)) continue;
    out.push([name, value]);
  }
  return out;
}

/**
 * Write a value into a live field so React sees it. Uses the prototype's native
 * setter (React tracks the last value it wrote on the node; assigning `.value`
 * directly makes React think nothing changed and swallow the event).
 */
function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
) {
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Toggle a checkbox/radio the way a user would. Deliberately `.click()` rather than
 * a native `checked` setter: a dispatched click runs the element's own activation
 * behavior AND fires React's onChange, so controlled and uncontrolled boxes both end
 * up where the draft says. (Setting `checked` first and then dispatching a click
 * would toggle it straight back.)
 */
function setChecked(el: HTMLInputElement, want: boolean) {
  if (el.checked === want) return;
  // A radio is only ever turned ON; the group's other member turns it off.
  if (el.type === "radio" && !want) return;
  el.click();
}

function applyFields(form: HTMLFormElement | null, fields: DraftField[]) {
  if (!form) return;
  const wanted = fieldMultimap(fields);
  // Consumed per name in document order, so repeated names line up with the
  // elements that produced them.
  const remaining = new Map<string, string[]>(
    [...wanted].map(([k, v]) => [k, [...v]])
  );
  for (const el of Array.from(form.elements)) {
    if (!isRestorable(el)) continue;
    if (isExcluded(el)) continue;
    const name = el.name;
    if (!name) continue;
    if (
      el instanceof HTMLInputElement &&
      (el.type === "checkbox" || el.type === "radio")
    ) {
      // An unchecked box is ABSENT from FormData, so "not in the draft" must
      // actively uncheck — otherwise a restore could only ever turn things on.
      const want = (wanted.get(name) ?? []).includes(el.value);
      setChecked(el, want);
      continue;
    }
    const bucket = remaining.get(name);
    const next = bucket && bucket.length ? bucket.shift()! : "";
    if (el.value !== next) setNativeValue(el, next);
  }
}

export function useFormDraft<E = undefined>({
  formKey,
  recordId = null,
  formRef,
  scopeRef,
  live = false,
  extra,
  enabled = true,
  onRestore,
  confirmReplace,
}: {
  formKey: DraftFormKey;
  /** The stored row being edited; null for a create form. */
  recordId?: number | null;
  /** The form element whose named fields are captured. Omit for state-only forms. */
  formRef?: { current: HTMLFormElement | null };
  /**
   * The subtree this draft covers, when it is not the captured form element — the
   * activity editor keeps everything in `extra`, so its <form> is not `formRef` but
   * its fields are still durable. Marked `data-draft-backed` so the #1878 dirty-form
   * registry can tell recoverable input from the kind an automatic reload must
   * refuse to cross (#2471).
   */
  scopeRef?: { current: HTMLElement | null };
  /**
   * The editor is in live-workout mode. Carried on the resume pointer only, so the
   * tab that reloads to take a deploy reopens the same mode it was in (#2471).
   */
  live?: boolean;
  /** Serializable state with no named field of its own. */
  extra?: E;
  /**
   * False turns the whole hook off — no capture, no offer. Used where the work is
   * ALREADY durably persisted elsewhere and a second copy would be a competing
   * source of truth (a live workout session is server-backed, #451).
   */
  enabled?: boolean;
  /** Apply a restored `extra`. Called before field values are written back. */
  onRestore?: (extra: E) => void;
  /**
   * Asked before resuming over input the user has already typed. Resolve false to
   * keep what's on screen. Without it, resume replaces (the user tapped Resume).
   */
  confirmReplace?: () => Promise<boolean>;
}): FormDraftApi {
  const profileId = useActiveProfileId();
  const active = enabled && profileId != null;
  const key = useMemo(
    () =>
      profileId == null
        ? null
        : draftKey({ profileId, formKey, recordId: recordId ?? null }),
    [profileId, formKey, recordId]
  );

  const [offer, setOffer] = useState<{ savedAt: number } | null>(null);
  const offeredRef = useRef<FormDraft | null>(null);
  // The snapshot the form mounted with. A form still equal to it has nothing worth
  // persisting, and a form that has moved off it is "touched" (resume would replace
  // real input).
  const initialSigRef = useRef<string | null>(null);
  // The last snapshot THIS mount persisted. A form that re-keys mid-session (a
  // create form whose auto-save produced a row) writes its draft under the new key
  // and would otherwise find it a moment later and offer the user their own live
  // input back.
  const lastWrittenSigRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const extraRef = useLatestRef<E | undefined>(extra);
  const keyRef = useRef<string | null>(key);
  const onRestoreRef = useLatestRef(onRestore);

  const snapshot = useCallback(
    (): { fields: DraftField[]; extra: unknown } => ({
      fields: collectFields(formRef?.current ?? null),
      extra: extraRef.current ?? null,
    }),
    [formRef, extraRef]
  );

  // Resolves once the draft is durable. Awaited by `capture` below, which is what
  // lets an automatic update reload prove it is not crossing an unflushed keystroke
  // (#2471); every other caller still fires and forgets.
  const write = useCallback((): Promise<void> => {
    const k = keyRef.current;
    if (!active || k == null || profileId == null) return Promise.resolve();
    const snap = snapshot();
    const sig = draftSig(snap.fields, snap.extra);
    if (initialSigRef.current == null) initialSigRef.current = sig;
    if (
      !shouldPersistDraft({
        currentSig: sig,
        initialSig: initialSigRef.current,
      })
    )
      return Promise.resolve();
    markUnsavedWork(k, true, entryRef.current);
    lastWrittenSigRef.current = sig;
    return putDraft({
      key: k,
      profileId,
      formKey,
      recordId: recordId ?? null,
      savedAt: Date.now(),
      fields: snap.fields,
      extra: snap.extra,
    });
  }, [active, profileId, formKey, recordId, snapshot]);

  // Cancel the debounce, write, and say what should be reopened on the other side.
  // A rejection here is what stops the reload: `captureUnsavedWork` answers
  // `{ ok: false }` and the tab stays exactly where it is.
  const capture = useCallback(async (): Promise<ResumePointer | null> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await write();
    return { formKey, recordId: recordId ?? null, live };
  }, [write, formKey, recordId, live]);
  const captureRef = useLatestRef(capture);
  // A stable entry whose callback is always the CURRENT mount's: the registry holds
  // it across re-renders, and a stale closure would flush a form that is gone.
  const entryRef = useRef<UnsavedWorkEntry>({
    capture: () => captureRef.current(),
  });

  const schedule = useCallback(() => {
    if (!active) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      write();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [active, write]);

  // Apply a stored draft to the live form. The one place that writes a draft back,
  // shared by the user's Resume tap and the #2471 continuation.
  const applyDraft = useCallback(
    (draft: FormDraft) => {
      offeredRef.current = null;
      setOffer(null);
      // `extra` first: dynamic rows must exist before their field values land.
      if (draft.extra != null) onRestoreRef.current?.(draft.extra as E);
      if (draft.fields.length > 0) {
        // One frame later, so the re-render triggered by `onRestore` has committed
        // the rows we are about to fill.
        requestAnimationFrame(() =>
          applyFields(formRef?.current ?? null, draft.fields)
        );
      }
    },
    [formRef, onRestoreRef]
  );

  // Mark the subtree whose unsaved input is durable (#2471). The #1878 dirty-form
  // registry reads this to tell recoverable input from the kind an automatic update
  // reload must refuse to cross. `scopeRef` wins when a form keeps its state in
  // `extra` rather than in the captured element.
  useEffect(() => {
    const el = scopeRef?.current ?? formRef?.current ?? null;
    if (!active || !el) return;
    el.setAttribute("data-draft-backed", "");
    return () => el.removeAttribute("data-draft-backed");
  }, [active, scopeRef, formRef]);

  // Seed the mount signature and look for a draft to offer. Runs once per key.
  useEffect(() => {
    if (!active || key == null || profileId == null) return;
    let cancelled = false;
    const snap = snapshot();
    initialSigRef.current = draftSig(snap.fields, snap.extra);
    void purgeExpiredDrafts(Date.now());
    void (async () => {
      const stored = await getDraft(key, Date.now());
      if (cancelled) return;
      if (
        stored &&
        draftSig(stored.fields, stored.extra) === lastWrittenSigRef.current
      ) {
        return; // our own writing, not a recovered draft
      }
      const current = snapshot();
      const currentSig = draftSig(current.fields, current.extra);
      if (
        !shouldOfferDraft({
          draft: stored,
          profileId,
          formKey,
          recordId: recordId ?? null,
          currentSig,
          now: Date.now(),
        })
      ) {
        return;
      }
      // THE ONE ARGUED EXCEPTION (#2471): this mount is the continuation of the tab
      // that reloaded itself seconds ago, so the tap that would apply this draft has
      // already happened. Every leg is a way of checking that. The conflict leg is
      // real rather than ceremonial: the draft read is asynchronous, so the user can
      // have typed into the freshly-mounted form before it landed — and applying on
      // top of live input is the one thing the offer banner exists to make visible.
      const continuation = takeResumeContinuationFor(key);
      if (
        shouldAutoApplyDraft({
          marker: continuation,
          formKey,
          recordId: recordId ?? null,
          savedAt: stored!.savedAt,
          conflicts: draftConflictsWithInput({
            currentSig,
            initialSig: initialSigRef.current ?? "",
          }),
          now: Date.now(),
        })
      ) {
        applyDraft(stored!);
        return;
      }
      offeredRef.current = stored;
      setOffer({ savedAt: stored!.savedAt });
    })();
    return () => {
      cancelled = true;
    };
    // `snapshot` is stable per formRef; re-running on every render would re-seed
    // the initial signature and defeat the pristine check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, profileId, formKey, recordId]);

  // A create form that has produced a server row (the activity editor's auto-save
  // does this) re-keys onto that row: the "new" draft is handed over rather than
  // left behind, where it would restore into a SECOND, duplicate record.
  useEffect(() => {
    const prev = keyRef.current;
    keyRef.current = key;
    if (prev && key && prev !== key) {
      void deleteDraft(prev);
      write();
    }
  }, [key, write]);

  // Capture every edit to a named field.
  useEffect(() => {
    const form = formRef?.current;
    if (!active || !form) return;
    const onEdit = () => schedule();
    form.addEventListener("input", onEdit);
    form.addEventListener("change", onEdit);
    return () => {
      form.removeEventListener("input", onEdit);
      form.removeEventListener("change", onEdit);
    };
  }, [active, formRef, schedule]);

  // …and every change to the state the DOM can't express.
  const extraSig = useMemo(() => JSON.stringify(extra ?? null), [extra]);
  useEffect(() => {
    if (!active) return;
    if (initialSigRef.current == null) return; // pre-seed render
    schedule();
  }, [active, extraSig, schedule]);

  // A pending debounce must still land when the form goes away — closing the
  // editor 200ms after the last keystroke is exactly the case #1699 is about.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        write();
      }
      const k = keyRef.current;
      // The form is gone, so nothing is being composed any more — the DRAFT stays,
      // the "mid-composition" flag and its capture callback don't.
      if (k) markUnsavedWork(k, false);
    };
  }, [write]);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const k = keyRef.current;
    offeredRef.current = null;
    setOffer(null);
    if (k) markUnsavedWork(k, false);
    // Re-baseline: after a successful save the form on screen IS the saved state,
    // so nothing is dirty until the user edits again.
    const snap = snapshot();
    initialSigRef.current = draftSig(snap.fields, snap.extra);
    if (k) void deleteDraft(k);
  }, [snapshot]);

  const discard = useCallback(() => {
    const k = keyRef.current;
    offeredRef.current = null;
    setOffer(null);
    if (k) void deleteDraft(k);
  }, []);

  const resume = useCallback(() => {
    const draft = offeredRef.current;
    if (!draft) return;
    void (async () => {
      const current = snapshot();
      const touched = draftConflictsWithInput({
        currentSig: draftSig(current.fields, current.extra),
        initialSig: initialSigRef.current ?? "",
      });
      if (touched && confirmReplace && !(await confirmReplace())) return;
      applyDraft(draft);
    })();
  }, [snapshot, confirmReplace, applyDraft]);

  return { offer, resume, discard, clear };
}
