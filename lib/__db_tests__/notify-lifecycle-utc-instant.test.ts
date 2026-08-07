// DB INTEGRATION TIER — migration 167 (#2233): `notify_lifecycle.at` moves off
// `new Date().toISOString()`'s millisecond shape onto the canonical stored instant,
// 'YYYY-MM-DDTHH:MM:SSZ'.
//
// What this pins, that the pure tier can't:
//   1. the one-shot value rewrite strips fractional seconds and nothing else —
//      already-canonical values, the empty string 061's legacy copy could have
//      stored, and NULL are untouched, and the rewrite replays as a no-op;
//   2. the LIVE writer stores the canonical shape end-to-end: a failed dispatch
//      recorded through recordDeliveryOutcome lands second-resolution + Z, so the
//      third serialization the migration removed cannot come back.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts (already fully
// migrated at import — so we drive the migration's up() directly against seeded rows,
// exactly as the notify-lifecycle 061 test does).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "@/lib/db";
import { up as migrate167 } from "@/lib/migrations/versions/167-notify-lifecycle-utc-instant";
import { dispatch, getNotifyError } from "@/lib/notifications";
import { setProfileHomeAssistant } from "@/lib/settings";

const CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function seedRow(key: string, at: string | null): void {
  db.prepare(
    `INSERT INTO notify_lifecycle (key, state, channel, detail, at)
       VALUES (?, 'failing', 'telegram', 'chat not found', ?)`
  ).run(key, at);
}

function atOf(key: string): string | null {
  return (
    db.prepare("SELECT at FROM notify_lifecycle WHERE key = ?").get(key) as {
      at: string | null;
    }
  ).at;
}

describe("migration 167 — notify_lifecycle.at states one convention (#2233)", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM notify_lifecycle").run();
  });

  it("strips the millisecond fraction from an iso-ms value, changing no instant", () => {
    seedRow("delivery-health", "2026-08-06T17:42:11.482Z");
    migrate167(db);
    expect(atOf("delivery-health")).toBe("2026-08-06T17:42:11Z");
  });

  it("leaves already-canonical, empty and NULL values untouched, and replays as a no-op", () => {
    seedRow("a-canonical", "2026-01-02T03:04:05Z");
    // Migration 061's legacy copy stored '' when notify_last_error_at was unset.
    seedRow("b-empty", "");
    seedRow("c-null", null);
    seedRow("d-ms", "2026-08-06T17:42:11.482Z");

    migrate167(db);
    expect(atOf("a-canonical")).toBe("2026-01-02T03:04:05Z");
    expect(atOf("b-empty")).toBe("");
    expect(atOf("c-null")).toBeNull();
    expect(atOf("d-ms")).toBe("2026-08-06T17:42:11Z");

    // Replay (the non-gated migrate() wrapper re-runs up()): the GLOB matches
    // nothing after the rewrite, so every value stands.
    expect(() => migrate167(db)).not.toThrow();
    expect(atOf("a-canonical")).toBe("2026-01-02T03:04:05Z");
    expect(atOf("d-ms")).toBe("2026-08-06T17:42:11Z");
  });

  it("the live writer records a failed dispatch at second resolution + Z", async () => {
    // The Home Assistant channel with a stubbed non-2xx webhook (the
    // home-assistant-notify.test.ts pattern): the send fails, and
    // recordDeliveryOutcome sets the marker — the exact path that used to
    // hand-build a millisecond instant.
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const profileId = Number(
        db.prepare("INSERT INTO profiles (name) VALUES ('NotifyAt167')").run()
          .lastInsertRowid
      );
      setProfileHomeAssistant(profileId, {
        enabled: true,
        webhookUrl: "http://homeassistant.local:8123/api/webhook/allos-test",
        secret: "",
        disabledKinds: [],
      });

      const results = await dispatch(profileId, {
        title: "test",
        body: "delivery-health probe",
        kind: "dose",
      });
      expect(results.some((r) => !r.ok)).toBe(true);

      const marker = getNotifyError();
      expect(marker).not.toBeNull();
      expect(marker!.at).toMatch(CANONICAL_RE);
      expect(atOf("delivery-health")).toMatch(CANONICAL_RE);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
