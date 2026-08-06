// DB INTEGRATION TIER — the sync-report route's ACCOUNT-LEVEL write gate (#2105),
// driven as the REAL POST handler over a realistic fixture.
//
// The hole this pins closed: the route wrote discovered identities and the account-level
// run report BEFORE its per-profile write gate, so any login able to mint an
// `upload:documents` token could — for ANY portal account, including one operated by
// another household adult — fabricate "the scheduled run couldn't sign in", stuff
// arbitrary pending patient labels onto its mapping list, and stamp reportedByLoginId to
// re-point its sync nudges. The gate is canReportOnAccount (lib/portal-visibility.ts):
// write on at least one profile bound under the account, or — for an UNCLAIMED
// first-contact account (#1756) — write somewhere at all. The tests assert the refusal
// AND that it writes NOTHING (row counts unchanged), because the status code alone would
// pass with the writes still in front of it.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { POST as SYNC_REPORT } from "@/app/api/documents/sync-report/route";
import { createApiToken } from "@/lib/api-tokens";
import {
  accountsForPortal,
  bindPortalIdentity,
  createPortal,
  type PortalAccount,
} from "@/lib/portals";

function makeLogin(username: string, role: "admin" | "member" = "member") {
  return Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, 'scrypt$2$1$1$00$00', ?)"
      )
      .run(username, role).lastInsertRowid
  );
}

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function grant(
  loginId: number,
  profileId: number,
  access: "write" | "read" = "write"
): void {
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, ?)"
  ).run(loginId, profileId, access);
}

function report(token: string, body: unknown): Request {
  return new Request("http://x/api/documents/sync-report", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function pendingCount(accountId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM pending_portal_identities WHERE account_id = ?"
      )
      .get(accountId) as { n: number }
  ).n;
}

function runReportCount(accountId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM portal_run_reports WHERE account_id = ?"
      )
      .get(accountId) as { n: number }
  ).n;
}

function syncEventCount(profileId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM integration_sync_events WHERE profile_id = ?"
      )
      .get(profileId) as { n: number }
  ).n;
}

// The victim household: a member operating a portal login whose one patient is bound to
// the victim profile — and the outsider: a different member with genuine write access to
// their OWN profile only, holding a perfectly valid upload token.
let victimLogin: number;
let victimProfile: number;
let victimToken: string;
let outsiderLogin: number;
let outsiderProfile: number;
let outsiderToken: string;
let readerLogin: number;
let readerToken: string;

let portalSeq = 0;
function portalFixture(opts: { bind?: boolean } = {}): {
  slug: string;
  account: PortalAccount;
} {
  const tag = `gate-${++portalSeq}`;
  const made = createPortal(`Gate Portal ${tag}`, "mychart");
  if (!made.ok) throw new Error("fixture portal");
  const account = accountsForPortal(made.id).find((a) => a.implicit)!;
  if (opts.bind !== false) {
    expect(
      bindPortalIdentity(account.id, "GATE, VICTIM", victimProfile).ok
    ).toBe(true);
  }
  return { slug: `gate-portal-${tag}`, account };
}

beforeAll(async () => {
  victimLogin = makeLogin("gate-victim");
  victimProfile = makeProfile("Gate Victim");
  grant(victimLogin, victimProfile);
  victimToken = (await createApiToken(victimLogin, "tool", "upload:documents"))
    .token;

  outsiderLogin = makeLogin("gate-outsider");
  outsiderProfile = makeProfile("Gate Outsider");
  grant(outsiderLogin, outsiderProfile);
  outsiderToken = (
    await createApiToken(outsiderLogin, "tool", "upload:documents")
  ).token;

  // A login whose ONLY grant on the victim profile is read: "can reach" is not the
  // gate — "can write" is.
  readerLogin = makeLogin("gate-reader");
  grant(readerLogin, victimProfile, "read");
  readerToken = (await createApiToken(readerLogin, "tool", "upload:documents"))
    .token;
});

describe("the portal-level failure branch (#2105)", () => {
  it("REFUSES an outsider token with the non-oracular 404 and writes NOTHING", async () => {
    const f = portalFixture();

    const res = await SYNC_REPORT(
      report(outsiderToken, {
        status: "failed",
        portal: f.slug,
        message: "the scheduled run couldn't sign in",
        attended: false,
        identities: ["FABRICATED, PATIENT", "ANOTHER, FAKE"],
      })
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    // Byte-identical to the unknown-login refusal: an unauthorized probe cannot tell a
    // real account from a nonexistent one.
    expect(body.error).toBe("unmapped-identity");

    // The load-bearing half: NO pending labels stuffed, NO run report fabricated —
    // so the card's status line, the #1888 staleness clock, and the #1757
    // reportedByLoginId nudge routing are all untouched.
    expect(pendingCount(f.account.id)).toBe(0);
    expect(runReportCount(f.account.id)).toBe(0);
  });

  it("REFUSES a token whose only grant on the bound profile is READ, identically", async () => {
    const f = portalFixture();

    const res = await SYNC_REPORT(
      report(readerToken, {
        status: "failed",
        portal: f.slug,
        identities: ["READER, FAKE"],
      })
    );
    expect(res.status).toBe(404);
    expect(pendingCount(f.account.id)).toBe(0);
    expect(runReportCount(f.account.id)).toBe(0);
  });

  it("a legitimately-bound reporter still records the run report AND the discovered list", async () => {
    const f = portalFixture();

    const res = await SYNC_REPORT(
      report(victimToken, {
        status: "failed",
        portal: f.slug,
        message: "portal login page changed",
        identities: ["GATE, VICTIM", "GATE, NEWCOMER"],
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; discovered?: number };
    expect(body.ok).toBe(true);
    // "GATE, VICTIM" is already bound, so exactly the newcomer is newly waiting.
    expect(body.discovered).toBe(1);
    expect(pendingCount(f.account.id)).toBe(1);
    const row = db
      .prepare(
        "SELECT status, reported_by_login_id AS reportedBy FROM portal_run_reports WHERE account_id = ?"
      )
      .get(f.account.id) as { status: string; reportedBy: number };
    expect(row.status).toBe("failed");
    expect(row.reportedBy).toBe(victimLogin);
  });

  it("an UNCLAIMED first-contact account still accepts any writer's report (#1756)", async () => {
    // No binding at all: the first run's own patient is not bound yet, which is exactly
    // the case the account-level run report exists for. The outsider token holds write
    // on its own profile, which is the any-writer population clause (b) admits.
    const f = portalFixture({ bind: false });

    const res = await SYNC_REPORT(
      report(outsiderToken, {
        status: "failed",
        portal: f.slug,
        identities: ["FIRST, CONTACT"],
      })
    );
    expect(res.status).toBe(200);
    expect(pendingCount(f.account.id)).toBe(1);
    expect(runReportCount(f.account.id)).toBe(1);
  });

  it("a DEMO-restricted member token is refused the same way, writing nothing", async () => {
    const f = portalFixture();
    process.env.ALLOS_DEMO_MODE = "1";
    try {
      // The victim's own token — authorized outside demo mode — so this isolates the
      // demo refusal from the reachability one.
      const res = await SYNC_REPORT(
        report(victimToken, {
          status: "failed",
          portal: f.slug,
          identities: ["DEMO, FAKE"],
        })
      );
      expect(res.status).toBe(404);
      expect(pendingCount(f.account.id)).toBe(0);
      expect(runReportCount(f.account.id)).toBe(0);
    } finally {
      delete process.env.ALLOS_DEMO_MODE;
    }
  });
});

describe("the patient branch (#2105)", () => {
  it("REFUSES an outsider token before ANY write — no pending row, no run report, no sync event", async () => {
    const f = portalFixture();

    const res = await SYNC_REPORT(
      report(outsiderToken, {
        status: "nothing-new",
        portal: f.slug,
        patient: "GATE, VICTIM",
        identities: ["GATE, VICTIM", "STUFFED, LABEL"],
      })
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    // This branch's own non-oracular refusal: the same answer an unmapped or invented
    // patient would get, so the probe learns nothing about the mapping either way.
    expect(body.error).toBe("unmapped-identity");

    expect(pendingCount(f.account.id)).toBe(0);
    expect(runReportCount(f.account.id)).toBe(0);
    expect(syncEventCount(victimProfile)).toBe(0);
  });

  it("a bound reporter's first-contact report still records the account-level trace (#1756)", async () => {
    const f = portalFixture();

    // The victim's own run reporting an UNMAPPED patient: the per-identity refusal
    // stands (nothing filed under a guess), but the run leaves its trace — the behavior
    // #1756 added, unchanged by the gate in front of it.
    const res = await SYNC_REPORT(
      report(victimToken, {
        status: "nothing-new",
        portal: f.slug,
        patient: "GATE, UNMAPPED",
        identities: ["GATE, UNMAPPED"],
      })
    );
    expect(res.status).toBe(404);
    expect(pendingCount(f.account.id)).toBeGreaterThan(0);
    expect(runReportCount(f.account.id)).toBe(1);
  });

  it("a fully authorized report still lands as the profile's sync event", async () => {
    const f = portalFixture();

    const res = await SYNC_REPORT(
      report(victimToken, {
        status: "downloaded",
        portal: f.slug,
        patient: "GATE, VICTIM",
        inserted: 2,
      })
    );
    expect(res.status).toBe(200);
    expect(runReportCount(f.account.id)).toBe(1);
    expect(syncEventCount(victimProfile)).toBeGreaterThan(0);
  });
});
