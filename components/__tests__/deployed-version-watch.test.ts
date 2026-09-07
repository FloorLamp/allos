import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { UPDATE_CHECK_MS, waitingWorkerPlan } from "@/lib/sw-update";
import { useDeployedVersion } from "../useDeployedVersion";

// Exercise the polling hook with React's real effect and ref lifetimes.
// e2e/sw-update.spec.ts covers detection through the registrar in a controlled tab.

const PAGE_SHA = "aaaaaaa";
const DEPLOYED_SHA = "bbbbbbb";

type VersionReply =
  | { status: 200; sha: string | null; commitMessage: string | null }
  | { status: 401 };

let reply: VersionReply;
let fetchCalls: number;

function stubVersionEndpoint() {
  fetchCalls = 0;
  return vi.fn(async () => {
    fetchCalls += 1;
    const answer = reply;
    if (answer.status === 401) {
      return { ok: false, status: 401 } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        sha: answer.sha,
        commitMessage: answer.commitMessage,
      }),
    } as unknown as Response;
  });
}

/** Let the in-flight fetch and its `.json()` settle without advancing the clock. */
async function settleReads() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  reply = { status: 200, sha: PAGE_SHA, commitMessage: "The running build" };
  vi.stubGlobal("fetch", stubVersionEndpoint());
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useDeployedVersion (#2329)", () => {
  it("asks the server on MOUNT, before any interval has elapsed", async () => {
    reply = { status: 200, sha: DEPLOYED_SHA, commitMessage: "Ship the thing" };
    const watch = renderHook(() =>
      useDeployedVersion({ baseline: PAGE_SHA, mode: "poll", generation: 0 })
    );

    expect(fetchCalls).toBe(1);

    await settleReads();
    expect(watch.result.current).toEqual({
      sha: DEPLOYED_SHA,
      commitMessage: "Ship the thing",
      settled: true,
    });
  });

  it("keeps polling while the server reports the build this page is on", async () => {
    const watch = renderHook(() =>
      useDeployedVersion({ baseline: PAGE_SHA, mode: "poll", generation: 0 })
    );
    await settleReads();
    expect(fetchCalls).toBe(1);
    expect(watch.result.current).toEqual({
      sha: PAGE_SHA,
      commitMessage: "The running build",
      settled: true,
    });

    reply = { status: 200, sha: DEPLOYED_SHA, commitMessage: "Ship the thing" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS);
    });
    expect(fetchCalls).toBe(2);
    expect(watch.result.current).toEqual({
      sha: DEPLOYED_SHA,
      commitMessage: "Ship the thing",
      settled: true,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS * 3);
    });
    expect(fetchCalls).toBe(2);
  });

  it("settles a read with no SHA and keeps polling", async () => {
    reply = { status: 200, sha: null, commitMessage: null };
    const watch = renderHook(() =>
      useDeployedVersion({ baseline: PAGE_SHA, mode: "poll", generation: 0 })
    );
    await settleReads();
    expect(watch.result.current).toEqual({
      sha: null,
      commitMessage: null,
      settled: true,
    });

    reply = { status: 200, sha: DEPLOYED_SHA, commitMessage: "Ship the thing" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS);
    });
    expect(watch.result.current.sha).toBe(DEPLOYED_SHA);
  });

  it("hands the matching read STRAIGHT to #1905's plan, rather than holding it at wait", async () => {
    const watch = renderHook(() =>
      useDeployedVersion({ baseline: PAGE_SHA, mode: "poll", generation: 0 })
    );
    await settleReads();

    expect(
      waitingWorkerPlan({
        pageSha: PAGE_SHA,
        deployedSha: watch.result.current.sha,
        deployedSettled: watch.result.current.settled,
      })
    ).toBe("activate-silently");
  });

  it("asks nothing with no baseline to compare against", async () => {
    renderHook(() =>
      useDeployedVersion({ baseline: null, mode: "off", generation: 0 })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS * 2);
    });
    expect(fetchCalls).toBe(0);
  });

  it("settles knowing nothing when the endpoint is session-gated (#390)", async () => {
    reply = { status: 401 };
    const watch = renderHook(() =>
      useDeployedVersion({ baseline: PAGE_SHA, mode: "poll", generation: 0 })
    );
    await settleReads();
    expect(watch.result.current).toEqual({
      sha: null,
      commitMessage: null,
      settled: true,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS * 2);
    });
    expect(fetchCalls).toBe(1);
  });

  it("re-arms on a generation bump, and the re-read is immediate too (#1905)", async () => {
    reply = { status: 200, sha: DEPLOYED_SHA, commitMessage: "Ship the thing" };
    const watch = renderHook(
      ({ generation }) =>
        useDeployedVersion({ baseline: PAGE_SHA, mode: "poll", generation }),
      { initialProps: { generation: 0 } }
    );
    await settleReads();
    expect(watch.result.current.settled).toBe(true);
    expect(fetchCalls).toBe(1);

    reply = { status: 200, sha: "ccccccc", commitMessage: "Ship it again" };
    // Keep the mounted hook's refs: a remount would reset the stopped poll itself.
    watch.rerender({ generation: 1 });
    expect(watch.result.current.settled).toBe(false);
    await settleReads();
    expect(fetchCalls).toBe(2);
    expect(watch.result.current).toEqual({
      sha: "ccccccc",
      commitMessage: "Ship it again",
      settled: true,
    });
  });

  it("ignores a 401 that lands after its own read was torn down (#2447)", async () => {
    const deferred: { resolve: (r: Response) => void }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            deferred.push({ resolve });
          })
      )
    );
    const props = { baseline: "0000000" };
    const watch = renderHook(() =>
      useDeployedVersion({
        baseline: props.baseline,
        mode: "poll",
        generation: 0,
      })
    );
    expect(deferred).toHaveLength(1);

    props.baseline = PAGE_SHA;
    watch.rerender();
    expect(deferred).toHaveLength(2);

    deferred[0].resolve({ ok: false, status: 401 } as unknown as Response);
    await settleReads();

    deferred[1].resolve({
      ok: true,
      status: 200,
      json: async () => ({
        sha: DEPLOYED_SHA,
        commitMessage: "Ship the thing",
      }),
    } as unknown as Response);
    await settleReads();

    expect(watch.result.current).toEqual({
      sha: DEPLOYED_SHA,
      commitMessage: "Ship the thing",
      settled: true,
    });
  });
});
