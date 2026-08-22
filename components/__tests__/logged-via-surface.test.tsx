import { describe, expect, it } from "vitest";
import { render, renderHook, screen } from "@testing-library/react";

import {
  LoggedViaField,
  LoggedViaSurface,
  useLoggedVia,
  useLoggedViaStamp,
} from "@/components/LoggedViaSurface";
import { LOGGED_VIA_FIELD } from "@/lib/logged-via";

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

describe("the hidden field, for a plain <form action={…}>", () => {
  it("carries the declared region into a form that builds its own FormData", () => {
    // A `<form action>` never passes through a callback, so the declaration has to be
    // in the DOM. Read back off the rendered input rather than off the component's
    // props: what the browser posts is the value that is actually there.
    render(
      <LoggedViaSurface value="dashboard-widget">
        <form aria-label="widget form">
          <LoggedViaField />
        </form>
      </LoggedViaSurface>
    );
    const form = screen.getByLabelText("widget form") as HTMLFormElement;
    expect(new FormData(form).get(LOGGED_VIA_FIELD)).toBe("dashboard-widget");
  });

  it("posts `page` when no region is declared, never nothing", () => {
    // An absent field and a `page` field are the same thing to the server's parse.
    // Posting one anyway is what makes a wired form visibly wired.
    render(
      <form aria-label="page form">
        <LoggedViaField />
      </form>
    );
    const form = screen.getByLabelText("page form") as HTMLFormElement;
    expect(new FormData(form).get(LOGGED_VIA_FIELD)).toBe("page");
  });
});
