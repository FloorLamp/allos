import { useRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useActivateToastProfile } from "@/components/Toast";
import {
  useKeyedReceipt,
  type ReceiptSession,
} from "@/components/useUndoableAction";
import { useWritePipeline } from "@/components/useWritePipeline";
import QuickSubstanceList from "@/components/quick-entry/QuickSubstanceList";
import type { UndoOutcome } from "@/lib/undo-offer";

// THE KEYED RECEIPT, THROUGH THE TOAST STACK THAT RENDERS IT (#5738).
//
// Everything here reads the SCREEN: the sentence that is up, the Undo the person can
// reach, the receipt that is or is not still there after an unmount or a profile
// switch. A mock of `useUndoableAction` would answer the question "was the hook
// called", which is not the question — the two hand-rolled lifecycles this substrate
// replaces both called their hooks correctly and still put the wrong sentence on
// screen. So the real `ToastProvider`, the real cards, and the real ownership
// arithmetic run in every case below.
//
// The owner guard is the interesting half, and it has two sides that fail differently:
// LIVENESS (this mount, this subject, this profile scope — checked by `isCurrent`) and
// OWNERSHIP (who holds the slot right now — checked by the toast's `onlyIfOwner`). A
// session can be perfectly live and still have lost its slot to a newer tap.

const substanceActions = vi.hoisted(() => ({
  log: vi.fn(),
  undo: vi.fn(),
}));
vi.mock("@/app/(app)/medical/substance-use/actions", () => ({
  logSubstanceUnitAction: substanceActions.log,
  undoSubstanceUnitAction: substanceActions.undo,
  addSubstanceDailyTotalAction: vi.fn(),
  correctSubstanceUseAction: vi.fn(),
}));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
  useQueuedDayContextCapture: () => () => null,
}));

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

// Puts a profile scope on the toast stack and offers a way to move it, which is what a
// profile switch does to every receipt already on screen.
function Acting({ profileId }: { profileId: number }) {
  const activate = useActivateToastProfile();
  const [live, setLive] = useState<number | null>(null);
  if (live !== profileId) {
    setLive(profileId);
    activate(profileId);
  }
  return null;
}

// One surface that earns receipts in a named slot. `tap` opens a session and announces;
// `late` announces again from the session the last tap opened, which is what a slow
// continuation — an inverse, a second server answer — does when it finally lands.
function Earner({
  subject,
  slot,
  name,
  undo,
}: {
  subject: string;
  slot: string;
  name: string;
  undo?: () => Promise<UndoOutcome>;
}) {
  const openReceipt = useKeyedReceipt(subject);
  const opened = useRef<ReceiptSession | null>(null);
  const announce = (session: ReceiptSession, message: string) =>
    session.announce({
      key: slot,
      message,
      undo: undo ? { undoneMessage: `${name} undone.`, run: undo } : null,
    });
  return (
    <>
      <button
        type="button"
        onClick={() => {
          const session = openReceipt();
          opened.current = session;
          announce(session, `${name} logged.`);
        }}
      >
        {name} tap
      </button>
      <button
        type="button"
        onClick={() => {
          if (opened.current) announce(opened.current, `${name} again.`);
        }}
      >
        {name} late
      </button>
    </>
  );
}

function receipts(): string[] {
  return screen
    .queryAllByTestId("toast")
    .map((card) => card.querySelector("p")?.textContent ?? "");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  cleanup();
  window.matchMedia = mediaQuery;
  vi.clearAllMocks();
  substanceActions.log.mockResolvedValue({
    ok: true,
    weekCount: 3,
    eventId: 41,
    date: "2026-08-20",
  });
  substanceActions.undo.mockResolvedValue({ ok: true, weekCount: 2 });
});

// Two surfaces competing for ONE slot. Rendered from a single component so the pair
// keeps its position when A leaves — swapping children around would unmount B too, and
// the case would pass for the wrong reason.
function Pair({
  showA,
  undoA,
}: {
  showA: boolean;
  undoA?: () => Promise<UndoOutcome>;
}) {
  return (
    <>
      {showA ? (
        <Earner subject="a" slot="unit:1" name="A" undo={undoA} />
      ) : null}
      <Earner subject="b" slot="unit:1" name="B" />
    </>
  );
}

describe("a receipt belongs to the interaction that earned it", () => {
  it("leaves the newer owner's receipt on screen when the older owner unmounts", () => {
    const view = render(
      <ToastProvider>
        <Pair showA />
      </ToastProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "A tap" }));
    expect(receipts()).toEqual(["A logged."]);

    // B takes the slot: one target, one receipt, so this is a replace and not a stack.
    fireEvent.click(screen.getByRole("button", { name: "B tap" }));
    expect(receipts()).toEqual(["B logged."]);

    // A goes away and dismisses what it claimed — which is no longer this slot.
    view.rerender(
      <ToastProvider>
        <Pair showA={false} />
      </ToastProvider>
    );
    expect(receipts()).toEqual(["B logged."]);
  });

  // THE POSITIVE CONTROL for the case above: the same unmount, with nobody else having
  // taken the slot, really does take the receipt off the screen. Without this, an
  // unmount cleanup that had quietly stopped running would pass the test above.
  it("takes a receipt with the surface that earned it", () => {
    const view = render(
      <ToastProvider>
        <Earner subject="a" slot="unit:1" name="A" />
      </ToastProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "A tap" }));
    expect(receipts()).toEqual(["A logged."]);

    view.rerender(<ToastProvider />);
    expect(receipts()).toEqual([]);
  });

  it("does not publish an inverse over the receipt a newer tap already posted", async () => {
    const inverse = deferred<UndoOutcome>();
    render(
      <ToastProvider>
        <Pair showA undoA={() => inverse.promise} />
      </ToastProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "A tap" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.click(screen.getByRole("button", { name: "B tap" }));
    expect(receipts()).toEqual(["B logged."]);

    await act(async () => {
      inverse.resolve({ ok: true });
      await inverse.promise;
    });
    // A's inverse landed, and A is still mounted and still current — it simply does not
    // own this slot any more, so the person keeps reading B's receipt.
    expect(receipts()).toEqual(["B logged."]);
    expect(screen.queryByText("A undone.")).toBeNull();
  });

  it("ends the receipts earned under a subject when the surface is re-pointed", () => {
    const view = render(
      <ToastProvider>
        <Earner subject="p42" slot="unit:1" name="A" />
      </ToastProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "A tap" }));
    expect(receipts()).toEqual(["A logged."]);

    view.rerender(
      <ToastProvider>
        <Earner subject="p43" slot="unit:1" name="A" />
      </ToastProvider>
    );
    expect(receipts()).toEqual([]);

    // …and the session opened under the old subject stays quiet when it lands late.
    fireEvent.click(screen.getByRole("button", { name: "A late" }));
    expect(receipts()).toEqual([]);
  });

  it("clears a receipt on a profile switch and mutes the session that earned it", () => {
    const view = render(
      <ToastProvider>
        <Acting profileId={7} />
        <Earner subject="p42" slot="unit:1" name="A" />
      </ToastProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "A tap" }));
    expect(receipts()).toEqual(["A logged."]);
    // The control: the same late continuation publishes while the scope still holds.
    fireEvent.click(screen.getByRole("button", { name: "A late" }));
    expect(receipts()).toEqual(["A again."]);

    view.rerender(
      <ToastProvider>
        <Acting profileId={9} />
        <Earner subject="p42" slot="unit:1" name="A" />
      </ToastProvider>
    );
    expect(receipts()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "A late" }));
    expect(receipts()).toEqual([]);
  });
});

// TENANT ONE — the substance row control, which used to spell this lifecycle by hand.
describe("the substance row control's receipt", () => {
  function sheet(subjectProfileId: number, actingProfileId = 7) {
    return (
      <ToastProvider>
        <Acting profileId={actingProfileId} />
        <QuickSubstanceList
          date="2026-08-20"
          subjectProfileId={subjectProfileId}
          substances={[
            {
              key: "nicotine",
              label: "Nicotine",
              logLabel: "Log a use",
              capProgress: null,
            },
          ]}
        />
      </ToastProvider>
    );
  }

  it("renders the receipt and the Undo the tap earned, and the undone sentence after it", async () => {
    render(sheet(42));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Log a use" }))
    );
    expect(receipts()).toEqual(["Use logged."]);

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    );
    await waitFor(() => expect(receipts()).toEqual(["Use undone."]));
    expect(substanceActions.undo).toHaveBeenCalledTimes(1);
  });

  // ONE SLOT PER EVENT, so two uses logged a minute apart leave two receipts and each
  // Undo takes back its OWN use. A single shared slot would put the second receipt over
  // the first and leave the first use with no way back.
  it("gives each logged use its own slot and its own inverse", async () => {
    vi.useFakeTimers();
    try {
      render(sheet(42));
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Log a use" }))
      );
      substanceActions.log.mockResolvedValue({
        ok: true,
        weekCount: 4,
        eventId: 42,
        date: "2026-08-20",
      });
      // The ledger's inert window absorbs a second tap that lands on top of the first.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_001);
      });
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Log a use" }))
      );
      expect(receipts()).toEqual(["Use logged.", "Use logged."]);

      const undos = screen.getAllByRole("button", { name: "Undo" });
      expect(undos).toHaveLength(2);
      await act(async () => fireEvent.click(undos[0]!));
      const sent = substanceActions.undo.mock.calls[0]![0] as FormData;
      expect(sent.get("event_id")).toBe("41");
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the receipt away when the row is pointed at another person", async () => {
    const view = render(sheet(42));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Log a use" }))
    );
    expect(receipts()).toEqual(["Use logged."]);

    view.rerender(sheet(43));
    expect(receipts()).toEqual([]);
  });

  it("says nothing about a tap whose acting profile moved while it was in flight", async () => {
    const answer = deferred<{
      ok: true;
      weekCount: number;
      eventId: number;
      date: string;
    }>();
    substanceActions.log.mockReturnValue(answer.promise);
    const view = render(sheet(42, 7));
    fireEvent.click(screen.getByRole("button", { name: "Log a use" }));
    view.rerender(sheet(42, 9));

    await act(async () => {
      answer.resolve({
        ok: true,
        weekCount: 3,
        eventId: 41,
        date: "2026-08-20",
      });
      await answer.promise;
    });
    expect(receipts()).toEqual([]);
    expect(screen.queryByRole("alert")?.textContent ?? "").toBe("");
  });
});

// TENANT TWO — the write pipeline, for a caller that declares a slot on its spec.
function PipelineTap({
  subject,
  slot,
  name,
  keyed = true,
}: {
  subject: string;
  slot: string;
  name: string;
  keyed?: boolean;
}) {
  const pipeline = useWritePipeline("substance-unit");
  const openReceipt = useKeyedReceipt(subject);
  return (
    <button
      type="button"
      onClick={() =>
        void pipeline.run({
          key: name,
          fields: { substance: "nicotine" },
          action: async () => ({ ok: true }) as const,
          settle: () => ({
            wrote: true,
            announce: { message: `${name} logged.`, undo: null },
          }),
          receipt: keyed ? { open: openReceipt, key: slot } : undefined,
          failureMessage: "Couldn't log that.",
        })
      }
    >
      {name} tap
    </button>
  );
}

describe("a pipeline caller that declares a receipt slot", () => {
  it("keeps one receipt in the slot and clears it on a profile switch", async () => {
    const view = render(
      <ToastProvider>
        <Acting profileId={7} />
        <PipelineTap subject="p42" slot="unit:1" name="First" />
        <PipelineTap subject="p42" slot="unit:1" name="Second" />
      </ToastProvider>
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "First tap" }))
    );
    expect(receipts()).toEqual(["First logged."]);

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Second tap" }))
    );
    expect(receipts()).toEqual(["Second logged."]);

    view.rerender(
      <ToastProvider>
        <Acting profileId={9} />
        <PipelineTap subject="p42" slot="unit:1" name="First" />
        <PipelineTap subject="p42" slot="unit:1" name="Second" />
      </ToastProvider>
    );
    expect(receipts()).toEqual([]);
  });

  // THE ADDITIVE HALF. A caller that declares no slot gets exactly what it had before:
  // an append-only toast with no stamp, which no profile switch takes away.
  it("leaves an undeclared announcement stacking and unstamped", async () => {
    const view = render(
      <ToastProvider>
        <Acting profileId={7} />
        <PipelineTap subject="p42" slot="unit:1" name="First" keyed={false} />
        <PipelineTap subject="p42" slot="unit:1" name="Second" keyed={false} />
      </ToastProvider>
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "First tap" }))
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Second tap" }))
    );
    expect(receipts()).toEqual(["First logged.", "Second logged."]);

    view.rerender(
      <ToastProvider>
        <Acting profileId={9} />
        <PipelineTap subject="p42" slot="unit:1" name="First" keyed={false} />
        <PipelineTap subject="p42" slot="unit:1" name="Second" keyed={false} />
      </ToastProvider>
    );
    expect(receipts()).toEqual(["First logged.", "Second logged."]);
  });
});
