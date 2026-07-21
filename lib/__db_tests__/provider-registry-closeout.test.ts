// DB INTEGRATION TIER — the provider-domain closeout sweep against the real schema
// (issues #1056/#1057/#1058/#1055). Exercises: import capturing + refreshing
// specialty; the archive lifecycle (hidden from the default directory, kept on record
// joins, un-archived by a re-import); the contact edit-lock preserving a manual
// correction across a later import; and the grouped, activity-aware directory with
// nested affiliated people, per-profile scoped. Runs via `npm run test:db`.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  resolveProviderId,
  getProvider,
  setProviderArchived,
} from "@/lib/providers-db";
import {
  linkAffiliation,
  getGroupedProviderDirectory,
} from "@/lib/queries/affiliations";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

let profileA: number;
let profileB: number;
beforeEach(() => {
  profileA = newProfile("A");
  profileB = newProfile("B");
});

describe("import captures + refreshes specialty (#1056)", () => {
  it("stores specialty on first resolve and refreshes it on re-import", () => {
    const id = resolveProviderId({
      name: `Dr. Spec ${Math.random()}`,
      type: "individual",
      npi: "1000000021",
      identifier: null,
      phone: null,
      address: null,
      specialtyCode: "207RC0000X",
      specialty: "Cardiology",
    })!;
    expect(getProvider(id)!.specialty).toBe("Cardiology");
    expect(getProvider(id)!.specialty_code).toBe("207RC0000X");

    // A later import (same NPI) refreshes the specialty; a sparse re-import (no
    // specialty) must NOT null the stored value.
    resolveProviderId({
      name: "Dr. Spec Renamed",
      type: "individual",
      npi: "1000000021",
      identifier: null,
      phone: null,
      address: null,
      specialtyCode: "2084N0400X",
      specialty: "Neurology",
    });
    expect(getProvider(id)!.specialty).toBe("Neurology");
    resolveProviderId({
      name: "Dr. Spec",
      type: "individual",
      npi: "1000000021",
      identifier: null,
      phone: null,
      address: null,
    });
    expect(getProvider(id)!.specialty).toBe("Neurology"); // not nulled
  });
});

describe("archive lifecycle (#1057)", () => {
  it("hides from the default directory but keeps record joins", () => {
    const id = resolveProviderId({
      name: `Old Clinic ${Math.random()}`,
      type: "organization",
      npi: null,
      identifier: null,
      phone: null,
      address: null,
    })!;
    // A record links this provider for profile A.
    db.prepare(
      `INSERT INTO encounters (profile_id, date, provider_id) VALUES (?, '2020-01-01', ?)`
    ).run(profileA, id);
    setProviderArchived(id, true);

    const dir = getGroupedProviderDirectory(profileA);
    // Not in the active flat list / orgs; present in the archived disclosure.
    expect(dir.flat.some((p) => p.id === id)).toBe(false);
    expect(dir.orgs.some((g) => g.org.id === id)).toBe(false);
    expect(dir.archived.some((p) => p.id === id)).toBe(true);
    expect(dir.archivedCount).toBeGreaterThanOrEqual(1);
    // The record's FK link is untouched — history is immutable.
    const link = db
      .prepare(
        `SELECT provider_id FROM encounters WHERE profile_id = ? AND provider_id = ?`
      )
      .get(profileA, id) as { provider_id: number } | undefined;
    expect(link?.provider_id).toBe(id);
  });

  it("un-archives when a re-import resolves to it (pinned)", () => {
    const id = resolveProviderId({
      name: `Reengaged ${Math.random()}`,
      type: "individual",
      npi: "1000000022",
      identifier: null,
      phone: null,
      address: null,
    })!;
    setProviderArchived(id, true);
    expect(getProvider(id)!.archived).toBe(1);
    // A re-import of the SAME provider un-archives it (evidently active again).
    resolveProviderId({
      name: "Reengaged",
      type: "individual",
      npi: "1000000022",
      identifier: null,
      phone: null,
      address: null,
    });
    expect(getProvider(id)!.archived).toBe(0);
  });
});

describe("contact edit-lock (#1058)", () => {
  it("preserves an edited phone/address across a later import; unedited refresh normally", () => {
    const id = resolveProviderId({
      name: `Contact Org ${Math.random()}`,
      type: "organization",
      npi: null,
      identifier: "1.2.3:99",
      phone: "111-111-1111",
      address: "1 Old St",
    })!;
    // Simulate a manual correction locking the contact.
    db.prepare(
      `UPDATE providers SET phone = '555-010-9999', address = '2 New Ave', contact_edited = 1 WHERE id = ?`
    ).run(id);

    // A later import must NOT clobber the locked contact.
    resolveProviderId({
      name: "Contact Org",
      type: "organization",
      npi: null,
      identifier: "1.2.3:99",
      phone: "555-010-3333",
      address: "3 Import Rd",
    });
    const locked = getProvider(id)!;
    expect(locked.phone).toBe("555-010-9999");
    expect(locked.address).toBe("2 New Ave");
  });

  it("a never-edited provider updates contact on import (last-write-wins)", () => {
    const id = resolveProviderId({
      name: `Fresh Org ${Math.random()}`,
      type: "organization",
      npi: null,
      identifier: "1.2.3:100",
      phone: "111-111-1111",
      address: "1 Old St",
    })!;
    resolveProviderId({
      name: "Fresh Org",
      type: "organization",
      npi: null,
      identifier: "1.2.3:100",
      phone: "555-010-2222",
      address: "2 Newer St",
    });
    const p = getProvider(id)!;
    expect(p.phone).toBe("555-010-2222");
    expect(p.address).toBe("2 Newer St");
  });
});

describe("grouped directory (#1055)", () => {
  it("nests affiliated individuals under their org, per-profile activity scoped", () => {
    const chen = resolveProviderId({
      name: `Dr. Chen ${Math.random()}`,
      type: "individual",
      npi: "1000000031",
      identifier: null,
      phone: "555-010-1000",
      address: null,
      specialtyCode: "207RC0000X",
      specialty: "Cardiology",
    })!;
    const east = resolveProviderId({
      name: `Care East ${Math.random()}`,
      type: "organization",
      npi: null,
      identifier: "1.2.3:east",
      phone: null,
      address: null,
    })!;
    const lab = resolveProviderId({
      name: `One-off Lab ${Math.random()}`,
      type: "organization",
      npi: null,
      identifier: "1.2.3:lab",
      phone: null,
      address: null,
    })!;
    linkAffiliation(chen, east);

    // Profile A has visits at East with Chen; profile B has none of this.
    db.prepare(
      `INSERT INTO encounters (profile_id, date, provider_id, location_provider_id)
       VALUES (?, '2026-01-05', ?, ?)`
    ).run(profileA, chen, east);
    db.prepare(
      `INSERT INTO medical_records (profile_id, date, category, name, provider_id)
       VALUES (?, '2019-01-01', 'lab', 'CBC', ?)`
    ).run(profileA, lab);

    const dir = getGroupedProviderDirectory(profileA);
    const eastGroup = dir.orgs.find((g) => g.org.id === east);
    expect(eastGroup).toBeTruthy();
    expect(eastGroup!.members.map((m) => m.id)).toContain(chen);
    // The nested individual carries its specialty chip data.
    expect(eastGroup!.members.find((m) => m.id === chen)!.specialty).toBe(
      "Cardiology"
    );
    // The one-off lab (no affiliation) is a separate org card with no members.
    expect(dir.orgs.find((g) => g.org.id === lab)!.members).toHaveLength(0);
    expect(dir.hasEdges).toBe(true);

    // Per-profile scoped: profile B sees the same global registry but zero activity.
    const dirB = getGroupedProviderDirectory(profileB);
    expect(dirB.orgs.find((g) => g.org.id === east)!.org.activity).toBe(0);
  });

  it("an encounter delete does not orphan an affiliation edge", () => {
    const chen = resolveProviderId({
      name: `Dr. Edge ${Math.random()}`,
      type: "individual",
      npi: "1000000041",
      identifier: null,
      phone: null,
      address: null,
    })!;
    const org = resolveProviderId({
      name: `Edge Org ${Math.random()}`,
      type: "organization",
      npi: null,
      identifier: "1.2.3:edge",
      phone: null,
      address: null,
    })!;
    linkAffiliation(chen, org);
    const encId = Number(
      db
        .prepare(
          `INSERT INTO encounters (profile_id, date, provider_id, location_provider_id)
           VALUES (?, '2026-02-02', ?, ?)`
        )
        .run(profileA, chen, org).lastInsertRowid
    );
    db.prepare("DELETE FROM encounters WHERE id = ?").run(encId);
    // The edge is independent of any one encounter — still linked.
    const edge = db
      .prepare(
        `SELECT COUNT(*) AS n FROM provider_affiliations
          WHERE individual_id = ? AND organization_id = ? AND status = 'linked'`
      )
      .get(chen, org) as { n: number };
    expect(edge.n).toBe(1);
  });
});
