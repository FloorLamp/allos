// DB INTEGRATION TIER — the delivery-health marker's move onto a lifecycle ROW
// (issue #942, migration 061). Two things this pins that the pure tier can't see:
//   1. The one-shot DATA MIGRATION copies a live pre-061 `notify_last_error*` settings
//      marker into the `notify_lifecycle` row and retires the legacy keys, so an
//      instance upgrading with a broken bot doesn't silently lose its delivery-health
//      signal — and the copy is idempotent on the non-gated migrate() replay.
//   2. getNotifyError() reads the SAME shape from the row it used to read from the
//      three settings keys (byte-equivalence of the Settings surface).
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts (already fully
// migrated at import — so we drive the migration's up() directly against seeded legacy
// keys, exactly as an upgrading instance would hit it).

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { up as migrate061 } from "@/lib/migrations/versions/061-notify-lifecycle";
import { getNotifyError } from "@/lib/notifications";

function seedLegacyMarker(error: string, at: string, channel: string): void {
  for (const [k, v] of [
    ["notify_last_error", error],
    ["notify_last_error_at", at],
    ["notify_last_error_channel", channel],
  ]) {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(k, v);
  }
}

function legacyKeyCount(): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM settings WHERE key LIKE 'notify_last_error%'"
      )
      .get() as { c: number }
  ).c;
}

describe("migration 061 — delivery-health marker becomes a lifecycle row (#942)", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM notify_lifecycle").run();
    db.prepare(
      "DELETE FROM settings WHERE key LIKE 'notify_last_error%'"
    ).run();
  });

  it("copies a live legacy marker into the notify_lifecycle row and retires the old keys", () => {
    seedLegacyMarker("chat not found", "2026-01-02T03:04:05Z", "telegram");

    migrate061(db);

    // getNotifyError() now reads the row, returning the identical shape.
    expect(getNotifyError()).toEqual({
      error: "chat not found",
      at: "2026-01-02T03:04:05Z",
      channel: "telegram",
    });
    // The single failing row exists...
    expect(
      (
        db.prepare("SELECT COUNT(*) AS c FROM notify_lifecycle").get() as {
          c: number;
        }
      ).c
    ).toBe(1);
    // ...and the three legacy settings keys are gone (single source of truth).
    expect(legacyKeyCount()).toBe(0);
  });

  it("is idempotent on replay (the non-gated migrate() wrapper re-runs up())", () => {
    seedLegacyMarker("401 unauthorized", "2026-02-02T00:00:00Z", "push");
    migrate061(db);
    // Replay: legacy keys already gone, so nothing is copied and the row is untouched.
    expect(() => migrate061(db)).not.toThrow();
    expect(getNotifyError()).toEqual({
      error: "401 unauthorized",
      at: "2026-02-02T00:00:00Z",
      channel: "push",
    });
    expect(legacyKeyCount()).toBe(0);
  });

  it("a clean instance (no legacy failure) migrates to no row → getNotifyError null", () => {
    migrate061(db);
    expect(getNotifyError()).toBeNull();
    expect(
      (
        db.prepare("SELECT COUNT(*) AS c FROM notify_lifecycle").get() as {
          c: number;
        }
      ).c
    ).toBe(0);
  });

  it("an empty legacy error is not a failure (no row created)", () => {
    // A cleared legacy marker stored the empty string — must not become a failing row.
    seedLegacyMarker("", "", "");
    migrate061(db);
    expect(getNotifyError()).toBeNull();
    expect(legacyKeyCount()).toBe(0);
  });
});
