import {
  accessForProfile,
  canAccessProfile,
  requireAdmin,
  requireProfileWriteAccess,
  requireSession,
  requireWriteAccess,
} from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { poolMembers } from "@/lib/queries/intake";
import type { CabinetViewer } from "@/lib/refill";

// The cabinet's viewer, resolved ONCE at the request boundary and then passed DOWN as
// data to the auth-blind readers in lib/ (#5122). Every cabinet surface — the /supplies
// list, the "N shared bottles" doors, the item form's picker and the `?supply=` deep
// link — asks the same question through the same value, so a door can never promise a
// bottle its page would hide. The ids must already be the caller's accessible set
// (scope.ids, or getAccessibleProfiles()); the role is the login's, because the
// member-less case is admin-only.
export function cabinetViewer(
  profileIds: readonly number[],
  role: Role
): CabinetViewer {
  return { accessible: new Set(profileIds), isAdmin: role === "admin" };
}

// A shared bottle has no owning profile, so membership defines who may change it:
// write access to at least one linked profile, not every linked profile.
//
// A bottle with NO members is ADMIN-ONLY (#5122, owner ruling 2026-09-09) — the write
// half of the same rule isPoolVisibleTo carries for reads. It still needs a legitimate
// writer (requireWriteAccess keeps the demo and read-only refusals), and additionally an
// admin. Both guards redirect(), which throws, so a forged POST aborts before any
// mutation. Deleting such a bottle stays reachable for that admin: "manageable only by
// an admin" is half the ruling.
export async function requirePoolWriteAccess(supplyId: number): Promise<void> {
  const session = await requireSession();
  const members = poolMembers(supplyId);
  if (members.length === 0) {
    await requireWriteAccess();
    await requireAdmin();
    return;
  }
  const writable = members.some(
    (member) =>
      canAccessProfile(session, member.profileId) &&
      accessForProfile(
        session.login.id,
        session.login.role,
        member.profileId
      ) === "write"
  );
  // Use the canonical profile gate for the refusal so inaccessible and read-only
  // targets keep the same behavior as every other profile-owned write.
  if (!writable) await requireProfileWriteAccess(members[0].profileId);
}
