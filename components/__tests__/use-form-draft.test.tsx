import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef } from "react";
import { ActiveProfileProvider } from "@/components/ActiveProfileProvider";
import { useFormDraft, type FormDraftApi } from "@/components/useFormDraft";
import type { FormDraft } from "@/lib/offline/drafts";
import { hasUnsavedWork, resetUnsavedWork } from "@/lib/offline/unsaved-work";

const db = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
  removeRevision: vi.fn(),
  purge: vi.fn(),
}));

vi.mock("@/lib/offline/draft-db", () => ({
  getDraft: db.get,
  putDraft: db.put,
  deleteDraft: db.remove,
  deleteDraftRevision: db.removeRevision,
  purgeExpiredDrafts: db.purge,
}));

let draft: FormDraftApi;

function Harness({ extra = 0 }: { extra?: number }) {
  const formRef = useRef<HTMLFormElement>(null);
  const api = useFormDraft({
    formKey: "medication",
    formRef,
    extra: { extra },
  });
  useEffect(() => {
    draft = api;
  }, [api]);
  return (
    <form ref={formRef}>
      <input aria-label="Name" name="name" defaultValue="" />
    </form>
  );
}

function mount(extra = 0) {
  return render(
    <ActiveProfileProvider profileId={7}>
      <Harness extra={extra} />
    </ActiveProfileProvider>
  );
}

async function flushAutosave() {
  await act(async () => {
    vi.advanceTimersByTime(600);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetUnsavedWork();
  db.get.mockReset().mockResolvedValue(null);
  db.put.mockReset().mockResolvedValue("kept");
  db.remove.mockReset().mockResolvedValue(undefined);
  db.removeRevision.mockReset().mockResolvedValue(undefined);
  db.purge.mockReset().mockResolvedValue(undefined);
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
    "00000000-0000-4000-8000-000000000001"
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetUnsavedWork();
});

describe("useFormDraft revision ownership", () => {
  it("retires ordinary-clear dedup so a later equal snapshot is written", async () => {
    mount();
    const input = screen.getByRole("textbox", { name: "Name" });
    fireEvent.input(input, { target: { value: "X" } });
    await flushAutosave();
    expect(db.put).toHaveBeenCalledTimes(1);

    fireEvent.input(input, { target: { value: "Y" } });
    act(() => draft.clear());
    fireEvent.input(input, { target: { value: "X" } });
    await flushAutosave();

    expect(db.remove).toHaveBeenCalledWith("7:medication:new");
    expect(db.put).toHaveBeenCalledTimes(2);
  });

  it("retires discard dedup before capturing unchanged live input", async () => {
    let resolveStored!: (value: FormDraft) => void;
    db.get.mockReturnValue(
      new Promise<FormDraft | null>((resolve) => {
        resolveStored = resolve;
      })
    );
    const stored: FormDraft = {
      key: "7:medication:new",
      profileId: 7,
      formKey: "medication",
      recordId: null,
      savedAt: Date.now(),
      fields: [["name", "offered"]],
      extra: null,
    };
    mount();
    await act(async () => resolveStored(stored));
    expect(draft.offer).toEqual({ savedAt: stored.savedAt });
    const input = screen.getByRole("textbox", { name: "Name" });
    fireEvent.input(input, { target: { value: "current" } });
    await flushAutosave();

    act(() => draft.discard());
    act(() => void draft.captureSubmission());

    expect(db.remove).toHaveBeenCalledWith("7:medication:new");
    expect(db.put).toHaveBeenCalledTimes(2);
  });

  it("retries the same snapshot after the device write did not keep it", async () => {
    let failFirst!: (outcome: "failed") => void;
    db.put
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            failFirst = resolve;
          })
      )
      .mockResolvedValueOnce("kept");
    mount();
    fireEvent.input(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "X" },
    });
    await flushAutosave();
    expect(db.put).toHaveBeenCalledTimes(1);

    await act(async () => failFirst("failed"));

    act(() => void draft.captureSubmission());
    expect(db.put).toHaveBeenCalledTimes(2);
    const first = db.put.mock.calls[0][0];
    const second = db.put.mock.calls[1][0];
    expect(second).toMatchObject({
      fields: first.fields,
      extra: first.extra,
      writerId: first.writerId,
      revision: first.revision + 1,
    });
  });

  it("deduplicates a kept snapshot and a late failure cannot retire newer work", async () => {
    let failFirst!: (outcome: "failed") => void;
    db.put
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            failFirst = resolve;
          })
      )
      .mockResolvedValue("kept");
    mount();
    const input = screen.getByRole("textbox", { name: "Name" });
    fireEvent.input(input, { target: { value: "X" } });
    await flushAutosave();
    fireEvent.input(input, { target: { value: "Y" } });
    await flushAutosave();
    expect(db.put).toHaveBeenCalledTimes(2);

    await act(async () => failFirst("failed"));
    act(() => void draft.captureSubmission());
    expect(db.put).toHaveBeenCalledTimes(2);
  });

  it("clears only an unchanged submitted revision and stays clean on rerender", async () => {
    const view = mount();
    fireEvent.input(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "saved" },
    });
    let submission!: ReturnType<FormDraftApi["captureSubmission"]>;
    act(() => {
      submission = draft.captureSubmission();
    });
    act(() => draft.clearSubmission(submission));
    view.rerender(
      <ActiveProfileProvider profileId={7}>
        <Harness extra={0} />
      </ActiveProfileProvider>
    );

    expect(db.removeRevision).toHaveBeenCalledWith(
      "7:medication:new",
      submission.writerId,
      submission.revision
    );
    expect(hasUnsavedWork()).toBe(false);
    await flushAutosave();
    expect(db.put).toHaveBeenCalledTimes(1);
  });

  it("preserves later same-mount work when an older submission settles", async () => {
    mount();
    const input = screen.getByRole("textbox", { name: "Name" });
    fireEvent.input(input, { target: { value: "A" } });
    let submission!: ReturnType<FormDraftApi["captureSubmission"]>;
    act(() => {
      submission = draft.captureSubmission();
    });
    fireEvent.input(input, { target: { value: "B" } });
    await flushAutosave();
    act(() => draft.clearSubmission(submission));

    expect(hasUnsavedWork()).toBe(true);
    expect(db.removeRevision).toHaveBeenCalledWith(
      "7:medication:new",
      submission.writerId,
      submission.revision
    );
    expect(db.put).toHaveBeenCalledTimes(2);
  });

  it("cannot clear a newer same-key mount with an older writer receipt", async () => {
    vi.mocked(globalThis.crypto.randomUUID)
      .mockReset()
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    const firstView = mount();
    fireEvent.input(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "A" },
    });
    const firstApi = draft;
    let firstSubmission!: ReturnType<FormDraftApi["captureSubmission"]>;
    act(() => {
      firstSubmission = firstApi.captureSubmission();
    });
    firstView.unmount();

    mount();
    fireEvent.input(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "B" },
    });
    await flushAutosave();
    act(() => firstApi.clearSubmission(firstSubmission));

    expect(firstSubmission.writerId).not.toBe(db.put.mock.calls[1][0].writerId);
    expect(db.removeRevision).toHaveBeenCalledWith(
      "7:medication:new",
      firstSubmission.writerId,
      firstSubmission.revision
    );
    expect(hasUnsavedWork()).toBe(true);
  });
});
