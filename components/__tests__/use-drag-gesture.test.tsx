import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useDragGesture,
  verticalScrollOwnersAtTop,
} from "../overlay/useDragGesture";

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
  const title = document.createElement("h2");
  const description = document.createElement("p");
  const close = document.createElement("button");
  const content = document.createElement("div");
  const nested = document.createElement("div");
  const body = document.createElement("button");
  handle.append(document.createElement("span"));
  nested.style.overflowY = "auto";
  Object.defineProperties(nested, {
    clientHeight: { value: 100 },
    scrollHeight: { value: 400 },
  });
  nested.append(body);
  content.append(nested);
  root.append(handle, title, description, close, content);
  document.body.append(root);

  const onCommit = vi.fn();
  const canStart = vi.fn(
    (origin: Node) =>
      !content.contains(origin) || verticalScrollOwnersAtTop(origin, content)
  );
  renderHook(() =>
    useDragGesture({
      targetRef: { current: root },
      direction: "down",
      canStart,
      onCommit,
    })
  );
  return {
    body,
    canStart,
    close,
    content,
    description,
    handle,
    nested,
    onCommit,
    title,
  };
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

  it("keeps a nested scroll owner's touch native after it reaches the top", () => {
    vi.useFakeTimers();
    const { body, canStart, content, nested, onCommit } =
      mountScrollAwareDrag();

    content.scrollTop = 0;
    nested.scrollTop = 80;
    dragDown(body, () => {
      nested.scrollTop = 0;
    });

    expect(canStart).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each(["handle", "title", "description", "close"] as const)(
    "admits %s chrome at any body scroll position",
    (key) => {
      vi.useFakeTimers();
      const mounted = mountScrollAwareDrag();

      mounted.content.scrollTop = 200;
      dragDown(mounted[key]);

      expect(mounted.canStart).toHaveBeenCalledTimes(1);
      expect(mounted.onCommit).toHaveBeenCalledTimes(1);
    }
  );
});
