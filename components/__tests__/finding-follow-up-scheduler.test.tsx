import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import FindingFollowUpScheduler from "@/components/FindingFollowUpScheduler";

describe("FindingFollowUpScheduler", () => {
  it("owns the closed intervals, anatomy, accessible names, and compact geometry", () => {
    render(
      <FindingFollowUpScheduler action={vi.fn()} kind="imaging" sourceId={42} />
    );
    const form = screen.getByTestId("track-followup-42") as HTMLFormElement;
    const select = screen.getByRole("combobox", {
      name: "Follow-up interval",
    }) as HTMLSelectElement;
    expect(form.elements.namedItem("study_id")).toHaveProperty("value", "42");
    expect([
      select.value,
      ...Array.from(select.options, (o) => o.text),
    ]).toEqual(["365", "3 months", "6 months", "12 months"]);
    expect(form.className).toContain("inline-flex max-w-full");
    expect(
      screen.getByRole("button", { name: "Track follow-up" }).className
    ).toContain("shrink-0");
  });

  it("posts the owned fields and keeps its name while pending", async () => {
    let finish!: () => void;
    const action = vi.fn(
      (_formData: FormData) =>
        new Promise<void>((resolve) => (finish = resolve))
    );
    render(
      <FindingFollowUpScheduler action={action} kind="dental" sourceId={42} />
    );
    const form = screen.getByTestId("track-dental-followup-42");
    const button = screen.getByRole("button", { name: "Track recheck" });
    fireEvent.change(
      screen.getByRole("combobox", { name: "Recheck interval" }),
      {
        target: { value: "365" },
      }
    );
    act(() => fireEvent.submit(form));
    const submitted = action.mock.calls[0][0];

    expect([
      submitted.get("record_id"),
      submitted.get("interval_days"),
    ]).toEqual(["42", "365"]);
    expect([
      button.getAttribute("aria-busy"),
      (button as HTMLButtonElement).disabled,
    ]).toEqual(["true", true]);
    expect(screen.getByRole("button", { name: "Track recheck" })).toBe(button);
    await act(async () => finish());
  });

  it("owns tracked-state presentation and domain wording", () => {
    const existing = {
      plannedDate: "2026-11-03",
      resolution: null,
      status: "pending",
    };
    const view = render(
      <FindingFollowUpScheduler
        action={vi.fn()}
        existing={existing}
        kind="lab"
        sourceId={42}
      />
    );
    expect(screen.getByTestId("lab-followup-state").textContent).toBe(
      "Follow-up: recheck due 2026-11-03"
    );
    view.rerender(
      <FindingFollowUpScheduler
        action={vi.fn()}
        existing={{ ...existing, plannedDate: null, resolution: "stable" }}
        kind="skin"
        sourceId={42}
      />
    );
    expect(screen.getByTestId("skin-followup-state-42").textContent).toBe(
      "Recheck: resolved · stable"
    );
  });
});
