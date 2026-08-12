"use client";

import { useEffect, useRef } from "react";
import { useToast } from "./Toast";
import {
  parseUpdateTaken,
  updateTakenMessage,
  UPDATE_TAKEN_KEY,
} from "@/lib/sw-update";

// "The app has updated" — the notice, after the fact (#2471).
//
// THE INVERSION. Until this issue a deploy asked before it did anything: a bar, a
// tap, a reload. Once the reload is provably lossless and the tab schedules it
// itself, asking protects nothing — so the notice moves to the other side of the
// event and becomes a statement of fact. That is a RENDERED AGGREGATE in the
// attention doctrine's taxonomy, not a send: it reports something that has already
// happened to this tab, it asks for nothing, and it is deliberately routed through
// the app's ONE toast system rather than anything in lib/notifications/.
//
// ONE NOTICE PER TAKEN BUILD (#1795/#1806, carried into the new shape). The dedupe is
// the consumption itself: the marker is written immediately before an
// update-machinery reload and removed the first time any healthy boot reads it. So a
// second machinery reload for the same build (#2155's late controller swap), a manual
// refresh afterwards, or a same-build waiting worker consumed silently (#2120 — which
// writes no marker at all) can none of them produce a second toast.
//
// HEADLESS, and mounted INSIDE the ToastProvider — which is why this is its own
// component rather than a few lines in ServiceWorkerRegister: the registrar sits
// above the provider in the root layout and cannot call `useToast()`.
//
// The crash boundary (app/global-error.tsx) replaces the root layout, so this never
// mounts there and the marker survives to the next healthy boot. That is deliberate:
// the update WAS taken, and the user should still be told once the app comes back.
export default function UpdateTakenToast() {
  const toast = useToast();
  // Once per document, before React's dev double-mount can read it twice.
  const consumedRef = useRef(false);

  useEffect(() => {
    if (consumedRef.current) return;
    consumedRef.current = true;
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(UPDATE_TAKEN_KEY);
      if (raw !== null) sessionStorage.removeItem(UPDATE_TAKEN_KEY);
    } catch {
      // Storage denied: no marker, no toast. The update still happened and the app
      // still works; saying nothing is the right failure here.
      return;
    }
    const taken = parseUpdateTaken(raw);
    if (!taken) return;
    toast(updateTakenMessage(taken), { key: "update-taken" });
  }, [toast]);

  return null;
}
