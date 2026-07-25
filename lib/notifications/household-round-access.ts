// Who a household dose round (issue #1459) may legitimately cover — the §1
// validation, resolved in ONE place and run TWICE: once at send time (which members
// get a section) and again at tap time (whether this confirm may write). A stored
// member selection is DATA, NOT AN AUTH CHECK; live grants are the authority, so a
// grant revoked between send and tap refuses the tap.
//
// THE RULE, stated once so it can't drift:
//
//   A member M is covered by the round of receiving profile R iff at least one login
//   whose OWN profile is R (`logins.own_profile_id`, #1013) currently holds WRITE
//   access to M — and M is not R itself.
//
// The common case is exactly one such login (the caregiver). "Own profile" — not
// "any login granted R" — is the bridge the design picked deliberately: the round is
// a push into the RECEIVER's pocket, so the person it is about must be the person
// whose account it is, otherwise a co-parent granted read on the receiver could
// conjure a round about someone else's children.
//
// Access is read through lib/auth's `accessForProfile` / `accessibleProfilesForLogin`
// — the SAME functions the in-app cross-profile dose confirm gates on
// (requireProfileWriteAccess → accessForProfile), so the Telegram round and the
// Household page can never disagree about who may log for whom. This module is
// AUTH-BLIND in the CLAUDE.md sense: it resolves access as DATA and performs no
// session gate; it is never a substitute for the action-layer gate on the web paths.

import { db } from "../db";
import {
  accessForProfile,
  accessibleProfilesForLogin,
  type Role,
} from "../auth";
import {
  getProfileHouseholdRound,
  isProfileMutedForLogin,
  loginIdsForTelegramChat,
} from "../settings";
import type { HouseholdTapAccess } from "./callback-data";

// A member the round may cover, with the login that authorizes it.
export interface HouseholdRoundMember {
  profileId: number;
  name: string;
  // The login whose own profile is the receiver and which holds write access here.
  loginId: number;
}

// The logins whose OWN profile is `profileId` (#1013). The "self" direction of the
// login↔profile edge set (managing-logins.ts owns the grant direction); a profile
// that is no login's own profile has none, and therefore no offerable members — the
// settings card says so and the toggle is inert (§1).
export function loginsOwningProfile(
  profileId: number
): { id: number; role: Role }[] {
  return db
    .prepare("SELECT id, role FROM logins WHERE own_profile_id = ? ORDER BY id")
    .all(profileId) as { id: number; role: Role }[];
}

// Every member the receiver's round MAY cover, deduped by profile and ordered by
// profile id. This is the OFFER set the settings checklist renders and the filter the
// send applies to the stored selection. The receiver itself is excluded — their own
// doses ride their own reminder, and folding them in would double-notify.
//
// An admin login reaches every profile, so an admin caregiver is OFFERED everyone;
// that is why the selection is explicit and never auto-all (§1). Nothing is included
// without the caregiver having ticked it.
export function householdRoundOfferableMembers(
  receiverProfileId: number
): HouseholdRoundMember[] {
  const byProfile = new Map<number, HouseholdRoundMember>();
  for (const login of loginsOwningProfile(receiverProfileId)) {
    for (const profile of accessibleProfilesForLogin(login.id)) {
      if (profile.id === receiverProfileId) continue;
      if (byProfile.has(profile.id)) continue;
      if (accessForProfile(login.id, login.role, profile.id) !== "write") {
        continue;
      }
      byProfile.set(profile.id, {
        profileId: profile.id,
        name: profile.name,
        loginId: login.id,
      });
    }
  }
  return [...byProfile.values()].sort((a, b) => a.profileId - b.profileId);
}

// The offerable members intersected with the caregiver's STORED selection, in the
// offer set's order. A selected member whose grant has since been revoked simply
// drops out — silently, per §1: the round is a convenience surface and a missing
// section is self-evident, whereas an error message about someone else's access in a
// dose reminder is noise at the breakfast table.
export function householdRoundMembers(
  receiverProfileId: number,
  selectedIds: readonly number[]
): HouseholdRoundMember[] {
  const selected = new Set(selectedIds);
  return householdRoundOfferableMembers(receiverProfileId).filter((m) =>
    selected.has(m.profileId)
  );
}

// The tap-time re-check: may `receiverProfileId`'s round still write for
// `memberProfileId`? Returns the authorizing login id, or null when the edge no
// longer holds. Deliberately the SAME resolution the send used, so there is one
// answer to one question.
export function householdRoundWriteLogin(
  receiverProfileId: number,
  memberProfileId: number
): number | null {
  const member = householdRoundOfferableMembers(receiverProfileId).find(
    (m) => m.profileId === memberProfileId
  );
  return member?.loginId ?? null;
}

// ---- Tap-time resolution (issue #1459 §3) ----------------------------------------
//
// A household confirm button is tapped. BEFORE any write, three things must hold, and
// each failure gets its own honest answer (never a silent success, never a shared
// "something went wrong"):
//
//   1. The tap came from the RECEIVING profile's own chat — i.e. some login whose
//      channel is this chat has the receiver as its own profile, and has not muted it.
//      A token that leaked into another chat is refused here.
//   2. The subscription still stands: the round is enabled and this member is still
//      in the stored selection.
//   3. The access edge still holds under LIVE grants (§1 re-validated, not trusted
//      from send time) — a grant revoked in the minutes since the send refuses.
//
// Only then does the caller run `markDoseTaken(memberProfileId, …)`, whose own typed
// outcome answers the rest. This never itself writes.
export function resolveHouseholdTapAccess(
  chatId: string,
  tap: { receiverProfileId: number; memberProfileId: number }
): HouseholdTapAccess {
  const loginIds = loginIdsForTelegramChat(chatId);
  // (1) Is this chat the receiving profile's own chat?
  const owning = new Set(
    loginsOwningProfile(tap.receiverProfileId).map((l) => l.id)
  );
  const chatOwnsReceiver = loginIds.some(
    (id) => owning.has(id) && !isProfileMutedForLogin(id, tap.receiverProfileId)
  );
  if (!chatOwnsReceiver) return { kind: "wrong-chat" };

  // (2) Is the round still subscribed, with this member still selected?
  const { enabled, memberIds } = getProfileHouseholdRound(
    tap.receiverProfileId
  );
  if (!enabled || !memberIds.includes(tap.memberProfileId)) {
    return { kind: "unsubscribed" };
  }

  // (3) Does the receiver's login still hold WRITE access to this member?
  const loginId = householdRoundWriteLogin(
    tap.receiverProfileId,
    tap.memberProfileId
  );
  if (loginId == null) return { kind: "revoked" };
  return { kind: "allowed", loginId };
}
