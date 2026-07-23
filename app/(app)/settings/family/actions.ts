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
  setOwnProfileForLogin,
  type Role,
} from "@/lib/auth";
import { db, writeTx } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { checkPasswordStrength } from "@/lib/password-strength";
import {
  getSetting,
  isValidTimezone,
  setProfileSetting,
  getPublicUrl,
  isEmailConfigured,
} from "@/lib/settings";
import {
  isValidEmail,
  normalizeEmail,
  canSendAuthEmail,
  sendInviteEmail,
} from "@/lib/auth-email";
import {
  normalizeGrantInputs,
  diffGrantAccess,
  normalizeAccess,
  formatGrantDiff,
  grantSignature,
  type GrantInput,
} from "@/lib/grants";
import { canDeleteLogin, canDeleteProfile } from "@/lib/family-deletion";
import { removeFromOffsiteMirror } from "@/lib/backup";
import { OWNED_TABLES } from "@/lib/owned-tables";
import { PHOTO_ROOT } from "@/lib/profile-photo";
import { photoDomainRoot } from "@/lib/photo/store";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { createLogger } from "@/lib/log";
import {
  initialOnboardingState,
  serializeOnboardingState,
} from "@/lib/onboarding";

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

// Symptom photos (#859 item 4) live under their own per-profile root; deleting a
// profile unlinks its photo files too (path-contained, same posture as medical files).
const SYMPTOM_PHOTO_UPLOAD_ROOT = path.resolve(
  process.cwd(),
  "data",
  "uploads",
  "symptom-photos"
);

// Lesion photos (#715) live under their own per-profile root; deleting a profile
// unlinks its lesion-photo files too (path-contained, same posture as symptom photos).
const LESION_PHOTO_UPLOAD_ROOT = path.resolve(
  process.cwd(),
  "data",
  "uploads",
  "lesion-photos"
);

// Progress photos (#1119) live under the shared photo core's per-profile root;
// deleting a profile unlinks its photo files AND thumbnails too (path-contained,
// same posture as the other photo domains). Reuse the store's OWN mapping
// (photoDomainRoot → DOMAIN_DIRS, #1284) rather than re-deriving the path here, so a
// later rename of the "progress" domain dir can't leave this containment check
// silently pointing at the wrong root and orphaning files after a profile delete.
const PROGRESS_PHOTO_UPLOAD_ROOT = path.resolve(photoDomainRoot("progress"));

// Symptom / episode video clips and training form-check clips (#1224) live under
// their own per-profile roots; deleting a profile unlinks its clip files AND
// poster frames too (path-contained, same posture as the photo domains).
const SYMPTOM_VIDEO_UPLOAD_ROOT = path.resolve(
  process.cwd(),
  "data",
  "uploads",
  "symptom-videos"
);
const ACTIVITY_VIDEO_UPLOAD_ROOT = path.resolve(
  process.cwd(),
  "data",
  "uploads",
  "activity-videos"
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

// Family / login management. Every action is admin-only —
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
  const admin = await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Enter a name." };
  if (name.length > 60) return { ok: false, error: "Name is too long." };

  const newId = writeTx((): number => {
    const info = db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name);
    const id = Number(info.lastInsertRowid);
    // Seed the new profile's timezone from the instance default (global settings
    // 'timezone') so its day boundaries are sensible before anyone opens Settings.
    const tz = getSetting("timezone");
    if (tz && isValidTimezone(tz)) setProfileSetting(id, "timezone", tz);
    setProfileSetting(
      id,
      "onboarding_state",
      serializeOnboardingState(initialOnboardingState())
    );
    return id;
  });
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
  await requireAdmin();
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
  const admin = await requireAdmin();
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

  // Symptom-photo file paths (#859 item 4), collected before the OWNED_TABLES sweep
  // deletes their rows.
  const photoPaths = (
    db
      .prepare(
        `SELECT stored_path FROM symptom_photos
          WHERE profile_id = ? AND stored_path IS NOT NULL AND stored_path != ''`
      )
      .all(id) as { stored_path: string }[]
  ).map((r) => r.stored_path);

  // Lesion-photo file paths (#715), collected before the OWNED_TABLES sweep deletes
  // their rows.
  const lesionPhotoPaths = (
    db
      .prepare(
        `SELECT stored_path FROM lesion_photos
          WHERE profile_id = ? AND stored_path IS NOT NULL AND stored_path != ''`
      )
      .all(id) as { stored_path: string }[]
  ).map((r) => r.stored_path);

  // Progress-photo file paths (#1119) — stored photo AND thumbnail — collected
  // before the OWNED_TABLES sweep deletes their rows.
  const progressPhotoPaths = (
    db
      .prepare(
        `SELECT stored_path, thumb_path FROM progress_photos
          WHERE profile_id = ? AND stored_path IS NOT NULL AND stored_path != ''`
      )
      .all(id) as { stored_path: string; thumb_path: string | null }[]
  ).flatMap((r) =>
    r.thumb_path ? [r.stored_path, r.thumb_path] : [r.stored_path]
  );

  // Symptom / activity video clip + poster file paths (#1224), collected before
  // the OWNED_TABLES sweep deletes their rows.
  const collectVideoPaths = (table: string): string[] =>
    (
      db
        .prepare(
          `SELECT stored_path, poster_path FROM ${table}
            WHERE profile_id = ? AND stored_path IS NOT NULL AND stored_path != ''`
        )
        .all(id) as { stored_path: string; poster_path: string | null }[]
    ).flatMap((r) =>
      r.poster_path ? [r.stored_path, r.poster_path] : [r.stored_path]
    );
  const symptomVideoPaths = collectVideoPaths("symptom_videos");
  const activityVideoPaths = collectVideoPaths("activity_videos");

  // Disable foreign_keys for the whole subtree sweep (issue #729). The app
  // connection runs foreign_keys = ON, and OWNED_TABLES lists medical_documents
  // BEFORE its FK children (conditions/encounters/procedures/family_history/
  // care_plan_items/care_goals/appointments — each carries a document_id FK with
  // no ON DELETE action), so `DELETE FROM medical_documents` would fire an
  // immediate FK violation while those child rows still reference it and abort the
  // whole transaction — a profile that imported clinical narratives couldn't be
  // deleted. The entire profile subtree is being removed atomically in this one
  // writeTx, so intra-subtree FK checks add no safety; we drop them for the sweep
  // and restore the prior setting after. This mirrors migrate()'s fkWasOn pattern
  // (lib/db.ts) for FK-parent rebuilds. NOTE: PRAGMA foreign_keys is a NO-OP inside
  // a transaction, so it MUST be toggled OUTSIDE/around writeTx — writeTx's BEGIN
  // IMMEDIATE still takes the write lock up front.
  const fkWasOn = (db.pragma("foreign_keys", { simple: true }) as number) === 1;
  if (fkWasOn) db.pragma("foreign_keys = OFF");
  try {
    writeTx(() => {
      // Child tables first, reached through their parent (they carry no profile_id
      // of their own, so these deletes are exempt from the profile-scoping test).
      db.prepare(
        "DELETE FROM exercise_sets WHERE activity_id IN (SELECT id FROM activities WHERE profile_id = ?)"
      ).run(id);
      db.prepare(
        "DELETE FROM activity_routes WHERE activity_id IN (SELECT id FROM activities WHERE profile_id = ?)"
      ).run(id);
      db.prepare(
        "DELETE FROM intake_item_logs WHERE item_id IN (SELECT id FROM intake_items WHERE profile_id = ?)"
      ).run(id);
      db.prepare(
        "DELETE FROM intake_item_doses WHERE item_id IN (SELECT id FROM intake_items WHERE profile_id = ?)"
      ).run(id);
      db.prepare(
        `DELETE FROM intake_item_pairs
        WHERE a_id IN (SELECT id FROM intake_items WHERE profile_id = ?)
           OR b_id IN (SELECT id FROM intake_items WHERE profile_id = ?)`
      ).run(id, id);
      // Routine children (#738), reached through routines (parent, OWNED). Slots
      // first (they FK routine_days), then days; the routines rows themselves are
      // cleared by the OWNED_TABLES loop below.
      db.prepare(
        `DELETE FROM routine_slots WHERE routine_day_id IN (
           SELECT rd.id FROM routine_days rd
             JOIN routines r ON r.id = rd.routine_id
            WHERE r.profile_id = ?)`
      ).run(id);
      db.prepare(
        `DELETE FROM routine_days WHERE routine_id IN (
           SELECT id FROM routines WHERE profile_id = ?)`
      ).run(id);
      // Fitness-check entries (#834), reached through fitness_assessments (parent,
      // OWNED). Its ON DELETE CASCADE FK is a no-op here because the sweep runs with
      // foreign_keys OFF, so the child rows are cleared explicitly before the parent
      // (mirrors exercise_sets/routine_days above).
      db.prepare(
        `DELETE FROM fitness_assessment_entries WHERE assessment_id IN (
           SELECT id FROM fitness_assessments WHERE profile_id = ?)`
      ).run(id);

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
      // Null any login's own-profile pointer at this profile (issue #1013,
      // row-side-state): the association dies with the data subject. Explicit here
      // (the FK carries no ON DELETE action — ADD COLUMN can't attach one) so
      // re-enabling foreign_keys after the sweep meets a clean graph.
      db.prepare(
        "UPDATE logins SET own_profile_id = NULL WHERE own_profile_id = ?"
      ).run(id);
      db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
    });
  } finally {
    if (fkWasOn) db.pragma("foreign_keys = ON");
  }
  recordAudit({
    loginId: admin.login.id,
    profileId: admin.profile.id,
    action: AUDIT_ACTIONS.profileDelete,
    target: String(id),
    detail: prof.name,
  });

  // Best-effort file cleanup after the DB change is durable.
  deleteFilesUnderRoot(MEDICAL_UPLOAD_ROOT, docPaths);
  deleteFilesUnderRoot(SYMPTOM_PHOTO_UPLOAD_ROOT, photoPaths);
  deleteFilesUnderRoot(LESION_PHOTO_UPLOAD_ROOT, lesionPhotoPaths);
  deleteFilesUnderRoot(PROGRESS_PHOTO_UPLOAD_ROOT, progressPhotoPaths);
  deleteFilesUnderRoot(SYMPTOM_VIDEO_UPLOAD_ROOT, symptomVideoPaths);
  deleteFilesUnderRoot(ACTIVITY_VIDEO_UPLOAD_ROOT, activityVideoPaths);
  if (prof.photo_path) deleteFilesUnderRoot(PHOTO_ROOT, [prof.photo_path]);

  // Sweep the same files from the OFF-VOLUME uploads mirror (#625) so a deleted
  // person's PHI doesn't linger on the NAS forever (the mirror is append-only for
  // single-row deletes, but a profile delete is a deliberate right-to-delete that
  // must reach the durable copy too). Path-contained + best-effort, and a no-op
  // unless BACKUP_DEST_DIR is configured and presently mounted+verified.
  const localUploadPaths = [
    ...docPaths,
    ...(prof.photo_path ? [prof.photo_path] : []),
  ].map((rel) => path.resolve(process.cwd(), rel));
  try {
    const swept = removeFromOffsiteMirror(localUploadPaths);
    if (swept > 0)
      log.info("swept deleted profile from off-volume mirror", { swept });
  } catch (err) {
    log.warn("off-volume mirror sweep on profile delete failed", { err });
  }

  revalidatePath("/settings/family");
  revalidatePath("/", "layout"); // switcher drops the profile
  return {
    ok: true,
    message: `Deleted “${prof.name}” and all of their data.`,
  };
}

// ---- Logins ----

export async function createLogin(formData: FormData): Promise<FamilyResult> {
  const admin = await requireAdmin();
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const roleRaw = String(formData.get("role") ?? "member");
  const role: Role = roleRaw === "admin" ? "admin" : "member";
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  // Offer to email a set-password invite instead of the admin choosing + relaying
  // a password (issue #985). Only meaningful when an email is set and email is
  // deliverable; both are re-checked below.
  const wantsInvite =
    formData.get("invite") === "1" || formData.get("invite") === "on";

  if (!USERNAME_RE.test(username))
    return {
      ok: false,
      error:
        "Username must be 3–32 characters, letters/digits/dot/dash/underscore.",
    };
  if (email && !isValidEmail(email))
    return { ok: false, error: "Enter a valid email address." };
  const strength = checkPasswordStrength(password, { username });
  if (!strength.ok) return { ok: false, error: strength.error };

  const passwordHash = await hashPassword(password);
  let newId: number;
  try {
    const info = db
      .prepare(
        "INSERT INTO logins (username, password_hash, role, email) VALUES (?, ?, ?, ?)"
      )
      .run(username, passwordHash, role, email || null);
    newId = Number(info.lastInsertRowid);
    recordAudit({
      loginId: admin.login.id,
      profileId: admin.profile.id,
      action: AUDIT_ACTIONS.loginCreate,
      target: String(newId),
      detail: `${username} (${role})`,
    });
  } catch (err) {
    // Surface the case-insensitive unique constraints as friendly messages instead
    // of a 500 (username and the unique-if-set email index).
    if (
      err instanceof Error &&
      /UNIQUE constraint failed: logins\.username/i.test(err.message)
    ) {
      return { ok: false, error: `Username “${username}” is already taken.` };
    }
    if (
      err instanceof Error &&
      /UNIQUE constraint failed: logins\.email/i.test(err.message)
    ) {
      return { ok: false, error: `That email is already in use.` };
    }
    throw err;
  }

  // Optionally email a set-password invite. A failure here never rolls back the
  // login — it's created; we just report the invite couldn't go out and the admin
  // can resend from the login's row.
  let inviteNote = "";
  if (wantsInvite) {
    if (!email) {
      inviteNote = " Add an email to send an invite.";
    } else if (!canSendAuthEmail()) {
      inviteNote =
        " Couldn't send the invite — configure SMTP and the public app URL on Settings → Server first.";
    } else {
      try {
        await sendInviteEmail(newId, username, email);
        recordAudit({
          loginId: admin.login.id,
          profileId: admin.profile.id,
          action: AUDIT_ACTIONS.loginInviteSent,
          target: String(newId),
        });
        inviteNote = ` Sent an invite to ${email}.`;
      } catch {
        inviteNote =
          " Couldn't send the invite email. Try again from the login’s row.";
      }
    }
  }

  revalidatePath("/settings/family");
  const base =
    role === "admin"
      ? `Created admin “${username}”.`
      : `Created “${username}”. Grant it a profile below.`;
  return { ok: true, message: base + inviteNote };
}

// Set or clear a login's email address (issue #985). Admin-only. The email is
// optional and unique-if-set (NOCASE); a duplicate surfaces as a friendly message.
export async function setLoginEmail(formData: FormData): Promise<FamilyResult> {
  const admin = await requireAdmin();
  const id = Number(formData.get("id"));
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  if (!id) return { ok: false, error: "Unknown login." };
  const acct = db
    .prepare("SELECT id, username FROM logins WHERE id = ?")
    .get(id) as { id: number; username: string } | undefined;
  if (!acct) return { ok: false, error: "Login not found." };
  if (email && !isValidEmail(email))
    return { ok: false, error: "Enter a valid email address." };

  try {
    db.prepare("UPDATE logins SET email = ? WHERE id = ?").run(
      email || null,
      id
    );
  } catch (err) {
    if (
      err instanceof Error &&
      /UNIQUE constraint failed: logins\.email/i.test(err.message)
    ) {
      return { ok: false, error: `That email is already in use.` };
    }
    throw err;
  }
  recordAudit({
    loginId: admin.login.id,
    profileId: admin.profile.id,
    action: AUDIT_ACTIONS.loginEmailUpdate,
    target: String(id),
  });

  revalidatePath("/settings/family");
  return { ok: true, message: email ? "Email updated." : "Email cleared." };
}

// Email a fresh set-password invite to an existing login (issue #985). Admin-only.
// Refuses with honest, specific copy when the login has no email or the instance
// can't send (SMTP / public URL unconfigured).
export async function sendInvite(formData: FormData): Promise<FamilyResult> {
  const admin = await requireAdmin();
  const id = Number(formData.get("id"));
  if (!id) return { ok: false, error: "Unknown login." };
  const acct = db
    .prepare("SELECT id, username, email FROM logins WHERE id = ?")
    .get(id) as
    { id: number; username: string; email: string | null } | undefined;
  if (!acct) return { ok: false, error: "Login not found." };
  if (!acct.email)
    return { ok: false, error: "Add an email to this login first." };
  if (!isEmailConfigured())
    return {
      ok: false,
      error:
        "Couldn't send the invite — configure SMTP on Settings → Server first.",
    };
  if (!getPublicUrl())
    return {
      ok: false,
      error:
        "Couldn't send the invite — set the public app URL on Settings → Server first.",
    };

  try {
    await sendInviteEmail(acct.id, acct.username, acct.email);
  } catch {
    return { ok: false, error: "Couldn't send the invite email. Try again." };
  }
  recordAudit({
    loginId: admin.login.id,
    profileId: admin.profile.id,
    action: AUDIT_ACTIONS.loginInviteSent,
    target: String(id),
  });
  return { ok: true, message: `Sent an invite to ${acct.email}.` };
}

export async function resetPassword(formData: FormData): Promise<FamilyResult> {
  const admin = await requireAdmin();
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
  const session = await requireAdmin();
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

  writeTx(() => {
    db.prepare("DELETE FROM sessions WHERE login_id = ?").run(id);
    db.prepare("DELETE FROM login_profiles WHERE login_id = ?").run(id);
    db.prepare("DELETE FROM login_settings WHERE login_id = ?").run(id);
    // Outstanding invite/reset tokens (issue #985) die with the login. They also
    // cascade via the FK, but delete explicitly so this holds even if foreign_keys
    // is ever off (the sibling deletes above).
    db.prepare("DELETE FROM login_auth_tokens WHERE login_id = ?").run(id);
    db.prepare("DELETE FROM logins WHERE id = ?").run(id);
  });
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
    await destroySession();
    redirect("/login");
  }

  revalidatePath("/settings/family");
  revalidatePath("/", "layout");
  return { ok: true, message: `Deleted login “${acct.username}”.` };
}

// Revoke every live session for a login without changing its password —
// the "sign out all devices" companion to the password reset,
// exposed directly so an admin can boot a login off every device on suspicion of
// compromise. Admin-only; profiles/credentials are untouched.
export async function revokeLoginSessions(
  formData: FormData
): Promise<FamilyResult> {
  await requireAdmin();
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
  const admin = await requireAdmin();
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
  // The signature of the grants the admin's form LOADED with (issue #467).
  const loadedSnapshot = String(formData.get("grants_snapshot") ?? "");

  // Optimistic concurrency for access-control state (issue #467). The form's DESIRED
  // set is absolute, so a stale form (opened before another admin granted profile P to
  // this member) would diff "remove P" and silently revoke the fresh grant. Instead we
  // re-read the login's CURRENT grants under the IMMEDIATE write lock and refuse when
  // they no longer match the loaded snapshot — read-check-apply all atomic, so nothing
  // can slip in between the check and the write.
  type GrantOutcome =
    | { kind: "conflict" }
    | { kind: "nochange" }
    | { kind: "applied"; diff: ReturnType<typeof diffGrantAccess> };
  const outcome = writeTx((): GrantOutcome => {
    const current: GrantInput[] = (
      db
        .prepare(
          "SELECT profile_id AS profileId, access FROM login_profiles WHERE login_id = ?"
        )
        .all(loginId) as { profileId: number; access: string | null }[]
    ).map((r) => ({
      profileId: r.profileId,
      access: normalizeAccess(r.access),
    }));

    if (grantSignature(current) !== loadedSnapshot) return { kind: "conflict" };

    const diff = diffGrantAccess(current, desired);
    if (
      diff.add.length === 0 &&
      diff.update.length === 0 &&
      diff.remove.length === 0
    )
      return { kind: "nochange" };

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
    // Row-side-state (issue #1013): revoking the grant that made a profile this
    // login's own-profile drops the association too (an own-profile must stay within
    // the login's accessible set). resolveScope re-validates on read as well, so this
    // is the stored twin of that re-derivation.
    const ownNull = db.prepare(
      "UPDATE logins SET own_profile_id = NULL WHERE id = ? AND own_profile_id = ?"
    );
    for (const pid of diff.remove) ownNull.run(loginId, pid);
    return { kind: "applied", diff };
  });

  if (outcome.kind === "conflict")
    return {
      ok: false,
      error:
        "This login’s access changed since you opened this form. Reload and try again.",
    };
  if (outcome.kind === "nochange") return { ok: true, message: "No changes." };

  // Detail is a compact grant diff by profile id + access level (identifiers
  // only — never PHI). e.g. "+2:read,~3:write,-4".
  recordAudit({
    loginId: admin.login.id,
    profileId: admin.profile.id,
    action: AUDIT_ACTIONS.grantUpdate,
    target: String(loginId),
    detail: formatGrantDiff(outcome.diff),
  });

  revalidatePath("/settings/family");
  revalidatePath("/", "layout"); // the member's switcher reflects new access
  return { ok: true, message: "Access updated." };
}

// Admin path for the own-profile association (issue #1013): set (or clear) which
// profile a login considers "mine". Admin-only (requireAdmin). Purely an association
// — it grants NO access; setOwnProfileForLogin still constrains the target to the
// login's OWN accessible set (a member's grants, an admin's all-profiles), so an
// admin can't mark an ungranted profile as a member's self. A forged/ungranted id is
// a friendly error. Nulling is allowed (own_profile_id = null).
export async function setLoginOwnProfile(
  formData: FormData
): Promise<FamilyResult> {
  const admin = await requireAdmin();
  const loginId = Number(formData.get("loginId"));
  if (!loginId) return { ok: false, error: "Unknown login." };
  const acct = db
    .prepare("SELECT id, role FROM logins WHERE id = ?")
    .get(loginId) as { id: number; role: Role } | undefined;
  if (!acct) return { ok: false, error: "Login not found." };

  const raw = formData.get("own_profile_id");
  const profileId =
    raw === null || raw === "" || raw === "none" ? null : Number(raw);
  if (profileId !== null && !Number.isInteger(profileId)) {
    return { ok: false, error: "Invalid profile." };
  }

  const ok = setOwnProfileForLogin(acct.id, acct.role, profileId);
  if (!ok) {
    return {
      ok: false,
      error: "That login can't act as that profile.",
    };
  }

  recordAudit({
    loginId: admin.login.id,
    profileId: admin.profile.id,
    action: AUDIT_ACTIONS.ownProfileUpdate,
    target: String(loginId),
    detail: `own=${profileId ?? "none"}`,
  });

  revalidatePath("/settings/family");
  revalidatePath("/", "layout"); // the login's not-self labels reflect the change
  return { ok: true, message: "Own profile updated." };
}
