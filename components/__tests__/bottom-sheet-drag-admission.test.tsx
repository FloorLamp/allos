import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BottomSheet from "../BottomSheet";
import { HAPTIC_PATTERNS } from "@/lib/haptics";

type TouchPoint = Pick<Touch, "identifier" | "clientX" | "clientY">;

function touch(
  target: HTMLElement,
  type: "touchstart" | "touchmove" | "touchend",
  point: TouchPoint
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: type === "touchend" ? [] : [point] },
    changedTouches: { value: type === "touchend" ? [point] : [] },
  });
  target.dispatchEvent(event);
}

function dragDown(target: HTMLElement): void {
  const start = { identifier: 1, clientX: 20, clientY: 20 };
  const end = { identifier: 1, clientX: 20, clientY: 260 };
  act(() => {
    touch(target, "touchstart", start);
    touch(target, "touchmove", end);
    touch(target, "touchend", end);
    vi.runAllTimers();
  });
}

function visibleHandle(): void {
  vi.spyOn(
    screen.getByTestId("sheet-drag-handle"),
    "getClientRects"
  ).mockReturnValue({ length: 1 } as DOMRectList);
}

// `dismiss: false` is the REFUSAL — a dirty form routed through a confirm, which is
// what this hook's #2774 contract exists for. It is the default here because every
// admission case below only needs the outcome to have been ASKED.
function renderSheet(dismiss = false) {
  const onClose = vi.fn<() => void>();
  const onGestureDismiss = vi.fn<() => boolean>(() => dismiss);
  render(
    <BottomSheet
      open
      onClose={onClose}
      onGestureDismiss={onGestureDismiss}
      title="Gesture contract"
      description="The sheet chrome shares its visible drag affordance."
      showClose
      presentation="dialog"
    >
      <button type="button">Body control</button>
    </BottomSheet>
  );
  return { onClose, onGestureDismiss };
}

describe("BottomSheet drag admission (#3721)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    );
    vi.stubGlobal("scrollTo", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["title", () => screen.getByRole("heading", { name: "Gesture contract" })],
    [
      "description",
      () =>
        screen.getByText(
          "The sheet chrome shares its visible drag affordance."
        ),
    ],
  ])(
    "admits a drag from the %s outside the content scroller",
    (_name, origin) => {
      const { onGestureDismiss } = renderSheet();
      visibleHandle();

      dragDown(origin());

      expect(onGestureDismiss).toHaveBeenCalledTimes(1);
    }
  );

  it("keeps a Close tap targeted but routes a Close drag through the gesture outcome", () => {
    const { onClose, onGestureDismiss } = renderSheet();
    visibleHandle();
    const close = screen.getByRole("button", { name: "Close" });

    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onGestureDismiss).not.toHaveBeenCalled();

    onClose.mockClear();
    dragDown(close);
    expect(onClose).not.toHaveBeenCalled();
    expect(onGestureDismiss).toHaveBeenCalledTimes(1);
  });

  it("leaves a body touch with native scrolling when content started below its top", () => {
    const { onGestureDismiss } = renderSheet();
    visibleHandle();
    const content = document.querySelector("[data-sheet-content]");
    expect(content).toBeInstanceOf(HTMLElement);
    (content as HTMLElement).scrollTop = 80;

    dragDown(screen.getByRole("button", { name: "Body control" }));

    expect(onGestureDismiss).not.toHaveBeenCalled();
  });

  // THE `select` CUE ON THE OUTCOME (#3699). It rides the drag's ANSWER, not its
  // release, which is the whole reason it can be mounted on the substrate at all: a
  // panel that refused to leave has not left, and a cue that said it had would be
  // lying about the one gesture whose contract is that it may say no.
  it.each([
    ["a committed dismissal buzzes", true, 1],
    ["a refused dismissal is silent", false, 0],
  ])("%s", (_name, dismiss, expected) => {
    const vibrations: number[][] = [];
    vi.stubGlobal("navigator", {
      ...navigator,
      vibrate: (pattern: number | number[]) => {
        vibrations.push(Array.isArray(pattern) ? [...pattern] : [pattern]);
        return true;
      },
    });
    try {
      const { onGestureDismiss } = renderSheet(dismiss);
      visibleHandle();

      dragDown(screen.getByRole("heading", { name: "Gesture contract" }));

      expect(onGestureDismiss).toHaveBeenCalledTimes(1);
      expect(vibrations).toEqual(
        expected === 0 ? [] : [[...HAPTIC_PATTERNS.select]]
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the handle's rendered box as a separate whole-sheet gate", () => {
    const { onGestureDismiss } = renderSheet();
    // jsdom gives the handle no rendered boxes, matching the responsive desktop
    // state BottomSheet reads in the browser.
    dragDown(screen.getByRole("heading", { name: "Gesture contract" }));

    expect(onGestureDismiss).not.toHaveBeenCalled();
  });
});
