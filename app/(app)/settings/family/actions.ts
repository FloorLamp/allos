"use server";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { revalidateRoute } from "@/lib/revalidate";
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
import { seedStandardMetricSaves } from "@/lib/standard-metric-seeds";
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
  grantAccessForRole,
  formatGrantDiff,
  grantSignature,
  type GrantInput,
} from "@/lib/grants";
import { canDeleteLogin, canDeleteProfile } from "@/lib/family-deletion";
import { removeFromOffsiteMirror } from "@/lib/backup";
import { deleteApiTokensForLogin } from "@/lib/api-tokens";
import { deleteProfileData } from "@/lib/profile-delete";
import { PHOTO_ROOT } from "@/lib/profile-photo";
import { photoDomainRoot, thumbSiblingPath } from "@/lib/photo/store";
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

// The three photo-core domains (#1119 progress, #1844 lesion + symptom) live under
// their own per-profile roots; deleting a profile unlinks its photo files AND
// thumbnails too (path-contained, same posture as medical files). Each root is read
// out of the store's OWN mapping (photoDomainRoot → DOMAIN_DIRS, #1284) rather than
// re-derived here, so a later rename of a domain dir can't leave this containment
// check silently pointing at the wrong root and orphaning files after a delete.
const SYMPTOM_PHOTO_UPLOAD_ROOT = path.resolve(photoDomainRoot("symptom"));
const LESION_PHOTO_UPLOAD_ROOT = path.resolve(photoDomainRoot("lesion"));
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
    // The standard Overview metric tiles as default-saved rows (issue #1487), so a
    // new profile's Trends Overview looks the same as an existing one's once the
    // grid is membership-driven. Create-time only — never re-run, or an unstarred
    // metric would come back. Same set for every profile: the training/growth age
    // gates stay a render-time filter (see lib/standard-metric-seeds.ts).
    seedStandardMetricSaves(db, id);
    return id;
  });
  recordAudit({
    loginId: admin.login.id,
    profileId: admin.profile.id,
    action: AUDIT_ACTIONS.profileCreate,
    target: String(newId),
  });

  revalidateRoute("/settings/family");
  revalidateRoute("/", "layout"); // profile switcher lists the new profile
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

  revalidateRoute("/settings/family");
  revalidateRoute("/", "layout");
  return { ok: true, message: "Renamed." };
}

// Permanently delete a profile and its ENTIRE health record. Destructive and
// admin-only. Every owned table is deleted explicitly by profile_id (NOT via FK
// cascade — upgraded DBs got profile_id via addColumnIfMissing, which can't attach
// an ON DELETE action), and child rows are deleted through their parents by the
// SCHEMA-DERIVED sweep in lib/profile-delete.ts (#2126 — a hand-maintained child
// list went stale three tables deep, leaving orphaned PHI; the derivation walks
// PRAGMA foreign_key_list from OWNED_TABLES, so it cannot). profile_settings +
// login_profiles cascade, but are deleted explicitly too for clarity.
// sessions.active_profile_id is nulled so the profiles delete doesn't trip the
// sessions FK; getCurrentSession() then snaps any parked session to its first
// accessible profile. Files are removed on disk after the transaction commits.
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
  // deletes their rows. Since #1844 these rows carry a photo-core thumbnail beside the
  // stored file; those tables have no thumb_path column, so the sibling is derived by
  // the store's own rule (thumbSiblingPath) — a path with no file behind it is a
  // best-effort no-op here, never an orphan left under the root.
  const photoPaths = (
    db
      .prepare(
        `SELECT stored_path FROM symptom_photos
          WHERE profile_id = ? AND stored_path IS NOT NULL AND stored_path != ''`
      )
      .all(id) as { stored_path: string }[]
  ).flatMap((r) => [r.stored_path, thumbSiblingPath(r.stored_path)]);

  // Lesion-photo file paths (#715) + their derived thumbnails, collected before the
  // OWNED_TABLES sweep deletes their rows.
  const lesionPhotoPaths = (
    db
      .prepare(
        `SELECT stored_path FROM lesion_photos
          WHERE profile_id = ? AND stored_path IS NOT NULL AND stored_path != ''`
      )
      .all(id) as { stored_path: string }[]
  ).flatMap((r) => [r.stored_path, thumbSiblingPath(r.stored_path)]);

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
      // The profile's entire data subtree: every child table reachable from an
      // OWNED_TABLES parent via PRAGMA foreign_key_list (deepest first, reached
      // through their parents — they carry no profile_id of their own, so those
      // deletes are exempt from the profile-scoping test), then every owned table
      // by profile_id. Derived from the live schema each time (#2126), so a child
      // table added by a future migration is swept automatically; the guard scan
      // (lib/__db_tests__/profile-delete-fk-scan.test.ts) fails the build on any
      // FK shape the derivation can't express.
      deleteProfileData(db, id);

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

  revalidateRoute("/settings/family");
  revalidateRoute("/", "layout"); // switcher drops the profile
  return {
    ok: true,
    message: `Deleted “${prof.name}” and all of their data.`,
  };
}

// ---- Logins ----

// A password hash of a value NOBODY knows — the stored credential for a login
// created through the invite path (issue #1434 part C). `logins.password_hash` is
// NOT NULL, and a nullable-credential auth path would be a much larger,
// security-sensitive change, so "passwordless" is expressed as an unguessable
// random secret that is generated, hashed, and immediately discarded. The login is
// therefore unusable until the invitee sets a real password through their token —
// strictly safer than the interim password an admin invents, knows, and leaves
// valid alongside the invite link.
async function unusablePasswordHash(): Promise<string> {
  return hashPassword(crypto.randomBytes(32).toString("hex"));
}

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

  // The invite carries its own trust (issue #1434): when the admin chose to email a
  // set-password link, the login is created PASSWORDLESS and no password is asked
  // for or accepted. Anything else still needs a real password up front. An invite
  // the instance can't actually send is refused BEFORE the insert, so no login is
  // ever left with a credential nobody can claim.
  const invitePath = wantsInvite && !!email && canSendAuthEmail();
  if (wantsInvite && !invitePath) {
    return {
      ok: false,
      error: !email
        ? "Add an email address to send an invite, or set a password instead."
        : "Couldn't send the invite — configure SMTP and the public app URL on Settings → Server first.",
    };
  }
  if (!invitePath) {
    const strength = checkPasswordStrength(password, { username });
    if (!strength.ok) return { ok: false, error: strength.error };
  }

  // The profiles this login starts with (issue #1434 part B). What the row MEANS
  // depends on the role, and both meanings are chosen at create time:
  //   • MEMBER — the profiles it should be able to open from day one. Access is part
  //     of CREATING a member, not a separate discipline the admin has to remember.
  //   • ADMIN  — its NOTIFICATION SCOPE (issue #2345). An admin already reaches every
  //     profile, so the row adds no access; it is the fan-out's opt-in, which used to
  //     be forced empty here (and refused by setGrants), leaving an admin with no way
  //     to receive anything at all. Still opt-IN: nothing is pre-selected for them.
  // Same field shape either way (repeated `profileId` + `access_<id>`), normalized
  // through the same pure helpers against the REAL profile ids, so a forged id can't
  // be granted; `grantAccessForRole` decides what lands in the `access` column.
  const validIds = (
    db.prepare("SELECT id FROM profiles").all() as { id: number }[]
  ).map((r) => r.id);
  const initialGrants: GrantInput[] = normalizeGrantInputs(
    formData
      .getAll("profileId")
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n))
      .map((profileId) => ({
        profileId,
        access: grantAccessForRole(role, formData.get(`access_${profileId}`)),
      })),
    validIds
  );

  const passwordHash = invitePath
    ? await unusablePasswordHash()
    : await hashPassword(password);
  let newId: number;
  try {
    // One transaction: the login and its initial grants land together, so a member
    // is never briefly visible with the zero-grant dead end this fixes.
    newId = writeTx((): number => {
      const info = db
        .prepare(
          "INSERT INTO logins (username, password_hash, role, email) VALUES (?, ?, ?, ?)"
        )
        .run(username, passwordHash, role, email || null);
      const id = Number(info.lastInsertRowid);
      const ins = db.prepare(
        "INSERT OR IGNORE INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, ?)"
      );
      for (const g of initialGrants) ins.run(id, g.profileId, g.access);
      return id;
    });
    recordAudit({
      loginId: admin.login.id,
      profileId: admin.profile.id,
      action: AUDIT_ACTIONS.loginCreate,
      target: String(newId),
      detail: `${username} (${role})`,
    });
    if (initialGrants.length > 0) {
      recordAudit({
        loginId: admin.login.id,
        profileId: admin.profile.id,
        action: AUDIT_ACTIONS.grantUpdate,
        target: String(newId),
        detail: formatGrantDiff({
          add: initialGrants,
          update: [],
          remove: [],
        }),
      });
    }
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

  // Email the set-password invite. A failure here never rolls back the login — it's
  // created; we just report the invite couldn't go out. The login is passwordless,
  // so say so plainly: the admin's rescue is "Send invite" (or a manual reset) from
  // the login's row, not a password only they know.
  let inviteNote = "";
  if (invitePath) {
    try {
      await sendInviteEmail(newId, username, email);
      recordAudit({
        loginId: admin.login.id,
        profileId: admin.profile.id,
        action: AUDIT_ACTIONS.loginInviteSent,
        target: String(newId),
      });
      inviteNote = ` Sent an invite to ${email} — no password is set until they use it.`;
    } catch {
      inviteNote =
        " Couldn’t send the invite email — the login has no password yet. Resend from its row.";
    }
  }

  revalidateRoute("/settings/family");
  revalidateRoute("/", "layout"); // an initial grant changes the member's switcher
  const base =
    role === "admin"
      ? // An admin's rows are notification scope, never access (#2345) — say which
        // one was chosen, and say plainly when none was, since that (correctly) means
        // nothing will reach them.
        initialGrants.length > 0
        ? `Created admin “${username}”, notified about ${initialGrants.length} ${initialGrants.length === 1 ? "profile" : "profiles"}.`
        : `Created admin “${username}”. They can see every profile but won’t be notified about any until you choose some.`
      : initialGrants.length > 0
        ? `Created “${username}” with access to ${initialGrants.length} ${initialGrants.length === 1 ? "profile" : "profiles"}.`
        : `Created “${username}”. Grant it a profile below — it can’t sign in usefully until you do.`;
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

  revalidateRoute("/settings/family");
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

  revalidateRoute("/settings/family");
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

  // The last-admin guard is ACCESS-CONTROL state, so it re-reads and decides INSIDE
  // the IMMEDIATE write lock (issue #2108) — the same #467 discipline setGrants above
  // applies to grants. Read-then-write outside the transaction is a guard only as long
  // as nothing else touches `logins` in between: a second process on the same SQLite
  // file (a second container, a script run against the live DB) deleting the OTHER
  // admin between the count and the DELETE would take the instance to zero admins,
  // which is exactly the one invariant this action exists to hold. The row read moves
  // in with it, so a role demotion racing the delete cannot slip past either.
  type DeleteOutcome =
    | { kind: "deleted"; username: string; isSelf: boolean }
    | { kind: "not-found" }
    | { kind: "refused"; reason: string };
  const outcome = writeTx((): DeleteOutcome => {
    const acct = db
      .prepare("SELECT id, username, role FROM logins WHERE id = ?")
      .get(id) as { id: number; username: string; role: Role } | undefined;
    if (!acct) return { kind: "not-found" };

    const decision = canDeleteLogin({
      role: acct.role,
      adminCount: adminLoginCount(),
    });
    if (!decision.ok) return { kind: "refused", reason: decision.reason };

    db.prepare("DELETE FROM sessions WHERE login_id = ?").run(id);
    db.prepare("DELETE FROM login_profiles WHERE login_id = ?").run(id);
    db.prepare("DELETE FROM login_settings WHERE login_id = ?").run(id);
    // Outstanding invite/reset tokens (issue #985) die with the login. They also
    // cascade via the FK, but delete explicitly so this holds even if foreign_keys
    // is ever off (the sibling deletes above).
    db.prepare("DELETE FROM login_auth_tokens WHERE login_id = ?").run(id);
    // API tokens (issue #1734) die with their login for the same reason and in the
    // same posture: the FK is ON DELETE CASCADE, but this runs explicitly so the
    // teardown holds even if foreign_keys is off, like the siblings above.
    deleteApiTokensForLogin(id);
    db.prepare("DELETE FROM logins WHERE id = ?").run(id);
    return {
      kind: "deleted",
      username: acct.username,
      isSelf: session.login.id === acct.id,
    };
  });

  if (outcome.kind === "not-found")
    return { ok: false, error: "Login not found." };
  if (outcome.kind === "refused") return { ok: false, error: outcome.reason };

  recordAudit({
    loginId: session.login.id,
    profileId: session.profile.id,
    action: AUDIT_ACTIONS.loginDelete,
    target: String(id),
    detail: outcome.username,
  });

  if (outcome.isSelf) {
    // We just deleted our own login. Clear the cookie and bounce to /login;
    // redirect() throws (NEXT_REDIRECT), so nothing below runs.
    await destroySession();
    redirect("/login");
  }

  revalidateRoute("/settings/family");
  revalidateRoute("/", "layout");
  return { ok: true, message: `Deleted login “${outcome.username}”.` };
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
  revalidateRoute("/settings/family");
  return { ok: true, message: "Signed out of all devices." };
}

// ---- Access grants (login × profile) ----

// Replace a login's `login_profiles` rows with the submitted set. What that row
// MEANS depends on the target login's role, and this is the one writer of both
// meanings (issue #2345):
//
//   • MEMBER — ACCESS. The row is what lets the login open the profile, and its
//     `access_<id>` level ('read' | 'write', issue #33) is what it may do there.
//     Notification scope rides along, because the two are the same question for a
//     login whose reach comes from the row.
//   • ADMIN — NOTIFICATION SCOPE, and nothing else. An admin reaches every profile
//     by ROLE (accessibleProfiles/accessForProfile never read this table for them),
//     so the row cannot widen or narrow what they can see; it means exactly "notify
//     me about this profile". That is the opt-in `lib/notifications/fan-out.ts`
//     already tells admins to perform — the fan-out deliberately does NOT inherit
//     admin-sees-all, so without a row an admin receives nothing about that profile.
//     This action used to refuse every admin ("Admins already have access to every
//     profile"), which was true about access and irrelevant to notifications, and
//     left the opt-in unperformable. There is no access selector for an admin: it
//     would change nothing. `grantAccessForRole` stores the inert, non-restricting
//     'write' for them — see its comment.
//
// Each granted profile arrives as a repeated `profileId` field plus (members only)
// an `access_<id>` field; a missing/garbled access defaults to 'write'.
export async function setGrants(formData: FormData): Promise<FamilyResult> {
  const admin = await requireAdmin();
  const loginId = Number(formData.get("loginId"));
  if (!loginId) return { ok: false, error: "Unknown login." };

  const acct = db
    .prepare("SELECT id, role FROM logins WHERE id = ?")
    .get(loginId) as { id: number; role: Role } | undefined;
  if (!acct) return { ok: false, error: "Login not found." };
  const targetIsAdmin = acct.role === "admin";

  const validIds = (
    db.prepare("SELECT id FROM profiles").all() as { id: number }[]
  ).map((r) => r.id);
  const submitted: GrantInput[] = formData
    .getAll("profileId")
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n))
    .map((profileId) => ({
      profileId,
      access: grantAccessForRole(
        acct.role,
        formData.get(`access_${profileId}`)
      ),
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
    //
    // MEMBERS ONLY (issue #2345). An admin's accessible set is every profile, by role
    // — removing their notification-scope row cannot put their own-profile outside it,
    // so nulling the association here would silently spend a column this action has no
    // business touching (and would drop them out of the recipient union as well).
    if (!targetIsAdmin) {
      const ownNull = db.prepare(
        "UPDATE logins SET own_profile_id = NULL WHERE id = ? AND own_profile_id = ?"
      );
      for (const pid of diff.remove) ownNull.run(loginId, pid);
    }
    return { kind: "applied", diff };
  });

  if (outcome.kind === "conflict")
    return {
      ok: false,
      error: targetIsAdmin
        ? "This login’s notification scope changed since you opened this form. Reload and try again."
        : "This login’s access changed since you opened this form. Reload and try again.",
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

  revalidateRoute("/settings/family");
  // The SAME control renders on Settings → Notifications for the signed-in login
  // (#2345 "one action, two renderers"), so a save on either surface must repaint
  // the other.
  revalidateRoute("/settings/notifications");
  revalidateRoute("/", "layout"); // the member's switcher reflects new access
  return {
    ok: true,
    message: targetIsAdmin ? "Notifications updated." : "Access updated.",
  };
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

  revalidateRoute("/settings/family");
  revalidateRoute("/", "layout"); // the login's not-self labels reflect the change
  return { ok: true, message: "Own profile updated." };
}
