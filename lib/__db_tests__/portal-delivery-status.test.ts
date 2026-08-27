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
//
// ONE NUMBER FOR ONE DELIVERY (#1991). The count is the DOCUMENTS THE RUNS CLAIMED, the
// same provenance rows the Imports feed's drill-in lists — not the tool's own
// `inserted + updated` split. The fixtures below deliberately report splits that DISAGREE
// with what allos stored, because that is the observed shape: a delivery of three
// archives reported as `inserted 1, unchanged 2`, and a delivery reported as
// `nothing-new` with an all-zero split. Deriving the page from the split made it state a
// confidently wrong quantity over a real delivery.

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
import {
  recordSyncEvent,
  recordSyncRows,
} from "@/lib/integrations/connections";
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

// One delivery: `documents` archives landed for this patient, and the run that reported
// them claimed each one. `split` is what the TOOL said about its portal visit, which is a
// different question and is allowed to disagree — see the header.
function deliveredEvent(
  profileId: number,
  account: PortalAccount,
  patientLabel: string,
  documents: number,
  split: { inserted: number; updated?: number; unchanged?: number },
  at: string
): void {
  const eventId = recordSyncEvent(profileId, SOURCE, {
    ok: true,
    received: documents,
    written: split.inserted + (split.updated ?? 0),
    inserted: split.inserted,
    updated: split.updated ?? 0,
    unchanged: split.unchanged ?? 0,
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
  // A delivered archive always carries the identity it was acquired for — that is what
  // the upload route stamps, and what ties the count below to this login.
  const identityId = (
    db
      .prepare(
        "SELECT id FROM portal_identities WHERE account_id = ? AND patient_label = ?"
      )
      .get(account.id, patientLabel) as { id: number }
  ).id;
  const docIds: number[] = [];
  for (let i = 0; i < documents; i++) {
    docIds.push(
      Number(
        db
          .prepare(
            `INSERT INTO medical_documents
               (filename, stored_path, mime_type, size_bytes, extraction_status,
                uploaded_at, profile_id, acquired_identity_id)
             VALUES (?, '', 'application/xml', 20, 'done', ?, ?, ?)`
          )
          .run(
            `bundle-${at.slice(0, 10)}-${i}.xml`,
            at.slice(0, 19),
            profileId,
            identityId
          ).lastInsertRowid
      )
    );
  }
  recordSyncRows(
    eventId,
    docIds.map((id) => ({
      target_table: "medical_documents" as const,
      target_id: id,
      disposition: "inserted" as const,
    }))
  );
  // The DURABLE half of the claim — what the login row's count is read from, and what
  // outlives the retention sweep that takes the provenance rows above.
  const stamp = db.prepare(
    "UPDATE medical_documents SET delivered_at = ? WHERE id = ?"
  );
  // BARE, the convention this column shares with its neighbours (#2205).
  for (const id of docIds) stamp.run(at.replace("T", " ").slice(0, 19), id);
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

  // Login one: checked on the 10th, then a DELIVERY on the 15th. Three archives landed
  // on the first run of that day and one on the second — and the first run REPORTED
  // `inserted 1, unchanged 2`, which is the split shape that made this page and the
  // drill-in state two different numbers for one delivery. Plus one document delivered
  // days earlier, which the day-grain aggregate must not fold into the 15th's number.
  deliveredEvent(
    profileOne,
    accountOne,
    "One Patient",
    1,
    { inserted: 1 },
    "2026-08-10T09:00:00Z"
  );
  deliveredEvent(
    profileOne,
    accountOne,
    "One Patient",
    3,
    { inserted: 1, unchanged: 2 },
    "2026-08-15T19:36:20Z"
  );
  deliveredEvent(
    profileOne,
    accountOne,
    "One Patient",
    1,
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
  // scoping mistake would show up as login one's number moving. Its split is ALL ZEROES
  // — the observed `nothing-new` delivery — and nine archives still landed.
  deliveredEvent(
    profileTwo,
    accountTwo,
    "Two Patient",
    9,
    { inserted: 0 },
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

// "UTC" throughout, deliberately (#3836). The delivery day is now bucketed in the zone
// the caller states, and these fixtures land at 09:00Z, 19:36Z and 20:00Z — instants a
// real zone would move onto a neighbouring day, silently retargeting assertions written
// about scoping and about one-number-per-delivery. Passing UTC keeps every expectation
// below meaning exactly what it meant. The zone-crossing behaviour is proved where it
// belongs, over STRADDLING fixtures, in lib/__db_tests__/utc-day-render-sweep.test.ts.
describe("deliveredDocumentCountsByAccount (#2914)", () => {
  it("counts the documents a login delivered on its most recent delivery day", () => {
    // Four archives landed on the 15th (3 + 1). The single document from the 10th is a
    // different day and is deliberately not folded in.
    //
    // THE TOOL'S SPLIT FOR THAT DAY SUMS TO 2 (`inserted 1` then `updated 1`). Reading it
    // is what made this page say "1" while the drill-in listed 3 — one delivery with two
    // numbers, which is the thing #1991 exists to forbid.
    expect(
      deliveredDocumentCountsByAccount(authorized([profileOne]), false, "UTC").get(
        accountOne.id
      )
    ).toEqual({ count: 4, day: "2026-08-15" });
  });

  it("never lends one household's documents to another's login row", () => {
    const forOne = deliveredDocumentCountsByAccount(authorized([profileOne]),
      false, "UTC");
    expect(forOne.has(accountTwo.id)).toBe(false);
    const forTwo = deliveredDocumentCountsByAccount(authorized([profileTwo]),
      false, "UTC");
    // Nine, over a report whose split was all zeroes: the run said `nothing-new` about
    // the portal visit it did not make, and nine archives arrived anyway.
    expect(forTwo.get(accountTwo.id)).toEqual({ count: 9, day: "2026-08-15" });
    expect(forTwo.has(accountOne.id)).toBe(false);
  });

  it("answers nothing at all for a login with no accessible profile", () => {
    expect(deliveredDocumentCountsByAccount(authorized([]), false, "UTC").size).toBe(
      0
    );
  });
});

describe("a push that straddles UTC midnight (#2914)", () => {
  it("names the day the archives landed, and counts all of that day's", async () => {
    // One login, two patients, reports either side of midnight. Joining the claims to the
    // report row's day meant the day of whichever patient reported LAST, so everything
    // stamped on the earlier day vanished from the count: the page said 2 over five
    // archives the feed listed as 3 + 2. The day the sentence names is now the day the
    // documents arrived, so the two surfaces agree per day.
    const profile = newProfile("DELIVERY-MIDNIGHT");
    const portal = createPortal("Delivery Portal Midnight");
    expect(portal.ok).toBe(true);
    const account = accountsForPortal(portal.ok ? portal.id : 0)[0];
    expect(bindPortalIdentity(account.id, "Midnight Patient", profile).ok).toBe(
      true
    );

    deliveredEvent(
      profile,
      account,
      "Midnight Patient",
      3,
      { inserted: 3 },
      "2026-08-14T23:59:52Z"
    );
    deliveredEvent(
      profile,
      account,
      "Midnight Patient",
      2,
      { inserted: 2 },
      "2026-08-15T00:00:05Z"
    );
    recordPortalRunReport(account, {
      ok: true,
      status: "downloaded",
      message: null,
      discovered: 0,
      contacted: false,
    });
    stampReport(account, "2026-08-15 00:00:06", null);

    const delivered = deliveredDocumentCountsByAccount(authorized([profile]),
      false, "UTC").get(account.id);
    // The most recent delivery day, and everything that landed on it.
    expect(delivered).toEqual({ count: 2, day: "2026-08-15" });

    const report = listVisiblePortalRunReports(
      authorized([profile]),
      false
    ).find((r) => r.accountId === account.id)!;
    expect(portalLoginStatus({ ...report, delivered }, "UTC").text).toBe(
      "Delivered 2 documents 2026-08-15 · portal never checked"
    );
    // The other three are not lost — they are the previous day's delivery, which is
    // exactly how the Imports feed lists them.
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM medical_documents
            WHERE profile_id = ? AND substr(delivered_at, 1, 10) = '2026-08-14'`
        )
        .get(profile)
    ).toEqual({ n: 3 });
  });
});

describe("the sentence a delivery-only login row renders (#2914)", () => {
  it("names the delivery, the count, and the check clock it lags", () => {
    const report = listVisiblePortalRunReports(
      authorized([profileOne]),
      false
    ).find((r) => r.accountId === accountOne.id)!;
    const delivered = deliveredDocumentCountsByAccount(authorized([profileOne]),
      false, "UTC");
    const line = portalLoginStatus(
      { ...report, delivered: delivered.get(accountOne.id) ?? null },
      "UTC"
    );
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
    const delivered = deliveredDocumentCountsByAccount(authorized([profileTwo]),
      false, "UTC");
    expect(
      portalLoginStatus(
        { ...report, delivered: delivered.get(accountTwo.id) ?? null },
        "UTC"
      ).text
    ).toBe("Delivered 9 documents 2026-08-15 · portal never checked");
  });
});
