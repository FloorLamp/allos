import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CgmGlucoseToggle from "@/app/(app)/integrations/health-connect/CgmGlucoseToggle";

const setCgmGlucose = vi.hoisted(() => vi.fn());
vi.mock("@/app/(app)/integrations/health-connect/actions", () => ({
  setCgmGlucose,
}));

// A write that is held OPEN until this test says otherwise — the deterministic form
// of the race in #4972, which in the browser depended on whether a reload beat the
// Server Action. Here "unsettled" is not a timing window that a fast machine can
// close; it is every moment between the flip and `settle()`.
function held() {
  let settle!: () => void;
  let fail!: (err: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    settle = () => resolve();
    fail = reject;
  });
  return { promise, settle, fail };
}

const card = () => screen.getByTestId("hc-cgm-glucose");
const box = () =>
  screen.getByTestId("hc-cgm-glucose-toggle") as HTMLInputElement;

// #4972. The switch used to hold its value in its own `useState` and flip it
// synchronously, with the write inside a bare `useTransition` and nothing rendered
// while that transition was open. So the checkbox reported the new value the instant
// it was clicked and NOTHING on the card said the write had not landed — a reload or
// a navigation in that window cancelled it, and the page came back showing the
// opposite of what the person had just chosen. It is now on `useSaveStatus` +
// `SaveStatus` like the other tap-is-the-save controls, which makes the outstanding
// write visible (to a person, and to e2e's `settledCheckSave`) and makes the revert
// on a failed write structural rather than this file's to remember.
describe("the CGM glucose switch cannot hide an unsettled write (#4972)", () => {
  it.each([
    { direction: "off→on", initial: false },
    { direction: "on→off", initial: true }, // the half that failed in CI
  ])(
    "$direction: says the write is open until it lands",
    async ({ initial }) => {
      const write = held();
      setCgmGlucose.mockImplementation(() => write.promise);
      render(<CgmGlucoseToggle initial={initial} />);
      expect(box().checked).toBe(initial);

      fireEvent.click(box());
      // The tap still paints in the same frame (#2641) — the fix must not be bought by
      // making the control wait for the round trip.
      await waitFor(() => expect(box().checked).toBe(!initial));
      // …and the card announces the open write, scoped to the card, which is exactly
      // what `awaitAutosaveSettled` reads before a spec is allowed to reload.
      expect(within(card()).getByLabelText("Saving")).toBeTruthy();

      write.settle();
      await waitFor(() =>
        expect(within(card()).queryByLabelText("Saving")).toBeNull()
      );
      expect(box().checked).toBe(!initial);
    }
  );

  it("puts the switch back when the write throws, and still says so", async () => {
    const write = held();
    setCgmGlucose.mockImplementation(() => write.promise);
    render(<CgmGlucoseToggle initial={false} />);

    fireEvent.click(box());
    await waitFor(() => expect(box().checked).toBe(true));

    write.fail(new Error("nope"));
    // Both halves together (#4747): the restore and the error flag land in one
    // transition whose `pending` clears a commit later, and the spinner is rendered
    // in preference to the error icon while it is true.
    await waitFor(() => {
      expect(box().checked).toBe(false);
      expect(within(card()).getByLabelText("Couldn’t save")).toBeTruthy();
    });
  });
});
