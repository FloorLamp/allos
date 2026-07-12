// DB INTEGRATION TIER — the install/first-boot marker (#464).
//
// The health endpoint's "backups enabled but never ran" alarm needs an instance
// age. seedInstallMarker (a per-boot task) stamps `install_first_boot_at` exactly
// once and never overwrites it, so the age keeps growing across restarts.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { migrate } from "@/lib/db";
import { seedInstallMarker } from "@/lib/migrations/boot-tasks";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

function newDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  return db;
}

function marker(db: Database.Database): string | undefined {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'install_first_boot_at'")
    .get() as { value?: string } | undefined;
  return row?.value;
}

describe("seedInstallMarker (#464)", () => {
  it("stamps install_first_boot_at on first boot", () => {
    const db = newDb();
    migrate(db);
    const at = marker(db);
    expect(at).toBeTruthy();
    expect(Number.isNaN(Date.parse(at as string))).toBe(false);
  });

  it("never overwrites the marker on a later boot", () => {
    const db = newDb();
    migrate(db);
    const first = marker(db);

    // Simulate a much older install, then re-run the boot task: it must not move.
    db.prepare(
      "UPDATE settings SET value = ? WHERE key = 'install_first_boot_at'"
    ).run("2020-01-01T00:00:00.000Z");
    seedInstallMarker(db);
    expect(marker(db)).toBe("2020-01-01T00:00:00.000Z");
    expect(first).toBeTruthy();
  });
});
