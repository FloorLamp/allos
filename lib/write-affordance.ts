// The write-affordance derivation (#4844) — "may this login be OFFERED a write on
// this profile, here, right now?"
//
// A surface that renders an edit control has to answer the same question the write
// gate will answer when the control is tapped. Answering it with `accessForProfile`
// ALONE gets one of the two inputs: it reads the #33 grant and ignores demo mode.
// So on an instance running ALLOS_DEMO_MODE with a write-granted non-admin — the
// flag flipped on a live instance, or a grant misconfigured to 'write' on a demo
// one — every such surface renders a control that looks live and then bounces to
// `/`, because `requireWriteAccess` / `requireProfileWriteAccess` refuse it
// (lib/auth's assertNotDemoRestricted). A live-looking control that bounces is not
// demo behaviour; the read-only rendering is. Ruled on #4844, 2026-09-10.
//
// So the two consults live together HERE and a caller gets both or neither. This is
// the affordance question only — what the page OFFERS. It is NOT a gate and mints no
// `WriteAuthorizedProfileId`: every action still re-gates the posted id server-side
// through lib/auth, which is where the refusal that matters lives.
//
// WHY ITS OWN MODULE rather than a line inside lib/auth beside `accessForProfile`.
// The server-action/render tier replaces `@/lib/auth` wholesale with a faithful mock
// (lib/__action_tests__/setup.ts), so a derivation defined in that module would be
// the MOCK's derivation everywhere a rendered surface can be tested — mutate the real
// one and nothing goes red. Here the fold is the real code in every tier, and only
// its grant input comes through the mocked boundary.
//
// REACHABILITY FIRST, as always: `accessForProfile` assumes the profile is already
// known reachable and defaults an UNGRANTED member to 'write', so a caller must have
// resolved the profile out of the login's accessible set before asking.

import { accessForProfile, type Role } from "./auth";
import { isDemoMode, isDemoRestricted } from "./demo";

export function canWriteProfile(
  loginId: number,
  role: Role,
  profileId: number
): boolean {
  if (isDemoRestricted(isDemoMode(), role)) return false;
  return accessForProfile(loginId, role, profileId) === "write";
}
