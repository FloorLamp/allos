import { describe, it, expect } from "vitest";
import {
  buildHomeAssistantPayload,
  extractDoses,
  extractLinks,
  parseDisabledKinds,
  serializeDisabledKinds,
  isKindEnabled,
  isValidWebhookUrl,
} from "../notifications/home-assistant-core";
import type { NotificationMessage } from "../notifications/types";

const SENT_AT = "2026-07-11T08:00:00.000Z";

describe("extractDoses", () => {
  it("pulls dose id + date + action from take/skip tokens", () => {
    const msg: NotificationMessage = {
      title: "💊 Morning supplements",
      body: "…",
      kind: "dose",
      actions: [
        { label: "✅ take", data: "take:2:41:9:2026-07-11", row: "d41" },
        { label: "⏭ skip", data: "skip:2:41:9:2026-07-11", row: "d41" },
      ],
    };
    expect(extractDoses(msg)).toEqual([
      { dose_id: 41, date: "2026-07-11", action: "taken" },
      { dose_id: 41, date: "2026-07-11", action: "skipped" },
    ]);
  });

  it("maps an escalation confirm (esctake) to taken and ignores escack", () => {
    const msg: NotificationMessage = {
      title: "⚠️ Missed dose",
      body: "…",
      kind: "escalation",
      actions: [
        { label: "✅ Confirmed taken", data: "esctake:2:7:3:2026-07-11" },
        { label: "👍 I'm on it", data: "escack:2:7:3:2026-07-11" },
      ],
    };
    expect(extractDoses(msg)).toEqual([
      { dose_id: 7, date: "2026-07-11", action: "taken" },
    ]);
  });

  it("ignores non-dose tokens, url actions, and malformed ids", () => {
    const msg: NotificationMessage = {
      title: "🩺 Preventive care",
      body: "…",
      kind: "preventive",
      actions: [
        { label: "✅ Done", data: "pvdone:2:colorectal_cancer" },
        { label: "Open form", url: "https://allos.example/medicine" },
        { label: "bad", data: "take:2:notanumber:9:2026-07-11" },
      ],
    };
    expect(extractDoses(msg)).toEqual([]);
  });

  it("dedupes a repeated (dose, action) pair", () => {
    const msg: NotificationMessage = {
      title: "t",
      body: "b",
      actions: [
        { label: "a", data: "take:1:5:2:2026-07-11" },
        { label: "b", data: "take:1:5:2:2026-07-11" },
      ],
    };
    expect(extractDoses(msg)).toEqual([
      { dose_id: 5, date: "2026-07-11", action: "taken" },
    ]);
  });
});

describe("extractLinks", () => {
  it("collects unique deep-link urls, order-preserving", () => {
    const msg: NotificationMessage = {
      title: "t",
      body: "b",
      actions: [
        { label: "snooze", data: "rfsnooze:2:9" },
        { label: "form", url: "https://allos.example/medicine" },
        { label: "form again", url: "https://allos.example/medicine" },
      ],
    };
    expect(extractLinks(msg)).toEqual(["https://allos.example/medicine"]);
  });
});

describe("buildHomeAssistantPayload", () => {
  it("carries title/body/kind/profile + actionable dose ids", () => {
    const msg: NotificationMessage = {
      title: "💊 Morning supplements",
      body: "Vitamin D 2000 IU",
      kind: "dose",
      actions: [
        { label: "✅ take", data: "take:2:41:9:2026-07-11", row: "d41" },
        { label: "⏭ skip", data: "skip:2:41:9:2026-07-11", row: "d41" },
      ],
    };
    expect(
      buildHomeAssistantPayload(msg, {
        profileId: 2,
        profileName: "Mom",
        sentAt: SENT_AT,
      })
    ).toEqual({
      title: "💊 Morning supplements",
      body: "Vitamin D 2000 IU",
      kind: "dose",
      profile: "Mom",
      profile_id: 2,
      doses: [
        { dose_id: 41, date: "2026-07-11", action: "taken" },
        { dose_id: 41, date: "2026-07-11", action: "skipped" },
      ],
      dose_ids: [41],
      links: [],
      sent_at: SENT_AT,
    });
  });

  it("forwards an unset kind as 'other' and carries no doses for a plain message", () => {
    const payload = buildHomeAssistantPayload(
      { title: "📊 Weekly recap", body: "…" },
      { profileId: 1, profileName: "Me", sentAt: SENT_AT }
    );
    expect(payload.kind).toBe("other");
    expect(payload.doses).toEqual([]);
    expect(payload.dose_ids).toEqual([]);
  });
});

describe("per-kind toggle", () => {
  it("round-trips the disabled set, dropping garbage/unknown kinds", () => {
    expect(parseDisabledKinds(undefined)).toEqual([]);
    expect(parseDisabledKinds("not json")).toEqual([]);
    expect(parseDisabledKinds('["weekly-recap","bogus","digest"]')).toEqual([
      "weekly-recap",
      "digest",
    ]);
    expect(
      parseDisabledKinds(
        serializeDisabledKinds(["refill", "refill", "workout"])
      )
    ).toEqual(["refill", "workout"]);
  });

  it("never treats 'test' as disable-able", () => {
    // Even a corrupt blob naming "test" is ignored; a test always sends.
    expect(parseDisabledKinds('["test","dose"]')).toEqual(["dose"]);
    expect(isKindEnabled("test", ["dose"])).toBe(true);
  });

  it("enables a kind unless it's explicitly disabled", () => {
    expect(isKindEnabled("dose", [])).toBe(true);
    expect(isKindEnabled("weekly-recap", ["weekly-recap"])).toBe(false);
    expect(isKindEnabled("dose", ["weekly-recap"])).toBe(true);
    expect(isKindEnabled(undefined, ["dose"])).toBe(true); // "other" is never gated here
  });
});

describe("isValidWebhookUrl", () => {
  it("accepts absolute http(s) Home Assistant webhook URLs", () => {
    expect(
      isValidWebhookUrl("http://homeassistant.local:8123/api/webhook/allos-mom")
    ).toBe(true);
    expect(isValidWebhookUrl("https://ha.example.com/api/webhook/x")).toBe(
      true
    );
  });

  it("rejects empty, non-http schemes, and garbage", () => {
    expect(isValidWebhookUrl("")).toBe(false);
    expect(isValidWebhookUrl("ftp://ha/api/webhook/x")).toBe(false);
    expect(isValidWebhookUrl("just-a-string")).toBe(false);
    expect(isValidWebhookUrl("/api/webhook/x")).toBe(false);
  });

  it("rejects arbitrary server-side POST targets", () => {
    expect(isValidWebhookUrl("http://127.0.0.1:8080/admin")).toBe(false);
    expect(
      isValidWebhookUrl("http://ha.local/api/services/light/turn_on")
    ).toBe(false);
    expect(isValidWebhookUrl("http://ha.local/api/webhook")).toBe(false);
    expect(isValidWebhookUrl("http://ha.local/api/webhook/")).toBe(false);
    expect(isValidWebhookUrl("http://ha.local/api/webhook/x/extra")).toBe(
      false
    );
    expect(isValidWebhookUrl("http://user:pass@ha.local/api/webhook/x")).toBe(
      false
    );
    expect(
      isValidWebhookUrl("http://ha.local/api/webhook/x?target=admin")
    ).toBe(false);
    expect(isValidWebhookUrl("http://ha.local/api/webhook/x#frag")).toBe(false);
  });
});
