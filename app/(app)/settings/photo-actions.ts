"use server";

import fs from "node:fs";
import path from "node:path";
import { revalidatePath } from "next/cache";
import {
  requireSession,
  requireWriteAccess,
  canAccessProfile,
} from "@/lib/auth";
import { db } from "@/lib/db";
import { MAX_PHOTO_BYTES, MIME_TO_EXT, PHOTO_ROOT } from "@/lib/profile-photo";

// Profile avatar upload/remove — one pair of actions serving two surfaces:
// Settings → Profile (operates on the caller's ACTIVE profile) and the Family
// admin page (an admin picks any profile via a hidden profileId field). The
// scoping rule is explicit: a plain session may only target its own active
// profile; only an admin may target a different profileId. A member-submitted
// profileId for someone else is always rejected — never trusted.

export type PhotoResult = { ok: true } | { ok: false; error: string };

// Resolve which profile this mutation targets, enforcing the rule above. Returns
// the profile id or a friendly error.
async function resolveTargetProfile(
  formData: FormData
): Promise<{ ok: true; profileId: number } | { ok: false; error: string }> {
  const session = await requireSession();
  const raw = formData.get("profileId");
  const submitted = raw == null ? "" : String(raw).trim();
  // No id (or the caller's own) → the active profile.
  if (submitted === "") return { ok: true, profileId: session.profile.id };

  const target = Number(submitted);
  if (!Number.isInteger(target) || target <= 0)
    return { ok: false, error: "Unknown profile." };
  if (target === session.profile.id) return { ok: true, profileId: target };

  // Targeting a different profile — admins only, and it must be one they can see.
  if (session.login.role !== "admin")
    return { ok: false, error: "You can only change your own profile photo." };
  if (!canAccessProfile(session, target))
    return { ok: false, error: "Profile not found." };
  return { ok: true, profileId: target };
}

function revalidatePhotoSurfaces() {
  // The switcher avatar lives in the app-shell layout; the two settings screens
  // show their own previews.
  revalidatePath("/", "layout");
  revalidatePath("/settings/profile");
  revalidatePath("/settings/family");
}

export async function uploadProfilePhoto(
  formData: FormData
): Promise<PhotoResult> {
  // A photo change is a write. requireWriteAccess() gates the caller's ACTIVE
  // profile: a member may only ever target their own active profile (see
  // resolveTargetProfile), so an active-profile write check is exactly right;
  // admins bypass grants and may target any profile from the Family screen.
  await requireWriteAccess();
  const target = await resolveTargetProfile(formData);
  if (!target.ok) return target;
  const profileId = target.profileId;

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0)
    return { ok: false, error: "Choose an image file." };

  const ext = MIME_TO_EXT[file.type];
  if (!ext)
    return {
      ok: false,
      error: "Only PNG, JPEG, or WebP images are allowed.",
    };
  if (file.size > MAX_PHOTO_BYTES)
    return {
      ok: false,
      error: `Image is too large (max ${Math.round(
        MAX_PHOTO_BYTES / 1024 / 1024
      )} MB).`,
    };

  const prev = db
    .prepare("SELECT photo_path FROM profiles WHERE id = ?")
    .get(profileId) as { photo_path: string | null } | undefined;
  if (!prev) return { ok: false, error: "Profile not found." };

  const buffer = Buffer.from(await file.arrayBuffer());
  const filename = `${profileId}.${ext}`;
  const relPath = path.join("data", "uploads", "profile-photos", filename);

  try {
    fs.mkdirSync(PHOTO_ROOT, { recursive: true });
    // The extension can change between uploads (png → jpg); delete the old file
    // when its path differs so we don't leave a stale second file behind.
    if (prev.photo_path && prev.photo_path !== relPath) {
      try {
        fs.rmSync(path.join(process.cwd(), prev.photo_path), { force: true });
      } catch {
        // best-effort; the DB row is the source of truth
      }
    }
    fs.writeFileSync(path.join(PHOTO_ROOT, filename), buffer);
  } catch {
    return { ok: false, error: "Could not save the image. Try again." };
  }

  // Bump the version so the ?v= cache-buster changes and the new photo shows
  // immediately despite the short private cache.
  db.prepare(
    "UPDATE profiles SET photo_path = ?, photo_version = photo_version + 1 WHERE id = ?"
  ).run(relPath, profileId);

  revalidatePhotoSurfaces();
  return { ok: true };
}

export async function removeProfilePhoto(
  formData: FormData
): Promise<PhotoResult> {
  // A photo change is a write — same active-profile gate as the upload path.
  await requireWriteAccess();
  const target = await resolveTargetProfile(formData);
  if (!target.ok) return target;
  const profileId = target.profileId;

  const prev = db
    .prepare("SELECT photo_path FROM profiles WHERE id = ?")
    .get(profileId) as { photo_path: string | null } | undefined;
  if (!prev) return { ok: false, error: "Profile not found." };

  if (prev.photo_path) {
    try {
      fs.rmSync(path.join(process.cwd(), prev.photo_path), { force: true });
    } catch {
      // best-effort; the row is nulled regardless
    }
  }
  db.prepare(
    "UPDATE profiles SET photo_path = NULL, photo_version = photo_version + 1 WHERE id = ?"
  ).run(profileId);

  revalidatePhotoSurfaces();
  return { ok: true };
}
