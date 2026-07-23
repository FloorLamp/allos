// DB INTEGRATION TIER — the multi-profile attention assembly + the persisted
// view-set (issue #1096) against a real in-memory SQLite handle.
//
//   • collectMultiProfileAttention loops the EXISTING per-profile collectAttentionModel
//     over the view-set, stamps each item's profileId, and merges each member's groups
//     banded in that member's OWN today() (loop-composed, not set-based SQL — the trap).
//   • setSessionViewProfiles validates a raw view-set against the login's CURRENT grants
//     (∩ accessible), so a member can never persist an ungranted id; sessionViewProfileIds
//     round-trips the stored value.
// Fixtures are the synthetic seedProfile rig (obviously-fictional names) — no PHI.

import { describe, it, expect, beforeEach, vi } from "vitest";

// This DB tier's shared setup mocks @/lib/auth for the server-action suite; THIS
// suite exercises the real auth core (createSession/resolveSessionToken/view-set), so
// restore the real module.
vi.mock("@/lib/auth", async () => vi.importActual("@/lib/auth"));

import { db, today } from "@/lib/db";
import {
  createSession,
  resolveSessionToken,
  setSessionViewProfiles,
  sessionViewProfileIds,
  type CurrentSession,
} from "@/lib/auth";
import { collectMultiProfileAttention } from "@/lib/queries";
import {
  groupAttentionForPage,
  type ProfiledUpcomingItem,
} from "@/lib/attention";
import { collectAttentionModel } from "@/lib/queries/attention";
import { seedProfile } from "./fixtures";

let seq = 0;
function mkLogin(role: "admin" | "member" = "member"): number {
  return Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, 'x', ?)"
      )
      .run(`mv_user_${++seq}`, role).lastInsertRowid
  );
}
function grant(
  loginId: number,
  profileId: number,
  access: "read" | "write" = "write"
): void {
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, ?)"
  ).run(loginId, profileId, access);
}

describe("collectMultiProfileAttention", () => {
  it("merges two profiles' attention, stamping each item with its own profileId", () => {
    const a = seedProfile("MVA");
    const b = seedProfile("MVB");
    const model = collectMultiProfileAttention([a.profileId, b.profileId]);

    // Both members present, each carrying its OWN today() (per-profile context).
    expect(model.members.map((m) => m.profileId).sort()).toEqual(
      [a.profileId, b.profileId].sort()
    );
    for (const m of model.members) expect(m.today).toBe(today(m.profileId));

    // Every merged item carries a profileId in the view-set, and BOTH profiles
    // contribute at least one item (seedProfile plants a due dose + careplan each).
    const owners = new Set<number>();
    for (const g of model.groups)
      for (const item of g.items as ProfiledUpcomingItem[])
        owners.add(item.profileId);
    expect(owners.has(a.profileId)).toBe(true);
    expect(owners.has(b.profileId)).toBe(true);

    // total reconciles with the per-member models.
    const expectedTotal =
      collectAttentionModel(a.profileId, a.todayStr).length +
      collectAttentionModel(b.profileId, b.todayStr).length;
    expect(model.total).toBe(expectedTotal);
  });

  it("is the single-view identity: one profile merges to that profile's own grouping", () => {
    const a = seedProfile("MVSOLO");
    const model = collectMultiProfileAttention([a.profileId]);
    const direct = groupAttentionForPage(
      collectAttentionModel(a.profileId, a.todayStr),
      a.todayStr
    );
    expect(model.groups.map((g) => g.kind)).toEqual(direct.map((g) => g.kind));
    expect(model.groups.map((g) => g.items.length)).toEqual(
      direct.map((g) => g.items.length)
    );
    // Every item stamped with the sole profile.
    for (const g of model.groups)
      for (const item of g.items as ProfiledUpcomingItem[])
        expect(item.profileId).toBe(a.profileId);
  });

  it("an empty view-set returns nothing (never everything)", () => {
    const model = collectMultiProfileAttention([]);
    expect(model.total).toBe(0);
    expect(model.groups).toEqual([]);
    expect(model.members).toEqual([]);
  });
});

describe("view-set persistence (setSessionViewProfiles / sessionViewProfileIds)", () => {
  let login: number;
  let pa: number;
  let pb: number;
  let token: string;
  let session: CurrentSession;

  beforeEach(() => {
    pa = seedProfile("VPA").profileId;
    pb = seedProfile("VPB").profileId;
    login = mkLogin("member");
    grant(login, pa, "write"); // only A granted initially
    token = createSession(login).token;
    session = resolveSessionToken(token)!;
    // Active profile is the first accessible one → A.
    expect(session.profile.id).toBe(pa);
  });

  it("drops an UNGRANTED id from a persisted view-set (member cannot widen the view)", () => {
    const stored = setSessionViewProfiles(session, token, [pa, pb]);
    // B is ungranted → dropped; only A survives → single-view default → NULL stored.
    expect(stored).toEqual([pa]);
    expect(sessionViewProfileIds(token)).toEqual([]);
  });

  it("persists a genuine multi-view set once the second profile is granted", () => {
    grant(login, pb, "read");
    const stored = setSessionViewProfiles(session, token, [pa, pb]);
    expect(stored).toEqual([pa, pb]);
    expect(sessionViewProfileIds(token)).toEqual([pa, pb]);
  });

  it("always keeps the acting profile in view even if omitted from the raw set", () => {
    grant(login, pb, "write");
    const stored = setSessionViewProfiles(session, token, [pb]);
    expect(stored).toEqual([pa, pb]); // A (acting) is force-retained
  });
});
