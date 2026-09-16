import {
  requireWriteAccess,
  requireProfileWriteAccess,
  type WriteAuthorizedProfileId,
} from "@/lib/auth";

// The one branch every item-level subject gate takes (#1328/#4932): an explicit
// target profile is write-gated cross-profile, its absence falls back to the
// active-profile gate — so "posted subject → requireProfileWriteAccess, absent →
// acting profile" (#4693 invariant 4) has exactly one implementation for both a
// FormData-posted `profile_id` (gateItemProfile) and a subject id already resolved
// server-side, e.g. the quick-log sheet's chosen chip (gateSubjectProfile).
//
// Both arms return the gate's OWN `writeProfileId` (#5348), not the id that went in:
// each gate mints a `WriteAuthorizedProfileId` for exactly the profile it authorized —
// requireProfileWriteAccess for the posted target, requireWriteAccess for the acting
// profile — so the brand this gate hands back is the gate's answer rather than a
// re-assertion of the caller's argument. Nothing here casts; there is nothing to cast,
// because both arms already hold a minted value they used to throw away.
async function gateProfile(
  pid: number | null
): Promise<WriteAuthorizedProfileId> {
  if (pid != null && pid > 0) {
    const { writeProfileId } = await requireProfileWriteAccess(pid);
    return writeProfileId;
  }
  const { writeProfileId } = await requireWriteAccess();
  return writeProfileId;
}

// Resolve + write-gate the TARGET profile for a per-item record write on a
// (possibly multi-view) Tier-1 list (#1328 — the shared twin of Upcoming's
// gateItemProfile, #1096). Every multi-view row posts its OWN `profile_id`, so an
// edit/delete on a non-acting member's row (e.g. deleting a condition on Mia's row
// while acting as Dad) must gate + write the ROW's profile — requireProfileWriteAccess
// asserts the target is reachable AND write, bouncing a read-only-granted or ungranted
// member. With no `profile_id` (a single-view form, the default) it falls back to the
// active-profile requireWriteAccess gate — which also keeps the write-access scanner's
// recognized literal present in THIS file. Returns the gated target profile id as a
// `WriteAuthorizedProfileId`, so a write core that takes the brand can be called with
// it directly; a branded number is still a number, so callers that only want an id are
// unaffected.
//
// Lives in the app (action) layer, NOT lib/ — it calls lib/auth's gates at runtime,
// which lib write cores do not do (the profileId-first / auth-boundary convention). A
// converted core may `import type` from lib/auth for the brand itself — that line is
// erased at build, so the core still runs auth-blind and the convention holds. The
// record actions that call it are allowlisted in
// lib/__tests__/actions-write-access.test.ts as gateItemProfile delegators, exactly as
// the Upcoming per-item writes are.
export async function gateItemProfile(
  formData: FormData
): Promise<WriteAuthorizedProfileId> {
  const pid = Number(formData.get("profile_id"));
  return gateProfile(pid > 0 ? pid : null);
}

// The same gate, for a caller that already holds the subject as a number rather than
// as a FormData field — the quick-log sheet's `loadQuickEntry` (#4932), whose subject
// comes from client state, not a posted form. ONE gate, reused rather than
// re-implemented: an explicit subject is write-checked with requireProfileWriteAccess
// exactly as a posted `profile_id` is, and no subject falls back to the acting
// profile.
export async function gateSubjectProfile(
  subjectProfileId: number | null | undefined
): Promise<WriteAuthorizedProfileId> {
  return gateProfile(subjectProfileId ?? null);
}
