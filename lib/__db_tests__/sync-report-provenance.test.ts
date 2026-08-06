// DB INTEGRATION TIER — what KIND of run a sync report describes (#1888, #1889), driven
// as the REAL route handlers over a realistic fixture.
//
// THE NAMED FIXTURE this file exists for is the first describe block, in the owner's own
// words: a `contacted: false` report ADVANCES IDENTITY SYNC STATUS but leaves an open
// `manual` request OPEN and the staleness clock UNMOVED. Both halves matter. The bug was
// that a delivery answered a request nobody had acted on; the over-rotation would be
// making a delivery look like nothing happened, when documents genuinely arrived.
//
// Then the rest of the seam:
//   • an unattended FAILED run leaves the request open; an attended one answers it;
//   • a per-identity `declined` suppresses staleness and post-visit for THAT identity
//     only, and a later successful collection clears it — including that a REFUSED report
//     clears nothing, because the self-clear is scoped by the token's write set rather
//     than by where it happens to sit relative to the route's gate (#1960);
//   • `GET /api/documents/requests`: the auth gate, the write-set scoping, open-and-
//     unexpired only, and no address-shaped field anywhere in the answer;
//   • migration 146's columns and its behaviour-preserving backfill.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { POST as SYNC_REPORT } from "@/app/api/documents/sync-report/route";
import { GET as REQUESTS } from "@/app/api/documents/requests/route";
import { createApiToken, revokeApiToken } from "@/lib/api-tokens";
import {
  accountsForPortal,
  bindPortalIdentity,
  createPortal,
  createPortalAccount,
  identitySyncStatuses,
  listPortalIdentities,
  listPortalRunReports,
  recordPortalRunReport,
  type PortalAccount,
} from "@/lib/portals";
import {
  evaluatePostVisitRequests,
  evaluateStalenessRequests,
  openSyncRequests,
  requestSync,
} from "@/lib/portal-requests";
import { STALENESS_CADENCE_DAYS } from "@/lib/sync-requests";
import { syncRequestItems } from "@/lib/queries/upcoming/portal-sync";

const PROVIDER = "patient-portals";

let memberLogin: number;
let readerLogin: number;
let memberToken: string;
let readerToken: string;
let revokedToken: string;

interface Fixture {
  tag: string;
  profile: number;
  portalId: number;
  account: PortalAccount;
  label: string;
  anchor: string;
}

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

function stamp(day: string, time = "09:00:00"): string {
  return `${day} ${time}`;
}

// Backdate a login's last report AND its sticky check clock together — one report writes
// them together, so a fixture that moved only one would describe a row no report could
// produce.
function backdateReport(accountId: number, at: string): void {
  db.prepare(
    `UPDATE portal_run_reports
        SET at = ?,
            checked_at = CASE WHEN checked_at IS NULL THEN NULL ELSE ? END,
            checked_ok_at = CASE WHEN checked_ok_at IS NULL THEN NULL ELSE ? END
      WHERE account_id = ?`
  ).run(at, at, at, accountId);
}

// A portal with one login, one bound patient, and a login that may write that profile.
function fixture(
  tag: string,
  opts: { grant?: "write" | "read" } = {}
): Fixture {
  const profile = makeProfile(`Prov ${tag}`);
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, ?)"
  ).run(memberLogin, profile, opts.grant ?? "write");
  const portal = createPortal(`Prov Portal ${tag}`, "mychart");
  if (!portal.ok) throw new Error("fixture portal");
  const account = accountsForPortal(portal.id).find((a) => a.implicit)!;
  const label = `PATIENT ${tag}`;
  expect(bindPortalIdentity(account.id, label, profile).ok).toBe(true);
  return {
    tag,
    profile,
    portalId: portal.id,
    account,
    label,
    anchor: today(profile),
  };
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

function requestsReq(token: string | null): Request {
  return new Request("http://x/api/documents/requests", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const todayFor = (profileId: number) => today(profileId);

function runReportRow(accountId: number): Record<string, unknown> {
  return db
    .prepare("SELECT * FROM portal_run_reports WHERE account_id = ?")
    .get(accountId) as Record<string, unknown>;
}

beforeAll(async () => {
  memberLogin = makeLogin("prov-member");
  readerLogin = makeLogin("prov-reader");
  memberToken = (await createApiToken(memberLogin, "tool", "upload:documents"))
    .token;
  readerToken = (await createApiToken(readerLogin, "tool", "upload:documents"))
    .token;
  const revoked = await createApiToken(memberLogin, "old", "upload:documents");
  revokedToken = revoked.token;
  revokeApiToken(revoked.id, memberLogin, "member");
});

beforeEach(() => {
  db.exec("DELETE FROM portal_sync_requests");
  db.exec("DELETE FROM upcoming_dismissals");
});

// ── #1888's named fixture ─────────────────────────────────────────────────────

describe("a delivery-only report (contacted: false)", () => {
  it("advances identity sync status, leaves an open manual request OPEN, and leaves the staleness clock unmoved", async () => {
    const f = fixture("delivery");

    // A real run a long time ago — the clock the staleness rule reads.
    recordPortalRunReport(f.account, {
      ok: true,
      status: "nothing-new",
      message: null,
      discovered: 0,
    });
    const longAgo = stamp(
      shiftDateStr(f.anchor, -(STALENESS_CADENCE_DAYS + 5))
    );
    backdateReport(f.account.id, longAgo);

    // Somebody presses "Request sync" this morning — the exact case the button exists
    // for: the person who manages allos is not the person whose laptop holds the login.
    expect(requestSync(f.account.id, "manual").ok).toBe(true);
    expect(openSyncRequests().some((r) => r.accountId === f.account.id)).toBe(
      true
    );

    // …and a routine `push` of files collected last week lands.
    const res = await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: `prov-portal-${f.tag}`,
        patient: f.label,
        inserted: 2,
        contacted: false,
      })
    );
    expect(res.status).toBe(200);

    // WHAT IT STILL STAMPS. Documents genuinely arrived, so every accounting surface
    // moves: the sync event, the per-identity "Last synced" chip, the connection stamp.
    const statuses = identitySyncStatuses(f.profile, PROVIDER);
    const chip = statuses.find((s) => s.patientLabel === f.label);
    expect(chip?.lastOkAt).toBeTruthy();
    const events = db
      .prepare(
        "SELECT COUNT(*) AS n FROM integration_sync_events WHERE profile_id = ? AND provider = ?"
      )
      .get(f.profile, PROVIDER) as { n: number };
    expect(events.n).toBe(1);
    expect(
      listPortalRunReports().find((r) => r.accountId === f.account.id)
        ?.contacted
    ).toBe(false);

    // WHAT IT DELIBERATELY DOES NOT. Nobody contacted the portal, so the ask stands…
    const open = openSyncRequests();
    expect(open.some((r) => r.accountId === f.account.id)).toBe(true);
    // …and the checked-the-portal clock has not moved off the real run.
    expect(open.find((r) => r.accountId === f.account.id)?.lastOkAt).toBe(
      longAgo
    );
    expect(runReportRow(f.account.id).checked_ok_at).toBe(longAgo);
  });

  it("does not reset the staleness clock, so the cadence still fires", async () => {
    const f = fixture("stale-push");
    recordPortalRunReport(f.account, {
      ok: true,
      status: "nothing-new",
      message: null,
      discovered: 0,
    });
    backdateReport(
      f.account.id,
      stamp(shiftDateStr(f.anchor, -(STALENESS_CADENCE_DAYS + 5)))
    );

    await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: `prov-portal-${f.tag}`,
        patient: f.label,
        inserted: 1,
        contacted: false,
      })
    );

    expect(evaluateStalenessRequests(todayFor)).toBeGreaterThanOrEqual(1);
    expect(openSyncRequests().some((r) => r.accountId === f.account.id)).toBe(
      true
    );
  });

  it("a CONTACTED report of the same shape answers the request and moves the clock", async () => {
    // The control: without the flag, nothing about the old behaviour changed.
    const f = fixture("contacted");
    expect(requestSync(f.account.id, "manual").ok).toBe(true);

    await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: `prov-portal-${f.tag}`,
        patient: f.label,
        inserted: 1,
      })
    );

    expect(openSyncRequests().some((r) => r.accountId === f.account.id)).toBe(
      false
    );
    expect(runReportRow(f.account.id).checked_ok_at).toBeTruthy();
  });

  it("a delivery push does NOT walk a real run's clock backwards", async () => {
    // The opposite bug a naive read-time filter would have introduced: the table holds
    // one row per login, so a push overwrites the last run — and "checked yesterday,
    // pushed today" must not read as "never checked".
    const f = fixture("noreset");
    recordPortalRunReport(f.account, {
      ok: true,
      status: "downloaded",
      message: null,
      discovered: 0,
    });
    const yesterday = stamp(shiftDateStr(f.anchor, -1));
    backdateReport(f.account.id, yesterday);

    await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: `prov-portal-${f.tag}`,
        patient: f.label,
        contacted: false,
      })
    );

    expect(runReportRow(f.account.id).checked_ok_at).toBe(yesterday);
    // evaluateStalenessRequests is instance-wide, so assert about THIS login rather than
    // counting rows other fixtures own.
    evaluateStalenessRequests(todayFor);
    expect(openSyncRequests().some((r) => r.accountId === f.account.id)).toBe(
      false
    );
  });
});

// ── #1889: attended ───────────────────────────────────────────────────────────

describe("attended — a failed run answers only if someone was there", () => {
  it("an UNATTENDED failed run leaves the request open, and says why on the ask", async () => {
    const f = fixture("unattended");
    expect(requestSync(f.account.id, "manual").ok).toBe(true);

    const res = await SYNC_REPORT(
      report(memberToken, {
        status: "failed",
        portal: `prov-portal-${f.tag}`,
        message: "passkey prompt",
        attended: false,
      })
    );
    expect(res.status).toBe(200);

    // The ask must not disappear at the exact point it became true.
    const open = openSyncRequests();
    const req = open.find((r) => r.accountId === f.account.id);
    expect(req).toBeTruthy();
    expect(req?.unattendedFailure).toEqual({
      at: expect.any(String),
      message: "passkey prompt",
    });

    // And the person-channel copy carries the reason, through the ONE shared formatter.
    const items = syncRequestItems(f.profile, f.anchor);
    const item = items.find((i) => i.domain === "portal-sync");
    expect(item?.detail).toContain(
      "The scheduled run couldn't finish (passkey prompt) — someone needs to go to the machine."
    );
  });

  it("an ATTENDED failed run answers it — the person went to the machine", async () => {
    const f = fixture("attended");
    expect(requestSync(f.account.id, "manual").ok).toBe(true);

    await SYNC_REPORT(
      report(memberToken, {
        status: "failed",
        portal: `prov-portal-${f.tag}`,
        message: "the portal was down",
      })
    );

    expect(openSyncRequests().some((r) => r.accountId === f.account.id)).toBe(
      false
    );
  });

  it("a SUCCESSFUL unattended run still answers: records arrived", async () => {
    const f = fixture("unattended-ok");
    expect(requestSync(f.account.id, "manual").ok).toBe(true);

    await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: `prov-portal-${f.tag}`,
        patient: f.label,
        inserted: 1,
        attended: false,
      })
    );

    expect(openSyncRequests().some((r) => r.accountId === f.account.id)).toBe(
      false
    );
  });

  it("a later answering report clears the escalation clause", async () => {
    const f = fixture("escalation-clear");
    expect(requestSync(f.account.id, "manual").ok).toBe(true);
    await SYNC_REPORT(
      report(memberToken, {
        status: "failed",
        portal: `prov-portal-${f.tag}`,
        message: "passkey prompt",
        attended: false,
      })
    );
    expect(runReportRow(f.account.id).unattended_fail_at).toBeTruthy();

    await SYNC_REPORT(
      report(memberToken, {
        status: "nothing-new",
        portal: `prov-portal-${f.tag}`,
        patient: f.label,
      })
    );
    expect(runReportRow(f.account.id).unattended_fail_at).toBeNull();
    expect(runReportRow(f.account.id).unattended_fail_message).toBeNull();
  });

  it("an unrelated delivery push does not erase why the machine gave up", async () => {
    const f = fixture("escalation-keep");
    expect(requestSync(f.account.id, "manual").ok).toBe(true);
    await SYNC_REPORT(
      report(memberToken, {
        status: "failed",
        portal: `prov-portal-${f.tag}`,
        message: "passkey prompt",
        attended: false,
      })
    );
    await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: `prov-portal-${f.tag}`,
        patient: f.label,
        contacted: false,
      })
    );
    expect(runReportRow(f.account.id).unattended_fail_message).toBe(
      "passkey prompt"
    );
    expect(openSyncRequests().some((r) => r.accountId === f.account.id)).toBe(
      true
    );
  });
});

// ── #1889: per-identity `declined` ────────────────────────────────────────────

describe("declined — one login, three patients, three answers", () => {
  // The scenario that settled the shape: the account holder downloads fine and the two
  // proxies are refused, ON THE SAME RUN. A run-level flag cannot say that.
  function threePatients(tag: string) {
    const holder = makeProfile(`Holder ${tag}`);
    const proxy = makeProfile(`Proxy ${tag}`);
    for (const p of [holder, proxy]) {
      db.prepare(
        "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
      ).run(memberLogin, p);
    }
    const portal = createPortal(`Three ${tag}`, "mychart");
    if (!portal.ok) throw new Error("fixture");
    const account = accountsForPortal(portal.id).find((a) => a.implicit)!;
    expect(bindPortalIdentity(account.id, `HOLDER ${tag}`, holder).ok).toBe(
      true
    );
    expect(bindPortalIdentity(account.id, `PROXY ${tag}`, proxy).ok).toBe(true);
    return {
      tag,
      slug: `three-${tag}`,
      holder,
      proxy,
      account,
      anchor: today(holder),
    };
  }

  function declinedFor(accountId: number, label: string): boolean {
    return listPortalIdentities().some(
      (i) => i.accountId === accountId && i.patientLabel === label && i.declined
    );
  }

  it("records a per-identity outcome without touching the other patient", async () => {
    const f = threePatients("mix");
    const res = await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: f.slug,
        patient: `HOLDER ${f.tag}`,
        inserted: 3,
        identities: [
          { patient: `HOLDER ${f.tag}`, outcome: "collected" },
          { patient: `PROXY ${f.tag}`, outcome: "declined" },
        ],
      })
    );
    expect(res.status).toBe(200);
    expect(declinedFor(f.account.id, `PROXY ${f.tag}`)).toBe(true);
    expect(declinedFor(f.account.id, `HOLDER ${f.tag}`)).toBe(false);
    // The run's own STATUS stays inside the closed three-value enum.
    expect(
      listPortalRunReports().find((r) => r.accountId === f.account.id)?.status
    ).toBe("downloaded");
  });

  it("is never re-reported as a failure event", async () => {
    const f = threePatients("quiet");
    await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: f.slug,
        patient: `HOLDER ${f.tag}`,
        identities: [{ patient: `PROXY ${f.tag}`, outcome: "declined" }],
      })
    );
    // No failed sync event anywhere — the proxy's refusal is state, not an incident,
    // so Data → Review's badge never lights for it.
    const failures = db
      .prepare(
        "SELECT COUNT(*) AS n FROM integration_sync_events WHERE provider = ? AND ok = 0 AND profile_id IN (?, ?)"
      )
      .get(PROVIDER, f.holder, f.proxy) as { n: number };
    expect(failures.n).toBe(0);
  });

  it("suppresses staleness only when every collectable patient is declined", async () => {
    const f = threePatients("stale");
    recordPortalRunReport(f.account, {
      ok: true,
      status: "nothing-new",
      message: null,
      discovered: 0,
    });
    backdateReport(
      f.account.id,
      stamp(shiftDateStr(f.anchor, -(STALENESS_CADENCE_DAYS + 5)))
    );

    // One of two declined: the ask is still actionable for the other, so it stands.
    await SYNC_REPORT(
      report(memberToken, {
        status: "failed",
        portal: f.slug,
        message: "no download offered",
        identities: [{ patient: `PROXY ${f.tag}`, outcome: "declined" }],
      })
    );
    // That report was ATTENDED, so it answers — push its stamps back into the past, or
    // the request raised a second later would be answered by the run that preceded it.
    backdateReport(
      f.account.id,
      stamp(shiftDateStr(f.anchor, -(STALENESS_CADENCE_DAYS + 5)))
    );
    db.exec("DELETE FROM portal_sync_requests");
    expect(evaluateStalenessRequests(todayFor)).toBeGreaterThanOrEqual(1);
    expect(openSyncRequests().some((r) => r.accountId === f.account.id)).toBe(
      true
    );

    // Both declined: asking a person to collect what the portal will not give is a
    // pointless nag, so the cadence goes quiet for this login.
    db.exec("DELETE FROM portal_sync_requests");
    await SYNC_REPORT(
      report(memberToken, {
        status: "failed",
        portal: f.slug,
        message: "no download offered",
        identities: [{ patient: `HOLDER ${f.tag}`, outcome: "declined" }],
      })
    );
    backdateReport(
      f.account.id,
      stamp(shiftDateStr(f.anchor, -(STALENESS_CADENCE_DAYS + 5)))
    );
    evaluateStalenessRequests(todayFor);
    expect(openSyncRequests().some((r) => r.accountId === f.account.id)).toBe(
      false
    );
  });

  it("suppresses a post-visit request for the declined patient only", async () => {
    const f = threePatients("visit");
    await SYNC_REPORT(
      report(memberToken, {
        status: "failed",
        portal: f.slug,
        message: "no download offered",
        identities: [
          { patient: `HOLDER ${f.tag}`, outcome: "declined" },
          { patient: `PROXY ${f.tag}`, outcome: "declined" },
        ],
      })
    );
    // The report was attended, so it answers anything raised after it unless its stamps
    // are pushed back — a request cannot be answered by a run that preceded it.
    backdateReport(f.account.id, stamp(shiftDateStr(f.anchor, -10)));

    // The declined proxy's visit really happened — and raises nothing.
    db.prepare(
      "INSERT INTO appointments (profile_id, scheduled_at, title, status) VALUES (?, ?, 'Cardiology', 'completed')"
    ).run(f.proxy, stamp(shiftDateStr(f.anchor, -1), "14:00:00"));
    evaluatePostVisitRequests(todayFor);
    expect(openSyncRequests().some((r) => r.accountId === f.account.id)).toBe(
      false
    );

    // The holder is collectable again, and their visit raises the ask as ever.
    await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: f.slug,
        patient: `HOLDER ${f.tag}`,
        inserted: 1,
      })
    );
    backdateReport(f.account.id, stamp(shiftDateStr(f.anchor, -10)));
    db.prepare(
      "INSERT INTO appointments (profile_id, scheduled_at, title, status) VALUES (?, ?, 'Dermatology', 'completed')"
    ).run(f.holder, stamp(shiftDateStr(f.anchor, -1), "14:00:00"));
    expect(evaluatePostVisitRequests(todayFor)).toBeGreaterThanOrEqual(1);
    expect(openSyncRequests().some((r) => r.accountId === f.account.id)).toBe(
      true
    );
  });

  it("a token that may not write a patient's profile cannot change their standing state", async () => {
    // One login, two people, and a caregiver token granted only one of them. A per-identity
    // outcome is a write to a profile-owned binding, so it is scoped like every other write
    // here — even though the direction of THIS change (fewer nags) looks harmless.
    //
    // The caregiver holds WRITE on the holder, which is what lets the report pass the
    // #2105 account-level gate at all (a token that can write NO bound profile is
    // refused before any write — pinned in sync-report-gate.test.ts). The run report is
    // account-level and stands; the proxy's standing state stays out of reach.
    const f = threePatients("scope");
    const caregiverLogin = makeLogin(`prov-caregiver-${f.tag}`);
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(caregiverLogin, f.holder);
    const caregiverToken = (
      await createApiToken(caregiverLogin, "tool", "upload:documents")
    ).token;
    const res = await SYNC_REPORT(
      report(caregiverToken, {
        status: "failed",
        portal: f.slug,
        message: "no download offered",
        identities: [{ patient: `PROXY ${f.tag}`, outcome: "declined" }],
      })
    );
    expect(res.status).toBe(200); // the run report itself is account-level and stands
    expect(declinedFor(f.account.id, `PROXY ${f.tag}`)).toBe(false);
  });

  it("a REFUSED downloaded report clears nothing — the 403 and the non-write are one fact (#1960)", async () => {
    // The household case: profile A and profile B on ONE shared portal login, and a
    // caregiver token that may write A only. The report names B.
    //
    // `clearIdentityDeclined` used to run BEFORE this route's write gate and scope itself
    // on the profile the run RESOLVED to — which authorizes nothing, because resolution is
    // an auth-blind lookup. The caller got its 403 and B's standing state had already been
    // mutated. The 403 alone never proved anything: it was returned before the fix too.
    const mine = makeProfile("Gate mine");
    const theirs = makeProfile("Gate theirs");
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(memberLogin, mine);
    // Nothing at all is granted on `theirs` — not read, not write.
    const portal = createPortal("Gate portal", "mychart");
    if (!portal.ok) throw new Error("fixture");
    const account = accountsForPortal(portal.id).find((a) => a.implicit)!;
    expect(bindPortalIdentity(account.id, "GATE MINE", mine).ok).toBe(true);
    expect(bindPortalIdentity(account.id, "GATE THEIRS", theirs).ok).toBe(true);

    // Their binding carries a standing "the portal declines this person".
    db.prepare(
      "UPDATE portal_identities SET declined = 1 WHERE account_id = ? AND patient_label = ?"
    ).run(account.id, "GATE THEIRS");
    expect(declinedFor(account.id, "GATE THEIRS")).toBe(true);

    const res = await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: "gate-portal",
        patient: "GATE THEIRS",
        inserted: 1,
      })
    );
    expect(res.status).toBe(403);
    // THE ASSERTION THIS TEST EXISTS FOR.
    expect(declinedFor(account.id, "GATE THEIRS")).toBe(true);

    // …and the same report for the profile this token MAY write still clears, so the
    // intersection scoped the write rather than disabling it.
    db.prepare(
      "UPDATE portal_identities SET declined = 1 WHERE account_id = ? AND patient_label = ?"
    ).run(account.id, "GATE MINE");
    const ok = await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: "gate-portal",
        patient: "GATE MINE",
        inserted: 1,
      })
    );
    expect(ok.status).toBe(200);
    expect(declinedFor(account.id, "GATE MINE")).toBe(false);
  });

  it("a later successful collection clears it, with no human involved", async () => {
    const f = threePatients("clear");
    await SYNC_REPORT(
      report(memberToken, {
        status: "failed",
        portal: f.slug,
        message: "no download offered",
        identities: [{ patient: `PROXY ${f.tag}`, outcome: "declined" }],
      })
    );
    expect(declinedFor(f.account.id, `PROXY ${f.tag}`)).toBe(true);

    // A plain successful download for that patient IS the evidence, whether or not the
    // client bothered to spell the outcome out.
    await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: f.slug,
        patient: `PROXY ${f.tag}`,
        inserted: 1,
      })
    );
    expect(declinedFor(f.account.id, `PROXY ${f.tag}`)).toBe(false);
  });

  it("a bare label list never clears a standing answer", async () => {
    const f = threePatients("bare");
    await SYNC_REPORT(
      report(memberToken, {
        status: "failed",
        portal: f.slug,
        message: "no download offered",
        identities: [{ patient: `PROXY ${f.tag}`, outcome: "declined" }],
      })
    );
    // An older client that only reports labels says nothing about outcomes, and must not
    // silently undo one.
    await SYNC_REPORT(
      report(memberToken, {
        status: "nothing-new",
        portal: f.slug,
        patient: `HOLDER ${f.tag}`,
        identities: [`HOLDER ${f.tag}`, `PROXY ${f.tag}`],
      })
    );
    expect(declinedFor(f.account.id, `PROXY ${f.tag}`)).toBe(true);
  });
});

// ── #1889: the read endpoint ──────────────────────────────────────────────────

describe("GET /api/documents/requests", () => {
  async function body(res: Response): Promise<Record<string, unknown>> {
    return (await res.json()) as Record<string, unknown>;
  }

  it("refuses an absent or revoked token", async () => {
    expect((await REQUESTS(requestsReq(null))).status).toBe(401);
    expect((await REQUESTS(requestsReq(revokedToken))).status).toBe(401);
  });

  it("lists open requests as slugs, reason and expiry day", async () => {
    const f = fixture("endpoint");
    expect(requestSync(f.account.id, "manual").ok).toBe(true);

    const res = await REQUESTS(requestsReq(memberToken));
    expect(res.status).toBe(200);
    const json = await body(res);
    expect(json.ok).toBe(true);
    const mine = (json.requests as Record<string, unknown>[]).filter(
      (r) => r.portal === `prov-portal-${f.tag}`
    );
    expect(mine).toHaveLength(1);
    expect(Object.keys(mine[0]).sort()).toEqual([
      "account",
      "expires",
      "portal",
      "reason",
    ]);
    expect(mine[0].reason).toBe("manual");
    expect(String(mine[0].expires)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("carries no address, no hostname, and no account nickname", async () => {
    const f = fixture("noaddr");
    expect(requestSync(f.account.id, "manual").ok).toBe(true);
    const text = JSON.stringify(
      await body(await REQUESTS(requestsReq(memberToken)))
    );
    // Asserted over the SERIALIZED response, recursively, so a field added to
    // `SyncRequest` later cannot leak by being spread into the shape.
    expect(text).not.toMatch(/https?:\/\//i);
    expect(text).not.toContain("://");
    expect(text).not.toMatch(/\bhost\b/i);
    expect(text).not.toContain("Prov Portal");
    expect(text).not.toContain("Default login");
  });

  it("scopes to the token's WRITE set, exactly as `held` does", async () => {
    const f = fixture("scoped");
    expect(requestSync(f.account.id, "manual").ok).toBe(true);

    // A login with no grant on the mapped profile sees nothing about it.
    const stranger = await body(await REQUESTS(requestsReq(readerToken)));
    expect(
      (stranger.requests as Record<string, unknown>[]).some(
        (r) => r.portal === `prov-portal-${f.tag}`
      )
    ).toBe(false);
  });

  it("a read-only grant is not a write set", async () => {
    const f = fixture("readonly", { grant: "read" });
    expect(requestSync(f.account.id, "manual").ok).toBe(true);
    const json = await body(await REQUESTS(requestsReq(memberToken)));
    expect(
      (json.requests as Record<string, unknown>[]).some(
        (r) => r.portal === `prov-portal-${f.tag}`
      )
    ).toBe(false);
  });

  it("answers with open AND unexpired requests only", async () => {
    const f = fixture("expiry");
    expect(requestSync(f.account.id, "manual").ok).toBe(true);
    db.prepare(
      "UPDATE portal_sync_requests SET created_at = ?, expires_at = ? WHERE account_id = ?"
    ).run(
      stamp(shiftDateStr(f.anchor, -30)),
      stamp(shiftDateStr(f.anchor, -20)),
      f.account.id
    );
    const json = await body(await REQUESTS(requestsReq(memberToken)));
    expect(
      (json.requests as Record<string, unknown>[]).some(
        (r) => r.portal === `prov-portal-${f.tag}`
      )
    ).toBe(false);
  });

  it("stops listing a request the moment a run answers it — no claim state needed", async () => {
    const f = fixture("answered");
    expect(requestSync(f.account.id, "manual").ok).toBe(true);
    await SYNC_REPORT(
      report(memberToken, {
        status: "nothing-new",
        portal: `prov-portal-${f.tag}`,
        patient: f.label,
      })
    );
    const json = await body(await REQUESTS(requestsReq(memberToken)));
    expect(
      (json.requests as Record<string, unknown>[]).some(
        (r) => r.portal === `prov-portal-${f.tag}`
      )
    ).toBe(false);
  });

  it("creates nothing: polling forever leaves the tables exactly as they were", async () => {
    const f = fixture("readonly-poll");
    expect(requestSync(f.account.id, "manual").ok).toBe(true);
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM portal_sync_requests")
      .get() as { n: number };
    for (let i = 0; i < 3; i++) await REQUESTS(requestsReq(memberToken));
    const after = db
      .prepare("SELECT COUNT(*) AS n FROM portal_sync_requests")
      .get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(openSyncRequests().some((r) => r.accountId === f.account.id)).toBe(
      true
    );
  });
});

// ── Migration 146 ─────────────────────────────────────────────────────────────

describe("migration 146 — the provenance columns", () => {
  it("adds both flags defaulting to the wire meaning, plus the clock and escalation columns", () => {
    const cols = new Map(
      (
        db.prepare("PRAGMA table_info(portal_run_reports)").all() as {
          name: string;
          dflt_value: string | null;
          notnull: number;
        }[]
      ).map((c) => [c.name, c])
    );
    for (const name of [
      "contacted",
      "attended",
      "checked_at",
      "checked_ok_at",
      "unattended_fail_at",
      "unattended_fail_message",
    ]) {
      expect(cols.has(name), name).toBe(true);
    }
    // Absent on the wire means TRUE, so the stored default IS the old meaning.
    expect(cols.get("contacted")?.dflt_value).toBe("1");
    expect(cols.get("attended")?.dflt_value).toBe("1");
  });

  it("gives portal_identities a `declined` flag that does NOT copy `ignored`'s CHECK", () => {
    const cols = (
      db.prepare("PRAGMA table_info(portal_identities)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(cols).toContain("declined");

    // A declined identity is BOUND to a real profile — the household wants those records
    // and the portal will not hand them over. That is the opposite of `ignored`, so the
    // mutual-exclusion CHECK migration 131 wrote for `ignored` must not extend to it.
    const f = fixture("check");
    db.prepare(
      "UPDATE portal_identities SET declined = 1 WHERE account_id = ? AND patient_label = ?"
    ).run(f.account.id, f.label);
    const row = listPortalIdentities().find(
      (i) => i.accountId === f.account.id && i.patientLabel === f.label
    );
    expect(row?.declined).toBe(true);
    expect(row?.profileId).toBe(f.profile);
  });

  it("backfills the clock from the stamps the old readers used", () => {
    // Behaviour-preserving: a household upgrading mid-week must not suddenly read as
    // never-checked. Simulated by clearing the sticky columns on a real row and
    // re-running the migration's own one-shot update.
    const f = fixture("backfill");
    recordPortalRunReport(f.account, {
      ok: true,
      status: "downloaded",
      message: null,
      discovered: 0,
    });
    const at = runReportRow(f.account.id).at as string;
    db.prepare(
      "UPDATE portal_run_reports SET checked_at = NULL, checked_ok_at = NULL WHERE account_id = ?"
    ).run(f.account.id);
    db.exec(
      `UPDATE portal_run_reports
          SET checked_at = at,
              checked_ok_at = CASE WHEN ok = 1 THEN at END
        WHERE checked_at IS NULL AND checked_ok_at IS NULL`
    );
    expect(runReportRow(f.account.id).checked_ok_at).toBe(at);
  });
});
