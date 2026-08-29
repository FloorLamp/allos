import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SegmentedControl from "../SegmentedControl";
import PullToRefresh from "../PullToRefresh";
import { ToastProvider, useToast } from "../Toast";
import { HAPTIC_PATTERNS } from "@/lib/haptics";

// THE SUBSTRATE MOUNTS (#3699), pinned where they are cheapest to pin.
//
// Haptics used to be four hand-placed calls, and the reason they never grew is that
// the CUE was chosen at the call site. They mount on the substrates now — the one
// toast provider, and the gesture recognizers — so coverage comes from a handful of
// files and no feature component names a pattern. What that buys is only real if the
// provider actually fires, only for the right tone, and NOT for a poster nobody asked
// for; those three are what this file holds.
//
// A stubbed `navigator.vibrate` records what the app ASKED FOR, which is the same
// approach e2e/live-workout-hardware.spec.ts takes for the two original cues and for
// the same reason: no headless environment has a motor.

function stubVibrate(): number[][] {
  const calls: number[][] = [];
  vi.stubGlobal("navigator", {
    ...navigator,
    vibrate: (pattern: number | number[]) => {
      calls.push(Array.isArray(pattern) ? [...pattern] : [pattern]);
      return true;
    },
  });
  return calls;
}

// PullToRefresh listens to nothing outside an installed PWA, so its own gate has to
// be satisfied before the cue can be reached at all.
function stubReducedMotion(reduce: boolean, standalone = false): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion")
        ? reduce
        : standalone && query.includes("display-mode: standalone"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );
}

function Poster({
  options,
}: {
  options?: { tone?: "success" | "error"; silent?: boolean };
}) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast("Saved.", options)}>
      Post
    </button>
  );
}

describe("the toast provider carries commit and reject (#3699)", () => {
  beforeEach(() => stubReducedMotion(false));
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["the default tone", undefined, [[...HAPTIC_PATTERNS.commit]]],
    ["an explicit success", { tone: "success" as const }, [[...HAPTIC_PATTERNS.commit]]],
    ["an error", { tone: "error" as const }, [[...HAPTIC_PATTERNS.reject]]],
    ["a headless poster", { silent: true }, []],
  ] as [string, { tone?: "success" | "error"; silent?: boolean } | undefined, number[][]][])(
    "%s",
    (_name, options, expected) => {
      const calls = stubVibrate();
      render(
        <ToastProvider>
          <Poster options={options} />
        </ToastProvider>
      );

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Post" }));
      });

      // The toast itself is posted either way — `silent` is about the hand, never
      // about what is on screen.
      expect(screen.getByText("Saved.")).toBeTruthy();
      expect(calls).toEqual(expected);
    }
  );

  it("stays silent under prefers-reduced-motion (#1307)", () => {
    stubReducedMotion(true);
    const calls = stubVibrate();
    render(
      <ToastProvider>
        <Poster />
      </ToastProvider>
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Post" }));
    });

    expect(screen.getByText("Saved.")).toBeTruthy();
    expect(calls).toEqual([]);
  });
});

describe("SegmentedControl answers the finger with select (#3699)", () => {
  beforeEach(() => stubReducedMotion(false));
  afterEach(() => vi.unstubAllGlobals());

  const options = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Bravo" },
  ];

  it.each([
    ["a segment that changes the value", "Bravo", [[...HAPTIC_PATTERNS.select]]],
    ["the segment already selected", "Alpha", []],
  ] as [string, string, number[][]][])("%s", (_name, label, expected) => {
    const calls = stubVibrate();
    const onChange = vi.fn();
    render(
      <SegmentedControl
        options={options}
        value="a"
        onChange={onChange}
        ariaLabel="Kind"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: label }));

    // The binding is untouched either way: the cue rides the change, it does not
    // replace it.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(expected);
  });
});

// The pull's own gesture recognizer is pure and already covered; what needs a DOM is
// the CROSSING — touchmove fires at frame rate, so a cue on the armed STATE rather
// than on the transition into it would buzz continuously while a finger rests past
// the threshold.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

function pullTo(deltaY: number): void {
  const point = { identifier: 1, clientX: 10, clientY: 10 + deltaY };
  const move = new Event("touchmove", { bubbles: true });
  Object.defineProperty(move, "touches", { value: [point] });
  act(() => {
    const start = new Event("touchstart", { bubbles: true });
    Object.defineProperty(start, "touches", {
      value: [{ identifier: 1, clientX: 10, clientY: 10 }],
    });
    if (deltaY === 0) window.dispatchEvent(start);
    else window.dispatchEvent(move);
  });
}

describe("a pull crossing into armed says so (#3699)", () => {
  beforeEach(() => stubReducedMotion(false, true));
  afterEach(() => vi.unstubAllGlobals());

  it("fires select once at the crossing, not once per frame", () => {
    const calls = stubVibrate();
    render(<PullToRefresh />);

    pullTo(0);
    // 128px of finger travel is what PTR_RESISTANCE turns into the 64px arming
    // distance; 100 is a real pull that has not got there.
    pullTo(100);
    expect(calls).toEqual([]);

    pullTo(140);
    expect(calls).toEqual([[...HAPTIC_PATTERNS.select]]);

    // Held past the threshold, and dragged further: the claim has already been made.
    pullTo(160);
    pullTo(200);
    expect(calls).toEqual([[...HAPTIC_PATTERNS.select]]);

    // Back below it and across again — a second crossing IS a second answer.
    pullTo(100);
    pullTo(140);
    expect(calls).toEqual([
      [...HAPTIC_PATTERNS.select],
      [...HAPTIC_PATTERNS.select],
    ]);
  });
});
