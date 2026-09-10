import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import PassportControls, {
  type ShareLinkView,
} from "@/components/PassportControls";
import { loudIn } from "./loud-controls";

// THE SHARE MODAL IS ONE SURFACE, AND IT SPENDS ITS ONE LOUD CONTROL ON THE
// COMMIT (#4978 ruling 3 with ruling 10, applied here 2026-09-10).
//
// The modal holds a `Create link` commit and one `Revoke` per existing link, so
// it is the repeated-row shape ruling 10 names: a per-row destructive action is
// not loud, and the fill it gives up lives on its confirm step. It is NOT the
// withings/strava shape — there is only one commit here, so no ruling 6
// one-commit-per-card question arises and `Create link` keeps its fill
// untouched.
//
// Asserted as the surface's budget WHOLE rather than one control at a time: a
// per-control check cannot see a second fill arriving beside the one it checks,
// and with two rows rendered it would also pass while only the first row was
// converted.
vi.mock("@/app/(app)/profile/actions", () => ({
  createShareLinkAction: vi.fn(),
  revokeShareLinkAction: vi.fn(),
}));

const links: ShareLinkView[] = [
  {
    id: 1,
    kind: "passport",
    fields: ["conditions"],
    status: "valid",
    expiresAt: "2026-10-01T00:00:00Z",
    createdAt: "2026-09-01T00:00:00Z",
  },
  {
    id: 2,
    kind: "immunizations",
    fields: [],
    status: "valid",
    expiresAt: "2026-11-02T00:00:00Z",
    createdAt: "2026-09-02T00:00:00Z",
  },
];

afterEach(cleanup);

function openShareModal(): HTMLElement {
  render(
    <ConfirmProvider>
      <PassportControls links={links} />
    </ConfirmProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
  const commit = screen.getByRole("button", { name: "Create link" });
  const modal = commit.closest("[role=dialog]");
  if (!(modal instanceof HTMLElement)) throw new Error("no share dialog");
  return modal;
}

describe("the share modal's loud budget (#4978 ruling 10)", () => {
  it("fills the commit and no Revoke, with two rows on the list", () => {
    const modal = openShareModal();
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(2);
    expect(loudIn(modal)).toEqual(["Create link"]);
  });

  it("moves the red to a confirm step that names the row it is about", async () => {
    const modal = openShareModal();
    const rows = screen.getAllByRole("button", { name: "Revoke" });

    // THE STATE IS THE POINT. A closed modal says nothing about where the fill
    // went, so the confirm is opened — from the SECOND row, because a confirm
    // that named the first row whichever control was pressed would pass a
    // per-row test that only ever pressed the first.
    fireEvent.click(rows[1]);
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog.textContent).toContain("Immunization record");
    expect(dialog.textContent).not.toContain("Conditions");

    // The dialog is on the retiring raw family (#4978 item 4 deletes it with its
    // last caller), so the destructive paint reads by the class that carries it
    // there rather than by the primitive's rank.
    const confirmed = within(dialog).getByRole("button", { name: "Revoke" });
    expect(confirmed.className).toContain("btn-danger");
    // A `z-110` overlay, not a control on the surface below: the modal's budget
    // is unchanged while it stands open.
    expect(loudIn(modal)).toEqual(["Create link"]);
  });
});
