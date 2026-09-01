import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  toast: vi.fn(),
  dismiss: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: calls.push }),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => calls.toast,
  useDismissToast: () => calls.dismiss,
}));

vi.mock("@/components/DirtyFormRegistry", () => ({
  useChromeRefresh: () => calls.refresh,
}));

import ExtractionToaster from "../ExtractionToaster";

const PROFILE_A = 11;
const PROFILE_B = 22;

type Envelope = {
  profileId: number;
  states: Array<{
    id: number;
    filename: string;
    status: string;
    count: number;
    error: string | null;
  }>;
};

const doc = (id: number, status: string) => ({
  id,
  filename: `document-${id}.pdf`,
  status,
  count: status === "done" ? 1 : 0,
  error: null,
});

let envelopes: Envelope[];
const fetchMock = vi.fn<typeof fetch>();

function queue(profileId: number, states: Envelope["states"]): void {
  envelopes.push({ profileId, states });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  envelopes = [];
  for (const mock of Object.values(calls)) mock.mockReset();
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    const envelope = envelopes.shift();
    if (!envelope) throw new Error("poll ran without a queued response");
    return Response.json({ ok: true, ...envelope });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "hidden");
});

describe("ExtractionToaster profile-switch polling", () => {
  it("refuses cross-profile answers before diffing or seeding", async () => {
    queue(PROFILE_A, [doc(1, "processing")]);
    const view = render(<ExtractionToaster profileId={PROFILE_A} />);
    await settle();

    // The session switches before the new profile prop arrives. A terminal row
    // from B must not be diffed against A's live seed.
    queue(PROFILE_B, [doc(2, "done")]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(calls.toast).not.toHaveBeenCalled();

    // The converse stale-answer window: once the prop is B, an A response must
    // not become B's seed. The next matching B answer seeds silently.
    queue(PROFILE_A, [doc(1, "done")]);
    view.rerender(<ExtractionToaster profileId={PROFILE_B} />);
    await settle();
    queue(PROFILE_B, [doc(2, "done")]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(calls.toast).not.toHaveBeenCalled();
    expect(calls.refresh).not.toHaveBeenCalled();

    // Positive control: a genuinely new completion on the matching profile still
    // traverses the same poll loop and announces once.
    queue(PROFILE_B, [doc(2, "done"), doc(3, "done")]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(calls.toast).toHaveBeenCalledTimes(1);
    expect(calls.toast).toHaveBeenCalledWith(
      "document-3.pdf: imported 1 record.",
      expect.objectContaining({ key: "doc-3" })
    );
  });
});
