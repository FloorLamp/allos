import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/Toast";
import EpisodeControls from "@/components/illness/EpisodeControls";

const unpromoteEpisodeConditionAction = vi.hoisted(() => vi.fn());
vi.mock("@/app/(app)/medical/episodes/actions", () => ({
  createEpisodeShareLinkAction: vi.fn(),
  promoteEpisodeToConditionAction: vi.fn(),
  unpromoteEpisodeConditionAction,
}));

function held<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (settle = resolve));
  return { promise, settle };
}

function mount() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <EpisodeControls
          episodeId={7}
          situation="Flu"
          ongoing={false}
          promoted
          canWrite
          profileId={3}
        />
      </ConfirmProvider>
    </ToastProvider>
  );
}

const openMenu = () =>
  fireEvent.click(screen.getByTestId("overflow-menu-trigger"));

// "Remove condition" was the LAST kebab write in the app spelled by hand —
// `action={async (fd) => { await unpromoteEpisodeConditionAction(fd); close(); }}`
// — and the shape hid a live defect. `unpromoteEpisodeConditionAction` returns a
// `FormResult` and refuses an episode that is no longer there; the wrapper threw
// that result away, so the menu closed, the item still read "Remove condition",
// and a refused write looked exactly like a lost tap. A thrown one reached the
// route error boundary (#477).
//
// `runAction` reports both, from the menu component that outlives the panel. What
// the site does NOT lose in the move is the "Removing…" pending item: the panel is
// up for the whole round trip either way, because `close()` inside an async
// transition does not commit until the action settles (measured in
// components/OverflowMenu.tsx and pinned in optimistic-tap-writes.test.tsx).
describe("the episode kebab's unpromote write (#2641)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    unpromoteEpisodeConditionAction.mockReset();
  });

  it("posts the episode and holds its pending item until the write settles", async () => {
    const write = held<{ ok: true }>();
    unpromoteEpisodeConditionAction.mockReturnValue(write.promise);
    mount();
    openMenu();

    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Remove condition" })
    );
    await waitFor(() =>
      expect(unpromoteEpisodeConditionAction).toHaveBeenCalledOnce()
    );
    const posted = unpromoteEpisodeConditionAction.mock.calls[0][0] as FormData;
    expect(posted.get("episodeId")).toBe("7");
    // The cross-profile write target travels with the post (#879).
    expect(posted.get("profileId")).toBe("3");

    // The item answers the tap in place while the write runs — the affordance the
    // hand-rolled version had, kept.
    const pending = await screen.findByRole("menuitem", { name: "Removing…" });
    expect(pending.getAttribute("aria-busy")).toBe("true");
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Condition removed")).toBeNull();

    await act(async () => write.settle({ ok: true }));
    await screen.findByText("Condition removed");
    await waitFor(() =>
      expect(
        screen.queryByRole("menuitem", { name: "Remove condition" })
      ).toBeNull()
    );
  });

  it("reports the typed refusal it used to discard", async () => {
    unpromoteEpisodeConditionAction.mockResolvedValue({
      ok: false,
      error: "That episode is no longer available.",
    });
    mount();
    openMenu();

    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Remove condition" })
    );
    // The refusal is the message, in the refusal's own words — never the success
    // sentence, and never silence (#2133).
    await screen.findByText("That episode is no longer available.");
    expect(screen.queryByText("Condition removed")).toBeNull();
  });

  it("reports a dropped write instead of ending in silence", async () => {
    unpromoteEpisodeConditionAction.mockRejectedValue(
      new Error("connection lost")
    );
    mount();
    openMenu();

    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Remove condition" })
    );
    await screen.findByText("Couldn't complete that action. Try again.");
  });
});
