import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import EndEpisodeReconcile from "@/components/illness/EndEpisodeReconcile";
import ReopenEpisodeReconcile from "@/components/illness/ReopenEpisodeReconcile";

vi.mock("@/components/Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("@/components/ModalShell", () => ({
  default: ({ title, children }: { title: string; children: ReactNode }) => (
    <section role="dialog" aria-label={title}>
      {children}
    </section>
  ),
}));
vi.mock("@/app/(app)/medical/episodes/actions", () => ({
  endEpisodeWithMedsAction: vi.fn(),
  reopenEpisodeAction: vi.fn(),
}));

describe("episode reconciliation triggers", () => {
  it("opens the end checklist through the ordinary Button treatment", () => {
    render(
      <EndEpisodeReconcile
        episodeId={7}
        meds={[
          {
            itemId: 19,
            name: "Ibuprofen",
            klass: "otc-prn",
            defaultChecked: true,
          },
        ]}
        triggerLabel="End episode"
        triggerTestId="episode-end"
      />
    );

    const trigger = screen.getByRole("button", { name: "End episode" });
    expect(trigger.getAttribute("type")).toBe("button");
    expect(trigger.getAttribute("data-testid")).toBe("episode-end");
    expect(trigger.getAttribute("data-button-control")).toBe("");
    expect(trigger.className).toBe("button-control");

    fireEvent.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "End this episode?" })
    ).not.toBeNull();
    expect(
      (
        screen.getByRole("checkbox", {
          name: /Ibuprofen/,
        }) as HTMLInputElement
      ).checked
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("dialog", { name: "End this episode?" })
    ).toBeNull();
  });

  it("opens the reopen checklist through the ordinary Button treatment", () => {
    render(
      <ReopenEpisodeReconcile
        episodeId={7}
        meds={[{ itemId: 19, name: "Ibuprofen" }]}
      />
    );

    const trigger = screen.getByRole("button", { name: "Reopen episode" });
    expect(trigger.getAttribute("type")).toBe("button");
    expect(trigger.getAttribute("data-testid")).toBe("episode-reopen-action");
    expect(trigger.getAttribute("data-button-control")).toBe("");
    expect(trigger.className).toBe("button-control");

    fireEvent.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "Reopen this episode?" })
    ).not.toBeNull();
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Ibuprofen",
        }) as HTMLInputElement
      ).checked
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("dialog", { name: "Reopen this episode?" })
    ).toBeNull();
  });
});
