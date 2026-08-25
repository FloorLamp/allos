import { useEffect } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useClaimToastKey, useToast } from "../Toast";
import { useUndoableAction } from "../useUndoableAction";
import type { UndoOutcome } from "@/lib/undo-offer";

function mediaQuery(): MediaQueryList {
  return {
    matches: false,
    media: "",
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  };
}

function Announcement({
  run,
  isCurrent,
  owner,
}: {
  run: () => Promise<UndoOutcome>;
  isCurrent: () => boolean;
  owner?: symbol;
}) {
  const announce = useUndoableAction();
  const claim = useClaimToastKey();
  useEffect(() => {
    if (owner) claim("food-serving:7:2026-08-24:berries", owner);
    announce({
      key: "food-serving:7:2026-08-24:berries",
      message: "1 serving of Berries today",
      owner,
      undo: { undoneMessage: "Serving undone.", run, isCurrent },
    });
  }, [announce, claim, isCurrent, owner, run]);
  return null;
}

function deferredOutcome() {
  let resolve!: (outcome: UndoOutcome) => void;
  return {
    promise: new Promise<UndoOutcome>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

function OwnedReceipt({
  owner,
  message,
  claimOwner,
  duration = null,
}: {
  owner: symbol;
  message: string;
  claimOwner: boolean;
  duration?: number | null;
}) {
  const claim = useClaimToastKey();
  const toast = useToast();
  useEffect(() => {
    if (claimOwner) claim("owned-receipt", owner);
    toast(message, {
      key: "owned-receipt",
      owner,
      onlyIfOwner: true,
      duration,
    });
  }, [claim, claimOwner, duration, message, owner, toast]);
  return null;
}

describe("useUndoableAction mutation sequence", () => {
  beforeEach(() => {
    window.matchMedia = mediaQuery;
  });

  it("does not let an older inverse outcome replace a newer keyed receipt", async () => {
    const pending = deferredOutcome();
    let current = true;
    render(
      <ToastProvider>
        <Announcement run={() => pending.promise} isCurrent={() => current} />
      </ToastProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    current = false;
    await act(async () => pending.resolve({ ok: true }));

    await waitFor(() =>
      expect(screen.queryByText("Serving undone.")).toBeNull()
    );
  });

  it("publishes the inverse outcome while its mutation is still current", async () => {
    render(
      <ToastProvider>
        <Announcement run={async () => ({ ok: true })} isCurrent={() => true} />
      </ToastProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Serving undone.")).toBeTruthy();
  });

  it("does not let an older inverse outcome replace a newer lifecycle claim", async () => {
    const pending = deferredOutcome();
    const oldOwner = Symbol("old offer");
    const newOwner = Symbol("new offer");
    const view = render(
      <ToastProvider>
        <Announcement
          owner={oldOwner}
          run={() => pending.promise}
          isCurrent={() => true}
        />
      </ToastProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    view.rerender(
      <ToastProvider>
        <Announcement
          owner={newOwner}
          run={async () => ({ ok: true })}
          isCurrent={() => true}
        />
      </ToastProvider>
    );
    expect(screen.getByText("1 serving of Berries today")).toBeTruthy();

    await act(async () => pending.resolve({ ok: true }));

    expect(screen.getByText("1 serving of Berries today")).toBeTruthy();
    expect(screen.queryByText("Serving undone.")).toBeNull();
  });

  it("keeps an action-click claim alive after its card exits", async () => {
    vi.useFakeTimers();
    const pending = deferredOutcome();
    const owner = Symbol("slow inverse");
    render(
      <ToastProvider>
        <Announcement
          owner={owner}
          run={() => pending.promise}
          isCurrent={() => true}
        />
      </ToastProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(screen.queryByTestId("toast")).toBeNull();

    await act(async () => pending.resolve({ ok: true }));
    expect(screen.getByText("Serving undone.")).toBeTruthy();
    vi.useRealTimers();
  });

  it("cancels a keyed lifecycle when the reader closes its card", () => {
    const owner = Symbol("closed receipt");
    const view = render(
      <ToastProvider>
        <OwnedReceipt owner={owner} message="Current receipt" claimOwner />
      </ToastProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    view.rerender(
      <ToastProvider>
        <OwnedReceipt
          owner={owner}
          message="Late continuation"
          claimOwner={false}
        />
      </ToastProvider>
    );

    expect(screen.queryByText("Late continuation")).toBeNull();
  });

  it("cancels a keyed lifecycle when its card times out", async () => {
    vi.useFakeTimers();
    const owner = Symbol("timed receipt");
    const view = render(
      <ToastProvider>
        <OwnedReceipt
          owner={owner}
          message="Current receipt"
          claimOwner
          duration={1}
        />
      </ToastProvider>
    );
    await act(async () => vi.advanceTimersByTime(1));

    view.rerender(
      <ToastProvider>
        <OwnedReceipt
          owner={owner}
          message="Late continuation"
          claimOwner={false}
        />
      </ToastProvider>
    );

    expect(screen.queryByText("Late continuation")).toBeNull();
    vi.useRealTimers();
  });
});
