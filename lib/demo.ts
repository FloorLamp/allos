// Demo mode (#181): support running a PUBLIC, read-only demo instance.
//
// One env flag, ALLOS_DEMO_MODE, drives everything. It is deliberately an ENV
// flag, not a global `settings` row: the global tier is admin-mutable from inside
// the app, and demo posture must NOT be editable from within the demo. Read at
// request time (process.env is fixed for the life of a server process, so this is
// effectively "read once at boot" — the same pattern lib/two-factor.is2faBypassed
// uses) so tests can toggle it around a case.
//
// Demo mode is PRESENTATION plus a belt-and-braces write block. The actual
// read-only enforcement is #33's view-only grants: the demo login is a MEMBER with
// `access = 'read'` grants to the seeded profile(s), which every mutating Server
// Action already refuses via requireWriteAccess(). The extra guard here only
// matters if a grant is ever misconfigured to 'write'.

// The demo member's public credentials. Shown on the login page in demo mode and
// created (as a read-only member) by the seed when the flag is set. Public by
// design — this login can only ever READ synthetic data.
export const DEMO_USERNAME = "demo";
export const DEMO_PASSWORD = "demo";

// The banner text — the PHI warning is the load-bearing part (the one real risk of
// a public health-app demo is someone pasting real labs in). Kept here so the
// rendered banner and any test assert against one source of truth.
export const DEMO_BANNER_TEXT =
  "Public demo — synthetic data — resets nightly — do not enter real health information.";

// Pure interpretation of the env value, so the on/off decision is unit-testable
// without touching process.env. Accepts the common truthy spellings; anything else
// (including undefined/empty) is off.
export function isDemoModeEnv(value: string | undefined | null): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Whether this instance is running as a public demo. Reads ALLOS_DEMO_MODE.
export function isDemoMode(): boolean {
  return isDemoModeEnv(process.env.ALLOS_DEMO_MODE);
}

// The role a login holds — mirrors lib/auth.Role, redeclared locally so this
// module stays dependency-free (lib/auth imports THIS module for the write guard,
// so importing back would be a cycle).
type DemoRole = "admin" | "member";

// The single pure predicate demo mode turns on: in demo mode a NON-admin login is
// restricted — every write is refused and the sensitive/config surfaces (change
// password, Telegram, uploads) are trimmed. The admin login stays fully functional
// so the operator can maintain the instance (and is never advertised in the UI).
//
// Consumed identically by the real requireWriteAccess() guard (lib/auth) and the
// action-tier faithful mock, and by the page-level surface trimming, so "who is
// locked down in demo" is decided in exactly one place.
export function isDemoRestricted(demoMode: boolean, role: DemoRole): boolean {
  return demoMode && role !== "admin";
}
