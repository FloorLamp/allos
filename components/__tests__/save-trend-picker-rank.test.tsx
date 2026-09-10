import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SaveTrendPicker from "@/components/SaveTrendPicker";

// THE ★ ADD-TILE FORM'S ONE COMMIT (#4014, under #4978's 2026-09-04 13:05 UTC
// form rule: the surface is the FORM, and its commit is the primary).
//
// WHY A TEST AND NOT JUST THE CALL SITE. This mount is the one a file-local
// census cannot rank: the `<SubmitButton>` lives in SaveTrendKeyPicker while its
// `<form>` lives in the parent SaveTrendPicker, so a scan that looks for an
// enclosing form in the same file reads it as a submit with no form and skips
// it. That is exactly how it stayed quiet through the bulk conversion. The
// pairing is only visible once the parent is MOUNTED, which is what this does.
//
// It also reads the RENDERED class rather than the prop: `ButtonProps` is closed
// and the wrappers forward props by name, so a rank that stopped being forwarded
// would typecheck, lint and still paint quiet. Nothing but the DOM catches that.
//
// The second assertion is the rule's other half — the form spends exactly ONE
// loud control. The fold's door is the parent's `<summary>`, not a button, and a
// fold's own door is the same action as its commit rather than a rival primary
// (#4978, 2026-09-05); this pins that it is still a summary, since turning it
// into a button would put a second loud control on the surface.

vi.mock("@/app/(app)/saved-actions", () => ({
  toggleSavedItem: async () => {},
}));

afterEach(cleanup);

function mount() {
  render(
    <SaveTrendPicker
      metrics={[
        { key: "metric:weight", label: "Weight", kind: "metric" },
        { key: "metric:steps", label: "Steps", kind: "metric" },
      ]}
    />
  );
  return screen.getByTestId("save-trend-picker");
}

describe("the ★ add-tile picker's rank (#4014)", () => {
  it("paints its one commit as the primary", () => {
    const form = mount();
    const star = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(star?.textContent).toContain("Star");
    expect(star?.className).toContain("button-control-primary");
  });

  it("spends exactly one loud control on the surface", () => {
    const form = mount();
    expect(form.querySelectorAll('button[type="submit"]')).toHaveLength(1);
    expect(form.querySelectorAll(".button-control-primary")).toHaveLength(1);

    // The door into the fold is a summary, so it is not a rival control.
    const door = screen.getByTestId("save-trend-picker-toggle");
    expect(door.tagName).toBe("SUMMARY");
    expect(
      screen
        .getByTestId("save-trend-picker-disclosure")
        .querySelectorAll(".button-control-primary")
    ).toHaveLength(1);
  });
});
