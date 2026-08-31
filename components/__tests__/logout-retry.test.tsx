import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

// A LOGOUT THAT NEVER ANSWERS MUST STILL BE RETRYABLE (#3515), driven through the
// REAL control rather than over a synthetic document.
//
// WHY THIS FILE EXISTS BESIDE logout-tap.test.ts. That one executes
// LOGOUT_BOOT_SCRIPT over hand-written HTML — the capture half of #3515, which has
// no component in it. It therefore cannot see anything about the REPLAY half: the
// `logoutStarted` ref, the effect, the onClick, and the interaction between them all
// live in SidebarContent and none of them is exercised by a string of HTML. A guard
// added to that ref shipped with no test in the tier that could observe it, and the
// regression it caused — a hung logout POST latching the control shut for the rest
// of the document's life — was found by hand. This is the tier that would have.
//
// WHAT IS BEING CLAIMED: a tap whose POST is still outstanding does not disable the
// control. The person tapping Log out in a dead zone is this app's own subject
// matter; on `main` their second tap was a second attempt, and any one of the
// attempts can land when signal returns. That must stay true.

/** Every wipe the control performed, and every logout attempt it made. */
const calls = { wipe: 0, logout: 0 };

vi.mock("@/components/device-wipe", () => ({
  wipeDeviceForSignOut: vi.fn(async () => {
    calls.wipe += 1;
  }),
  reopenUnlessSessionEnded: vi.fn(async () => {}),
}));

vi.mock("@/app/(app)/session-actions", () => ({
  // THE POST THAT NEVER ANSWERS — the case device-wipe.ts describes in its own
  // words: "a link that accepts the connection and then stops carrying it sits for
  // the browser's own connect/read timeout, which is minutes." A promise that never
  // settles is that link, and it is the only fixture in which the question can be
  // asked: while it is outstanding, `submitLogout`'s catch cannot run.
  logoutAction: vi.fn(() => {
    calls.logout += 1;
    return new Promise<never>(() => {});
  }),
}));

// The router hooks the sidebar's children read. `unstable_rethrow` is kept REAL —
// it is a barrier in submitLogout's catch and a stub of it would quietly disarm the
// thing the surrounding comment spends thirty lines pinning.
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

// The sidebar's OTHER contents are stand-ins. Each one needs a context this
// question does not turn on (the activity editor, the command palette, a router
// that prefetches), and none of them can reach the logout ref. The control itself,
// its form, its refs, its effect and its guard are the real ones — that is the part
// under test.
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

function mountSidebar() {
  return render(
    <SidebarContent
      active={ACTIVE}
      username="sam"
      profiles={[ACTIVE]}
    />
  );
}

/** Tap Log out and let the wipe's microtasks and the submit settle. */
async function tapLogout(): Promise<void> {
  const button = screen.getByRole("button", { name: "Log out" });
  await act(async () => {
    button.click();
  });
}

describe("Log out stays retryable while a POST is outstanding (#3515)", () => {
  beforeEach(() => {
    calls.wipe = 0;
    calls.logout = 0;
  });

  it("makes a SECOND attempt when the first one never answers", async () => {
    mountSidebar();

    await tapLogout();
    expect(calls.wipe, "first tap wipes").toBe(1);
    expect(calls.logout, "first tap posts").toBe(1);

    await tapLogout();

    // The whole claim, in one number. A guard that latches on the first tap and
    // is only released by a catch downstream of the outstanding POST makes this 1
    // — a spinner that says "working on it" indefinitely, on a device whose PHI is
    // already wiped and whose write gate is already shut, with the session still
    // alive and no escape but a reload. On `main` this is 2, and it must stay 2.
    expect(calls.logout, "the retry is a real second attempt").toBe(2);
    expect(calls.wipe, "and it wipes again — clearQueue is idempotent").toBe(2);
  });

  it("keeps saying it is working while the first attempt is outstanding", async () => {
    // The retry above must not be bought by dropping the pending state: the
    // person tapping again is doing so BECAUSE nothing has visibly happened, and
    // a control that reset itself between taps would be telling them the attempt
    // was abandoned when it is still open.
    mountSidebar();
    const button = screen.getByRole("button", { name: "Log out" });

    await tapLogout();

    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("data-pending")).toBe(true);
  });
});
