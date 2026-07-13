// SERVER-ACTION TIER — pins the off-volume mirror sweep on profile deletion (#625).
//
// deleteProfile unlinks a deleted person's medical files + profile photo locally,
// but the OFF-VOLUME uploads mirror (BACKUP_DEST_DIR/uploads) was append-only and
// pruned by nothing — so the complete medical document set stayed readable on the
// NAS forever after a "right to delete". This test drives the real action against a
// temp BACKUP_DEST_DIR with a sentinel + planted mirror files and asserts the
// deleted profile's mirror copies are swept while another profile's are untouched,
// and that the sweep stays path-contained under <dest>/uploads.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { OFFSITE_SENTINEL } from "@/lib/backup-offsite";
import { deleteProfile } from "@/app/(app)/settings/family/actions";
import {
  createLogin,
  createProfile,
  actAs,
  fd,
  type TestProfile,
} from "./harness";

let destDir: string;
const prevDest = process.env.BACKUP_DEST_DIR;

// Plant a file (creating parents) and return its absolute path.
function plant(abs: string, body = "phi"): string {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

beforeEach(() => {
  destDir = fs.mkdtempSync(path.join(os.tmpdir(), "allos-offsite-sweep-"));
  // Mark the destination mounted+verified so the readiness gate lets the sweep run.
  fs.writeFileSync(path.join(destDir, OFFSITE_SENTINEL), "sentinel");
  process.env.BACKUP_DEST_DIR = destDir;
});

afterEach(() => {
  if (prevDest === undefined) delete process.env.BACKUP_DEST_DIR;
  else process.env.BACKUP_DEST_DIR = prevDest;
  fs.rmSync(destDir, { recursive: true, force: true });
});

// Insert a medical document row whose stored_path lives under the local uploads
// tree; returns the relative stored_path.
function addDoc(profileId: number, name: string): string {
  const rel = path.join("data", "uploads", "medical", String(profileId), name);
  db.prepare(
    `INSERT INTO medical_documents (profile_id, filename, stored_path)
     VALUES (?, ?, ?)`
  ).run(profileId, name, rel);
  return rel;
}

describe("deleteProfile off-volume mirror sweep (#625)", () => {
  it("removes the deleted profile's mirror files, keeps others, stays contained", () => {
    const admin = createLogin({ role: "admin" });
    const acting: TestProfile = createProfile("Acting Admin");
    const victim: TestProfile = createProfile("Test Patient");
    const bystander: TestProfile = createProfile("Ada Lovelace");
    actAs(admin, acting);

    // Victim's medical doc + photo, and their planted off-volume mirror copies.
    const docRel = addDoc(victim.id, "labs.pdf");
    const photoRel = path.join(
      "data",
      "uploads",
      "profile-photos",
      `${victim.id}.png`
    );
    db.prepare("UPDATE profiles SET photo_path = ? WHERE id = ?").run(
      photoRel,
      victim.id
    );

    const destUploads = path.join(destDir, "uploads");
    const victimDocMirror = plant(
      path.join(
        destUploads,
        path.relative(path.join("data", "uploads"), docRel)
      )
    );
    const victimPhotoMirror = plant(
      path.join(
        destUploads,
        path.relative(path.join("data", "uploads"), photoRel)
      )
    );
    // A different profile's mirror file must survive the sweep.
    const bystanderMirror = plant(
      path.join(destUploads, "medical", String(bystander.id), "keep.pdf")
    );

    return deleteProfile(fd({ id: victim.id })).then((res) => {
      expect(res.ok).toBe(true);
      expect(fs.existsSync(victimDocMirror)).toBe(false);
      expect(fs.existsSync(victimPhotoMirror)).toBe(false);
      expect(fs.existsSync(bystanderMirror)).toBe(true);
      // The destination root + its sentinel are never touched.
      expect(fs.existsSync(path.join(destDir, OFFSITE_SENTINEL))).toBe(true);
    });
  });

  it("is a no-op when the destination is unmounted/unverified (no sentinel)", () => {
    fs.rmSync(path.join(destDir, OFFSITE_SENTINEL), { force: true });
    const admin = createLogin({ role: "admin" });
    const acting = createProfile("Acting Admin");
    const victim = createProfile("Test Patient");
    actAs(admin, acting);

    const docRel = addDoc(victim.id, "labs.pdf");
    const destUploads = path.join(destDir, "uploads");
    const mirror = plant(
      path.join(
        destUploads,
        path.relative(path.join("data", "uploads"), docRel)
      )
    );

    return deleteProfile(fd({ id: victim.id })).then((res) => {
      expect(res.ok).toBe(true);
      // Unverified destination → sweep skipped, the mirror copy is left in place.
      expect(fs.existsSync(mirror)).toBe(true);
    });
  });
});
