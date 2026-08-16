// DB INTEGRATION TIER — what a DELIVERY-ONLY push says on the Patient portals page
// (#2914).
//
// #1888 gave a `contacted: false` report its back-end semantics: it records events and
// documents, answers no sync request, and moves no staleness clock. The page then
// rendered every ok report as the same `Last run <day>`, so a push that delivered four
// archives was indistinguishable from an empty check — the "over-rotate" failure #1888's
// own review warned about.
//
// So this pins the two halves the page needed and did not have: the login's real CHECK
// clock in the projection it reads, and the DELIVERED-document count per login. Both are
// asked through the scoped reads, because the count is household data like everything
// else on that page — a login row must never be handed a number drawn from a household
// the viewer cannot reach.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  accountsForPortal,
  bindPortalIdentity,
  createPortal,
  recordPortalRunReport,
  type PortalAccount,
} from "@/lib/portals";
import {
  deliveredDocumentCountsByAccount,
  listVisiblePortalRunReports,
} from "@/lib/portal-visibility";
import { portalLoginStatus } from "@/lib/portal-status";
import { recordSyncEvent } from "@/lib/integrations/connections";
import { testAuthorizedIds as authorized } from "../__tests__/authorized-ids";

const SOURCE = "patient-portals";

let profileOne: number;
let profileTwo: number;
let accountOne: PortalAccount;
let accountTwo: PortalAccount;

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A portal run's product is DOCUMENTS, so the split columns on the event are documents
// too — `inserted 2, unchanged 1` means two new archives and one already held.
function deliveredEvent(
  profileId: number,
  account: PortalAccount,
  patientLabel: string,
  counts: { inserted: number; updated?: number; unchanged?: number },
  at: string
): void {
  recordSyncEvent(profileId, SOURCE, {
    ok: true,
    received: counts.inserted,
    written: counts.inserted + (counts.updated ?? 0),
    inserted: counts.inserted,
    updated: counts.updated ?? 0,
    unchanged: counts.unchanged ?? 0,
    skipped: 0,
    identity: {
      portalId: account.portalId,
      accountId: account.id,
      patientLabel,
    },
  });
  db.prepare(
    `UPDATE integration_sync_events SET at = ?
      WHERE id = (SELECT MAX(id) FROM integration_sync_events)`
  ).run(at);
}

// Force a report's stamps, the way the e2e fixture does — recordPortalRunReport reads
// the clock seam, and this file needs two runs on two different days.
function stampReport(
  account: PortalAccount,
  at: string,
  checkedAt: string | null
): void {
  db.prepare(
    "UPDATE portal_run_reports SET at = ?, checked_at = ? WHERE account_id = ?"
  ).run(at, checkedAt, account.id);
}

beforeAll(() => {
  profileOne = newProfile("DELIVERY-ONE");
  profileTwo = newProfile("DELIVERY-TWO");

  const one = createPortal("Delivery Portal One");
  expect(one.ok).toBe(true);
  accountOne = accountsForPortal(one.ok ? one.id : 0)[0];
  expect(bindPortalIdentity(accountOne.id, "One Patient", profileOne).ok).toBe(
    true
  );

  const two = createPortal("Delivery Portal Two");
  expect(two.ok).toBe(true);
  accountTwo = accountsForPortal(two.ok ? two.id : 0)[0];
  expect(bindPortalIdentity(accountTwo.id, "Two Patient", profileTwo).ok).toBe(
    true
  );

  // Login one: checked on the 10th, then a DELIVERY on the 15th that brought four
  // documents — plus one document delivered days earlier, which the day-grain aggregate
  // must not fold into the 15th's number.
  deliveredEvent(
    profileOne,
    accountOne,
    "One Patient",
    { inserted: 1 },
    "2026-08-10T09:00:00Z"
  );
  deliveredEvent(
    profileOne,
    accountOne,
    "One Patient",
    { inserted: 3, unchanged: 2 },
    "2026-08-15T19:36:20Z"
  );
  deliveredEvent(
    profileOne,
    accountOne,
    "One Patient",
    { inserted: 0, updated: 1 },
    "2026-08-15T19:36:24Z"
  );
  recordPortalRunReport(accountOne, {
    ok: true,
    status: "nothing-new",
    message: null,
    discovered: 0,
    contacted: false,
  });
  stampReport(accountOne, "2026-08-15 19:36:25", "2026-08-10 09:00:00");

  // Login two, another household entirely: its own delivery on the same day, so a
  // scoping mistake would show up as login one's number moving.
  deliveredEvent(
    profileTwo,
    accountTwo,
    "Two Patient",
    { inserted: 9 },
    "2026-08-15T20:00:00Z"
  );
  recordPortalRunReport(accountTwo, {
    ok: true,
    status: "downloaded",
    message: null,
    discovered: 0,
    contacted: false,
  });
  stampReport(accountTwo, "2026-08-15 20:00:05", null);
});

describe("the check clock reaches the page (#2914)", () => {
  it("projects checked_at beside the report the login row renders", () => {
    const report = listVisiblePortalRunReports(
      authorized([profileOne]),
      false
    ).find((r) => r.accountId === accountOne.id)!;
    expect(report.contacted).toBe(false);
    // The delivery did NOT advance it — that is #1888's ruling, and the reason the row
    // can honestly say the portal was last checked five days earlier.
    expect(report.checkedAt).toBe("2026-08-10 09:00:00");
  });

  it("carries a null clock through as 'never checked' rather than as a missing field", () => {
    const report = listVisiblePortalRunReports(
      authorized([profileTwo]),
      false
    ).find((r) => r.accountId === accountTwo.id)!;
    expect(report.checkedAt).toBeNull();
  });
});

describe("deliveredDocumentCountsByAccount (#2914)", () => {
  it("counts the documents a login delivered on its last report's day", () => {
    // 3 inserted + 1 updated on the 15th. The single document from the 10th is a
    // different day and is deliberately not folded in.
    expect(
      deliveredDocumentCountsByAccount(authorized([profileOne]), false).get(
        accountOne.id
      )
    ).toBe(4);
  });

  it("never lends one household's documents to another's login row", () => {
    const forOne = deliveredDocumentCountsByAccount(
      authorized([profileOne]),
      false
    );
    expect(forOne.has(accountTwo.id)).toBe(false);
    const forTwo = deliveredDocumentCountsByAccount(
      authorized([profileTwo]),
      false
    );
    expect(forTwo.get(accountTwo.id)).toBe(9);
    expect(forTwo.has(accountOne.id)).toBe(false);
  });

  it("answers nothing at all for a login with no accessible profile", () => {
    expect(deliveredDocumentCountsByAccount(authorized([]), false).size).toBe(
      0
    );
  });
});

describe("the sentence a delivery-only login row renders (#2914)", () => {
  it("names the delivery, the count, and the check clock it lags", () => {
    const report = listVisiblePortalRunReports(
      authorized([profileOne]),
      false
    ).find((r) => r.accountId === accountOne.id)!;
    const delivered = deliveredDocumentCountsByAccount(
      authorized([profileOne]),
      false
    );
    const line = portalLoginStatus({
      ...report,
      delivered: delivered.get(accountOne.id) ?? 0,
    });
    expect(line.tone).toBe("ok");
    expect(line.text).toBe(
      "Delivered 4 documents 2026-08-15 · portal last checked 2026-08-10"
    );
    expect(line.segments).toContainEqual({
      kind: "link",
      text: "4 documents",
      href: "/data?section=review",
    });
  });

  it("says the portal was never checked when a login has only ever been pushed to", () => {
    const report = listVisiblePortalRunReports(
      authorized([profileTwo]),
      false
    ).find((r) => r.accountId === accountTwo.id)!;
    const delivered = deliveredDocumentCountsByAccount(
      authorized([profileTwo]),
      false
    );
    expect(
      portalLoginStatus({
        ...report,
        delivered: delivered.get(accountTwo.id) ?? 0,
      }).text
    ).toBe("Delivered 9 documents 2026-08-15 · portal never checked");
  });
});
