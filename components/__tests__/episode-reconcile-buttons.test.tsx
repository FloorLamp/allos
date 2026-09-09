import { fireEvent, render, screen, within } from "@testing-library/react";
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

const END = (
  <EndEpisodeReconcile
    episodeId={7}
    meds={[
      { itemId: 19, name: "Ibuprofen", klass: "otc-prn", defaultChecked: true },
    ]}
    triggerLabel="End episode"
    triggerTestId="episode-end"
  />
);
const REOPEN = (
  <ReopenEpisodeReconcile
    episodeId={7}
    meds={[{ itemId: 19, name: "Ibuprofen" }]}
  />
);

describe("episode reconciliation triggers", () => {
  it("opens the end checklist through the ordinary Button treatment", () => {
    render(END);

    const trigger = screen.getByRole("button", { name: "End episode" });
    expect(trigger.getAttribute("type")).toBe("button");
    expect(trigger.getAttribute("data-testid")).toBe("episode-end");
    expect(trigger.getAttribute("data-button-control")).toBe("");

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

  // THE ROW CONVERTS WHOLE (#4978 ruling 3, 2026-09-05). Both checklists confirm
  // through what used to be a filled `.btn` beside a raw `.btn-ghost` Cancel;
  // neither is inside a `<form>`, so the commit takes the SECONDARY paint and the
  // pair ends up as one treatment rather than the mismatched row the owner
  // declined. Asserted over BOTH controls of the row at once, which is what makes
  // a half-converted row fail here rather than only in a browser.
  it.each([
    {
      row: "end",
      element: END,
      trigger: "End episode",
      dialog: "End this episode?",
      commitTestId: "episode-med-reconcile-confirm",
      commitLabel: "End episode",
    },
    {
      row: "reopen",
      element: REOPEN,
      trigger: "Reopen episode",
      dialog: "Reopen this episode?",
      commitTestId: "episode-reopen-confirm",
      commitLabel: "Reopen episode",
    },
  ])(
    "renders the $row checklist's commit and its Cancel as one treatment",
    ({ element, trigger, dialog, commitTestId, commitLabel }) => {
      render(element);
      fireEvent.click(screen.getByRole("button", { name: trigger }));

      const row = screen.getByRole("dialog", { name: dialog });
      const commit = screen.getByTestId(commitTestId);
      const cancel = within(row).getByRole("button", { name: "Cancel" });

      expect(commit.textContent).toBe(commitLabel);
      for (const control of [commit, cancel]) {
        expect(control.className.split(" ")).toEqual(["button-control"]);
        expect(control.getAttribute("data-button-control")).toBe("");
        expect(control.getAttribute("type")).toBe("button");
      }
    }
  );

  it("opens the reopen checklist through the ordinary Button treatment", () => {
    render(REOPEN);

    const trigger = screen.getByRole("button", { name: "Reopen episode" });
    expect(trigger.getAttribute("type")).toBe("button");
    expect(trigger.getAttribute("data-testid")).toBe("episode-reopen-action");
    expect(trigger.getAttribute("data-button-control")).toBe("");

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
