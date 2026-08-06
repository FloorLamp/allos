// DB INTEGRATION TIER (issue #1093) — the two illness-domain cross-links.
//
// Exercises against the real migrated schema (migration 109):
//   • symptom_photos.symptom_log_id — a photo binds to the SPECIFIC symptom-day log it
//     illustrates, so two symptoms logged the same day keep DISTINCT photo sets.
//   • symptom_logs.episode_id — a symptom logged while an episode is OPEN auto-associates;
//     the reverse query gathers the episode's symptoms; detach nulls the link.
//   • #203 row-side-state under foreign_keys=ON: deleting an episode nulls its symptoms'
//     links (symptoms survive); a merge reparents them to the keeper; deleting a symptom
//     log takes its photos (rows + files).
//
// Deterministic: :memory:-backed temp DB via setup.ts; a synthetic ProcessedPhoto per
// photo (the write core takes bytes ALREADY through the shared photo core since #1844,
// so the strip itself is proven at the action tier — this suite is about the LINKS).

import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, today } from "@/lib/db";
import type { ProcessedPhoto } from "@/lib/photo/ingest";
import { shiftDateStr } from "@/lib/date";
import {
  logSymptomCore,
  setSymptomEpisodeCore,
  removeSymptomCore,
  deleteCustomSymptomCore,
  renameCustomSymptomCore,
} from "@/lib/symptom-log-write";
import {
  attachSymptomPhotoCore,
  getSymptomPhotosForLog,
  getSymptomPhotosInRange,
  SYMPTOM_PHOTO_DIR,
} from "@/lib/symptom-photo-write";
import { getEpisodeSymptomLogs } from "@/lib/queries";
import {
  createEpisodeRow,
  deleteEpisodeRow,
  mergeEpisodeRows,
} from "@/lib/illness-episode-store";

const createdProfiles: number[] = [];

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  createdProfiles.push(id);
  return id;
}

// A synthetic already-processed photo: what processPhoto hands the write core. The
// bytes are opaque to this suite (only the row links and the file lifecycle matter);
// a unique hash per seed keeps the per-profile content-hash dedup treating each as a
// distinct photo. Real image bytes + the EXIF strip are pinned at the action tier.
function processedFixture(seed: string): ProcessedPhoto {
  const bytes = Buffer.from(`synthetic-fixture-${seed}`);
  return {
    bytes,
    thumbBytes: bytes,
    mime: "image/jpeg",
    width: 4,
    height: 3,
    sizeBytes: bytes.length,
    contentHash: crypto.createHash("sha256").update(bytes).digest("hex"),
    captureDate: null,
  };
}

function logId(profileId: number, date: string, symptom: string): number {
  return (
    db
      .prepare(
        `SELECT id FROM symptom_logs WHERE profile_id = ? AND date = ? AND symptom = ?`
      )
      .get(profileId, date, symptom) as { id: number }
  ).id;
}

function episodeIdOfLog(
  profileId: number,
  date: string,
  symptom: string
): number | null {
  return (
    db
      .prepare(
        `SELECT episode_id FROM symptom_logs WHERE profile_id = ? AND date = ? AND symptom = ?`
      )
      .get(profileId, date, symptom) as { episode_id: number | null }
  ).episode_id;
}

afterAll(() => {
  // Clean the per-profile photo dirs this suite wrote under data/uploads/symptom-photos/.
  for (const id of createdProfiles) {
    fs.rmSync(path.join(SYMPTOM_PHOTO_DIR, String(id)), {
      recursive: true,
      force: true,
    });
  }
});

describe("symptom_photos.symptom_log_id — a photo resolves to its log", () => {
  it("two same-day symptoms keep DISTINCT photo sets", () => {
    const p = newProfile("Photo Split");
    const date = "2026-05-04";
    logSymptomCore(p, "rash", 2, date);
    logSymptomCore(p, "cough", 3, date);
    const rashLog = logId(p, date, "rash");
    const coughLog = logId(p, date, "cough");

    const a = attachSymptomPhotoCore(
      p,
      date,
      processedFixture("rash-1"),
      "rash"
    );
    const b = attachSymptomPhotoCore(
      p,
      date,
      processedFixture("rash-2"),
      "rash"
    );
    const c = attachSymptomPhotoCore(
      p,
      date,
      processedFixture("cough-1"),
      "cough"
    );
    expect(a.kind).toBe("attached");
    expect(b.kind).toBe("attached");
    expect(c.kind).toBe("attached");

    const rashPhotos = getSymptomPhotosForLog(p, rashLog);
    const coughPhotos = getSymptomPhotosForLog(p, coughLog);
    expect(rashPhotos.map((x) => x.symptom).sort()).toEqual(["rash", "rash"]);
    expect(coughPhotos.map((x) => x.symptom)).toEqual(["cough"]);
    // Every rash photo carries the rash log id; none leak into the cough set.
    expect(rashPhotos.every((x) => x.symptom_log_id === rashLog)).toBe(true);
    expect(coughPhotos.every((x) => x.symptom_log_id === coughLog)).toBe(true);
  });

  it("a whole-day photo (no symptom) carries a NULL log link", () => {
    const p = newProfile("Day Photo");
    const date = "2026-05-05";
    logSymptomCore(p, "fever", 2, date);
    const res = attachSymptomPhotoCore(p, date, processedFixture("day"));
    expect(res.kind).toBe("attached");
    const row = getSymptomPhotosInRange(p, date, date)[0];
    expect(row.symptom_log_id).toBeNull();
  });

  it("a photo for a not-yet-logged symptom carries a NULL log link", () => {
    const p = newProfile("Unlogged Symptom Photo");
    const date = "2026-05-06";
    const res = attachSymptomPhotoCore(
      p,
      date,
      processedFixture("nolog"),
      "rash"
    );
    expect(res.kind).toBe("attached");
    expect(getSymptomPhotosInRange(p, date, date)[0].symptom_log_id).toBeNull();
  });
});

describe("symptom_logs.episode_id — open-episode association + reverse query", () => {
  it("a symptom logged during an OPEN episode auto-associates; the reverse query returns it", () => {
    const p = newProfile("Episode Assoc");
    const start = "2026-03-03";
    const epId = createEpisodeRow(p, "Illness", start, null); // open
    logSymptomCore(p, "cough", 3, "2026-03-04");
    logSymptomCore(p, "fever", 2, "2026-03-05");

    expect(episodeIdOfLog(p, "2026-03-04", "cough")).toBe(epId);
    const symptoms = getEpisodeSymptomLogs(p, epId)
      .map((s) => s.symptom)
      .sort();
    expect(symptoms).toEqual(["cough", "fever"]);
  });

  it("a symptom logged OUTSIDE any open episode carries no link", () => {
    const p = newProfile("Standalone Symptom");
    logSymptomCore(p, "headache", 2, "2026-03-10");
    expect(episodeIdOfLog(p, "2026-03-10", "headache")).toBeNull();
  });

  it("a CLOSED episode does not retro-claim a freshly logged symptom", () => {
    const p = newProfile("Closed Episode");
    createEpisodeRow(p, "Illness", "2026-02-01", "2026-02-08"); // closed
    logSymptomCore(p, "cough", 2, "2026-02-05"); // inside the closed range
    expect(episodeIdOfLog(p, "2026-02-05", "cough")).toBeNull();
  });

  it("detach nulls the link; re-attach sets it; a foreign episode id is rejected", () => {
    const p = newProfile("Detach");
    const epId = createEpisodeRow(p, "Illness", "2026-04-01", null);
    logSymptomCore(p, "cough", 2, "2026-04-02");
    expect(episodeIdOfLog(p, "2026-04-02", "cough")).toBe(epId);

    const detach = setSymptomEpisodeCore(p, "cough", "2026-04-02", null);
    expect(detach.kind).toBe("ok");
    expect(episodeIdOfLog(p, "2026-04-02", "cough")).toBeNull();
    expect(getEpisodeSymptomLogs(p, epId)).toHaveLength(0);

    const reattach = setSymptomEpisodeCore(p, "cough", "2026-04-02", epId);
    expect(reattach.kind).toBe("ok");
    expect(episodeIdOfLog(p, "2026-04-02", "cough")).toBe(epId);

    // A different profile's episode id must be rejected (data-layer ownership gate).
    const other = newProfile("Other");
    const otherEp = createEpisodeRow(other, "Illness", "2026-04-01", null);
    expect(setSymptomEpisodeCore(p, "cough", "2026-04-02", otherEp).kind).toBe(
      "bad-episode"
    );
    // And the link is untouched.
    expect(episodeIdOfLog(p, "2026-04-02", "cough")).toBe(epId);
  });
});

describe("#203 row-side-state under foreign_keys=ON", () => {
  it("deleting an episode NULLs its symptoms' links but keeps the symptoms", () => {
    const p = newProfile("Episode Delete");
    const epId = createEpisodeRow(p, "Illness", "2026-06-01", null);
    logSymptomCore(p, "cough", 3, "2026-06-02");
    logSymptomCore(p, "fever", 2, "2026-06-03");
    expect(getEpisodeSymptomLogs(p, epId)).toHaveLength(2);

    expect(deleteEpisodeRow(p, epId)).toBe(true);
    // Symptoms survive; their links are nulled.
    const remaining = db
      .prepare(
        `SELECT symptom, episode_id FROM symptom_logs WHERE profile_id = ? ORDER BY symptom`
      )
      .all(p) as { symptom: string; episode_id: number | null }[];
    expect(remaining.map((r) => r.symptom)).toEqual(["cough", "fever"]);
    expect(remaining.every((r) => r.episode_id === null)).toBe(true);
  });

  it("merging episodes reparents the loser's symptoms onto the keeper", () => {
    const p = newProfile("Episode Merge");
    const keep = createEpisodeRow(p, "Illness", "2026-06-10", "2026-06-14");
    const drop = createEpisodeRow(p, "Illness", "2026-06-13", null);
    // Attach one symptom to each episode explicitly.
    logSymptomCore(p, "cough", 2, "2026-06-11");
    setSymptomEpisodeCore(p, "cough", "2026-06-11", keep);
    logSymptomCore(p, "fever", 3, "2026-06-13");
    setSymptomEpisodeCore(p, "fever", "2026-06-13", drop);

    expect(mergeEpisodeRows(p, keep, drop)).toBe(keep);
    // The dropped episode's symptom now points at the keeper; none dangle at the loser.
    const keeperSymptoms = getEpisodeSymptomLogs(p, keep)
      .map((s) => s.symptom)
      .sort();
    expect(keeperSymptoms).toEqual(["cough", "fever"]);
    expect(getEpisodeSymptomLogs(p, drop)).toHaveLength(0);
  });

  it("deleting a symptom log removes its photos (rows + files)", () => {
    const p = newProfile("Log Delete Photos");
    const date = "2026-07-01";
    logSymptomCore(p, "rash", 2, date);
    const rashLog = logId(p, date, "rash");
    attachSymptomPhotoCore(p, date, processedFixture("del-1"), "rash");
    attachSymptomPhotoCore(p, date, processedFixture("del-2"), "rash");
    const before = getSymptomPhotosForLog(p, rashLog);
    expect(before).toHaveLength(2);
    const files = before.map((ph) => {
      const sp = (
        db
          .prepare(`SELECT stored_path FROM symptom_photos WHERE id = ?`)
          .get(ph.id) as { stored_path: string }
      ).stored_path;
      return path.resolve(process.cwd(), sp);
    });
    expect(files.every((f) => fs.existsSync(f))).toBe(true);

    const out = removeSymptomCore(p, "rash", date);
    expect(out.kind).toBe("removed");
    // Log gone, photo rows gone, files unlinked.
    expect(getSymptomPhotosForLog(p, rashLog)).toHaveLength(0);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM symptom_photos WHERE profile_id = ?`
        )
        .get(p)
    ).toEqual({ n: 0 });
    expect(files.some((f) => fs.existsSync(f))).toBe(false);
  });

  it("deleting a custom symptom removes its photos; renaming preserves them", () => {
    const p = newProfile("Custom Symptom Photos");
    const date = "2026-07-02";
    // A custom (free-text) symptom name — clearly not a curated slug.
    logSymptomCore(p, "weird tingling arm", 2, date);
    const oldLog = logId(p, date, "weird tingling arm");
    attachSymptomPhotoCore(
      p,
      date,
      processedFixture("cust-1"),
      "weird tingling arm"
    );
    expect(getSymptomPhotosForLog(p, oldLog)).toHaveLength(1);

    // Rename: the row keeps its id, so its photo survives (re-labeled).
    expect(
      renameCustomSymptomCore(p, "weird tingling arm", "odd tingling arm").kind
    ).toBe("ok");
    const renamedLog = logId(p, date, "odd tingling arm");
    expect(renamedLog).toBe(oldLog);
    const afterRename = getSymptomPhotosForLog(p, renamedLog);
    expect(afterRename).toHaveLength(1);
    expect(afterRename[0].symptom).toBe("odd tingling arm");

    // Delete the custom symptom entirely: its photos go too.
    expect(deleteCustomSymptomCore(p, "odd tingling arm").kind).toBe("ok");
    expect(getSymptomPhotosForLog(p, renamedLog)).toHaveLength(0);
  });
});

describe("migration 109 shape", () => {
  it("adds both nullable back-link columns to the migrated schema", () => {
    const photoCols = new Set(
      (
        db.prepare(`PRAGMA table_info(symptom_photos)`).all() as {
          name: string;
        }[]
      ).map((c) => c.name)
    );
    const logCols = new Set(
      (
        db.prepare(`PRAGMA table_info(symptom_logs)`).all() as {
          name: string;
        }[]
      ).map((c) => c.name)
    );
    expect(photoCols.has("symptom_log_id")).toBe(true);
    expect(logCols.has("episode_id")).toBe(true);
  });
});
