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
import { markUnsavedWork } from "@/lib/offline/unsaved-work";

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

function setNativeChecked(el: HTMLInputElement, checked: boolean) {
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, "checked");
  if (desc?.set) desc.set.call(el, checked);
  else el.checked = checked;
  el.dispatchEvent(new Event("click", { bubbles: true }));
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
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
      if (el.checked !== want) setNativeChecked(el, want);
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
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const extraRef = useRef<E | undefined>(extra);
  extraRef.current = extra;
  const keyRef = useRef<string | null>(key);
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;

  const snapshot = useCallback(
    (): { fields: DraftField[]; extra: unknown } => ({
      fields: collectFields(formRef?.current ?? null),
      extra: extraRef.current ?? null,
    }),
    [formRef]
  );

  const write = useCallback(() => {
    const k = keyRef.current;
    if (!active || k == null || profileId == null) return;
    const snap = snapshot();
    const sig = draftSig(snap.fields, snap.extra);
    if (initialSigRef.current == null) initialSigRef.current = sig;
    if (
      !shouldPersistDraft({
        currentSig: sig,
        initialSig: initialSigRef.current,
      })
    )
      return;
    markUnsavedWork(k, true);
    void putDraft({
      key: k,
      profileId,
      formKey,
      recordId: recordId ?? null,
      savedAt: Date.now(),
      fields: snap.fields,
      extra: snap.extra,
    });
  }, [active, profileId, formKey, recordId, snapshot]);

  const schedule = useCallback(() => {
    if (!active) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      write();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [active, write]);

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
      const current = snapshot();
      if (
        shouldOfferDraft({
          draft: stored,
          profileId,
          formKey,
          recordId: recordId ?? null,
          currentSig: draftSig(current.fields, current.extra),
          now: Date.now(),
        })
      ) {
        offeredRef.current = stored;
        setOffer({ savedAt: stored!.savedAt });
      }
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
      // the "mid-composition" flag doesn't.
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
    })();
  }, [snapshot, formRef, confirmReplace]);

  return { offer, resume, discard, clear };
}
