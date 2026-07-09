"use server";

import fs from "node:fs";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  requireAdmin,
  destroyLoginSessions,
  destroySession,
  adminLoginCount,
  type Role,
} from "@/lib/auth";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { checkPasswordStrength } from "@/lib/password-strength";
import { getSetting, isValidTimezone, setProfileSetting } from "@/lib/settings";
import {
  normalizeGrantInputs,
  diffGrantAccess,
  normalizeAccess,
  formatGrantDiff,
  type GrantInput,
} from "@/lib/grants";
import { canDeleteLogin, canDeleteProfile } from "@/lib/family-deletion";
import { OWNED_TABLES } from "@/lib/owned-tables";
import { PHOTO_ROOT } from "@/lib/profile-photo";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { createLogger } from "@/lib/log";

const log = createLogger("family");

// Every medical upload lives somewhere under this root (per-profile subdirs for
// new files, flat for older rows). Deleting a profile unlinks its files, but only
// after containing each path here so a malformed stored_path can't rm elsewhere.
const MEDICAL_UPLOAD_ROOT = path.resolve(
  process.cwd(),
  "data",
  "uploads",
  "medical"
);

// Best-effort unlink of files that resolve to inside `root`. A path pointing
// outside the root (hostile/corrupt stored_path) is skipped, never followed.
// Failures are logged and swallowed — the DB rows are already gone by this point.
function deleteFilesUnderRoot(root: string, relPaths: readonly string[]) {
  for (const rel of relPaths) {
    if (!rel) continue;
    try {
      const abs = path.resolve(process.cwd(), rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        log.warn("skipping file outside uploads root", { root, rel });
        continue;
      }
      fs.rmSync(abs, { force: true });
    } catch (err) {
      log.warn("failed to delete file during profile deletion", { rel, err });
    }
  }
}

// Family / login management (issue #67, Phase 4). Every action is admin-only —
// requireAdmin() (which redirects a member) is the first line of each. Mutations
// are global by nature (they manage logins/profiles/grants), so they're NOT
// profile-scoped; the profile-scoping leak test only covers the per-profile data
// tables, none of which are touched here.

export type FamilyResult =
  | { ok: true; message?: string }
  | {
      ok: false;
      error: string;
    };

// A username is stored UNIQUE COLLATE NOCASE; keep the accepted shape simple and
// predictable (letters/digits/._-), 3–32 chars, so it reads cleanly in the UI.
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

// ---- Profiles ----

export async function createProfile(formData: FormData): Promise<FamilyResult> {
  const admin = requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Enter a name." };
  if (name.length > 60) return { ok: false, error: "Name is too long." };

  const create = db.transaction((): number => {
    const info = db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name);
    const id = Number(info.lastInsertRowid);
    // Seed the new profile's timezone from the instance default (global settings
    // 'timezone') so its day boundaries are sensible before anyone opens Settings.
    const tz = getSetting("timezone");
    if (tz && isValidTimezone(tz)) setProfileSetting(id, "timezone", tz);
    return id;
  });
  const newId = create();
  recordAudit({
    loginId: admin.login.id,
    profileId: admin.profile.id,
    action: AUDIT_ACTIONS.profileCreate,
    target: String(newId),
  });

  revalidatePath("/settings/family");
  revalidatePath("/", "layout"); // profile switcher lists the new profile
  return { ok: true, message: `Added profile “${name}”.` };
}

export async function renameProfile(formData: FormData): Promise<FamilyResult> {
  requireAdmin();
  const id = Number(formData.get("id"));
  const name = String(formData.get("name") ?? "").trim();
  if (!id) return { ok: false, error: "Unknown profile." };
  if (!name) return { ok: false, error: "Enter a name." };
  if (name.length > 60) return { ok: false, error: "Name is too long." };

  const res = db
    .prepare("UPDATE profiles SET name = ? WHERE id = ?")
    .run(name, id);
  if (res.changes === 0) return { ok: false, error: "Profile not found." };

  revalidatePath("/settings/family");
  revalidatePath("/", "layout");
  return { ok: true, message: "Renamed." };
}

// Permanently delete a profile and its ENTIRE health record. Destructive and
// admin-only. Every owned + key-rebuilt table is deleted explicitly by
// profile_id (NOT via FK cascade — upgraded DBs got profile_id via
// addColumnIfMissing, which can't attach an ON DELETE action), and child rows are
// deleted through their parents. profile_settings + login_profiles cascade, but
// are deleted explicitly too for clarity. sessions.active_profile_id is nulled so
// the profiles delete doesn't trip the sessions FK; getCurrentSession() then snaps
// any parked session to its first accessible profile. Files are removed on disk
// after the transaction commits.
export async function deleteProfile(formData: FormData): Promise<FamilyResult> {
  const admin = requireAdmin();
  const id = Number(formData.get("id"));
  if (!id) return { ok: false, error: "Unknown profile." };

  const prof = db
    .prepare("SELECT id, name, photo_path FROM profiles WHERE id = ?")
    .get(id) as
    { id: number; name: string; photo_path: string | null } | undefined;
  if (!prof) return { ok: false, error: "Profile not found." };

  const profileCount = (
    db.prepare("SELECT COUNT(*) AS c FROM profiles").get() as { c: number }
  ).c;
  const decision = canDeleteProfile({ profileCount });
  if (!decision.ok) return { ok: false, error: decision.reason };

  // Collect the on-disk file paths BEFORE deleting the rows that name them.
  const docPaths = (
    db
      .prepare(
        `SELECT stored_path FROM medical_documents
          WHERE profile_id = ? AND stored_path IS NOT NULL AND stored_path != ''`
      )
      .all(id) as { stored_path: string }[]
  ).map((r) => r.stored_path);

  const remove = db.transaction(() => {
    // Child tables first, reached through their parent (they carry no profile_id
    // of their own, so these deletes are exempt from the profile-scoping test).
    db.prepare(
      "DELETE FROM exercise_sets WHERE activity_id IN (SELECT id FROM activities WHERE profile_id = ?)"
    ).run(id);
    db.prepare(
      "DELETE FROM intake_item_logs WHERE supplement_id IN (SELECT id FROM intake_items WHERE profile_id = ?)"
    ).run(id);
    db.prepare(
      "DELETE FROM intake_item_doses WHERE supplement_id IN (SELECT id FROM intake_items WHERE profile_id = ?)"
    ).run(id);
    db.prepare(
      `DELETE FROM intake_item_pairs
        WHERE a_id IN (SELECT id FROM intake_items WHERE profile_id = ?)
           OR b_id IN (SELECT id FROM intake_items WHERE profile_id = ?)`
    ).run(id, id);

    // Every directly profile-owned table, deleted by profile_id. (No FK cascade —
    // upgraded DBs got profile_id via addColumnIfMissing, which can't attach an ON
    // DELETE action, so rows are removed explicitly here.) OWNED_TABLES is the
    // shared source of truth (lib/owned-tables.ts): a new owned table added there
    // is cleared here automatically, so a forgotten table can't silently leave a
    // deleted person's PHI behind.
    for (const t of OWNED_TABLES) {
      db.prepare(`DELETE FROM ${t} WHERE profile_id = ?`).run(id);
    }

    db.prepare("DELETE FROM profile_settings WHERE profile_id = ?").run(id);
    db.prepare("DELETE FROM login_profiles WHERE profile_id = ?").run(id);
    db.prepare(
      "UPDATE sessions SET active_profile_id = NULL WHERE active_profile_id = ?"
    ).run(id);
    db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
  });
  remove();
  recordAudit({
    loginId: admin.login.id,
    profileId: admin.profile.id,
    action: AUDIT_ACTIONS.profileDelete,
    target: String(id),
    detail: prof.name,
  });

  // Best-effort file cleanup after the DB change is durable.
  deleteFilesUnderRoot(MEDICAL_UPLOAD_ROOT, docPaths);
  if (prof.photo_path) deleteFilesUnderRoot(PHOTO_ROOT, [prof.photo_path]);

  revalidatePath("/settings/family");
  revalidatePath("/", "layout"); // switcher drops the profile
  return {
    ok: true,
    message: `Deleted “${prof.name}” and all of their data.`,
  };
}

// ---- Logins ----

export async function createLogin(formData: FormData): Promise<FamilyResult> {
  const admin = requireAdmin();
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const roleRaw = String(formData.get("role") ?? "member");
  const role: Role = roleRaw === "admin" ? "admin" : "member";

  if (!USERNAME_RE.test(username))
    return {
      ok: false,
      error:
        "Username must be 3–32 characters, letters/digits/dot/dash/underscore.",
    };
  const strength = checkPasswordStrength(password, { username });
  if (!strength.ok) return { ok: false, error: strength.error };

  const passwordHash = await hashPassword(password);
  try {
    const info = db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, ?, ?)"
      )
      .run(username, passwordHash, role);
    recordAudit({
      loginId: admin.login.id,
      profileId: admin.profile.id,
      action: AUDIT_ACTIONS.loginCreate,
      target: String(Number(info.lastInsertRowid)),
      detail: `${username} (${role})`,
    });
  } catch (err) {
    // Surface the case-insensitive unique-username constraint as a friendly
    // message instead of a 500.
    if (
      err instanceof Error &&
      /UNIQUE constraint failed: logins\.username/i.test(err.message)
    ) {
      return { ok: false, error: `Username “${username}” is already taken.` };
    }
    throw err;
  }

  revalidatePath("/settings/family");
  return {
    ok: true,
    message:
      role === "admin"
        ? `Created admin “${username}”.`
        : `Created “${username}”. Grant it a profile below.`,
  };
}

export async function resetPassword(formData: FormData): Promise<FamilyResult> {
  const admin = requireAdmin();
  const id = Number(formData.get("id"));
  const password = String(formData.get("password") ?? "");
  if (!id) return { ok: false, error: "Unknown login." };

  const acct = db
    .prepare("SELECT id, username FROM logins WHERE id = ?")
    .get(id) as { id: number; username: string } | undefined;
  if (!acct) return { ok: false, error: "Login not found." };
  const strength = checkPasswordStrength(password, { username: acct.username });
  if (!strength.ok) return { ok: false, error: strength.error };

  const passwordHash = await hashPassword(password);
  db.prepare("UPDATE logins SET password_hash = ? WHERE id = ?").run(
    passwordHash,
    id
  );
  // Every existing session for the login is invalidated — a reset must lock out
  // whoever held the old password (including on other devices).
  destroyLoginSessions(id);
  recordAudit({
    loginId: admin.login.id,
    profileId: admin.profile.id,
    action: AUDIT_ACTIONS.passwordReset,
    target: String(id),
  });

  revalidatePath("/settings/family");
  return {
    ok: true,
    message: "Password reset — existing sessions signed out.",
  };
}

// Delete a login. Admin-only. Refuses the last admin (the instance must keep one
// admin surface). Deleting your OWN login is allowed only when another admin
// remains — the same guard — and it then tears down your session and redirects to
// /login. Profiles are NEVER deleted here: the tracked people outlive their
// logins. Sessions + grants + login_settings cascade via FK, but are deleted
// explicitly too so this holds even if foreign_keys is ever off.
export async function deleteLogin(formData: FormData): Promise<FamilyResult> {
  const session = requireAdmin();
  const id = Number(formData.get("id"));
  if (!id) return { ok: false, error: "Unknown login." };

  const acct = db
    .prepare("SELECT id, username, role FROM logins WHERE id = ?")
    .get(id) as { id: number; username: string; role: Role } | undefined;
  if (!acct) return { ok: false, error: "Login not found." };

  const decision = canDeleteLogin({
    role: acct.role,
    adminCount: adminLoginCount(),
  });
  if (!decision.ok) return { ok: false, error: decision.reason };

  const isSelf = session.login.id === acct.id;

  const remove = db.transaction(() => {
    db.prepare("DELETE FROM sessions WHERE login_id = ?").run(id);
    db.prepare("DELETE FROM login_profiles WHERE login_id = ?").run(id);
    db.prepare("DELETE FROM login_settings WHERE login_id = ?").run(id);
    db.prepare("DELETE FROM logins WHERE id = ?").run(id);
  });
  remove();
  recordAudit({
    loginId: session.login.id,
    profileId: session.profile.id,
    action: AUDIT_ACTIONS.loginDelete,
    target: String(id),
    detail: acct.username,
  });

  if (isSelf) {
    // We just deleted our own login. Clear the cookie and bounce to /login;
    // redirect() throws (NEXT_REDIRECT), so nothing below runs.
    destroySession();
    redirect("/login");
  }

  revalidatePath("/settings/family");
  revalidatePath("/", "layout");
  return { ok: true, message: `Deleted login “${acct.username}”.` };
}

// Revoke every live session for a login without changing its password (issue
// #132, Phase C) — the "sign out all devices" companion to the password reset,
// exposed directly so an admin can boot a login off every device on suspicion of
// compromise. Admin-only; profiles/credentials are untouched.
export async function revokeLoginSessions(
  formData: FormData
): Promise<FamilyResult> {
  requireAdmin();
  const id = Number(formData.get("id"));
  if (!id) return { ok: false, error: "Unknown login." };

  const acct = db.prepare("SELECT id FROM logins WHERE id = ?").get(id) as
    { id: number } | undefined;
  if (!acct) return { ok: false, error: "Login not found." };

  destroyLoginSessions(id);
  revalidatePath("/settings/family");
  return { ok: true, message: "Signed out of all devices." };
}

// ---- Access grants (login × profile) ----

// Replace a member login's granted profiles (and their access LEVELS) with the
// submitted set. Admins are implicit-all and never have login_profiles rows
// managed here — editing an admin's grants is rejected. Each granted profile
// arrives as a repeated `profileId` field plus an `access_<id>` field carrying
// 'read' | 'write' (issue #33); a missing/garbled access defaults to 'write'.
export async function setGrants(formData: FormData): Promise<FamilyResult> {
  const admin = requireAdmin();
  const loginId = Number(formData.get("loginId"));
  if (!loginId) return { ok: false, error: "Unknown login." };

  const acct = db
    .prepare("SELECT id, role FROM logins WHERE id = ?")
    .get(loginId) as { id: number; role: Role } | undefined;
  if (!acct) return { ok: false, error: "Login not found." };
  if (acct.role === "admin")
    return {
      ok: false,
      error: "Admins already have access to every profile.",
    };

  const validIds = (
    db.prepare("SELECT id FROM profiles").all() as { id: number }[]
  ).map((r) => r.id);
  const submitted: GrantInput[] = formData
    .getAll("profileId")
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n))
    .map((profileId) => ({
      profileId,
      access: normalizeAccess(formData.get(`access_${profileId}`)),
    }));
  const desired = normalizeGrantInputs(submitted, validIds);

  const current: GrantInput[] = (
    db
      .prepare(
        "SELECT profile_id AS profileId, access FROM login_profiles WHERE login_id = ?"
      )
      .all(loginId) as { profileId: number; access: string | null }[]
  ).map((r) => ({ profileId: r.profileId, access: normalizeAccess(r.access) }));

  const diff = diffGrantAccess(current, desired);
  if (
    diff.add.length === 0 &&
    diff.update.length === 0 &&
    diff.remove.length === 0
  )
    return { ok: true, message: "No changes." };

  const apply = db.transaction(() => {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, ?)"
    );
    const upd = db.prepare(
      "UPDATE login_profiles SET access = ? WHERE login_id = ? AND profile_id = ?"
    );
    const del = db.prepare(
      "DELETE FROM login_profiles WHERE login_id = ? AND profile_id = ?"
    );
    for (const g of diff.add) ins.run(loginId, g.profileId, g.access);
    for (const g of diff.update) upd.run(g.access, loginId, g.profileId);
    for (const pid of diff.remove) del.run(loginId, pid);
  });
  apply();
  // Detail is a compact grant diff by profile id + access level (identifiers
  // only — never PHI). e.g. "+2:read,~3:write,-4".
  recordAudit({
    loginId: admin.login.id,
    profileId: admin.profile.id,
    action: AUDIT_ACTIONS.grantUpdate,
    target: String(loginId),
    detail: formatGrantDiff(diff),
  });

  revalidatePath("/settings/family");
  revalidatePath("/", "layout"); // the member's switcher reflects new access
  return { ok: true, message: "Access updated." };
}
