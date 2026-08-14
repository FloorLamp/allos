// DB INTEGRATION TIER — the fixture profile id space (#2670).
//
// The tier gives every test file a private DATABASE and a SHARED working
// directory. Six specs write real bytes under `data/uploads/<domain>/<profileId>/`
// and remove those directories when they finish, so the profile id in that path
// is the ONLY thing that keeps one file's fixture files out of another's cleanup.
// The template holds one profile (the bootstrap admin, id 1), so every file's
// first fixture profile used to be id 2 and each of those trees was one shared
// directory.
//
// The hazard that produces is pure ORDERING: a neighbour's `afterAll` (say
// `video-write.test.ts`'s `rm -rf data/uploads/{symptom,activity}-videos/2`)
// landing inside `export-media.test.ts`'s read window empties domains the victim
// is about to read, and it fails reading back rows whose files have gone. Both
// specs are correct alone. The reported #2670 failure was NOT reproduced —
// forcing the deletion reproduces the shape, but nothing shows the ordering ever
// occurred on its own. So what is pinned here is not that ordering. It is the
// invariant that makes ordering irrelevant: two files live at the same moment can
// never be handed the same profile id, and a per-profile cleanup can only ever
// reach its own.
//
// Of the three tests below, only "allocates this file's profiles inside that
// block" is a RATCHET — it fails against the pre-fix setup (#2677). The other two
// exercise the helper and the cleanup shape and pass either way; they are
// characterisation, kept for what they document, not as regression guards.

import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { db } from "@/lib/db";
import { photoDomainRoot } from "@/lib/photo/store";
import {
  FIXTURE_PROFILE_BLOCK,
  fixtureProfileBase,
} from "./fixture-profile-space";

// The id every test file's first fixture profile had before this space existed:
// one past the template's only profile.
const LEGACY_SHARED_FIRST_ID = 2;

const ROOT = photoDomainRoot("progress");
const touched: number[] = [];

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  touched.push(id);
  return id;
}

// The fixture-file shape the media specs use: one file under this profile's own
// directory inside a real, shared domain root.
function writeFixtureFile(profileId: number): string {
  const dir = path.join(ROOT, String(profileId));
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, "fixture-profile-isolation.txt");
  fs.writeFileSync(abs, "OWNED");
  return abs;
}

// The cleanup EVERY media spec performs in its own afterAll, verbatim in shape.
function neighbourCleanup(profileId: number): void {
  fs.rmSync(path.join(ROOT, String(profileId)), {
    recursive: true,
    force: true,
  });
}

afterAll(() => {
  for (const id of touched) neighbourCleanup(id);
});

describe("fixture profile id space (#2670)", () => {
  it("hands this file a block no concurrently live file can also hold", () => {
    // A (process, thread) pair runs exactly one test file at a time, so keying
    // the block on that pair is what makes it collision-free by construction.
    // Every other pair is a different block, and the blocks do not overlap.
    const base = fixtureProfileBase();
    expect(
      fixtureProfileBase(process.pid, threadId + 1)
    ).toBeGreaterThanOrEqual(base + FIXTURE_PROFILE_BLOCK);
    expect(
      fixtureProfileBase(process.pid + 1, threadId)
    ).toBeGreaterThanOrEqual(base + FIXTURE_PROFILE_BLOCK);
    expect(fixtureProfileBase(7, 3)).not.toBe(fixtureProfileBase(3, 7));
  });

  it("allocates this file's profiles inside that block, never the shared low ids", () => {
    const base = fixtureProfileBase();
    const first = newProfile("Fixture Space First");
    const second = newProfile("Fixture Space Second");

    // The regression itself: the id that made all six upload trees one directory.
    expect(first).not.toBe(LEGACY_SHARED_FIRST_ID);

    for (const id of [first, second]) {
      expect(id).toBeGreaterThan(base);
      expect(id).toBeLessThanOrEqual(base + FIXTURE_PROFILE_BLOCK);
    }
    expect(second).toBeGreaterThan(first);

    // The bootstrap admin keeps id 1 — the space is raised, not renumbered, so a
    // spec that reads the seeded profile is untouched.
    const admin = db.prepare("SELECT MIN(id) AS id FROM profiles").get() as {
      id: number;
    };
    expect(admin.id).toBe(1);
  });

  it("keeps a per-profile cleanup inside the directory it names", () => {
    // The ordering this reproduces: a neighbour finishing — and running the
    // cleanup every media spec runs — at an arbitrary moment inside this file's
    // reads. Under one shared id space that cleanup named THIS directory.
    const mine = newProfile("Fixture Space Owner");
    const mineFile = writeFixtureFile(mine);

    // Stand-ins for a neighbour's first fixture profile. They are ids from the
    // top of THIS file's own block: unallocated, so removing them is safe, and
    // identical in every other respect to the id a neighbour would clean up.
    const neighbours = [
      fixtureProfileBase() + FIXTURE_PROFILE_BLOCK - 1,
      fixtureProfileBase() + FIXTURE_PROFILE_BLOCK - 2,
    ];
    for (const id of neighbours) {
      expect(id).not.toBe(mine);
      writeFixtureFile(id);
      neighbourCleanup(id);
    }

    expect(fs.existsSync(mineFile)).toBe(true);
    expect(fs.readFileSync(mineFile, "utf8")).toBe("OWNED");
  });
});
