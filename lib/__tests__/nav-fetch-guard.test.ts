import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  NAV_RETRY_DELAYS_MS,
  hasNavRetryBudget,
  headerValue,
  installNavFetchGuard,
  isNavigationRscFetch,
  isNetworkFailure,
  navRetryDelayMs,
} from "@/lib/nav-fetch-guard";
import {
  getNavProgress,
  resetNavProgress,
  retryNavProgress,
  startNavProgress,
} from "@/lib/nav-progress";

const NAV_HEADERS = {
  RSC: "1",
  "Next-Router-State-Tree": "tree1",
};

describe("headerValue", () => {
  it("reads a plain object case-insensitively — Next passes one", () => {
    expect(headerValue({ RSC: "1" }, "rsc")).toBe("1");
    expect(headerValue({ rsc: "1" }, "RSC")).toBe("1");
  });

  it("reads a Headers instance", () => {
    expect(headerValue(new Headers({ RSC: "1" }), "RSC")).toBe("1");
  });

  it("reads an entry array", () => {
    expect(headerValue([["RSC", "1"]], "rsc")).toBe("1");
  });

  it("is null for a header that is not there, and for no headers at all", () => {
    expect(headerValue({ RSC: "1" }, "Next-Router-Prefetch")).toBeNull();
    expect(headerValue(undefined, "RSC")).toBeNull();
  });
});

describe("isNavigationRscFetch", () => {
  it("matches the App Router reading a route for a navigation", () => {
    expect(isNavigationRscFetch({ method: "GET", headers: NAV_HEADERS })).toBe(
      true
    );
  });

  it("does not match a prefetch — holding one would stall the control, not the navigation", () => {
    expect(
      isNavigationRscFetch({
        method: "GET",
        headers: { ...NAV_HEADERS, "Next-Router-Prefetch": "1" },
      })
    ).toBe(false);
  });

  it("does not match a Server Action, which is a POST", () => {
    // This is the whole reason the guard lives at the fetch layer rather than
    // behind `experimental.useOffline`: the write path must keep rejecting, so
    // the offline write queue still sees the failure it queues on.
    expect(
      isNavigationRscFetch({
        method: "POST",
        headers: { "Next-Action": "action1", RSC: "1" },
      })
    ).toBe(false);
  });

  it("does not match an ordinary app fetch", () => {
    expect(
      isNavigationRscFetch({ method: "GET", headers: { Accept: "text/html" } })
    ).toBe(false);
  });
});

describe("isNetworkFailure", () => {
  it("is true for the TypeError a dropped connection produces", () => {
    expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("is false for a deliberate abort or timeout", () => {
    expect(isNetworkFailure(new DOMException("stop", "AbortError"))).toBe(false);
    expect(isNetworkFailure(new DOMException("slow", "TimeoutError"))).toBe(
      false
    );
  });

  it("is false for an ordinary error", () => {
    expect(isNetworkFailure(new Error("boom"))).toBe(false);
  });
});

describe("the retry budget", () => {
  it("is bounded, and stepped rather than immediate", () => {
    expect(NAV_RETRY_DELAYS_MS.length).toBeGreaterThan(0);
    const delays = NAV_RETRY_DELAYS_MS.map((_, i) => navRetryDelayMs(i + 1));
    expect(delays).toEqual([...NAV_RETRY_DELAYS_MS]);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });

  it("runs out, so a dead connection is told rather than retried forever", () => {
    expect(hasNavRetryBudget(NAV_RETRY_DELAYS_MS.length)).toBe(true);
    expect(hasNavRetryBudget(NAV_RETRY_DELAYS_MS.length + 1)).toBe(false);
    expect(navRetryDelayMs(NAV_RETRY_DELAYS_MS.length + 1)).toBe(0);
  });
});

// A stand-in for the browser global the guard wraps. The point of these tests is
// the guard's DECISIONS — what it wraps, what it retries, what it holds — so the
// window is the smallest thing that can carry a `fetch` property.
function fakeWindow(fetchImpl: typeof fetch) {
  return { fetch: fetchImpl } as unknown as Window;
}

const ok = () => new Response("payload", { status: 200 });

describe("installNavFetchGuard", () => {
  beforeEach(() => {
    resetNavProgress();
  });

  afterEach(() => {
    resetNavProgress();
    vi.useRealTimers();
  });

  it("installs once, so a re-entry cannot stack wrappers", () => {
    const win = fakeWindow(vi.fn(async () => ok()));
    installNavFetchGuard(win);
    const wrapped = win.fetch;
    installNavFetchGuard(win);
    expect(win.fetch).toBe(wrapped);
  });

  it("passes a non-navigation fetch straight through, arguments untouched", async () => {
    const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ok()
    );
    const win = fakeWindow(inner);
    installNavFetchGuard(win);

    const body = "dose=1";
    await win.fetch("/timeline", { method: "POST", body });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner.mock.calls[0][1]).toMatchObject({ method: "POST", body });
  });

  it("passes a fetch with no init through", async () => {
    const inner = vi.fn(async () => ok());
    const win = fakeWindow(inner);
    installNavFetchGuard(win);
    await win.fetch("/api/things");
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("retries a navigation read that dies at the network, and lands it", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const inner = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return ok();
    });
    const win = fakeWindow(inner);
    installNavFetchGuard(win);
    startNavProgress();

    const result = win.fetch("/timeline", { headers: NAV_HEADERS });
    await vi.advanceTimersByTimeAsync(NAV_RETRY_DELAYS_MS[0]);
    expect((await result).ok).toBe(true);
    expect(calls).toBe(2);
    // A blip that the retry rode out is a SLOW navigation, not a failed one.
    expect(getNavProgress()).not.toBe("failed");
  });

  it("hands an abort straight back rather than retrying it", async () => {
    const controller = new AbortController();
    controller.abort();
    const inner = vi.fn(async () => {
      throw new DOMException("stop", "AbortError");
    });
    const win = fakeWindow(inner);
    installNavFetchGuard(win);
    startNavProgress();

    await expect(
      win.fetch("/timeline", { headers: NAV_HEADERS, signal: controller.signal })
    ).rejects.toThrow(DOMException);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("holds the navigation open once the budget is spent, and never rejects it", async () => {
    vi.useFakeTimers();
    const inner = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const win = fakeWindow(inner);
    installNavFetchGuard(win);
    startNavProgress();

    let settled = false;
    void win.fetch("/timeline", { headers: NAV_HEADERS }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    for (const delay of NAV_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    await vi.advanceTimersByTimeAsync(10_000);

    // Rejecting is what Next turns into the hard exit that throws away the page
    // the person is still using. So it does not reject — it asks.
    expect(settled).toBe(false);
    expect(getNavProgress()).toBe("failed");
    expect(inner).toHaveBeenCalledTimes(NAV_RETRY_DELAYS_MS.length + 1);
  });

  it("goes again on retry, and lands the navigation it was holding", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const inner = vi.fn(async () => {
      calls += 1;
      if (calls <= NAV_RETRY_DELAYS_MS.length + 1) {
        throw new TypeError("Failed to fetch");
      }
      return ok();
    });
    const win = fakeWindow(inner);
    installNavFetchGuard(win);
    startNavProgress();

    const result = win.fetch("/timeline", { headers: NAV_HEADERS });
    for (const delay of NAV_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(getNavProgress()).toBe("failed");

    retryNavProgress();
    await vi.advanceTimersByTimeAsync(0);
    expect((await result).ok).toBe(true);
  });

  it("rejects a background read nobody is waiting on, exactly as today", async () => {
    // A poll-driven `router.refresh()` runs on a timer with no one watching.
    // Turning a polling miss into a banner would make the banner meaningless, so
    // an unwatched read keeps today's behavior once its retries are spent.
    vi.useFakeTimers();
    const inner = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const win = fakeWindow(inner);
    installNavFetchGuard(win);
    expect(getNavProgress()).toBe("idle");

    const result = win.fetch("/timeline", { headers: NAV_HEADERS });
    const assertion = expect(result).rejects.toThrow(TypeError);
    for (const delay of NAV_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    await assertion;
    expect(getNavProgress()).toBe("idle");
  });
});
