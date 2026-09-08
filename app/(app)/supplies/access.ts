import {
  accessForProfile,
  canAccessProfile,
  requireProfileWriteAccess,
  requireSession,
  requireWriteAccess,
} from "@/lib/auth";
import { poolMembers } from "@/lib/queries/intake";

// A shared bottle has no owning profile, so membership defines who may change it:
// write access to at least one linked profile, not every linked profile. An empty
// cabinet entry names nobody and falls back to the active-profile write gate.
export async function requirePoolWriteAccess(supplyId: number): Promise<void> {
  const session = await requireSession();
  const members = poolMembers(supplyId);
  if (members.length === 0) {
    await requireWriteAccess();
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
