// Pure decision logic for reassigning a mis-filed import to another profile
// (issue #208, Phase 3). A document uploaded under the wrong person needs to move
// — the document row, every row it imported, and its on-disk file — to another
// profile the acting login can reach. The DB/file move lives in the server action
// (app/(app)/medical/actions.reassignDocument); this module owns the pure
// "may this login move THIS document from A to B?" rule so it unit-tests without a
// DB, mirroring lib/family-deletion.
//
// The rule: the destination must be a real, DIFFERENT profile the login can
// access. `accessibleProfileIds` is the caller's accessible set — for admins that
// is every profile (they bypass grants), for members only their granted ones — so
// a single membership check covers both roles. The source is the document's
// current profile; the caller has already resolved the document under it
// (getMedicalDocument is profile-scoped), so it is accessible by construction, but
// we assert it too so a caller can't smuggle an id the login can't reach.

export interface ReassignRequest {
  sourceProfileId: number;
  destProfileId: number;
  accessibleProfileIds: number[];
}

export type ReassignDecision = { ok: true } | { ok: false; reason: string };

export function canReassignDocument(req: ReassignRequest): ReassignDecision {
  const { sourceProfileId, destProfileId, accessibleProfileIds } = req;
  const accessible = new Set(accessibleProfileIds);
  if (!Number.isInteger(destProfileId) || destProfileId <= 0) {
    return { ok: false, reason: "Choose a destination profile." };
  }
  if (destProfileId === sourceProfileId) {
    return { ok: false, reason: "The document is already on this profile." };
  }
  if (!accessible.has(sourceProfileId)) {
    return {
      ok: false,
      reason: "You don't have access to this document's profile.",
    };
  }
  if (!accessible.has(destProfileId)) {
    return {
      ok: false,
      reason: "You don't have access to the destination profile.",
    };
  }
  return { ok: true };
}
