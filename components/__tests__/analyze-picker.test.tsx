import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AnalyzePicker from "@/app/(app)/training/AnalyzePicker";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

beforeEach(() => {
  push.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

describe("AnalyzePicker option identity (#3512)", () => {
  it("keeps an entity named All training distinct from the aggregate option", () => {
    const entityHref =
      "/training?tab=analyze&kind=strength&item=All+training&metric=volume&range=12w";
    render(
      <AnalyzePicker
        options={[
          {
            kind: "strength",
            item: "All training",
            label: "All training",
            href: entityHref,
            sessions: 3,
            lastDate: "2026-08-20",
          },
        ]}
        value="All training"
        allTrainingHref="/training?tab=analyze&range=12w"
      />
    );

    const picker = screen.getByRole("combobox", {
      name: "Exercise or activity",
    });
    fireEvent.focus(picker);

    // The badge disambiguates the user-created entity in the visible list, while
    // keyed option identities keep the two identical labels from sharing a route.
    fireEvent.mouseDown(
      screen.getByRole("option", { name: "All trainingStrength" })
    );
    expect(push).toHaveBeenLastCalledWith(entityHref);

    fireEvent.blur(picker);
    fireEvent.focus(picker);
    fireEvent.mouseDown(screen.getByRole("option", { name: /^All training$/ }));
    expect(push).toHaveBeenLastCalledWith("/training?tab=analyze&range=12w");
  });
});
