// DB INTEGRATION TIER: the Home Assistant notification channel (#248) against a
// real (in-memory) SQLite handle. Proves what the pure/source scans can't:
//   1. The per-profile HA config round-trips through profile_settings.
//   2. The channel's isConfigured gate (enabled + valid URL).
//   3. A dispatch() to an HA-only profile POSTs the built payload (kind + profile
//      name + dose ids) with the shared-secret header, and a per-kind toggle-off is
//      a silent no-op.
//   4. An HA send failure folds into the channel-aware notify_last_error marker.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/lib/db";
import {
  getProfileHomeAssistant,
  setProfileHomeAssistant,
} from "@/lib/settings";
import { homeAssistantChannel } from "@/lib/notifications/home-assistant";
import { HA_SECRET_HEADER } from "@/lib/notifications/home-assistant-core";
import { dispatch, getNotifyError } from "@/lib/notifications";
import type { NotificationMessage } from "@/lib/notifications/types";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

const URL = "http://homeassistant.local:8123/api/webhook/allos-test";

const DOSE_MSG: NotificationMessage = {
  title: "💊 Morning supplements",
  body: "Vitamin D 2000 IU",
  kind: "dose",
  actions: [{ label: "✅ take", data: "take:9:41:5:2026-07-11" }],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  // Reset the global delivery-health marker between cases.
  db.prepare("DELETE FROM settings WHERE key LIKE 'notify_last_error%'").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HA config round-trip", () => {
  it("persists and reads back enable/url/secret/disabled kinds", () => {
    const p = newProfile("RoundTrip");
    setProfileHomeAssistant(p, {
      enabled: true,
      webhookUrl: `  ${URL}  `,
      secret: "  s3cr3t  ",
      disabledKinds: ["weekly-recap", "digest"],
    });
    expect(getProfileHomeAssistant(p)).toEqual({
      enabled: true,
      webhookUrl: URL, // trimmed
      secret: "s3cr3t", // trimmed
      disabledKinds: ["weekly-recap", "digest"],
    });
  });
});

describe("homeAssistantChannel.isConfigured", () => {
  it("is false unless enabled with a valid URL", () => {
    const p = newProfile("Gate");
    expect(homeAssistantChannel.isConfigured(p)).toBe(false); // nothing set

    setProfileHomeAssistant(p, {
      enabled: false,
      webhookUrl: URL,
      secret: "",
      disabledKinds: [],
    });
    expect(homeAssistantChannel.isConfigured(p)).toBe(false); // disabled

    setProfileHomeAssistant(p, {
      enabled: true,
      webhookUrl: "not-a-url",
      secret: "",
      disabledKinds: [],
    });
    expect(homeAssistantChannel.isConfigured(p)).toBe(false); // bad URL

    setProfileHomeAssistant(p, {
      enabled: true,
      webhookUrl: URL,
      secret: "",
      disabledKinds: [],
    });
    expect(homeAssistantChannel.isConfigured(p)).toBe(true);
  });
});

describe("dispatch to an HA-only profile", () => {
  it("POSTs the payload with the secret header and clears the marker", async () => {
    const p = newProfile("Mom");
    setProfileHomeAssistant(p, {
      enabled: true,
      webhookUrl: URL,
      secret: "s3cr3t",
      disabledKinds: [],
    });

    const results = await dispatch(p, DOSE_MSG);
    expect(results).toEqual([{ id: "home-assistant", ok: true }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(URL);
    expect((init.headers as Record<string, string>)[HA_SECRET_HEADER]).toBe(
      "s3cr3t"
    );
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      title: "💊 Morning supplements",
      kind: "dose",
      profile: "Mom",
      profile_id: p,
      dose_ids: [41],
      doses: [{ dose_id: 41, date: "2026-07-11", action: "taken" }],
    });
    expect(typeof body.sent_at).toBe("string");

    // A healthy send leaves no delivery-error marker.
    expect(getNotifyError()).toBeNull();
  });

  it("skips a kind toggled off for the channel (no POST, still healthy)", async () => {
    const p = newProfile("QuietRecap");
    setProfileHomeAssistant(p, {
      enabled: true,
      webhookUrl: URL,
      secret: "",
      disabledKinds: ["weekly-recap"],
    });

    const results = await dispatch(p, {
      title: "📊 Weekly recap",
      body: "…",
      kind: "weekly-recap",
    });
    // Channel was configured (attempted) but the kind is off → no network call,
    // counted as a healthy no-op (mirrors push with no live subscription).
    expect(results).toEqual([{ id: "home-assistant", ok: true }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records a home-assistant failure in the channel-aware marker on a non-2xx", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    const p = newProfile("Broken");
    setProfileHomeAssistant(p, {
      enabled: true,
      webhookUrl: URL,
      secret: "",
      disabledKinds: [],
    });

    const results = await dispatch(p, DOSE_MSG);
    expect(results[0].ok).toBe(false);
    const marker = getNotifyError();
    expect(marker?.channel).toBe("home-assistant");
    expect(marker?.error).toContain("404");
  });
});
