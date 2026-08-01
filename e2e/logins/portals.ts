// Shared credential + fixture-profile names for the e2e patient-portals fixtures.
// Composed into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// TWO HOUSEHOLDS THAT SHARE NOTHING (#1787). The portals fixtures elsewhere all run as
// the admin, who can reach every profile — so they cannot express the question this bug
// was about: what a login with NO access to a portal account's profile sees. These two
// members each hold write access to exactly one profile and none to the other's, which
// is the scenario the profile-scoping discipline exists for.
export const E2E_LOGIN_PORTAL_A = "e2e_portal_a";
export const PORTAL_HOUSEHOLD_A_PROFILE = "Portal House A (e2e)";

export const E2E_LOGIN_PORTAL_B = "e2e_portal_b";
export const PORTAL_HOUSEHOLD_B_PROFILE = "Portal House B (e2e)";

// Household B's portal, its named login, and the free-text failure line the companion
// tool reported for it. The message is the payload of the disclosure: it is what an
// external tool supplies through the token-authenticated upload API, and it is what the
// status card rendered to every login before the fix. Deliberately distinctive so the
// spec can assert its ABSENCE without matching anything else in the app.
export const PORTAL_B_NAME = "Bee Clinic Portal (e2e)";
export const PORTAL_B_ACCOUNT = "Bee Household Login (e2e)";
export const PORTAL_B_FAILURE = "e2e-1787-leak-canary: sign-in blocked for bee";

// A READ-ONLY caregiver on household A, for the guided page's empty-registry stage
// (#1826). The stage is derived from the registry this login can SEE, and a read-only
// member is outside the `canManagePending` population — so the scoped read admits neither
// a claimed account (A's profile has no portal binding) nor an unclaimed one. Its visible
// registry is therefore empty no matter what portals other specs create and remove around
// it, which is what makes "a household with no portal of its own" a deterministic
// assertion on a shared worker database rather than a scheduling coin flip.
export const E2E_LOGIN_PORTAL_NONE = "e2e_portal_none";
