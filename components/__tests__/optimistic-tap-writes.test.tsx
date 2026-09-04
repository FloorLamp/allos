import { useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/Toast";
import FindingRow from "@/components/FindingRow";
import { FindingCard } from "@/components/FindingCard";
import OverflowMenu, {
  OverflowMenuSubmitItem,
} from "@/components/OverflowMenu";
import type { Finding } from "@/lib/findings";

const dismissIntakeFinding = vi.hoisted(() => vi.fn());
vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  dismissIntakeFinding,
}));

const FINDING: Finding = {
  domain: "coaching",
  dedupeKey: "training-balance:push-pull",
  title: "Push and pull are drifting apart",
  detail: "Four push sessions to one pull in the last two weeks.",
  evidence: "Last 14 days",
  tone: "caution",
};

function held<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (settle = resolve));
  return { promise, settle };
}

// #2641 gap 2: a tap-shaped write must show its DESTINATION state in the same frame,
// and must un-show it when the write did not happen. These three surfaces are the
// shared ones — every findings list renders FindingRow, every intake warning renders
// FindingCard, and every kebab in the app runs through OverflowMenu's runAction — so
// what they do is what dozens of call sites do.
describe("optimistic paint on tap-shaped writes (#2641)", () => {
  // The menu's panel anchors itself with a ResizeObserver, which jsdom has not got.
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });

  it("hides a finding row on the tap and brings it back when the write did not land", async () => {
    const write = held<void>();
    const dismiss = vi.fn((_fd: FormData) => write.promise);
    render(
      <ToastProvider>
        <ul>
          <FindingRow
            finding={FINDING}
            dismissAction={dismiss}
            itemTestid="row"
            dismissTestid="row-dismiss"
          />
        </ul>
      </ToastProvider>
    );
    expect(screen.getByTestId("row")).toBeTruthy();

    fireEvent.click(screen.getByTestId("row-dismiss"));
    // The paint is the row's absence, and it is there before the server answers.
    await waitFor(() => expect(screen.queryByTestId("row")).toBeNull());
    expect(dismiss).toHaveBeenCalledOnce();
    expect(dismiss.mock.calls[0]?.[0].get("dedupe_key")).toBe(
      FINDING.dedupeKey
    );

    // The write settled without the row leaving the server's render — a refusal, or a
    // dedupeKey outside this surface's namespace. The optimistic value falls away with
    // the transition and the row is visibly back rather than silently gone.
    await act(async () => write.settle());
    await waitFor(() => expect(screen.queryByTestId("row")).not.toBeNull());
  });

  it("reports a dropped dismiss instead of leaving the row painted away", async () => {
    const dismiss = vi.fn((_fd: FormData) =>
      Promise.reject(new Error("connection lost"))
    );
    render(
      <ToastProvider>
        <ul>
          <FindingRow
            finding={FINDING}
            dismissAction={dismiss}
            itemTestid="row"
            dismissTestid="row-dismiss"
          />
        </ul>
      </ToastProvider>
    );
    fireEvent.click(screen.getByTestId("row-dismiss"));
    await screen.findByText("Couldn't dismiss that. Try again.");
    await waitFor(() => expect(screen.queryByTestId("row")).not.toBeNull());
  });

  it("answers an intake finding card's typed refusal and un-hides the card", async () => {
    dismissIntakeFinding.mockResolvedValue({
      ok: false,
      error: "Couldn't dismiss that finding.",
    });
    render(
      <ToastProvider>
        <FindingCard
          tone="amber"
          testid="ul-warning"
          title="Above the upper limit"
          detail="Zinc 60mg"
          evidence="UL 40mg"
          dismissKey="intake-ul:zinc"
          dismissLabel="Dismiss zinc warning"
        />
      </ToastProvider>
    );
    fireEvent.click(screen.getByTestId("intake-finding-dismiss"));
    await screen.findByText("Couldn't dismiss that finding.");
    // A PRESENCE assertion, so waiting longer can only ever be honest: a card that
    // was never restored does not appear however long this waits.
    await waitFor(() =>
      expect(screen.queryByTestId("ul-warning")).not.toBeNull()
    );
  });

  // WHAT A KEBAB WRITE ACTUALLY PAINTS WHILE IT IS IN FLIGHT.
  //
  // This case used to be called "closes the overflow menu on the tap rather than
  // on the response" and asserted `onOpenChange` had been CALLED with false. It
  // had — `runAction` calls `close()` before the await — but a call is not a
  // commit: `open` was a literal here and `onOpenChange` a spy, so the panel was
  // never asked to unmount and the assertion could not have failed either way.
  //
  // Given a real controlled parent, the panel stays up for the whole round trip.
  // A form's `action` runs inside a React transition, and a state update made
  // inside an async transition is not committed until the action settles — so
  // `close()` moves when the close is REQUESTED, not when it is SEEN. The same
  // thing is visible in the browser on a held Server Action POST
  // (components/OverflowMenu.tsx carries that measurement).
  //
  // Which makes the pending item the only in-flight answer a kebab gives, and it
  // is asserted here as such rather than assumed either way.
  it("keeps the panel and its pending item up until the write settles", async () => {
    const write = held<void>();
    const action = vi.fn((_fd: FormData) => write.promise);
    // Not a literal: lib/__tests__/overflow-menu-identity.test.ts scans every mount
    // for a hard-coded itemName, and this row has a name like any other.
    const rowName = FINDING.title;
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <OverflowMenu itemName={rowName} open={open} onOpenChange={setOpen}>
          {({ runAction }) => (
            <form action={(fd) => runAction(action, fd, "Snoozed for 1 week")}>
              <input
                type="hidden"
                name="signal_key"
                value="preventive:shingles"
              />
              <OverflowMenuSubmitItem pendingLabel="Snoozing…">
                1 week
              </OverflowMenuSubmitItem>
            </form>
          )}
        </OverflowMenu>
      );
    }
    render(
      <ToastProvider>
        <Host />
      </ToastProvider>
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "1 week" }));
    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    // The item reports itself as busy, in place, while the write runs.
    const pending = await screen.findByRole("menuitem", { name: "Snoozing…" });
    expect(pending.getAttribute("aria-busy")).toBe("true");
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    // And the success message is NOT claimed before the write has settled.
    expect(screen.queryByText("Snoozed for 1 week")).toBeNull();

    await act(async () => write.settle());
    await screen.findByText("Snoozed for 1 week");
    // Only now does the panel go.
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: "1 week" })).toBeNull()
    );
  });
});
