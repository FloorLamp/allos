import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import FamilyManager from "@/app/(app)/settings/family/FamilyManager";

// THE FAMILY LOGIN ROW'S ONE RANK AND ITS ONE DESTRUCTIVE PAINT (#4978 slice 4,
// owner rulings 2026-09-05 (3) and 2026-09-09 20:05 UTC (5)).
//
// Slice 2 converted the rest of `settings/family` and deliberately left this row
// whole: its Delete wore `btn-ghost text-rose-600`, a red-TINTED ghost, which is a
// rank decision rather than a class swap. Ruling (5) settled it — destructive
// actions look the same everywhere, so Delete is the filled `danger` paint and no
// tinted-ghost variant exists. Ruling (3) then decides the UNIT: the Delete and the
// four quiet actions beside it convert together, because a filled red standing next
// to four raw ghosts is exactly the half-converted state the owner declined.
//
// So this asserts the PAIR, never Delete alone: the destructive control carries
// `button-control-danger` AND every neighbour in the same row carries the plain
// `button-control` with no raw family class left on it. Falsified both ways during
// authoring — against the unconverted file (Delete has no `button-control-danger`)
// and against a half-converted copy with Delete converted and `Sign out devices`
// left raw (the neighbour still matches the raw family).
//
// Read off the RENDERED classes rather than the call site, so a prop the primitive
// silently drops cannot pass here.
//
// No control in this row is a form commit — `LoginRow` renders no `<form>`, and the
// row itself renders once per login — so under the 2026-09-04 13:05 UTC form reading
// there is no primary to spend. That is asserted too: a primary appearing here would
// be one per row.
//
// THE COUNT IS TAKEN OVER THE ROW, AND IT USED TO BE TAKEN OVER THE DOCUMENT.
// A document-wide zero was a true proxy only while slice 2's reading held and no
// card on this surface was filled. PM ruling 6 (2026-09-09 23:35 UTC) made the
// CARD the surface, so the logins card now spends its one primary on "Create
// login" and a document total of 0 would be false for a reason that has nothing
// to do with this row. The claim being made was always about the ROW, so the
// count moved onto it — narrower, and it now fails for one reason only.

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
  it("paints Delete with the one destructive paint and every neighbour quiet", () => {
    mount();
    const row = memberRow();
    const del = within(row, "Delete");

    expect(del.className).toContain("button-control-danger");
    expect(del.className).not.toContain("button-control-primary");

    // The four quiet actions in the same row. `Send invite` only renders when the
    // instance can send mail AND the login has an address — both true above.
    for (const name of [
      "Send invite",
      "Email",
      "Reset password",
      "Sign out devices",
    ]) {
      const el = within(row, name);
      expect(el.className).toContain("button-control");
      expect(el.className).not.toContain("button-control-danger");
      expect(el.className).not.toContain("button-control-primary");
    }

    // Nothing in the row is on the retiring raw family any more, and every control
    // carries the one control box rather than boxes that happen to agree today.
    for (const name of [
      "Send invite",
      "Email",
      "Reset password",
      "Sign out devices",
      "Delete",
    ]) {
      const el = within(row, name);
      expect(el.className).not.toMatch(RAW_FAMILY);
      expect(el.hasAttribute("data-button-control")).toBe(true);
    }
  });

  it("spends no primary on a row that renders once per login", () => {
    mount();
    for (const row of screen.getAllByTestId("login-row")) {
      expect(row.querySelectorAll(".button-control-primary")).toHaveLength(0);
    }
    // One destructive paint per login row, not one per screen: the rank belongs to
    // the action, and this action exists on every row.
    expect(document.querySelectorAll(".button-control-danger")).toHaveLength(
      LOGINS.length
    );
  });
});

function within(row: HTMLElement, name: string): HTMLElement {
  const match = Array.from(row.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === name
  );
  if (!match) throw new Error(`no "${name}" control in the login row`);
  return match;
}
