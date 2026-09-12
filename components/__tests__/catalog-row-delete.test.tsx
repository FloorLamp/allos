import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/Toast";
import CatalogRow from "@/components/CatalogRow";

// THE CATALOG ROW'S DELETE, AND THE ONE DIRECTION IT MUST FAIL IN (#5865).
//
// `CatalogRow` asks for its confirm through `useOptionalConfirm`, so the row stays
// renderable outside the app shell — the shared-primitive posture ModalShell set. That
// posture fails OPEN, which is right for a modal dismissal and WRONG here: this action
// tells the person it cannot be undone, so "nobody could be asked" must mean nothing is
// deleted rather than everything is.
//
// It is asked at the component tier because the whole claim is about a mount-time
// condition — which hooks resolved — and because five component suites already stub
// `useOptionalConfirm` to null. A catalog rendered under one of those stubs is exactly
// the case that would otherwise delete a row and go green.

const optionalConfirm = vi.hoisted(() => ({
  fn: null as null | ((o: unknown) => Promise<boolean>),
}));

vi.mock("@/components/ConfirmDialog", async (importActual) => {
  const actual =
    await importActual<typeof import("@/components/ConfirmDialog")>();
  return { ...actual, useOptionalConfirm: () => optionalConfirm.fn };
});

const NoForm = () => null;

function row(deleteAction: (fd: FormData) => Promise<{ ok: true }>) {
  return render(
    <ToastProvider>
      <ul>
        <CatalogRow
          name="Spicy"
          facts="Loose stools"
          control={null}
          inactive={false}
          kind="Sensitivity"
          inactiveLabel="Stopped tracking"
          editor={{ Form: NoForm, formProps: {}, title: "Edit sensitivity" }}
          deleteAction={deleteAction}
        />
      </ul>
    </ToastProvider>
  );
}

function openDelete() {
  fireEvent.click(screen.getByTestId("overflow-menu-trigger"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
}

beforeEach(() => {
  // The menu's panel anchors through a ResizeObserver, which jsdom does not ship.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  optionalConfirm.fn = null;
});

afterEach(cleanup);

describe("deleting a catalog row", () => {
  it("does not delete when there is no confirm to answer, and says so", async () => {
    const deleteAction = vi.fn(async () => ({ ok: true as const }));
    row(deleteAction);
    openDelete();
    // The write never ran…
    expect(deleteAction).not.toHaveBeenCalled();
    // …and the person is told why, rather than left with a tap that did nothing.
    expect(await screen.findByText(/nothing was deleted/i)).toBeTruthy();
  });

  it("deletes once the question is answered yes", async () => {
    const deleteAction = vi.fn(async () => ({ ok: true as const }));
    optionalConfirm.fn = vi.fn(async () => true);
    row(deleteAction);
    openDelete();
    expect(optionalConfirm.fn).toHaveBeenCalled();
    await vi.waitFor(() => expect(deleteAction).toHaveBeenCalledTimes(1));
  });

  it("leaves the row alone when the question is answered no", async () => {
    const deleteAction = vi.fn(async () => ({ ok: true as const }));
    optionalConfirm.fn = vi.fn(async () => false);
    row(deleteAction);
    openDelete();
    await vi.waitFor(() => expect(optionalConfirm.fn).toHaveBeenCalled());
    expect(deleteAction).not.toHaveBeenCalled();
  });
});
