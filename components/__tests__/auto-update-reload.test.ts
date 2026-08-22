import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  markUnrecoverableWork,
  markUnsavedWork,
  resetUnsavedWork,
} from "@/lib/offline/unsaved-work";
import { AUTO_RELOAD_KEY, UPDATE_TAKEN_KEY } from "@/lib/sw-update";
import { resetUpdateReloadChannel } from "../update-reload-channel";
import { useAutoUpdateReload } from "../useAutoUpdateReload";

// `takeUpdate`'s POST-AWAIT RE-CHECK — the second customer of the component tier
// (#3446), and the branch #3371 shipped knowing nothing could see it.
//
// The re-check is the line after `await captureUnsavedWork()`. The flush is fast but
// not instant, and a form that starts holding unrecoverable input in that gap must
// still stop the reload. Its own source comment says so, and says why it was left
// unpinned: "no surface in the tree can open [that window] on purpose and a spec
// could only fake it." That is true of a browser spec. It is not true here — the
// window is an await, and a test that supplies the awaited function decides exactly
// what happens inside it.
//
// SO THE FORGERY IS THE POINT, and it is placed where the real thing happens: the
// registered flush callback is what `captureUnsavedWork()` awaits, so work that
// appears while it runs appears strictly after `evaluate()` asked its question and
// strictly before the navigation is dispatched. Nothing else is faked — real hook,
// real registry, real plan, real DOM.
//
// EVERY CASE HERE IS PAIRED WITH ITS CONTROL, because all three assert an ABSENCE
// (no reload, no markers) and an absence is what a harness that never reached the
// reload at all would also report. `takes the update when the window stays clean`
// runs the identical mount and reaches `machineryReload`, so a green absence above
// it means the guard refused rather than the setup failing to arrive.

/** Where the automatic path is free to fire: a hidden tab short-circuits straight
 * to `{action:"reload"}` in `autoReloadPlan`, with no input-quiet window to wait
 * out and no fake timers needed. */
function hideTheTab(): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
}

const TARGET_SHA = "build two";

/**
 * Mount the registrar with a deploy outstanding, and hand it `duringFlush` as the
 * one registered form's flush callback.
 */
function mountWithFlush(duringFlush: () => void) {
  const machineryReload = vi.fn();
  markUnsavedWork("sleep note", true, {
    capture: async () => {
      duringFlush();
      return null;
    },
  });
  renderHook(() =>
    useAutoUpdateReload({
      pending: true,
      targetSha: TARGET_SHA,
      commitMessage: "one commit",
      machineryReload,
    })
  );
  return machineryReload;
}

/** One macrotask turn drains every microtask the flush chain queued, so the
 * assertions below read a SETTLED sequence rather than a sampled one — no polling,
 * no timeout to tune, and no window for a slow resolution to flatter an absence. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("takeUpdate's post-await re-check (#3371)", () => {
  beforeEach(() => {
    hideTheTab();
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
    resetUnsavedWork();
    resetUpdateReloadChannel();
  });

  it("takes the update when nothing appears while the flush is in flight", async () => {
    // THE CONTROL for the two refusals below. Same mount, same deploy, same flush —
    // and it reaches the reload, so an absence in the next two tests is a refusal
    // and not a setup that never got here.
    const machineryReload = mountWithFlush(() => {});
    await settle();

    expect(machineryReload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(UPDATE_TAKEN_KEY)).toContain(TARGET_SHA);
  });

  it("refuses when a hand-composed form starts declaring during the flush", async () => {
    const machineryReload = mountWithFlush(() => {
      const dialog = document.createElement("div");
      dialog.dataset.unsaved = "true";
      dialog.textContent = "a sleep note typed while the flush ran";
      document.body.append(dialog);
    });
    await settle();

    expect(
      machineryReload,
      "a declaration that appeared during the flush must stop the reload"
    ).not.toHaveBeenCalled();
    // Nothing was written either: the refusal is before the markers and before the
    // ration, so the tab keeps its one automatic attempt for the next quiet moment.
    expect(sessionStorage.getItem(UPDATE_TAKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(AUTO_RELOAD_KEY)).toBeNull();
  });

  it("refuses when a registry-tracked form goes unrecoverable during the flush", async () => {
    // The re-check's OTHER operand. Same window, the #1878 registry's view of it.
    const machineryReload = mountWithFlush(() => {
      markUnrecoverableWork("provider affiliations", true);
    });
    await settle();

    expect(
      machineryReload,
      "unrecoverable work registered during the flush must stop the reload"
    ).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(UPDATE_TAKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(AUTO_RELOAD_KEY)).toBeNull();
  });
});
