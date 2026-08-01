// DB INTEGRATION TIER — who may see a portal ACCOUNT: its run report (#1787), and its
// registry row (#1796).
//
// The bug this pins was a cross-household DISCLOSURE. The Patient portals status card
// passed every account's run report, instance-wide, into portalStatusLine, which picks
// the globally-newest FAILED one and renders the portal name, the account nickname, and
// the tool's free-text `message` — content an external companion tool supplies through
// the token-authenticated upload API — to any login that could open the page.
//
// So the assertions are written as the disclosure question, not as a row count: for a
// login with no tie to the failing account, the account name and the message must not
// appear ANYWHERE in what the read returns, and the status sentence the page would show
// must not contain them either. That way a future column added to PortalRunReport, or a
// change to which report portalStatusLine picks, cannot re-open the leak quietly.
//
// The second half of the file asks the same question of the REGISTRY the tool-config
// endpoint serves (#1796), on the same fixture and in the same words — one reachability
// rule, two surfaces, so a change to either has to face both.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  accountsForPortal,
  bindPortalIdentity,
  createPortal,
  createPortalAccount,
  listPortalAccounts,
  listPortalRunReports,
  listPortals,
  recordPortalRunReport,
  type PortalAccount,
} from "@/lib/portals";
import {
  listVisiblePortalRegistry,
  listVisiblePortalRunReports,
} from "@/lib/portal-visibility";
import { portalStatusLine } from "@/lib/portal-status";

// Household B's secrets — the strings that must never reach household A.
const B_PORTAL = "Leak Test Portal B";
const B_ACCOUNT = "Bee Household Login";
const B_MESSAGE = "two-factor code expired for account bee-9921";

// Household A's own portal, so A has a legitimate report of its own to still see.
const A_PORTAL = "Leak Test Portal A";
const A_MESSAGE = "portal returned 503 for the ay household";

let profileA: number;
let profileB: number;
let accountA: PortalAccount;
let accountB: PortalAccount;
let unclaimedAccount: PortalAccount;
let aPortalId: number;
let bPortalId: number;
let unclaimedPortalId: number;

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

beforeAll(() => {
  profileA = newProfile("LEAK-A");
  profileB = newProfile("LEAK-B");

  // Household A: its own portal, one binding onto profile A, one failed run.
  const a = createPortal(A_PORTAL);
  expect(a.ok).toBe(true);
  aPortalId = a.ok ? a.id : 0;
  accountA = accountsForPortal(aPortalId)[0];
  expect(bindPortalIdentity(accountA.id, "Ay Patient", profileA).ok).toBe(true);
  recordPortalRunReport(accountA, {
    ok: false,
    status: "failed",
    message: A_MESSAGE,
    discovered: 0,
  });

  // Household B: a DIFFERENT portal with a named login, bound only to profile B, whose
  // run failed with a message naming their account. This is the report the bug leaked.
  const b = createPortal(B_PORTAL);
  expect(b.ok).toBe(true);
  bPortalId = b.ok ? b.id : 0;
  const named = createPortalAccount(bPortalId, B_ACCOUNT);
  expect(named.ok).toBe(true);
  accountB = accountsForPortal(bPortalId).find(
    (acc) => acc.id === (named.ok ? named.id : -1)
  )!;
  expect(bindPortalIdentity(accountB.id, "Bee Patient", profileB).ok).toBe(
    true
  );
  // Newest of the three, so it is exactly the one portalStatusLine's rule 1 would pick.
  recordPortalRunReport(accountB, {
    ok: false,
    status: "failed",
    message: B_MESSAGE,
    discovered: 0,
  });

  // An account nobody has claimed yet — the #1756 first-contact case.
  const u = createPortal("Leak Test Portal Unclaimed");
  expect(u.ok).toBe(true);
  unclaimedPortalId = u.ok ? u.id : 0;
  unclaimedAccount = accountsForPortal(unclaimedPortalId)[0];
  recordPortalRunReport(unclaimedAccount, {
    ok: false,
    status: "failed",
    message: "nobody owns this one yet",
    discovered: 0,
  });

  // Pin the ordering explicitly rather than leaning on datetime('now') — all three
  // land in the same second, and this fixture's whole point is WHICH report is
  // globally newest: household B's, so it is the one portalStatusLine's rule 1
  // picks and therefore the one the bug rendered to everybody.
  const stampAt = db.prepare(
    "UPDATE portal_run_reports SET at = ? WHERE account_id = ?"
  );
  stampAt.run("2026-07-01 10:00:00", accountA.id);
  stampAt.run("2026-07-02 10:00:00", unclaimedAccount.id);
  stampAt.run("2026-07-03 10:00:00", accountB.id);
});

// The unscoped reader is still the instance-wide truth — the acquirer paths and the
// admin surfaces need it. What changed is which reader the CARD uses.
describe("listPortalRunReports stays instance-wide", () => {
  it("still returns every account's report", () => {
    const all = listPortalRunReports();
    expect(all.some((r) => r.accountId === accountA.id)).toBe(true);
    expect(all.some((r) => r.accountId === accountB.id)).toBe(true);
    expect(all.some((r) => r.accountId === unclaimedAccount.id)).toBe(true);
  });
});

describe("listVisiblePortalRunReports — the #1787 disclosure boundary", () => {
  it("hides an account bound only to a profile the viewer cannot reach", () => {
    // Household A's login: access to profile A only, and write access there, so it is
    // in the canManagePending population — the widest a non-admin member can be.
    const visible = listVisiblePortalRunReports([profileA], true);
    const serialized = JSON.stringify(visible);

    expect(visible.some((r) => r.accountId === accountB.id)).toBe(false);
    // The disclosure assertion proper: neither the nickname nor the free-text message
    // appears anywhere in the payload, whatever shape it grows.
    expect(serialized).not.toContain(B_ACCOUNT);
    expect(serialized).not.toContain(B_MESSAGE);
    expect(serialized).not.toContain(B_PORTAL);

    // …and A still sees its OWN failure, so the fix did not just blank the surface.
    expect(visible.some((r) => r.accountId === accountA.id)).toBe(true);
    expect(serialized).toContain(A_MESSAGE);
  });

  it("keeps the leak out of the sentence the card actually renders", () => {
    // End-to-end through the pure formatter: rule 1 picks the globally-newest failure,
    // which is household B's — the exact path that produced the reported bug.
    const leaked = portalStatusLine({
      lastSuccessAt: null,
      connected: true,
      reports: listPortalRunReports(),
      pending: [],
    });
    expect(leaked.text).toContain(B_MESSAGE);

    const scoped = portalStatusLine({
      lastSuccessAt: null,
      connected: true,
      reports: listVisiblePortalRunReports([profileA], true),
      pending: [],
    });
    expect(scoped.text).not.toContain(B_MESSAGE);
    expect(scoped.text).not.toContain(B_ACCOUNT);
    expect(scoped.text).not.toContain(B_PORTAL);
  });

  it("shows a household its own account, from either side", () => {
    const forB = listVisiblePortalRunReports([profileB], true);
    expect(forB.some((r) => r.accountId === accountB.id)).toBe(true);
    expect(JSON.stringify(forB)).toContain(B_MESSAGE);
    // …and B does not get A's.
    expect(JSON.stringify(forB)).not.toContain(A_MESSAGE);
  });

  it("gives a login with no accessible profile nothing but the unclaimed case", () => {
    // The reader the bug exposed most: zero accessible profiles. profileIdsIn([])
    // renders `(NULL)`, so clause (a) matches nothing rather than everything.
    const none = listVisiblePortalRunReports([], false);
    expect(none).toEqual([]);
    const noneSerialized = JSON.stringify(
      listVisiblePortalRunReports([], true)
    );
    expect(noneSerialized).not.toContain(B_MESSAGE);
    expect(noneSerialized).not.toContain(A_MESSAGE);
  });

  it("shows an UNCLAIMED account only to the population that can act on it", () => {
    // #1756's first-contact case: an account bound to nobody belongs to no household
    // yet, and hiding its failure would restore the dead zone that issue removed. It is
    // shown to exactly the canManagePending population — the same one that already sees
    // pending's portal-spelled patient labels.
    const canManage = listVisiblePortalRunReports([profileA], true);
    expect(canManage.some((r) => r.accountId === unclaimedAccount.id)).toBe(
      true
    );
    const cannotManage = listVisiblePortalRunReports([profileA], false);
    expect(cannotManage.some((r) => r.accountId === unclaimedAccount.id)).toBe(
      false
    );
    // Turning the flag on never widens visibility of a CLAIMED foreign account.
    expect(canManage.some((r) => r.accountId === accountB.id)).toBe(false);
  });

  it("stops showing an account the moment its last accessible binding goes", () => {
    // Visibility follows the bindings, not a snapshot: bind B's account to A too, and A
    // sees it; unbind, and it disappears again. This is what makes the read the
    // authority rather than a one-time filter.
    expect(bindPortalIdentity(accountB.id, "Shared Patient", profileA).ok).toBe(
      true
    );
    expect(
      listVisiblePortalRunReports([profileA], true).some(
        (r) => r.accountId === accountB.id
      )
    ).toBe(true);

    db.prepare(
      "DELETE FROM portal_identities WHERE account_id = ? AND profile_id = ?"
    ).run(accountB.id, profileA);
    expect(
      listVisiblePortalRunReports([profileA], true).some(
        (r) => r.accountId === accountB.id
      )
    ).toBe(false);
  });
});

// ── The registry itself (#1796) ──────────────────────────────────────────────
//
// Same fixture, same question, one surface over: `GET /api/documents/portals` used to
// answer with the whole instance-wide vocabulary, so an account NICKNAME — household
// composition, spelled out — reached any authorized token. These assertions are written
// the same way as the ones above: the foreign strings must not appear anywhere in the
// serialized read, so a field added to `Portal` or `PortalAccount` cannot re-open it.
describe("listVisiblePortalRegistry — the #1796 registry boundary", () => {
  beforeAll(() => {
    // Claim household B's implicit default login as well, so B's portal is claimed in
    // FULL. That is the "portal with zero reachable accounts" case: until a portal has
    // ANY binding it belongs to nobody, and it stays visible to everyone who could set
    // it up — bindings only exist after a run has discovered a patient, so requiring
    // one would leave `tool init` unable to learn the slug of a portal created a minute
    // ago, which is the whole reason the endpoint exists.
    const bDefault = accountsForPortal(bPortalId).find((acc) => acc.implicit)!;
    expect(
      bindPortalIdentity(bDefault.id, "Bee Default Patient", profileB).ok
    ).toBe(true);
  });

  it("omits a portal whose accounts are all claimed by an unreachable household", () => {
    const visible = listVisiblePortalRegistry([profileA], true);
    const serialized = JSON.stringify(visible);

    expect(visible.portals.some((p) => p.id === bPortalId)).toBe(false);
    // Not "B's portal with zero logins" — the portal name is gone too, because naming
    // it would disclose exactly what the scoping removes.
    expect(serialized).not.toContain(B_PORTAL);
    expect(serialized).not.toContain(B_ACCOUNT);
    expect(visible.accounts.some((acc) => acc.id === accountB.id)).toBe(false);

    // …and A still gets its own portal, so the fix did not just blank the registry.
    expect(visible.portals.some((p) => p.id === aPortalId)).toBe(true);
    expect(serialized).toContain(A_PORTAL);
  });

  it("filters accounts WITHIN a portal a household can partly reach", () => {
    // Bind B's named login onto profile A as well: A can now reach that account, so the
    // portal and that one account appear — while an account of the same portal claimed
    // only by B stays hidden. Visibility is per ACCOUNT; the portal rides along.
    expect(bindPortalIdentity(accountB.id, "Shared Patient", profileA).ok).toBe(
      true
    );
    const shared = listVisiblePortalRegistry([profileA], true);
    expect(shared.portals.some((p) => p.id === bPortalId)).toBe(true);
    const bAccounts = shared.accounts.filter(
      (acc) => acc.portalId === bPortalId
    );
    expect(bAccounts.map((acc) => acc.id)).toEqual([accountB.id]);
    // The implicit default, claimed only by B, is not among them.
    expect(bAccounts.some((acc) => acc.implicit)).toBe(false);

    db.prepare(
      "DELETE FROM portal_identities WHERE account_id = ? AND profile_id = ?"
    ).run(accountB.id, profileA);
    expect(
      listVisiblePortalRegistry([profileA], true).portals.some(
        (p) => p.id === bPortalId
      )
    ).toBe(false);
  });

  it("shows a household its own portal and login, from either side", () => {
    const forB = listVisiblePortalRegistry([profileB], true);
    expect(forB.portals.some((p) => p.id === bPortalId)).toBe(true);
    expect(forB.accounts.some((acc) => acc.id === accountB.id)).toBe(true);
    // …and B does not get A's.
    expect(JSON.stringify(forB)).not.toContain(A_PORTAL);
    expect(forB.portals.some((p) => p.id === aPortalId)).toBe(false);
  });

  it("gives an admin the full registry, by reaching every profile", () => {
    // No admin branch exists in the reader: an admin reaches every profile, so the same
    // clause (a) admits every claimed account. "Admin sees everything" stays a property
    // of the accessible set rather than a second rule that could disagree with it.
    const forAdmin = listVisiblePortalRegistry([profileA, profileB], true);
    for (const portalId of [aPortalId, bPortalId, unclaimedPortalId]) {
      expect(forAdmin.portals.some((p) => p.id === portalId)).toBe(true);
    }
    expect(forAdmin.accounts.some((acc) => acc.id === accountA.id)).toBe(true);
    expect(forAdmin.accounts.some((acc) => acc.id === accountB.id)).toBe(true);
  });

  it("keeps an unclaimed account visible only to the population that can set it up", () => {
    const canManage = listVisiblePortalRegistry([profileA], true);
    expect(
      canManage.accounts.some((acc) => acc.id === unclaimedAccount.id)
    ).toBe(true);
    expect(canManage.portals.some((p) => p.id === unclaimedPortalId)).toBe(
      true
    );

    const cannotManage = listVisiblePortalRegistry([profileA], false);
    expect(
      cannotManage.accounts.some((acc) => acc.id === unclaimedAccount.id)
    ).toBe(false);
    expect(cannotManage.portals.some((p) => p.id === unclaimedPortalId)).toBe(
      false
    );
    // Turning the flag on never widens visibility of a CLAIMED foreign account.
    expect(canManage.accounts.some((acc) => acc.id === accountB.id)).toBe(
      false
    );
  });

  it("returns nothing of this fixture to a login with no accessible profile", () => {
    const none = listVisiblePortalRegistry([], false);
    const serialized = JSON.stringify(none);
    expect(serialized).not.toContain(A_PORTAL);
    expect(serialized).not.toContain(B_PORTAL);
    expect(serialized).not.toContain(B_ACCOUNT);
    for (const portalId of [aPortalId, bPortalId, unclaimedPortalId]) {
      expect(none.portals.some((p) => p.id === portalId)).toBe(false);
    }
  });

  it("never returns an account whose portal it withheld", () => {
    // The grouping invariant: a portal appears only BECAUSE one of its accounts did, so
    // an account can never arrive orphaned from the portal it names.
    const visible = listVisiblePortalRegistry([profileA], true);
    const portalIds = new Set(visible.portals.map((p) => p.id));
    for (const acc of visible.accounts) {
      expect(portalIds.has(acc.portalId)).toBe(true);
    }
  });
});

// The unscoped registry readers stay instance-wide — the acquirer resolution paths and
// the admin surfaces read them, and #1796 changed which reader the ENDPOINT uses.
describe("listPortals / listPortalAccounts stay instance-wide", () => {
  it("still returns every portal and account", () => {
    expect(listPortals().some((p) => p.id === bPortalId)).toBe(true);
    expect(listPortalAccounts().some((acc) => acc.id === accountB.id)).toBe(
      true
    );
  });
});
