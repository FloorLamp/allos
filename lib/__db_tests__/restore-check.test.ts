// The deploy/backup adapter must boot and read the restored app, refuse absent uploads, and leave checkpoint inputs untouched.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  afterAll,
  beforeAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import Database from "better-sqlite3";
import { rawDb } from "@/lib/db";
import { MIGRATIONS } from "@/lib/migrations/versions";
import { makeTmpDir } from "../__tests__/tmp-dir";

let root: string, buildRoot: string, profile: number;
beforeAll(() => {
  buildRoot = makeTmpDir("resource-probe-build");
  execFileSync(
    path.resolve("node_modules/.bin/esbuild"),
    [
      "scripts/restore-check.ts",
      "--bundle",
      "--platform=node",
      "--target=node24",
      "--format=cjs",
      "--external:better-sqlite3",
      "--external:next/*",
      `--outfile=${path.join(buildRoot, "probe.cjs")}`,
    ],
    { stdio: "pipe", timeout: 20000 }
  );
});
afterAll(() => fs.rmSync(buildRoot, { recursive: true, force: true }));
const digest = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII=",
  "base64"
);
function probe() {
  return spawnSync(
    process.execPath,
    [path.join(buildRoot, "probe.cjs"), root],
    {
      env: {
        ...process.env,
        NODE_ENV: "production",
        NODE_PATH: path.resolve("node_modules"),
        ALLOS_DB_PATH: path.join(root, "must-not-open.db"),
      },
      encoding: "utf8",
      timeout: 20000,
    }
  );
}
beforeEach(() => {
  root = makeTmpDir("resource-restore");
  profile = Number(
    rawDb
      .prepare("INSERT INTO profiles (name) VALUES ('Restore fixture')")
      .run().lastInsertRowid
  );
  const relative = `data/uploads/profile-photos/${profile}.png`;
  fs.mkdirSync(path.join(root, "uploads", "profile-photos"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, "uploads", "profile-photos", `${profile}.png`),
    png
  );
  rawDb
    .prepare("UPDATE profiles SET photo_path = ? WHERE id = ?")
    .run(relative, profile);
  rawDb.exec(
    `VACUUM INTO '${path.join(root, "allos.db").replace(/'/g, "''")}'`
  );
  const checkpoint = new Database(path.join(root, "allos.db"));
  checkpoint.pragma("journal_mode = WAL");
  checkpoint.close();
});
afterEach(() => {
  rawDb.prepare("DELETE FROM profiles WHERE id = ?").run(profile);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("isolated application restore entrypoint", () => {
  it("boots the restored schema and reads profile files without writing the supplied checkpoint or ambient DB", () => {
    const before = digest(path.join(root, "allos.db")),
      files = fs.readdirSync(root);
    const result = probe();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toMatchObject({
      ok: true,
      schemaVersion: MIGRATIONS.length,
      files: 1,
    });
    expect(digest(path.join(root, "allos.db"))).toBe(before);
    expect(fs.readdirSync(root)).toEqual(files);
  });

  it.each([
    "missing upload",
    "corrupt database",
    "newer schema",
    "unknown migration",
  ])("refuses %s without modifying the checkpoint", (reason) => {
    const file = path.join(root, "allos.db");
    if (reason === "missing upload")
      fs.rmSync(path.join(root, "uploads"), { recursive: true });
    if (reason === "corrupt database") fs.writeFileSync(file, "not a database");
    if (reason === "newer schema") {
      const db = new Database(file);
      db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
      db.close();
    }
    if (reason === "unknown migration") {
      const db = new Database(file);
      db.prepare(
        "INSERT INTO schema_migrations (name, applied_at) VALUES ('future-fixture', '2026-10-05T00:00:00Z')"
      ).run();
      db.close();
    }
    const before = digest(file),
      result = probe();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Allos restore verification failed");
    expect(digest(file)).toBe(before);
    expect(fs.existsSync(path.join(root, "must-not-open.db"))).toBe(false);
  });
});
