import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";

// A LOGOUT MUST OUTLIVE THE CONTROL THAT STARTED IT (#3605), driven through the REAL
// SidebarContent rather than over a synthetic document.
//
// WHAT WAS WRONG. `logoutAfterWipe` wiped this device's PHI and then issued the
// sign-out with `logoutFormRef.current?.requestSubmit()`. That is a DOM read, and the
// node is gone if the mobile drawer unmounts while the async wipe is in flight — which
// four ordinary gestures do (components/MobileNav.tsx: the scrim, Escape, the ✕, the
// drag). The `?.` then made it a SILENT no-op: PHI wiped, write gate shut, no POST, no
// error, no rejection, and a session still alive behind someone who believes they left.
//
// WHY THE COUNT BELOW IS `logoutAction` AND NOT "the new function was called". The
// claim is about the SESSION DESTROY reaching the server, so the only measurement that
// can be trusted is the one that counts the action itself. Asserting that some new
// helper ran would go green against a helper that issues nothing.
//
// THE SECOND TEST IS THE OTHER HALF, and it is the one that stops the fix from trading
// one silence for another. `requestSubmit()` was not only a way to call the action: a
// `<form action={fn}>` hands a REJECTED action to the nearest error boundary, and that
// is the only reason a logout that FAILS is visible at all. A fix that merely called
// `submitLogout()` directly would turn every failure — and, because a successful logout
// reports itself by throwing a redirect, every SUCCESS — into an unhandled rejection.

/** Every wipe the control performed, and every logout attempt it made. */
const calls = { wipe: 0, logout: 0 };

/** Releases the in-flight wipe. Reassigned by each `wipeDeviceForSignOut` call. */
let releaseWipe: () => void = () => {};

/** What the mocked action does when it is finally called. */
let logoutOutcome: () => Promise<void> = async () => {};

vi.mock("@/components/device-wipe", () => ({
  // A wipe that does NOT settle on its own is the whole fixture: the unmount has to
  // happen while it is outstanding, which is the only window the defect lives in.
  wipeDeviceForSignOut: vi.fn(() => {
    calls.wipe += 1;
    return new Promise<void>((resolve) => {
      releaseWipe = resolve;
    });
  }),
  reopenUnlessSessionEnded: vi.fn(async () => {}),
}));

vi.mock("@/app/(app)/session-actions", () => ({
  logoutAction: vi.fn(() => {
    calls.logout += 1;
    return logoutOutcome();
  }),
}));

// The router hooks the sidebar's children read. `unstable_rethrow` is kept REAL — it is
// a barrier in submitLogout's catch and a stub of it would quietly disarm it.
vi.mock("next/navigation", async () => {
  const actual =
    await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    usePathname: () => "/history",
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
    }),
  };
});

// The sidebar's OTHER contents are stand-ins, exactly as in logout-retry.test.tsx: each
// needs a context this question does not turn on. The control, its refs, its effect,
// its guard and the failure relay are the real ones.
vi.mock("../Nav", () => ({ default: () => <nav data-testid="nav" /> }));
vi.mock("../SidebarLogButton", () => ({
  default: () => <button type="button">+ Log</button>,
}));
vi.mock("../ThemeToggle", () => ({ default: () => null }));
vi.mock("../WhatsNewLink", () => ({ default: () => null }));
vi.mock("../ProfileIdentityBar", () => ({ default: () => null }));
vi.mock("../Wordmark", () => ({ default: () => <span>Allos</span> }));
vi.mock("../CommandPalette", () => ({ openGlobalSearch: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import SidebarContent from "../SidebarContent";

const ACTIVE = { id: 1, name: "Sam", photo_path: null, photo_version: 0 };

/** Stands in for app/global-error.tsx: the boundary a sidebar throw actually reaches. */
class Boundary extends Component<
  { children: ReactNode; onError: (err: unknown) => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    this.props.onError(err);
  }
  render() {
    return this.state.failed ? <p>boundary</p> : this.props.children;
  }
}

function mountSidebar(onError: (err: unknown) => void = () => {}) {
  return render(
    <Boundary onError={onError}>
      <SidebarContent
        active={ACTIVE}
        username="sam"
        profiles={[ACTIVE]}
      />
    </Boundary>
  );
}

async function tapLogout(): Promise<void> {
  const button = screen.getByRole("button", { name: "Log out" });
  await act(async () => {
    button.click();
  });
}

describe("A logout survives the sidebar unmounting mid-wipe (#3605)", () => {
  beforeEach(() => {
    calls.wipe = 0;
    calls.logout = 0;
    releaseWipe = () => {};
    logoutOutcome = async () => {};
  });

  it("still ends the session when the drawer closes during the wipe", async () => {
    const { unmount } = mountSidebar();

    await tapLogout();
    expect(calls.wipe, "the tap started the wipe").toBe(1);
    expect(calls.logout, "and the wipe has not finished yet").toBe(0);

    // The drawer's exit animation ends and usePresence unmounts SidebarContent for
    // real — the scrim, Escape, the ✕ or the drag, all four of them here.
    unmount();

    await act(async () => {
      releaseWipe();
    });

    // THE WHOLE CLAIM, IN ONE NUMBER. Through `logoutFormRef.current?.requestSubmit()`
    // this is 0: the device is wiped, the write gate is shut, and the session is still
    // alive with nothing said about it.
    expect(calls.logout, "the session destroy still reached the server").toBe(
      1
    );
  });

  it("still shows a failure when the logout it issued fails", async () => {
    // The replacement for what `<form action={…}>` was giving. Without the relay this
    // rejection has no consumer at all: no boundary, no message, an unhandled rejection
    // and a person left signed in on a wiped device.
    const failure = new Error("logout post never landed");
    logoutOutcome = () => Promise.reject(failure);
    const seen: unknown[] = [];

    mountSidebar((err) => seen.push(err));
    await tapLogout();
    await act(async () => {
      releaseWipe();
    });

    expect(calls.logout, "the attempt was made").toBe(1);
    expect(seen, "and its failure reached an error boundary").toEqual([
      failure,
    ]);
  });
});
