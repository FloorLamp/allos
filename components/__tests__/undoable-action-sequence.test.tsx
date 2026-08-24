import { useEffect } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ToastProvider } from "../Toast";
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
}: {
  run: () => Promise<UndoOutcome>;
  isCurrent: () => boolean;
}) {
  const announce = useUndoableAction();
  useEffect(() => {
    announce({
      key: "food-serving:7:2026-08-24:berries",
      message: "1 serving of Berries today",
      undo: { undoneMessage: "Serving undone.", run, isCurrent },
    });
  }, [announce, isCurrent, run]);
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
});
