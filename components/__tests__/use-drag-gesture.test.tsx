import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDragGesture } from "../overlay/useDragGesture";

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

function mountScrollAwareDrag() {
  const root = document.createElement("div");
  const handle = document.createElement("div");
  const content = document.createElement("div");
  const body = document.createElement("button");
  handle.append(document.createElement("span"));
  content.append(body);
  root.append(handle, content);
  document.body.append(root);

  const onCommit = vi.fn();
  const canStart = vi.fn(
    (origin: Node) =>
      handle.contains(origin) ||
      (content.contains(origin) && content.scrollTop <= 0)
  );
  renderHook(() =>
    useDragGesture({
      targetRef: { current: root },
      direction: "down",
      canStart,
      onCommit,
    })
  );
  return { body, canStart, content, handle, onCommit };
}

function dragDown(target: HTMLElement, afterStart?: () => void): void {
  const start = { identifier: 1, clientX: 20, clientY: 20 };
  const end = { identifier: 1, clientX: 20, clientY: 260 };
  act(() => {
    touch(target, "touchstart", start);
    afterStart?.();
    touch(target, "touchmove", end);
    touch(target, "touchend", end);
    vi.runAllTimers();
  });
}

describe("useDragGesture touch-start admission (#3691)", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps a body drag admitted when the body started at the top", () => {
    vi.useFakeTimers();
    const { body, canStart, content, onCommit } = mountScrollAwareDrag();

    content.scrollTop = 0;
    dragDown(body, () => {
      // A later scroll change cannot revoke the touch-start decision.
      content.scrollTop = 80;
    });

    expect(canStart).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("keeps a scroll-origin touch native after that scroll reaches the top", () => {
    vi.useFakeTimers();
    const { body, canStart, content, onCommit } = mountScrollAwareDrag();

    content.scrollTop = 80;
    dragDown(body, () => {
      // Reaching the boundary does not turn the same touch into a dismissal.
      content.scrollTop = 0;
    });

    expect(canStart).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("admits the handle at any body scroll position", () => {
    vi.useFakeTimers();
    const { canStart, content, handle, onCommit } = mountScrollAwareDrag();

    content.scrollTop = 200;
    dragDown(handle);

    expect(canStart).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
