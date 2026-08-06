// DB INTEGRATION TIER — the opt-in media bundle for the full-account export
// (issue #1846).
//
// The photo + video cores are the strictest privacy tier: structurally out of share
// links, the printable, the emergency card, and the DEFAULT export. Their only other
// egress was the per-file authenticated serve route, so a year of serial mole photos
// could not leave the app at all. "Include photo & video files" (?media=1) is the
// opt-in; this proves the three things that matter about it:
//
//   1. opting OUT keeps media entirely absent (the default is unchanged),
//   2. opting IN bundles exactly the exporting profile's files — never another
//      profile's, even when the row is tampered to point at one,
//   3. the row context that makes each file readable rides along.
//
// It writes real bytes under the repo's data/uploads (gitignored, the
// progress-photo-write.test.ts precedent) and removes its fixture dirs afterward.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { setMinTrainingAge } from "@/lib/age-gate";
import { setStoredAge } from "@/lib/settings";
import { photoDomainRoot } from "@/lib/photo/store";
import { videoDomainRoot } from "@/lib/video/store";
import { LESION_PHOTO_DIR } from "@/lib/skin-photo-write";
import { SYMPTOM_PHOTO_DIR } from "@/lib/symptom-photo-write";
import {
  MEDIA_DOMAINS,
  MEDIA_ROW_SELECTS,
  listProfileMediaFiles,
  collectExportSnapshot,
} from "@/lib/export-full";

let mine: number;
let theirs: number;
let minor: number;

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// Write a fixture file into <domainRoot>/<profileId>/ exactly where the domain's
// own store would put it, and return the repo-relative path for the row.
function writeMediaFile(
  domainRoot: string,
  profileId: number,
  name: string,
  bytes: string
): string {
  const dir = path.join(domainRoot, String(profileId));
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, bytes);
  return path.relative(process.cwd(), abs);
}

const ROOTS = {
  progress: photoDomainRoot("progress"),
  lesion: LESION_PHOTO_DIR,
  symptomPhoto: SYMPTOM_PHOTO_DIR,
  symptomVideo: videoDomainRoot("symptom"),
  activityVideo: videoDomainRoot("activity"),
};

let lesionId: number;
let activityId: number;
let theirLesionPhotoId: number;

beforeAll(() => {
  mine = newProfile("MEDIA-MINE");
  theirs = newProfile("MEDIA-THEIRS");
  minor = newProfile("MEDIA-MINOR");

  // ── The exporting profile: one file in each of the five domains ────────────
  db.prepare(
    `INSERT INTO progress_photos
       (profile_id, date, pose, stored_path, content_hash, caption)
     VALUES (?, '2026-01-05', 'front', ?, 'hash-prog', 'January check-in')`
  ).run(mine, writeMediaFile(ROOTS.progress, mine, "prog1.jpg", "PROG-MINE"));

  lesionId = Number(
    db
      .prepare(
        `INSERT INTO skin_lesions (profile_id, label, body_region, status, observed_date)
         VALUES (?, 'Upper back mole', 'back', 'watch', '2026-01-02')`
      )
      .run(mine).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO lesion_photos (profile_id, lesion_id, date, stored_path, caption)
     VALUES (?, ?, '2026-01-06', ?, 'Month 1')`
  ).run(
    mine,
    lesionId,
    writeMediaFile(ROOTS.lesion, mine, "les1.jpg", "LESION-MINE")
  );

  db.prepare(
    `INSERT INTO symptom_photos (profile_id, date, symptom, stored_path, caption)
     VALUES (?, '2026-01-07', 'rash', ?, 'Left forearm')`
  ).run(
    mine,
    writeMediaFile(ROOTS.symptomPhoto, mine, "sym1.jpg", "SYMP-MINE")
  );

  db.prepare(
    `INSERT INTO symptom_videos
       (profile_id, date, symptom, stored_path, kind, duration_sec, caption)
     VALUES (?, '2026-01-08', 'tremor', ?, 'video', 12.5, 'Resting tremor')`
  ).run(
    mine,
    writeMediaFile(ROOTS.symptomVideo, mine, "symv1.mp4", "SYMV-MINE")
  );

  activityId = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, '2026-01-09', 'strength', 'Squat day', 50)`
      )
      .run(mine).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO activity_videos
       (profile_id, activity_id, exercise, stored_path, kind, duration_sec, caption)
     VALUES (?, ?, 'Back Squat', ?, 'video', 8, 'Third set, side angle')`
  ).run(
    mine,
    activityId,
    writeMediaFile(ROOTS.activityVideo, mine, "actv1.mp4", "ACTV-MINE")
  );

  // ── Another profile's lesion photo, byte-for-byte the shape of the one above ──
  const theirLesion = Number(
    db
      .prepare(
        `INSERT INTO skin_lesions (profile_id, label, status, observed_date)
         VALUES (?, 'THEIRS mole', 'active', '2026-01-02')`
      )
      .run(theirs).lastInsertRowid
  );
  theirLesionPhotoId = Number(
    db
      .prepare(
        `INSERT INTO lesion_photos (profile_id, lesion_id, date, stored_path, caption)
         VALUES (?, ?, '2026-01-06', ?, 'THEIRS caption')`
      )
      .run(
        theirs,
        theirLesion,
        writeMediaFile(ROOTS.lesion, theirs, "les-theirs.jpg", "LESION-THEIRS")
      ).lastInsertRowid
  );
});

afterEach(() => setMinTrainingAge(null));

afterAll(() => {
  for (const root of Object.values(ROOTS)) {
    for (const p of [mine, theirs, minor]) {
      try {
        fs.rmSync(path.join(root, String(p)), { recursive: true, force: true });
      } catch {
        // best-effort cleanup of a gitignored fixture dir
      }
    }
  }
});

describe("every media read is profile-scoped (#1208 scan obligation)", () => {
  // The .prepare() call indexes MEDIA_ROW_SELECTS by the loop variable, so the
  // source scan in lib/__tests__/profile-scoping.test.ts cannot read the SQL and
  // takes an ALLOW_NON_LITERAL entry naming this assertion. Discharge it here:
  // every declared domain filters the exporting profile's OWN profile_id, in a
  // predicate position, after the WHERE.
  it.each([...MEDIA_DOMAINS])(
    "%s filters profile_id in its WHERE",
    (domain) => {
      const sql = MEDIA_ROW_SELECTS[domain].replace(/\s+/g, " ");
      const where = sql.slice(sql.search(/\bWHERE\b/i));
      expect(where).toMatch(/(?:^|[\s.(])profile_id\s*=\s*\?/i);
    }
  );

  it("declares a select for every domain and no extras", () => {
    expect(Object.keys(MEDIA_ROW_SELECTS).sort()).toEqual(
      [...MEDIA_DOMAINS].sort()
    );
  });
});

describe("media stays out unless the download opts in (#1846)", () => {
  it("collectExportSnapshot carries null media by default", () => {
    const snap = collectExportSnapshot(mine, "Media Mine");
    expect(snap.media).toBeNull();
    // …and nothing media-shaped leaks into the datasets either: the five tables
    // are export-allowlisted precisely because their rows ride the bundle.
    expect(snap.datasets.map((d) => d.key)).not.toContain("progress_photos");
  });

  it("collectExportSnapshot carries the files when it opts in", () => {
    const snap = collectExportSnapshot(mine, "Media Mine", {
      includeMedia: true,
    });
    expect(snap.media).not.toBeNull();
    expect(snap.media!.map((m) => m.domain).sort()).toEqual(
      [...MEDIA_DOMAINS].sort()
    );
  });
});

describe("the opt-in bundle holds exactly this profile's files (#1846)", () => {
  it("bundles one file per domain, under media/<domain>/<rowId>-<name>", () => {
    const files = listProfileMediaFiles(mine);
    expect(files).toHaveLength(5);
    // Domains come out in MEDIA_DOMAINS order, so the archive is deterministic.
    expect(files.map((f) => f.domain)).toEqual([...MEDIA_DOMAINS]);
    for (const f of files) {
      expect(f.zipName.startsWith(`media/${f.domain}/`)).toBe(true);
      expect(f.size).toBeGreaterThan(0);
      // The bytes are actually readable at the resolved path.
      expect(fs.readFileSync(f.absPath, "utf8")).toContain("MINE");
    }
  });

  it("carries the row context each file needs to be readable", () => {
    const by = new Map(listProfileMediaFiles(mine).map((f) => [f.domain, f]));

    expect(by.get("progress-photos")!.meta).toMatchObject({
      date: "2026-01-05",
      pose: "front",
      caption: "January check-in",
    });
    // A lesion photo names its parent lesion, so the serial comparison survives
    // alongside the now-exported skin_lesions dataset.
    expect(by.get("lesion-photos")!.meta).toMatchObject({
      date: "2026-01-06",
      caption: "Month 1",
      lesion_id: lesionId,
      lesion_label: "Upper back mole",
      body_region: "back",
    });
    expect(by.get("symptom-photos")!.meta).toMatchObject({
      date: "2026-01-07",
      symptom: "rash",
    });
    expect(by.get("symptom-videos")!.meta).toMatchObject({
      date: "2026-01-08",
      symptom: "tremor",
      kind: "video",
      duration_sec: 12.5,
    });
    expect(by.get("activity-videos")!.meta).toMatchObject({
      exercise: "Back Squat",
      duration_sec: 8,
      activity_date: "2026-01-09",
      activity_title: "Squat day",
    });

    // The on-disk path is an instance-local detail the archive layout replaces —
    // it must never travel in the index.
    for (const f of listProfileMediaFiles(mine))
      expect(f.meta).not.toHaveProperty("stored_path");
  });

  it("excludes another profile's files entirely", () => {
    const mineFiles = listProfileMediaFiles(mine);
    for (const f of mineFiles) {
      expect(f.absPath).toContain(path.sep + String(mine) + path.sep);
      expect(fs.readFileSync(f.absPath, "utf8")).not.toContain("THEIRS");
    }
    // The other profile's own export sees only its own single file.
    const theirFiles = listProfileMediaFiles(theirs);
    expect(theirFiles).toHaveLength(1);
    expect(fs.readFileSync(theirFiles[0].absPath, "utf8")).toBe(
      "LESION-THEIRS"
    );
  });

  it("refuses a stored_path pointing outside this profile's own directory", () => {
    // The SQL profile filter is the scoping guarantee; containment to
    // <domainRoot>/<profileId>/ is the second lock on it. Point one of THEIR rows
    // at MY directory and re-read THEIR export: the row is skipped, not followed.
    const theirRow = db
      .prepare(`SELECT stored_path FROM lesion_photos WHERE id = ?`)
      .get(theirLesionPhotoId) as { stored_path: string };
    const crossProfile = path.relative(
      process.cwd(),
      path.join(LESION_PHOTO_DIR, String(mine), "les1.jpg")
    );
    db.prepare(`UPDATE lesion_photos SET stored_path = ? WHERE id = ?`).run(
      crossProfile,
      theirLesionPhotoId
    );
    try {
      expect(listProfileMediaFiles(theirs)).toEqual([]);
      // An absolute path escaping the tree entirely is refused the same way.
      db.prepare(`UPDATE lesion_photos SET stored_path = ? WHERE id = ?`).run(
        "/etc/hostname",
        theirLesionPhotoId
      );
      expect(listProfileMediaFiles(theirs)).toEqual([]);
    } finally {
      db.prepare(`UPDATE lesion_photos SET stored_path = ? WHERE id = ?`).run(
        theirRow.stored_path,
        theirLesionPhotoId
      );
    }
  });

  it("refuses a parent FK pointing at another profile's row", () => {
    // The parent's columns travel into media/index.json (a lesion's label and
    // region, an activity's date and title), so the joins match the parent's
    // profile_id as well as its id. Point THEIR photo at MY lesion — the file
    // itself stays in their own directory, so containment passes and the JOIN is
    // the only thing standing between my lesion's label and their export.
    const theirRow = db
      .prepare(`SELECT lesion_id FROM lesion_photos WHERE id = ?`)
      .get(theirLesionPhotoId) as { lesion_id: number };
    db.prepare(`UPDATE lesion_photos SET lesion_id = ? WHERE id = ?`).run(
      lesionId,
      theirLesionPhotoId
    );
    try {
      expect(listProfileMediaFiles(theirs)).toEqual([]);
      // My own export is unaffected — the tampering was on their row.
      expect(
        listProfileMediaFiles(mine).map((f) => f.meta.lesion_label)
      ).toContain("Upper back mole");
    } finally {
      db.prepare(`UPDATE lesion_photos SET lesion_id = ? WHERE id = ?`).run(
        theirRow.lesion_id,
        theirLesionPhotoId
      );
    }
  });

  it("skips a row whose file vanished from disk", () => {
    const before = listProfileMediaFiles(mine);
    const progress = before.find((f) => f.domain === "progress-photos")!;
    fs.rmSync(progress.absPath);
    try {
      const after = listProfileMediaFiles(mine);
      expect(after.map((f) => f.domain)).not.toContain("progress-photos");
      expect(after).toHaveLength(4);
    } finally {
      fs.writeFileSync(progress.absPath, "PROG-MINE");
    }
  });
});

describe("the age gate reaches the media bundle too (#471/#1846)", () => {
  it("holds back form-check clips for a training-restricted profile", () => {
    // activity_videos hang off `activities`, whose dataset is already gated out of
    // the ZIP — the clips must not be the way around it.
    expect(
      listProfileMediaFiles(mine, { trainingRestricted: true }).map(
        (f) => f.domain
      )
    ).not.toContain("activity-videos");

    // …and the snapshot applies that gate itself, from the profile's real age.
    setStoredAge(mine, 8);
    setMinTrainingAge(18);
    try {
      const snap = collectExportSnapshot(mine, "Media Mine", {
        includeMedia: true,
      });
      expect(snap.media!.map((m) => m.domain)).not.toContain("activity-videos");
      // Every other domain still exports — the gate is about training, not media.
      expect(snap.media!.map((m) => m.domain)).toContain("lesion-photos");
    } finally {
      setStoredAge(mine, null);
    }
  });
});
