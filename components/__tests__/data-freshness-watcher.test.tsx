import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("@/components/DirtyFormRegistry", () => ({
  useChromeRefresh: () => calls.refresh,
}));

import DataFreshnessWatcher from "../DataFreshnessWatcher";

const PROFILE_A = 11;
const PROFILE_B = 22;
const INTERVAL_MS = 15_000;

let hidden = false;
const fetchMock = vi.fn<typeof fetch>();

function response(profileId: number, revision: string): Response {
  return Response.json({ profileId, revision });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function Shell({ profileId }: { profileId: number }) {
  return (
    <>
      <main data-write-revision="4" />
      <DataFreshnessWatcher profileId={profileId} />
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  calls.refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  hidden = false;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "hidden");
});

describe("DataFreshnessWatcher", () => {
  it("requests one guarded repaint for a newer revision until the marker advances", async () => {
    fetchMock
      .mockResolvedValueOnce(response(PROFILE_A, "4"))
      .mockResolvedValueOnce(response(PROFILE_A, "5"))
      .mockResolvedValueOnce(response(PROFILE_A, "5"))
      .mockResolvedValueOnce(response(PROFILE_A, "6"));

    render(<Shell profileId={PROFILE_A} />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls.refresh).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(INTERVAL_MS));
    expect(calls.refresh).toHaveBeenCalledTimes(1);

    // The returned tree has not landed yet, so the same observation is suppressed.
    await act(async () => vi.advanceTimersByTimeAsync(INTERVAL_MS));
    expect(calls.refresh).toHaveBeenCalledTimes(1);

    document.querySelector("main")!.setAttribute("data-write-revision", "5");
    await act(async () => vi.advanceTimersByTimeAsync(INTERVAL_MS));
    expect(calls.refresh).toHaveBeenCalledTimes(2);
  });

  it("does no hidden work, shares overlapping checks, and retires old profile answers", async () => {
    const oldAnswer = deferred<Response>();
    const currentAnswer = deferred<Response>();
    fetchMock
      .mockImplementationOnce(() => oldAnswer.promise)
      .mockImplementationOnce(() => currentAnswer.promise);
    hidden = true;

    const view = render(<Shell profileId={PROFILE_A} />);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent(window, new PopStateEvent("popstate"));
    await act(async () => vi.advanceTimersByTimeAsync(INTERVAL_MS * 2));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    view.rerender(<Shell profileId={PROFILE_B} />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    oldAnswer.resolve(response(PROFILE_A, "9"));
    await settle();
    expect(calls.refresh).not.toHaveBeenCalled();

    currentAnswer.resolve(response(PROFILE_B, "9"));
    await settle();
    expect(calls.refresh).toHaveBeenCalledTimes(1);
  });

  it("retires a visible request when hidden and observes fresh on resume", async () => {
    const oldAnswer = deferred<Response>();
    const resumedAnswer = deferred<Response>();
    fetchMock
      .mockImplementationOnce(() => oldAnswer.promise)
      .mockImplementationOnce(() => resumedAnswer.promise);

    render(<Shell profileId={PROFILE_A} />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    hidden = true;
    fireEvent(document, new Event("visibilitychange"));
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    oldAnswer.resolve(response(PROFILE_A, "9"));
    await settle();
    expect(calls.refresh).not.toHaveBeenCalled();

    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resumedAnswer.resolve(response(PROFILE_A, "9"));
    await settle();
    expect(calls.refresh).toHaveBeenCalledTimes(1);
  });

  it("requests one guarded repaint for current auth refusal or profile mismatch", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({}, { status: 401 }))
      .mockResolvedValueOnce(Response.json({}, { status: 401 }));
    const view = render(<Shell profileId={PROFILE_A} />);
    await settle();
    expect(calls.refresh).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(INTERVAL_MS));
    expect(calls.refresh).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(response(PROFILE_A, "9"));
    view.rerender(<Shell profileId={PROFILE_B} />);
    await settle();
    expect(calls.refresh).toHaveBeenCalledTimes(2);
  });
});
