import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import FollowUpResolveControls from "@/components/FollowUpResolveControls";

describe("FollowUpResolveControls", () => {
  it.each([
    ["Resolved", "resolved"],
    ["Stable", "stable"],
    ["Changed", "changed"],
  ] as const)("posts the %s submitter through Button", async (label, value) => {
    const result = Promise.withResolvers<void>();
    const action = vi.fn((_formData: FormData) => result.promise);
    render(
      <FollowUpResolveControls
        action={action}
        carePlanItemId={42}
        resolvingRecordId={73}
        profileId={9}
      />
    );

    const button = screen.getByRole("button", { name: label });
    expect(button.className).toBe("button-control");
    expect(button.getAttribute("data-button-control")).toBe("");
    fireEvent.click(button);

    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    const submitted = action.mock.calls[0][0];
    expect([
      submitted.get("care_plan_item_id"),
      submitted.get("resolving_study_id"),
      submitted.get("profile_id"),
      submitted.get("resolution"),
    ]).toEqual(["42", "73", "9", value]);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();

    await act(async () => result.resolve());
  });
});
