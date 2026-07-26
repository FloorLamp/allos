// e2e seed fixtures — providers domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import { db } from "../../lib/db";
import { PROFILE_ID } from "./common";

// ── Same-named provider pair for merge disambiguation ──
export function seedProviderMergePair(): void {
  // ── Same-named provider pair for the merge disambiguation (issue #532) ────────
  // Two organizations that share the name "E2E Duplicate Lab" but carry distinct
  // identifiers + addresses (so distinct dedup keys). The admin merge picker + its
  // irreversible confirm must label them by the differing field, not by the byte-
  // identical name — otherwise the destructive pick is blind on the exact case merge
  // targets. Idempotent: clear both by dedup_key first. Unlinked (no records), so the
  // merge-disambig spec can open the picker/confirm and CANCEL without side effects.
  for (const key of ["id:e2e-dup-lab-a", "id:e2e-dup-lab-b"]) {
    db.prepare(`DELETE FROM providers WHERE dedup_key = ?`).run(key);
  }
  const insDupProvider = db.prepare(
    `INSERT INTO providers (name, type, identifier, address, dedup_key)
   VALUES ('E2E Duplicate Lab', 'organization', ?, ?, ?)`
  );
  insDupProvider.run(
    "e2e-dup-lab-a",
    "100 Alpha St, Springfield",
    "id:e2e-dup-lab-a"
  );
  insDupProvider.run(
    "e2e-dup-lab-b",
    "200 Beta Ave, Portland",
    "id:e2e-dup-lab-b"
  );
  console.log(
    "e2e: seeded two same-named 'E2E Duplicate Lab' providers (merge disambiguation, #532)"
  );
}

// ── Provider-domain closeout fixtures ──
export function seedProviderCloseout(): void {
  // ── Provider-domain closeout fixtures (#1056/#1057/#1058/#1055) ────────────────
  // On profile 1 (the admin's default active profile) so the provider-registry spec
  // can drive both READ surfaces (grouped directory, specialty chip, "Practices at",
  // archived disclosure) and the admin-only WRITE flows (archive round-trip, decline
  // a suggestion). Idempotent: every provider is cleared by its dedup_key first, and
  // the affiliation edge + encounters are rebuilt from the fresh ids. Synthetic names.
  {
    const provKeys = [
      "e2e-prov-corabell",
      "e2e-prov-bellcardio",
      "e2e-prov-retired",
      "e2e-prov-samng",
      "e2e-prov-ngfp",
    ];
    const delProv = db.prepare(`DELETE FROM providers WHERE dedup_key = ?`);
    for (const k of provKeys) delProv.run(k);

    const insInd = db.prepare(
      `INSERT INTO providers (name, type, specialty_code, specialty, archived, dedup_key)
     VALUES (?, 'individual', ?, ?, ?, ?)`
    );
    const insOrg = db.prepare(
      `INSERT INTO providers (name, type, archived, dedup_key)
     VALUES (?, 'organization', ?, ?)`
    );
    const coraId = Number(
      insInd.run(
        "Dr. Cora Bell (e2e)",
        "207RC0000X",
        "Cardiology",
        0,
        "e2e-prov-corabell"
      ).lastInsertRowid
    );
    const bellCardioId = Number(
      insOrg.run("Bell Cardiology (e2e)", 0, "e2e-prov-bellcardio")
        .lastInsertRowid
    );
    // A seeded ARCHIVED provider for the archive→disclosure→unarchive round-trip.
    insOrg.run("Retired Clinic (e2e)", 1, "e2e-prov-retired");
    // A co-occurrence pair with NO edge → surfaces as a suggestion to accept/decline.
    const samId = Number(
      insInd.run("Dr. Sam Ng (e2e)", null, null, 0, "e2e-prov-samng")
        .lastInsertRowid
    );
    const ngfpId = Number(
      insOrg.run("Ng Family Practice (e2e)", 0, "e2e-prov-ngfp").lastInsertRowid
    );

    // The confirmed affiliation edge (Cora Bell practices at Bell Cardiology).
    db.prepare(
      `DELETE FROM provider_affiliations WHERE individual_id IN (?, ?) OR organization_id IN (?, ?)`
    ).run(coraId, samId, bellCardioId, ngfpId);
    db.prepare(
      `INSERT INTO provider_affiliations (individual_id, organization_id, status, source)
     VALUES (?, ?, 'linked', 'manual')`
    ).run(coraId, bellCardioId);

    // Encounters on profile 1 giving both pairs activity + co-occurrence. Clear the
    // fixture encounters first (by a reason marker) so a re-seed doesn't duplicate.
    db.prepare(
      `DELETE FROM encounters WHERE profile_id = ? AND reason = 'e2e provider fixture'`
    ).run(PROFILE_ID);
    const insEnc = db.prepare(
      `INSERT INTO encounters (profile_id, date, provider_id, location_provider_id, reason)
     VALUES (?, ?, ?, ?, 'e2e provider fixture')`
    );
    insEnc.run(PROFILE_ID, "2026-03-01", coraId, bellCardioId);
    insEnc.run(PROFILE_ID, "2026-03-02", samId, ngfpId);

    console.log(
      `e2e: seeded provider-domain closeout fixtures (#1055/#1056/#1057/#1058) on profile ${PROFILE_ID}`
    );
  }
}
