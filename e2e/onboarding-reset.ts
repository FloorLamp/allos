// Reset the onboarding fixture profiles to their seeded state — the per-repeat
// reset that makes e2e/onboarding.spec.ts repeat-safe (it previously skipped
// repeatEachIndex > 0, so the --repeat-each lanes could never amplify an
// onboarding flake).
//
// The wizard is a one-way, stateful flow: its first step flips the fixture
// profile's onboarding state not_started→in_progress, and completing it writes
// records (a baseline body metric, a starter routine, a dashboard layout) and
// stamps the state complete — after which the dashboard no longer auto-redirects
// to /onboarding, so a second run of the same test against the same DB starts in
// the wrong world. This module re-creates the seeded starting state on demand.
//
// ONE SOURCE OF TRUTH: e2e/seed-events.ts imports these same functions for its
// boot-time fixture setup, so the boot-time seed and the per-repeat reset cannot
// drift. Every function takes the DB handle as an argument so it works with both
// seed-events' `lib/db` connection (boot time — app not yet started) and the
// bare connection `withE2eDb` opens from the Playwright worker (mid-suite — the
// app is live, hence busy_timeout; WAL supports the extra process, same as the
// app's own 3-writer topology).
//
// The spec-side write is safe because these fixture profiles are OWNED by
// onboarding.spec.ts (the #868 fixture-ownership rule): no other spec — and no
// app background work — touches them, so a reset between repeats can't race
// anything. Do NOT reach for this module to mutate shared/profile-1 state from a
// spec; fixture ownership is what makes direct DB writes legitimate here.
import Database from "better-sqlite3";
import path from "node:path";
import {
  initialOnboardingState,
  serializeOnboardingState,
} from "../lib/onboarding";
import {
  ONBOARDING_PROFILE,
  ONBOARDING_CAREGIVER_PROFILE,
  ORIENTATION_PROFILE,
  E2E_LOGIN_ORIENTATION,
} from "./fixture-logins";

// The minimal handle surface both callers share.
type DbHandle = Pick<InstanceType<typeof Database>, "prepare">;

// Delete every row the onboarding wizard (or the fixture's prior run) can have
// written for this profile, returning it to "truly empty". This is the wizard's
// whole write surface: the metrics path records a baseline weight, the fitness
// path creates a starter routine, the dashboard step writes a layout, and the
// finish stamps goals/targets — plus the belt-and-suspenders tables a future
// wizard step could plausibly touch (same list the boot-time seed always used).
export function resetOnboardingProfileRows(
  db: DbHandle,
  profileId: number
): void {
  db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM activities WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM medical_records WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM medical_documents WHERE profile_id = ?`).run(
    profileId
  );
  db.prepare(`DELETE FROM intake_items WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM appointments WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM immunizations WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM care_plan_items WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM goals WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM frequency_targets WHERE profile_id = ?`).run(
    profileId
  );
  db.prepare(`DELETE FROM equipment WHERE profile_id = ?`).run(profileId);
  db.prepare(
    `DELETE FROM routine_slots
    WHERE routine_day_id IN (
      SELECT rd.id FROM routine_days rd
      JOIN routines r ON r.id = rd.routine_id
      WHERE r.profile_id = ?
    )`
  ).run(profileId);
  db.prepare(
    `DELETE FROM routine_days
    WHERE routine_id IN (SELECT id FROM routines WHERE profile_id = ?)`
  ).run(profileId);
  db.prepare(`DELETE FROM routines WHERE profile_id = ?`).run(profileId);
  db.prepare(
    `DELETE FROM profile_settings WHERE profile_id = ? AND key = 'dashboard_layout'`
  ).run(profileId);
}

// Stamp the profile back to the wizard's entry state (not_started, version 1,
// checklist un-dismissed — the checklist flag lives INSIDE this JSON, so this
// one write also re-arms the post-finish dashboard checklist). Mirrors
// lib/settings' setOnboardingState upsert; SQL is inlined so a bare (non-lib/db)
// connection can run it.
export function writeWizardEntryState(db: DbHandle, profileId: number): void {
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'onboarding_state', ?)
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  ).run(profileId, serializeOnboardingState(initialOnboardingState()));
}

// Clear the per-login existing-profile orientation dismissal so the orientation
// card shows again (the "Got it" click writes this key).
export function clearOrientationDismissal(
  db: DbHandle,
  loginId: number,
  profileId: number
): void {
  db.prepare(`DELETE FROM login_settings WHERE login_id = ? AND key = ?`).run(
    loginId,
    `profile_orientation_v1:${profileId}`
  );
}

export type OnboardingFixtureRole = "onboarding" | "caregiver" | "orientation";

const ROLE_PROFILE: Record<OnboardingFixtureRole, string> = {
  onboarding: ONBOARDING_PROFILE,
  caregiver: ONBOARDING_CAREGIVER_PROFILE,
  orientation: ORIENTATION_PROFILE,
};

// Reset ONE fixture role. Per-role (not reset-all) on purpose: fullyParallel can
// run the three onboarding tests in different workers concurrently, and each
// test must only ever touch its own fixture profile.
export function resetOnboardingFixture(
  db: DbHandle,
  role: OnboardingFixtureRole
): void {
  const profile = db
    .prepare(`SELECT id FROM profiles WHERE name = ?`)
    .get(ROLE_PROFILE[role]) as { id: number } | undefined;
  if (!profile) {
    throw new Error(
      `onboarding fixture profile "${ROLE_PROFILE[role]}" not found — did seed-events run?`
    );
  }
  if (role === "orientation") {
    // The orientation test only dismisses the card (a login_settings key); its
    // seeded body metric is untouched, so only the dismissal needs clearing.
    const login = db
      .prepare(`SELECT id FROM logins WHERE username = ?`)
      .get(E2E_LOGIN_ORIENTATION) as { id: number } | undefined;
    if (!login) {
      throw new Error(
        `orientation fixture login "${E2E_LOGIN_ORIENTATION}" not found — did seed-events run?`
      );
    }
    clearOrientationDismissal(db, login.id, profile.id);
    return;
  }
  resetOnboardingProfileRows(db, profile.id);
  writeWizardEntryState(db, profile.id);
}

// Open the e2e DB from the Playwright worker, run `fn`, close. The path mirrors
// playwright.config.ts's DB_PATH fallback (workers don't inherit the webServer
// env block). fileMustExist fails loud if the suite isn't running against the
// expected isolated DB — this must never silently create (or touch) a dev
// data/allos.db.
export function withE2eDb<T>(fn: (db: DbHandle) => T): T {
  const dbPath = path.resolve(
    process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db"
  );
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    // The app is live and writing; wait out its write locks like every other
    // writer in the 3-process topology does.
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}
