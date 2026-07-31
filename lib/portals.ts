import { db, writeTx } from "./db";
import {
  isPatientLabel,
  isPortalSlug,
  normalizePatientLabel,
  rejectsAddress,
  PORTAL_NAME_MAX,
} from "./acquirer-identity";

// The portal registry and the `(portal, patient-label) → profile` identity mapping
// (issue #1739) — the DB half of the acquirer surface. The pure vocabulary lives in
// lib/acquirer-identity.ts and nothing here re-implements it.
//
// ── THE ONE RULE ─────────────────────────────────────────────────────────────
//
// A mapping is NEVER a bypass of profile authorization. `resolvePortalIdentity` answers
// "which profile did the user bind this patient label to", and stops. Whether the CALLER
// may write to that profile is a separate question the route answers by intersecting the
// resolved id with the token's `accessForProfile` write set — the same seam
// authenticateApiToken/route authorization already use. A binding that resolves to a
// profile the pushing token cannot write is refused exactly as loudly as an unknown one.
//
// ── AND THE ONE REFUSAL ──────────────────────────────────────────────────────
//
// An unmapped identity REFUSES; it never defaults. When a new proxy patient appears on a
// portal — a child turning into an adult account, a parent added to someone's proxy list
// — the correct behaviour is a visible failure that becomes a one-tap binding, not a
// silent landing on whichever profile seemed closest. There is deliberately no fallback
// to an "active" or "first" profile anywhere in this module.

export interface Portal {
  id: number;
  slug: string;
  name: string;
  createdAt: string;
}

export interface PortalIdentity {
  id: number;
  portalId: number;
  portalSlug: string;
  portalName: string;
  patientLabel: string;
  profileId: number;
  updatedAt: string;
}

// ── Portal registry ──────────────────────────────────────────────────────────

const LIST_PORTALS_STMT = db.prepare(
  `SELECT id, slug, name, created_at AS createdAt FROM portals ORDER BY name COLLATE NOCASE`
);

export function listPortals(): Portal[] {
  return LIST_PORTALS_STMT.all() as Portal[];
}

const PORTAL_BY_SLUG_STMT = db.prepare(
  `SELECT id, slug, name, created_at AS createdAt
     FROM portals WHERE slug = ? COLLATE NOCASE`
);

export function portalBySlug(slug: string): Portal | null {
  return (PORTAL_BY_SLUG_STMT.get(slug) as Portal | undefined) ?? null;
}

export type PortalWriteResult =
  { ok: true; id: number } | { ok: false; error: string };

// Register a portal. Validation is the security boundary, not a convenience: a slug must
// be a slug, and the display NAME is refused if it looks like an address. The schema has
// no URL column at all (migration 128), so this closes the only remaining way an address
// could enter the authoritative record — a human pasting one into the free-text field.
export function createPortal(slug: string, name: string): PortalWriteResult {
  const s = slug.trim().toLowerCase();
  const n = name.trim().slice(0, PORTAL_NAME_MAX);
  if (!isPortalSlug(s)) {
    return {
      ok: false,
      error:
        "The portal id must be lowercase letters, digits and hyphens — for example “ochsner”.",
    };
  }
  if (!n) return { ok: false, error: "Give the portal a name." };
  if (rejectsAddress(n) || rejectsAddress(s)) {
    return {
      ok: false,
      error:
        "A portal is recorded by name only — never a web address. The companion tool holds the address on your own machine.",
    };
  }
  if (portalBySlug(s)) {
    return { ok: false, error: `A portal “${s}” already exists.` };
  }
  const id = writeTx((): number => {
    const info = db
      .prepare(
        "INSERT INTO portals (slug, name, created_at) VALUES (?, ?, datetime('now'))"
      )
      .run(s, n);
    return Number(info.lastInsertRowid);
  });
  return { ok: true, id };
}

// Remove a portal. Its bindings cascade (FK ON DELETE CASCADE), and they are also cleared
// explicitly so the teardown holds with foreign_keys off — the posture every other
// multi-table delete in this repo uses.
export function deletePortal(portalId: number): boolean {
  return writeTx((): boolean => {
    db.prepare("DELETE FROM portal_identities WHERE portal_id = ?").run(
      portalId
    );
    return (
      db.prepare("DELETE FROM portals WHERE id = ?").run(portalId).changes > 0
    );
  });
}

// ── Identity bindings ────────────────────────────────────────────────────────

const LIST_IDENTITIES_STMT = db.prepare(
  `SELECT pi.id AS id, pi.portal_id AS portalId, p.slug AS portalSlug,
          p.name AS portalName, pi.patient_label AS patientLabel,
          pi.profile_id AS profileId, pi.updated_at AS updatedAt
     FROM portal_identities pi JOIN portals p ON p.id = pi.portal_id
    ORDER BY p.name COLLATE NOCASE, pi.patient_label COLLATE NOCASE`
);

// Every binding on the instance, for the setup card. Cross-profile by nature — the card
// is an administrative view of "which patient goes where" — so the CALLER filters to what
// its viewer may see; this layer stays scope-blind.
export function listPortalIdentities(): PortalIdentity[] {
  return LIST_IDENTITIES_STMT.all() as PortalIdentity[];
}

export type BindResult =
  { ok: true; id: number } | { ok: false; error: string };

// Bind a patient label on a portal to a profile.
//
// An ACCESS-CONTROL-ADJACENT write, so it is an atomic upsert rather than
// read-then-write: the UNIQUE(portal_id, patient_label) index makes the binding a KEY,
// and ON CONFLICT re-points it in one statement. Two admins binding the same label
// concurrently therefore end with one unambiguous answer instead of two rows racing to
// define where a person's records land.
//
// The caller MUST have already authorized `profileId` for the acting login — this is the
// write core, and per house rules it is auth-blind.
export function bindPortalIdentity(
  portalId: number,
  patientLabel: string,
  profileId: number
): BindResult {
  const label = normalizePatientLabel(patientLabel);
  if (!isPatientLabel(label)) {
    return {
      ok: false,
      error: "Give the patient label exactly as the portal shows it.",
    };
  }
  const portal = db
    .prepare("SELECT id FROM portals WHERE id = ?")
    .get(portalId) as { id: number } | undefined;
  if (!portal) return { ok: false, error: "Unknown portal." };

  const id = writeTx((): number => {
    const info = db
      .prepare(
        `INSERT INTO portal_identities
           (portal_id, patient_label, profile_id, created_at, updated_at)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(portal_id, patient_label)
         DO UPDATE SET profile_id = excluded.profile_id,
                       updated_at = datetime('now')`
      )
      .run(portalId, label, profileId);
    if (info.lastInsertRowid) return Number(info.lastInsertRowid);
    const row = db
      .prepare(
        "SELECT id FROM portal_identities WHERE portal_id = ? AND patient_label = ?"
      )
      .get(portalId, label) as { id: number };
    return row.id;
  });
  return { ok: true, id };
}

// Remove a binding. Scoped by id; the caller authorizes.
export function unbindPortalIdentity(identityId: number): boolean {
  return (
    db.prepare("DELETE FROM portal_identities WHERE id = ?").run(identityId)
      .changes > 0
  );
}

// ── Resolution (the upload path) ─────────────────────────────────────────────

export type IdentityResolution =
  | { ok: true; profileId: number; portalId: number }
  // The identity is not bound at all. Typed so the endpoint can answer
  // `unmapped-identity` rather than a generic 400 — the tool surfaces it, and the card
  // turns it into a pending binding.
  | { ok: false; reason: "unmapped-identity" };

// Resolve `(portal slug, patient label)` to the profile the user bound it to, or refuse.
//
// This is the ONE lookup that RESOLVES which profile to gate on, which is why its SQL
// selects `profile_id` without filtering by it — filtering would presuppose the answer.
// The gate is the protection, not the filter: the caller immediately intersects the
// returned id with the token's `accessForProfile` write set, and an unauthorized result
// is refused. Registered with that justification in the profile-scoping allowlist.
export function resolvePortalIdentity(
  portalSlug: string,
  patientLabel: string
): IdentityResolution {
  const label = normalizePatientLabel(patientLabel);
  const row = db
    .prepare(
      `SELECT pi.profile_id AS profileId, pi.portal_id AS portalId
         FROM portal_identities pi JOIN portals p ON p.id = pi.portal_id
        WHERE p.slug = ? COLLATE NOCASE AND pi.patient_label = ?`
    )
    .get(portalSlug, label) as
    { profileId: number; portalId: number } | undefined;
  if (!row) return { ok: false, reason: "unmapped-identity" };
  return { ok: true, profileId: row.profileId, portalId: row.portalId };
}
