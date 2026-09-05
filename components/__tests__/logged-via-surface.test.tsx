import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";

import DoseConfirmButton from "@/components/DoseConfirmButton";
import {
  LoggedViaSurface,
  useLoggedVia,
  useLoggedViaStamp,
} from "@/components/LoggedViaSurface";
import { LOGGED_VIA_FIELD, type StampedFormData } from "@/lib/logged-via";

vi.mock("@/components/useUndoableAction", () => ({
  useUndoableAction: () => () => {},
}));

// WHICH SURFACE A MOUNTING IS (#3087) — the half that only exists once something is
// mounted, which is what this tier is for (docs/internals/component-tests.md).
//
// The vocabulary and the server-side parse are pure and live in lib/logged-via.ts with
// their own tests. What cannot go there is the answer to "what does a control report
// when it is rendered HERE rather than THERE" — the whole mechanism is a React
// context, so it has no behaviour at all until a tree exists. The Server Actions that
// read the posted value are driven end to end in
// lib/__action_tests__/logged-via-surfaces.actions.test.ts; this is the other end of
// the same wire.

/** A control that posts, in the smallest form the real ones share. */
function stampOf(wrapper?: React.ComponentType<{ children: React.ReactNode }>) {
  const { result } = renderHook(() => useLoggedViaStamp(), { wrapper });
  const fd = new FormData();
  result.current(fd);
  return fd.get(LOGGED_VIA_FIELD);
}

describe("a control reports the region it is mounted in", () => {
  it("answers `page` with no region declared — an answer, not a fallback", () => {
    // A control a domain page renders, with nothing declared above it, IS on that
    // page's own form. It is the same value every `parseWebOrigin` caller passes as
    // its fallback, so the two agree by construction.
    expect(stampOf()).toBe("page");
    expect(renderHook(() => useLoggedVia()).result.current).toBe("page");
  });

  it("answers the DECLARED region, which is the whole point of the mechanism", () => {
    // The failure this replaces: the same component, mounted in the quick-log sheet
    // and on its domain page, posting the same Server Action and indistinguishable at
    // the server. Threading a prop meant every call site was somewhere to forget.
    for (const surface of [
      "quick-log",
      "dashboard-widget",
      "dashboard-hero",
      "page",
    ] as const) {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <LoggedViaSurface value={surface}>{children}</LoggedViaSurface>
      );
      expect(stampOf(wrapper), surface).toBe(surface);
    }
  });

  it("lets the NEAREST region win, so a sheet inside a dashboard is the sheet", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <LoggedViaSurface value="dashboard-widget">
        <LoggedViaSurface value="quick-log">{children}</LoggedViaSurface>
      </LoggedViaSurface>
    );
    expect(stampOf(wrapper)).toBe("quick-log");
  });

  it("REPLACES rather than appends, so a resubmission cannot post two surfaces", () => {
    const { result } = renderHook(() => useLoggedViaStamp());
    const fd = new FormData();
    fd.append(LOGGED_VIA_FIELD, "quick-log");
    result.current(fd);
    expect(fd.getAll(LOGGED_VIA_FIELD)).toEqual(["page"]);
  });
});

describe("a DOM-collected `<form action={…}>` reaches its action stamped", () => {
  // THE OTHER SHAPE, and the one a hidden `<LoggedViaField />` used to serve (#5349).
  // A `<form action>` builds its FormData from the DOM, so nothing the control did
  // earlier is in it — and `DoseConfirmButton` is that form: the server component
  // hands it `markTaken`, which reads the posted surface. The declaration therefore
  // has to happen in the submit handler, between the browser's FormData and the
  // action, which is what the brand now makes the only compiling arrangement.
  //
  // Driven through a real submit rather than by calling the handler, because the
  // FormData under test is the one the BROWSER builds.
  it.each([["dashboard-widget"], [null]] as const)(
    "posts the region %s declares",
    async (region) => {
      const posted: (string | null)[] = [];
      const button = (
        <DoseConfirmButton
          action={async (fd: StampedFormData) => {
            posted.push(fd.get(LOGGED_VIA_FIELD) as string | null);
            return { ok: true, outcome: "logged" };
          }}
          fields={{ dose_id: 7 }}
        >
          Mark taken
        </DoseConfirmButton>
      );
      render(
        region ? (
          <LoggedViaSurface value={region}>{button}</LoggedViaSurface>
        ) : (
          button
        )
      );
      fireEvent.click(screen.getByRole("button", { name: "Mark taken" }));
      await waitFor(() => expect(posted).toEqual([region ?? "page"]));
    }
  );
});
