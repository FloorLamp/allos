import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ApiTokensSettings from "@/app/(app)/settings/ApiTokensSettings";
import { API_TOKEN_SCOPES } from "@/lib/api-token-format";

// THE SETTINGS SURFACE'S TWO RANKS, ASSERTED AS A PAIR (#4978 slice 2, owner
// ruling 2026-09-05 (3)).
//
// /settings/tokens mounts exactly one component, so it is the one settings
// surface where item 3's admission test — "the action the surface exists for" —
// has an unambiguous answer: minting a token. Its commit is therefore the
// primary, and every other control on the page is the quiet rank.
//
// The two halves are checked TOGETHER, because the state the owner declined is
// exactly the half-converted one: a commit on the primitive's smaller box beside
// a neighbour still wearing the raw family's larger type, which measured 1.84x
// the commit's width. Read off the RENDERED classes rather than the call site,
// so a wrapper that silently dropped `variant` (the demotion #3982 was written
// against) reddens here too.

vi.mock("@/app/(app)/settings/token-actions", () => ({
  createApiTokenAction: async () => ({
    ok: true as const,
    token: "allos_pat_testtoken",
    name: "Laptop CLI",
  }),
  revokeApiTokenAction: async () => ({ ok: true as const }),
}));

const RAW_FAMILY = /\b(btn|btn-ghost|btn-danger|btn-sm)\b/;

const token = {
  id: 7,
  loginId: 3,
  name: "Laptop CLI",
  scope: API_TOKEN_SCOPES[0],
  username: "sam",
  createdAt: "2026-09-01T10:00:00Z",
  lastUsedAt: null,
};

function mount() {
  render(
    <ApiTokensSettings tokens={[token]} showOwner={false} canManage={true} />
  );
}

afterEach(cleanup);

describe("the API-token surface ranks its commit against its neighbours", () => {
  it("paints the mint commit primary and the revoke beside it secondary", () => {
    mount();
    const commit = screen.getByTestId("api-token-create");
    const revoke = screen.getByTestId("api-token-revoke");

    expect(commit.className).toContain("button-control-primary");
    expect(revoke.className).toContain("button-control");
    expect(revoke.className).not.toContain("button-control-primary");

    // Neither control is on the retiring raw family any more, and both carry the
    // one control box rather than two boxes that happen to agree today.
    for (const el of [commit, revoke]) {
      expect(el.className).not.toMatch(RAW_FAMILY);
      expect(el.hasAttribute("data-button-control")).toBe(true);
    }
  });

  it("spends the surface's one primary on the commit, in both of its states", async () => {
    mount();
    expect(document.querySelectorAll(".button-control-primary")).toHaveLength(
      1
    );

    // The minted-secret panel adds a control to the SAME card as the commit; it
    // is the neighbour ruling (3) is about, so it converts with the commit and
    // does not become a second filled control.
    fireEvent.change(screen.getByTestId("api-token-name"), {
      target: { value: "Laptop CLI" },
    });
    fireEvent.click(screen.getByTestId("api-token-create"));
    const dismiss = await screen.findByTestId("api-token-secret-dismiss");
    expect(dismiss.className).toContain("button-control");
    expect(dismiss.className).not.toContain("button-control-primary");
    expect(dismiss.className).not.toMatch(RAW_FAMILY);
    expect(document.querySelectorAll(".button-control-primary")).toHaveLength(
      1
    );
  });
});
