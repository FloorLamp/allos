import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import FamilyManager from "@/app/(app)/settings/family/FamilyManager";

// THE FAMILY LOGIN ROW SPENDS NO LOUD CONTROL AT ALL (#4978 slice 4, owner
// rulings 2026-09-05 (3), 2026-09-09 20:05 UTC (5), 2026-09-09 23:35 UTC (6),
// 2026-09-10 01:30 UTC (10)).
//
// Slice 2 converted the rest of `settings/family` and deliberately left this row
// whole: its Delete wore `btn-ghost text-rose-600`, a red-TINTED ghost, which is a
// rank decision rather than a class swap. Ruling (5) settled the PAINT — destructive
// actions look the same everywhere, so no tinted-ghost variant exists — and #5677
// filled Delete accordingly. Ruling (10) then settled what that fill COSTS: a filled
// danger control SPENDS the surface's loud-control budget rather than sitting outside
// it, so a per-row destructive action in a repeated list goes quiet. This row renders
// once per login, so the filled Delete was one loud control per login on a single
// card — 194 of them on the e2e fixture. Delete is now the plain secondary like its
// neighbours, and the filled danger lives where ruling (10) puts it: the standalone
// action and the confirm step (ProfileCard's "Delete permanently").
//
// So this asserts that the whole row is quiet, never Delete alone: every control in
// it carries the plain `button-control` with no raw family class left on it, and
// neither loud paint appears. Ruling (3) still decides the UNIT — the row converts
// as one — which is why the neighbours are named here rather than left implied.
// Falsified during authoring against the unconverted file (the neighbours still
// match the raw family) and against the pre-ruling-10 tree (Delete carries
// `button-control-danger`).
//
// A NEGATIVE PAINT ASSERTION NEEDS AN ANCHOR, AND ITS ANCHOR IS button.test.tsx:
// that test pins `variant="danger"` to exactly `button-control button-control-danger`
// on the primitive, so "no `button-control-danger` in this row" cannot pass here by
// the token drifting. Read off the RENDERED classes rather than the call site, so a
// prop the primitive silently drops cannot pass either.
//
// No control in this row is a form commit — `LoginRow` renders no `<form>`, and the
// row itself renders once per login — so under the 2026-09-04 13:05 UTC form reading
// there is no primary to spend.
//
// THE COUNTS ARE TAKEN OVER THE ROW, AND THE PRIMARY COUNT USED TO BE TAKEN OVER THE
// DOCUMENT. A document-wide zero was a true proxy only while slice 2's reading held
// and no card on this surface was filled. Ruling (6) made the CARD the surface, so
// the logins card now spends its one primary on "Create login" and a document total
// of 0 would be false for a reason that has nothing to do with this row. The claim
// being made was always about the ROW, so both counts sit on it — narrower, and each
// now fails for one reason only.

vi.mock("@/app/(app)/settings/family/actions", () => ({
  createProfile: async () => ({ ok: true as const }),
  renameProfile: async () => ({ ok: true as const }),
  deleteProfile: async () => ({ ok: true as const }),
  createLogin: async () => ({ ok: true as const }),
  resetPassword: async () => ({ ok: true as const }),
  deleteLogin: async () => ({ ok: true as const }),
  revokeLoginSessions: async () => ({ ok: true as const }),
  setGrants: async () => ({ ok: true as const }),
  setLoginOwnProfile: async () => ({ ok: true as const }),
  setLoginEmail: async () => ({ ok: true as const }),
  sendInvite: async () => ({ ok: true as const }),
}));

vi.mock("@/app/(app)/settings/photo-actions", () => ({
  uploadProfilePhoto: async () => ({ ok: true as const }),
  removeProfilePhoto: async () => ({ ok: true as const }),
}));

const RAW_FAMILY = /\b(btn|btn-ghost|btn-danger|btn-sm)\b/;

// Two admins, so the member's Delete is enabled and the row is not the last-admin
// special case; a session on the member so `Sign out devices` is pressable too.
const LOGINS = [
  {
    id: 1,
    username: "owner",
    role: "admin" as const,
    email: "owner@example.test",
    own_profile_id: null,
  },
  {
    id: 2,
    username: "second",
    role: "admin" as const,
    email: null,
    own_profile_id: null,
  },
  {
    id: 3,
    username: "kid",
    role: "member" as const,
    email: "kid@example.test",
    own_profile_id: null,
  },
];

function mount() {
  render(
    <ConfirmProvider>
      <FamilyManager
        profiles={[]}
        logins={LOGINS}
        grants={{ 3: [] }}
        access={{}}
        summaries={{}}
        sessionCounts={{ 1: 1, 3: 2 }}
        canInvite={true}
        selfLoginId={1}
      />
    </ConfirmProvider>
  );
}

/** The member row — the one whose Delete is enabled. */
function memberRow(): HTMLElement {
  const row = screen
    .getAllByTestId("login-row")
    .find((el) => el.textContent?.includes("kid"));
  if (!row) throw new Error("no member login row rendered");
  return row;
}

afterEach(cleanup);

describe("the family login row ranks its destructive action against its neighbours", () => {
  it("paints Delete quiet like every neighbour beside it", () => {
    mount();
    const row = memberRow();

    // The six controls of the converted row. `Send invite` only renders when the
    // instance can send mail AND the login has an address — both true above.
    for (const name of [
      "Send invite",
      "Email",
      "Reset password",
      "Sign out devices",
      "Delete",
    ]) {
      const el = within(row, name);
      // Nothing in the row is on the retiring raw family any more, and every
      // control carries the one control box rather than boxes that happen to
      // agree today.
      expect(el.className).toContain("button-control");
      expect(el.className).not.toMatch(RAW_FAMILY);
      expect(el.hasAttribute("data-button-control")).toBe(true);
      // Neither loud paint: Delete included, under ruling (10).
      expect(el.className).not.toContain("button-control-danger");
      expect(el.className).not.toContain("button-control-primary");
    }
  });

  it("adds no loud control per login on a row that renders once per login", () => {
    mount();
    // The multiplication is the point, and it is now zero on both paints. A loud
    // control here would be one PER LOGIN on a single card — the shape ruling (10)
    // named when it sent per-row destructive actions quiet.
    for (const row of screen.getAllByTestId("login-row")) {
      expect(row.querySelectorAll(".button-control-primary")).toHaveLength(0);
      expect(row.querySelectorAll(".button-control-danger")).toHaveLength(0);
    }
    expect(screen.getAllByTestId("login-row")).toHaveLength(LOGINS.length);
  });
});

function within(row: HTMLElement, name: string): HTMLElement {
  const match = Array.from(row.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === name
  );
  if (!match) throw new Error(`no "${name}" control in the login row`);
  return match;
}
