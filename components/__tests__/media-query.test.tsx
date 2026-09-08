import { act, cleanup, render, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { useMediaQuery } from "../useMediaQuery";
import { MEDIA_QUERIES, type MediaQuery } from "@/lib/media-queries";

function media() {
  const lists = new Map<
    string,
    { matches: boolean; listeners: Set<() => void> }
  >();
  const matchMedia = vi.fn((query: string) => {
    const state = { matches: false, listeners: new Set<() => void>() };
    lists.set(query, state);
    return {
      get matches() {
        return state.matches;
      },
      addEventListener: (_event: string, listener: () => void) =>
        state.listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) =>
        state.listeners.delete(listener),
    };
  });
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    matchMedia,
    state: (key: MediaQuery) => lists.get(MEDIA_QUERIES[key])!,
    change(key: MediaQuery, matches: boolean) {
      const state = lists.get(MEDIA_QUERIES[key])!;
      state.matches = matches;
      act(() => state.listeners.forEach((listener) => listener()));
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps a shared query live until its last subscriber leaves", () => {
  const browser = media();
  const first = renderHook(() => useMediaQuery("maxMd"));
  const second = renderHook(() => useMediaQuery("maxMd"));
  expect(browser.matchMedia).toHaveBeenCalledTimes(1);
  expect([first.result.current, second.result.current]).toEqual([false, false]);

  browser.change("maxMd", true);
  expect([first.result.current, second.result.current]).toEqual([true, true]);
  first.unmount();
  browser.change("maxMd", false);
  expect(second.result.current).toBe(false);
  second.unmount();
  expect(browser.state("maxMd").listeners.size).toBe(0);
});

it("switches its subscription when the requested query changes", () => {
  const browser = media();
  const hook = renderHook(({ query }) => useMediaQuery(query), {
    initialProps: { query: "reducedMotion" as MediaQuery },
  });
  browser.change("reducedMotion", true);
  expect(hook.result.current).toBe(true);
  hook.rerender({ query: "standalone" });
  expect(hook.result.current).toBe(false);
  expect(browser.state("reducedMotion").listeners.size).toBe(0);
  browser.change("standalone", true);
  expect(hook.result.current).toBe(true);
});

it("hydrates the server fallback before adopting the browser's answer", () => {
  const matchMedia = vi.fn(() => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("matchMedia", matchMedia);
  function Probe() {
    return <span>{String(useMediaQuery("md"))}</span>;
  }
  const container = document.createElement("div");
  container.innerHTML = renderToString(<Probe />);
  expect(container.textContent).toBe("false");
  expect(matchMedia).not.toHaveBeenCalled();
  document.body.append(container);
  const onRecoverableError = vi.fn();
  render(<Probe />, { container, hydrate: true, onRecoverableError });
  expect(container.textContent).toBe("true");
  expect(onRecoverableError).not.toHaveBeenCalled();
});
