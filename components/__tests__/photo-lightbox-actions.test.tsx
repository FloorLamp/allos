import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PhotoDeleteAction from "@/components/photo/PhotoLightboxActions";

const confirm = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());

vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => confirm }));
vi.mock("@/components/Toast", () => ({ useToast: () => toast }));

describe("photo lightbox delete action", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the photo open when confirmation is cancelled", async () => {
    confirm.mockResolvedValue(false);
    const remove = vi.fn();
    const close = vi.fn();
    render(<PhotoDeleteAction remove={remove} close={close} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete photo" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(remove).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("reports a rejected delete without closing the photo", async () => {
    confirm.mockResolvedValue(true);
    const close = vi.fn();
    render(
      <PhotoDeleteAction
        remove={vi.fn().mockResolvedValue({ ok: false, error: "Gone" })}
        close={close}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete photo" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Gone", { tone: "error" })
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Delete photo" })
          .hasAttribute("disabled")
      ).toBe(false)
    );
    expect(close).not.toHaveBeenCalled();
  });

  it("disables itself until a successful delete closes the photo", async () => {
    confirm.mockResolvedValue(true);
    const result = Promise.withResolvers<{ ok: true }>();
    const close = vi.fn();
    render(<PhotoDeleteAction remove={() => result.promise} close={close} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete photo" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Deleting…" })
          .hasAttribute("disabled")
      ).toBe(true)
    );
    fireEvent.click(screen.getByRole("button", { name: "Deleting…" }));
    expect(confirm).toHaveBeenCalledOnce();
    await act(async () => result.resolve({ ok: true }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(toast).toHaveBeenCalledWith("Photo deleted.");
    expect(toast.mock.invocationCallOrder[0]).toBeLessThan(
      close.mock.invocationCallOrder[0]
    );
  });
});
