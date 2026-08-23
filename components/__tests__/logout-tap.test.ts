import { describe, expect, it } from "vitest";
import {
  clearQueuedLogoutTap,
  hasQueuedLogoutTap,
  LOGOUT_BOOT_SCRIPT,
  LOGOUT_BUTTON_ATTR,
  LOGOUT_TAPPED_ATTR,
} from "@/lib/logout-tap";

// LOGOUT_BOOT_SCRIPT — the capture half of #3515, pinned in the component tier because
// it is a listener over a real document and has nowhere else to live. The script is a
// STRING of source that runs in <head> before any bundle, so it cannot import the rule
// it enforces and nothing in `lib/**` can execute it: the pure tier's environment is
// `node`, with no document to click on.
//
// WHAT IS ACTUALLY BEING CLAIMED, so these tests can be read as the claim rather than as
// coverage. On main, a tap on Log out before React attaches produced NOTHING — no submit,
// no POST, no navigation, no error — because the control is `type="button"` with a React
// `onClick` on a form whose action is a client function (#2908 made it that way to stop
// the async PHI wipe racing the navigation). The script below is what turns that silence
// into a recorded tap and a visible pending state; e2e/logout-pre-hydration.spec.ts is
// the other half, and it drives the real control in the real hydration window.
//
// The script is executed rather than pattern-matched. A test that greps this source for
// `addEventListener` would pass over a script that never ran.
function bootScript(): void {
  new Function(LOGOUT_BOOT_SCRIPT).call(globalThis);
}

/** The control as the SERVER renders it: the marker, and no handler behind it. */
function serverRenderedLogout(): HTMLButtonElement {
  document.body.innerHTML = `
    <form>
      <button type="button" ${LOGOUT_BUTTON_ATTR}>
        <svg class="logout-idle-icon"></svg>
        <svg class="logout-pending-spinner"></svg>
        Log out
      </button>
    </form>`;
  return document.querySelector("button") as HTMLButtonElement;
}

describe("LOGOUT_BOOT_SCRIPT captures a tap with no handler behind it (#3515)", () => {
  it("marks the control tapped and busy", () => {
    bootScript();
    const btn = serverRenderedLogout();

    expect(hasQueuedLogoutTap(btn)).toBe(false);
    btn.click();

    expect(hasQueuedLogoutTap(btn)).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
  });

  it("catches a tap on the ICON inside the button, not only on the button itself", () => {
    // The thing under a finger is usually a child. `closest()` is what makes the
    // listener see the control from wherever the tap landed, and dropping it would
    // leave the most common tap of all — on the label or the icon — still silent.
    bootScript();
    const btn = serverRenderedLogout();

    (btn.querySelector(".logout-idle-icon") as SVGElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true })
    );

    expect(hasQueuedLogoutTap(btn)).toBe(true);
  });

  it("registers BEFORE the control exists, because the document is still streaming", () => {
    // The order here is the point: the script runs from <head>, so the button it
    // serves has not been parsed yet. A MutationObserver-style sweep (the shape
    // DISCLOSURE_BOOT_SCRIPT needs) would have to find nodes; a delegated listener
    // resolves its target at CLICK time and does not.
    document.body.innerHTML = "";
    bootScript();
    const btn = serverRenderedLogout();

    btn.click();

    expect(hasQueuedLogoutTap(btn)).toBe(true);
  });

  it("is SILENT on every other control on the page", () => {
    // A guard that marked anything else would put a spinner on an unrelated button
    // and, worse, hand SidebarContent's effect a logout nobody asked for. The
    // neighbours here are the ones that actually sit beside it in the sidebar.
    bootScript();
    document.body.innerHTML = `
      <button type="button" data-testid="profile-identity-bar">Switch profile</button>
      <button type="submit">Save</button>
      <a href="/timeline">Timeline</a>`;

    // Swallow the anchor's default so jsdom does not try to navigate; the listener
    // under test runs in the CAPTURE phase and has already seen the event by then.
    document.addEventListener("click", (e) => e.preventDefault());

    for (const el of Array.from(document.body.children)) {
      (el as HTMLElement).click();
      expect(el.hasAttribute(LOGOUT_TAPPED_ATTR), el.outerHTML).toBe(false);
      expect(el.hasAttribute("aria-busy"), el.outerHTML).toBe(false);
    }
  });

  it("does not swallow the tap — a live handler still runs", () => {
    // Capture phase, no preventDefault, no stopPropagation. Once React IS attached the
    // same tap must reach the real handler; this listener then only records the state
    // that handler is about to set. If this ever stopped propagation the fix for the
    // pre-hydration window would have broken every logout after it.
    bootScript();
    const btn = serverRenderedLogout();
    let handlerRuns = 0;
    btn.addEventListener("click", () => {
      handlerRuns += 1;
    });

    btn.click();

    expect(handlerRuns).toBe(1);
    expect(hasQueuedLogoutTap(btn)).toBe(true);
  });

  it("clearQueuedLogoutTap withdraws the claim when the logout does not proceed", () => {
    bootScript();
    const btn = serverRenderedLogout();
    btn.click();

    clearQueuedLogoutTap(btn);

    expect(hasQueuedLogoutTap(btn)).toBe(false);
    expect(btn.hasAttribute("aria-busy")).toBe(false);
  });

  it("hasQueuedLogoutTap tolerates a ref that has not attached", () => {
    expect(hasQueuedLogoutTap(null)).toBe(false);
    expect(() => clearQueuedLogoutTap(null)).not.toThrow();
  });
});
