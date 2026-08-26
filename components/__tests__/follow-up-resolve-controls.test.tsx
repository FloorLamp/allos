import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import FollowUpResolveControls from "@/components/FollowUpResolveControls";

describe("FollowUpResolveControls", () => {
  it("keeps all three resolution submitters", () => {
    render(
      <FollowUpResolveControls
        action={vi.fn()}
        carePlanItemId={42}
        resolvingRecordId={73}
        profileId={9}
      />
    );

    for (const [label, value] of [
      ["Resolved", "resolved"],
      ["Stable", "stable"],
      ["Changed", "changed"],
    ]) {
      const button = screen.getByRole("button", { name: label });
      expect(button.getAttribute("name")).toBe("resolution");
      expect(button.getAttribute("value")).toBe(value);
      expect(button.className).toBe("button-control");
    }
  });
});
