// DB INTEGRATION TIER — portal sync requests (#1757), end to end over a realistic
// fixture: a two-login portal, mapped and unmapped patients, real appointments, real
// logins with real grants.
//
// What this file exists to pin, in the issue's own words:
//
//   • post-visit creation happens for a MAPPED profile only;
//   • delivery routing reaches the login whose token reported the pair, with the
//     write-access fallback when none has;
//   • the dedupe key is registered (the #448 guard) and the finding is realistic;
//   • a dismissal silences the Upcoming item and the digest line TOGETHER, because they
//     are the same key on the same bus;
//   • an expired request leaves no nudge behind.

import { describe, it, expect, beforeEach } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  bindPortalIdentity,
  createPortal,
  createPortalAccount,
  accountsForPortal,
  recordPortalRunReport,
  type PortalAccount,
} from "@/lib/portals";
import {
  evaluatePostVisitRequests,
  evaluateStalenessRequests,
  listSyncRequests,
  openSyncRequests,
  requestSync,
  syncRequestCarrierProfiles,
  syncRequestRecipients,
} from "@/lib/portal-requests";
import {
  SYNC_REQUEST_PREFIX,
  STALENESS_CADENCE_DAYS,
  syncRequestDedupeKey,
} from "@/lib/sync-requests";
import { syncRequestItems } from "@/lib/queries/upcoming/portal-sync";
import { collectUpcoming } from "@/lib/queries";
import { dismissFinding, restoreFinding } from "@/lib/queries";
import { groupUpcoming } from "@/lib/upcoming";
import { buildUpcomingDigest } from "@/lib/notifications/upcoming-digest";
import { attentionCardItems } from "@/lib/attention";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";

// ---- Fixture -----------------------------------------------------------------

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function makeLogin(
  username: string,
  role: "admin" | "member" = "member"
): number {
  return Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, 'scrypt$2$1$1$00$00', ?)"
      )
      .run(username, role).lastInsertRowid
  );
}

function grant(loginId: number, profileId: number, access: "read" | "write") {
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, ?)"
  ).run(loginId, profileId, access);
}

// A stored SQL-shaped stamp N days before/after `anchor` (a YYYY-MM-DD day).
function stamp(day: string, time = "09:00:00"): string {
  return `${day} ${time}`;
}

// Backdate a login's last run report, INCLUDING the sticky CHECK CLOCK the answering and
// staleness reads now use (#1888). One report writes `at` and its clock stamps together,
// so a fixture that moves one must move the other — otherwise it describes a row no
// report could ever produce. A NULL stamp stays NULL: a report that never earned a clock
// stamp does not gain one by being backdated.
function backdateReport(accountId: number, at: string): void {
  db.prepare(
    `UPDATE portal_run_reports
        SET at = ?,
            checked_at = CASE WHEN checked_at IS NULL THEN NULL ELSE ? END,
            checked_ok_at = CASE WHEN checked_ok_at IS NULL THEN NULL ELSE ? END
      WHERE account_id = ?`
  ).run(at, at, at, accountId);
}

interface Fixture {
  momProfile: number;
  dadProfile: number;
  portalId: number;
  mom: PortalAccount;
  dad: PortalAccount;
  anchor: string;
}

function fixture(tag: string): Fixture {
  const momProfile = makeProfile(`Mom ${tag}`);
  const dadProfile = makeProfile(`Dad ${tag}`);
  const portal = createPortal(`Portal ${tag}`, "mychart");
  if (!portal.ok) throw new Error("fixture portal");
  expect(createPortalAccount(portal.id, `MomLogin${tag}`).ok).toBe(true);
  expect(createPortalAccount(portal.id, `DadLogin${tag}`).ok).toBe(true);
  const accounts = accountsForPortal(portal.id);
  const mom = accounts.find((a) => a.name === `MomLogin${tag}`)!;
  const dad = accounts.find((a) => a.name === `DadLogin${tag}`)!;
  // Mom's login covers Mom. Dad's login covers nobody yet — the unmapped case.
  expect(bindPortalIdentity(mom.id, `PATIENT ${tag}`, momProfile).ok).toBe(
    true
  );
  return {
    momProfile,
    dadProfile,
    portalId: portal.id,
    mom,
    dad,
    anchor: today(momProfile),
  };
}

const todayFor = (profileId: number) => today(profileId);

beforeEach(() => {
  db.exec("DELETE FROM portal_sync_requests");
  db.exec("DELETE FROM upcoming_dismissals");
});

// ---- Creation ----------------------------------------------------------------

describe("requestSync — the manual creator", () => {
  it("raises one request, and a second ask of the same reason is a no-op", () => {
    const f = fixture("man");
    const first = requestSync(f.mom.id, "manual");
    expect(first.ok && first.created).toBe(true);

    const second = requestSync(f.mom.id, "manual");
    expect(second.ok).toBe(true);
    expect(second.ok && second.created).toBe(false);
    // ONE row per portal login, by primary key — the table cannot be grown by asking.
    expect(
      listSyncRequests().filter((r) => r.accountId === f.mom.id)
    ).toHaveLength(1);
  });

  it("refuses a portal login with no mapped patients", () => {
    const f = fixture("nomap");
    const out = requestSync(f.dad.id, "manual");
    expect(out).toEqual({ ok: false, error: "no-mapped-patients" });
    expect(listSyncRequests().some((r) => r.accountId === f.dad.id)).toBe(
      false
    );
  });

  it("refuses an unknown login without writing anything", () => {
    expect(requestSync(999_999, "manual")).toEqual({
      ok: false,
      error: "unknown-account",
    });
  });

  it("lets a manual ask supersede an open staleness one, but not the reverse", () => {
    const f = fixture("sup");
    expect(requestSync(f.mom.id, "staleness").ok).toBe(true);
    const promoted = requestSync(f.mom.id, "manual");
    expect(promoted.ok && promoted.created).toBe(true);
    expect(promoted.ok && promoted.request.reason).toBe("manual");

    const demoted = requestSync(f.mom.id, "staleness");
    expect(demoted.ok && demoted.created).toBe(false);
    expect(demoted.ok && demoted.request.reason).toBe("manual");
  });
});

describe("staleness — the cadence creator", () => {
  it("fires for a mapped login past the cadence and stays silent for an unmapped one", () => {
    const f = fixture("stale");
    // Mom's login: a successful run long ago. Dad's login: never run, but unmapped.
    recordPortalRunReport(f.mom, {
      ok: true,
      status: "nothing-new",
      message: null,
      discovered: 0,
    });
    backdateReport(
      f.mom.id,
      stamp(shiftDateStr(f.anchor, -(STALENESS_CADENCE_DAYS + 5)))
    );

    expect(evaluateStalenessRequests(todayFor)).toBeGreaterThanOrEqual(1);
    const open = openSyncRequests();
    expect(open.some((r) => r.accountId === f.mom.id)).toBe(true);
    // The whole point of the mapped-patients rule: Dad's login is stale in every sense
    // and still raises nothing, because a nudge there could reach nobody.
    expect(open.some((r) => r.accountId === f.dad.id)).toBe(false);
  });

  it("stays silent inside the cadence", () => {
    const f = fixture("fresh");
    recordPortalRunReport(f.mom, {
      ok: true,
      status: "downloaded",
      message: null,
      discovered: 0,
    });
    backdateReport(f.mom.id, stamp(shiftDateStr(f.anchor, -3)));
    evaluateStalenessRequests(todayFor);
    expect(openSyncRequests().some((r) => r.accountId === f.mom.id)).toBe(
      false
    );
  });

  it("does not let a FAILED run reset the staleness clock", () => {
    const f = fixture("failclock");
    // A successful run long ago, then a failure yesterday. The portal has not actually
    // been read in a month, and that is what the nudge must say.
    recordPortalRunReport(f.mom, {
      ok: true,
      status: "downloaded",
      message: null,
      discovered: 0,
    });
    backdateReport(
      f.mom.id,
      stamp(shiftDateStr(f.anchor, -(STALENESS_CADENCE_DAYS + 2)))
    );
    // Simulate the failure as a separate stored state: ok = 0 with an OLD stamp, so the
    // staleness read (ok = 1 only) sees nothing recent.
    db.prepare(
      "UPDATE portal_run_reports SET ok = 0, status = 'failed' WHERE account_id = ?"
    ).run(f.mom.id);
    expect(evaluateStalenessRequests(todayFor)).toBeGreaterThanOrEqual(1);
  });
});

describe("post-visit — mapped profiles only", () => {
  it("raises a request when a MAPPED profile's visit just happened", () => {
    const f = fixture("visit");
    db.prepare(
      "INSERT INTO appointments (profile_id, scheduled_at, title, status) VALUES (?, ?, 'Cardiology', 'completed')"
    ).run(f.momProfile, stamp(shiftDateStr(f.anchor, -1), "14:00:00"));

    expect(evaluatePostVisitRequests(todayFor)).toBeGreaterThanOrEqual(1);
    const req = openSyncRequests().find((r) => r.accountId === f.mom.id);
    expect(req?.reason).toBe("post-visit");
  });

  it("raises NOTHING for a visit belonging to an unmapped profile", () => {
    const f = fixture("visit-unmapped");
    // Dad has a visit, but Dad is bound to no portal login.
    db.prepare(
      "INSERT INTO appointments (profile_id, scheduled_at, title, status) VALUES (?, ?, 'Dermatology', 'completed')"
    ).run(f.dadProfile, stamp(shiftDateStr(f.anchor, -1), "14:00:00"));

    evaluatePostVisitRequests(todayFor);
    expect(openSyncRequests().filter((r) => r.portalId === f.portalId)).toEqual(
      []
    );
  });

  it("ignores a cancelled appointment — nothing happened, so nothing was published", () => {
    const f = fixture("visit-cancelled");
    db.prepare(
      "INSERT INTO appointments (profile_id, scheduled_at, title, status) VALUES (?, ?, 'Cardiology', 'cancelled')"
    ).run(f.momProfile, stamp(shiftDateStr(f.anchor, -1), "14:00:00"));
    evaluatePostVisitRequests(todayFor);
    expect(openSyncRequests().some((r) => r.accountId === f.mom.id)).toBe(
      false
    );
  });

  it("ignores a visit outside the window and a future one", () => {
    const f = fixture("visit-window");
    db.prepare(
      "INSERT INTO appointments (profile_id, scheduled_at, title, status) VALUES (?, ?, 'Old', 'completed')"
    ).run(f.momProfile, stamp(shiftDateStr(f.anchor, -30)));
    db.prepare(
      "INSERT INTO appointments (profile_id, scheduled_at, title, status) VALUES (?, ?, 'Future', 'scheduled')"
    ).run(f.momProfile, stamp(shiftDateStr(f.anchor, 5)));
    evaluatePostVisitRequests(todayFor);
    expect(openSyncRequests().some((r) => r.accountId === f.mom.id)).toBe(
      false
    );
  });
});

// ---- Answering + expiry ------------------------------------------------------

describe("the request answers itself", () => {
  it("is closed by the next run report — including a FAILED one", () => {
    const f = fixture("answer");
    expect(requestSync(f.mom.id, "manual").ok).toBe(true);
    expect(openSyncRequests().some((r) => r.accountId === f.mom.id)).toBe(true);

    // The person went to the machine and the run broke. That still answers the ask;
    // whether it worked is the sync STATUS's story.
    recordPortalRunReport(f.mom, {
      ok: false,
      status: "failed",
      message: "the login page changed",
      discovered: 0,
    });

    expect(openSyncRequests().some((r) => r.accountId === f.mom.id)).toBe(
      false
    );
    // The ROW is still there — nothing was deleted, nothing was stamped. Openness is
    // derived, so the report path needs no second write to keep consistent.
    expect(listSyncRequests().some((r) => r.accountId === f.mom.id)).toBe(true);
  });

  it("is NOT closed by a report that predates it", () => {
    const f = fixture("answer-old");
    recordPortalRunReport(f.mom, {
      ok: true,
      status: "nothing-new",
      message: null,
      discovered: 0,
    });
    backdateReport(f.mom.id, stamp(shiftDateStr(f.anchor, -10)));
    expect(requestSync(f.mom.id, "manual").ok).toBe(true);
    expect(openSyncRequests().some((r) => r.accountId === f.mom.id)).toBe(true);
  });

  it("leaves no nudge behind once it expires", () => {
    const f = fixture("expire");
    expect(requestSync(f.mom.id, "manual").ok).toBe(true);
    db.prepare(
      "UPDATE portal_sync_requests SET created_at = ?, expires_at = ? WHERE account_id = ?"
    ).run(
      stamp(shiftDateStr(f.anchor, -20)),
      stamp(shiftDateStr(f.anchor, -13)),
      f.mom.id
    );

    expect(openSyncRequests().some((r) => r.accountId === f.mom.id)).toBe(
      false
    );
    // And nothing reaches any surface: no Upcoming item, therefore no digest line.
    expect(syncRequestItems(f.momProfile, f.anchor)).toEqual([]);
  });
});

// ---- Delivery routing --------------------------------------------------------

describe("delivery routing", () => {
  it("routes to the login whose token reported this (portal, account)", () => {
    const f = fixture("route");
    const runner = makeLogin("portal-runner");
    const otherCaregiver = makeLogin("portal-other");
    grant(runner, f.momProfile, "write");
    grant(otherCaregiver, f.momProfile, "write");

    recordPortalRunReport(f.mom, {
      ok: true,
      status: "nothing-new",
      message: null,
      discovered: 0,
      reportedByLoginId: runner,
    });

    const reach = syncRequestRecipients(f.mom.id);
    expect(reach.routing).toBe("reporter");
    expect(reach.loginIds).toEqual([runner]);
    // Mom's phone, not the household at large.
    expect(reach.loginIds).not.toContain(otherCaregiver);
  });

  it("falls back to the logins with WRITE access to the mapped profiles", () => {
    const f = fixture("fallback");
    const writer = makeLogin("portal-writer");
    const reader = makeLogin("portal-reader");
    const stranger = makeLogin("portal-stranger");
    grant(writer, f.momProfile, "write");
    grant(reader, f.momProfile, "read");
    grant(stranger, f.dadProfile, "write");

    const reach = syncRequestRecipients(f.mom.id);
    expect(reach.routing).toBe("write-access");
    expect(reach.loginIds).toContain(writer);
    // A caregiver who may only LOOK at the record cannot be the person asked to go run a
    // tool that files documents into it.
    expect(reach.loginIds).not.toContain(reader);
    // Nor can someone with no access to any patient on this login.
    expect(reach.loginIds).not.toContain(stranger);
  });

  it("counts a login's OWN profile as write access (the notification edge set)", () => {
    const f = fixture("own");
    const self = makeLogin("portal-self");
    db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
      f.momProfile,
      self
    );
    expect(syncRequestRecipients(f.mom.id).loginIds).toContain(self);
  });

  it("carries the nudge on the mapped profiles the recipient manages", () => {
    const f = fixture("carrier");
    const runner = makeLogin("carrier-runner");
    grant(runner, f.momProfile, "write");
    recordPortalRunReport(f.mom, {
      ok: true,
      status: "nothing-new",
      message: null,
      discovered: 0,
      reportedByLoginId: runner,
    });
    expect(syncRequestCarrierProfiles(f.mom.id)).toEqual([f.momProfile]);
  });

  it("falls back to EVERY mapped profile rather than reaching nobody", () => {
    const f = fixture("carrier-orphan");
    // Nobody reported, and nobody has a grant on the mapped profile.
    expect(syncRequestCarrierProfiles(f.mom.id)).toEqual([f.momProfile]);
  });
});

// ---- Reach: Upcoming + digest, one key ---------------------------------------

describe("reach — an Upcoming item and a digest line sharing one key", () => {
  function withOpenRequest(tag: string) {
    const f = fixture(tag);
    const out = requestSync(f.mom.id, "manual");
    if (!out.ok) throw new Error("fixture request");
    const key = syncRequestDedupeKey(
      out.request.portalSlug,
      out.request.accountSlug,
      out.request.createdAt
    );
    return { f, key };
  }

  it("emits a realistic item under the REGISTERED, coaching-tier prefix", () => {
    const { f, key } = withOpenRequest("reach");
    const items = syncRequestItems(f.momProfile, f.anchor);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.key).toBe(key);
    expect(item.key.startsWith(SYNC_REQUEST_PREFIX)).toBe(true);
    expect(dedupeKeyHasKnownPrefix(item.key)).toBe(true);
    expect(tierForDedupeKey(item.key)).toBe("coaching");
    expect(item.domain).toBe("portal-sync");
    expect(item.title).toContain("Run the portal tool");
    expect(item.detail).toContain("run the portal tool");
    expect(item.dueText).toMatch(/expires/);
    expect(item.suppressible).toBe(true);
    // Slugs only, never a URL — at the surface as well as in the store.
    expect(`${item.title} ${item.detail} ${item.href}`).not.toMatch(
      /https?:\/\//i
    );
  });

  it("reaches the Upcoming aggregation and the digest with the SAME key", () => {
    const { f, key } = withOpenRequest("digest");
    const upcoming = collectUpcoming(f.momProfile, f.anchor);
    expect(upcoming.some((i) => i.key === key)).toBe(true);

    const model = buildUpcomingDigest("Mom", groupUpcoming(upcoming, f.anchor));
    expect(model).not.toBeNull();
    // Named, not merely counted: a bare "1 portal check" cannot be acted on.
    expect(
      model!.syncIssues.some((s) => s.title.includes("Run the portal tool"))
    ).toBe(true);
    // …and named ONCE (#1913 item 5). The named line IS the band item now, so the
    // "1 portal check" count is gone rather than sitting beside it — which also retires
    // the noun that read as a completed event (item 8).
    expect(model!.lines.join(" ")).not.toContain("portal check");
  });

  it("stays OFF the non-hideable Needs-attention hero", () => {
    const { f } = withOpenRequest("hero");
    const upcoming = collectUpcoming(f.momProfile, f.anchor);
    // Even when its expiry lands on today, a calm ask is never pinned to the hero.
    db.prepare(
      "UPDATE portal_sync_requests SET expires_at = ? WHERE account_id = ?"
    ).run(stamp(f.anchor, "23:59:59"), f.mom.id);
    const card = attentionCardItems(
      collectUpcoming(f.momProfile, f.anchor),
      f.anchor
    );
    expect(card.some((i) => i.domain === "portal-sync")).toBe(false);
    expect(upcoming.some((i) => i.domain === "portal-sync")).toBe(true);
  });

  it("a dismissal silences the Upcoming item and the digest line TOGETHER", () => {
    const { f, key } = withOpenRequest("dismiss");
    dismissFinding(f.momProfile, key);

    const upcoming = collectUpcoming(f.momProfile, f.anchor);
    expect(upcoming.some((i) => i.key === key)).toBe(false);
    // One computation: the digest formats the SAME filtered set, so there is no second
    // place a dismissed ask could survive.
    const model = buildUpcomingDigest("Mom", groupUpcoming(upcoming, f.anchor));
    const text = model ? JSON.stringify(model) : "";
    expect(text).not.toContain("Run the portal tool");

    restoreFinding(f.momProfile, key);
    expect(
      collectUpcoming(f.momProfile, f.anchor).some((i) => i.key === key)
    ).toBe(true);
  });

  it("does not carry the item onto a profile the request is not about", () => {
    const { f } = withOpenRequest("scope");
    expect(syncRequestItems(f.dadProfile, today(f.dadProfile))).toEqual([]);
  });
});
