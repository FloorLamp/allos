// Shared helpers for the server-action tests. Seeds REAL login/profile rows into
// the throwaway temp DB and binds the mocked session (see setup.ts) to them, so an
// action runs as a faithful login→profile pairing. NOT a test file (the config only
// collects *.test.ts).

import type { Access, CurrentSession, Role } from "@/lib/auth";
import { db } from "@/lib/db";
import { hashPasswordSync } from "@/lib/password";
import type { WeightUnit, DistanceUnit } from "@/lib/settings";
import { setActingSession } from "./session-state";

let seq = 0;

export interface TestLogin {
  id: number;
  username: string;
  role: Role;
}

export interface TestProfile {
  id: number;
  name: string;
}

// A real login row (+ optional unit prefs). Usernames are unique (NOCASE), so each
// call gets a fresh suffix.
export function createLogin(
  opts: {
    role?: Role;
    weightUnit?: WeightUnit;
    distanceUnit?: DistanceUnit;
    username?: string;
  } = {}
): TestLogin {
  const role: Role = opts.role ?? "admin";
  const username = opts.username ?? `login_${++seq}`;
  const id = Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, ?, ?)"
      )
      .run(username, hashPasswordSync("pw-" + username), role).lastInsertRowid
  );
  if (opts.weightUnit) {
    db.prepare(
      "INSERT INTO login_settings (login_id, key, value) VALUES (?, 'weight_unit', ?)"
    ).run(id, opts.weightUnit);
  }
  if (opts.distanceUnit) {
    db.prepare(
      "INSERT INTO login_settings (login_id, key, value) VALUES (?, 'distance_unit', ?)"
    ).run(id, opts.distanceUnit);
  }
  return { id, username, role };
}

// A real profile row. Optionally grant it to a member login (admins bypass grants).
export function createProfile(
  name: string,
  grantToLoginId?: number
): TestProfile {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  if (grantToLoginId != null) {
    db.prepare(
      "INSERT OR IGNORE INTO login_profiles (login_id, profile_id) VALUES (?, ?)"
    ).run(grantToLoginId, id);
  }
  return { id, name };
}

// Bind the mocked session: subsequent requireSession()/requireAdmin() calls inside
// an action return this login acting as this profile. Mirrors the CurrentSession
// shape auth.getCurrentSession() builds in prod.
export function actAs(
  login: TestLogin,
  profile: TestProfile,
  access: Access = "write"
): CurrentSession {
  const session: CurrentSession = {
    login: { id: login.id, username: login.username, role: login.role },
    profile: {
      id: profile.id,
      name: profile.name,
      photo_path: null,
      photo_version: 0,
    },
    // Access level on the acting profile (issue #33). Defaults to 'write' so
    // existing action tests are unaffected; a test can pass 'read' to assert a
    // mutating action is blocked by requireWriteAccess().
    access,
  };
  setActingSession(session);
  return session;
}

// Convenience: a login + one profile, already acting. Returns both plus the session.
export function seedActor(
  opts: {
    role?: Role;
    weightUnit?: WeightUnit;
    profileName?: string;
  } = {}
): { login: TestLogin; profile: TestProfile } {
  const login = createLogin({ role: opts.role, weightUnit: opts.weightUnit });
  const profile = createProfile(
    opts.profileName ?? `Profile ${login.username}`,
    login.id
  );
  actAs(login, profile);
  return { login, profile };
}

// A FormData builder — the argument shape every form-based action takes. Values are
// stringified (FormData coerces anyway) and null/undefined entries are skipped, so a
// test can express "field absent" by passing null.
export function fd(
  fields: Record<string, string | number | null | undefined>
): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    form.set(k, String(v));
  }
  return form;
}
