import { describe, expect, it } from "vitest";
import {
  isSubscriptionGone,
  parsePushSubscription,
  buildPushPayload,
  vapidConfigured,
  DEFAULT_PUSH_URL,
  PUSH_GONE_STATUSES,
} from "@/lib/notifications/push-core";

describe("push-core: isSubscriptionGone", () => {
  it("treats 404/410 as gone (prune the row)", () => {
    expect(isSubscriptionGone(404)).toBe(true);
    expect(isSubscriptionGone(410)).toBe(true);
  });

  it("treats other statuses as transient/real errors", () => {
    for (const s of [0, 200, 201, 400, 401, 403, 429, 500, 503])
      expect(isSubscriptionGone(s)).toBe(false);
  });

  it("PUSH_GONE_STATUSES lists exactly 404 and 410", () => {
    expect([...PUSH_GONE_STATUSES].sort()).toEqual([404, 410]);
  });
});

describe("push-core: parsePushSubscription", () => {
  const valid = {
    endpoint: "https://push.example.com/abc123",
    keys: { p256dh: "PUB_KEY", auth: "AUTH_SECRET" },
  };

  it("flattens a valid browser subscription", () => {
    expect(parsePushSubscription(valid)).toEqual({
      endpoint: "https://push.example.com/abc123",
      p256dh: "PUB_KEY",
      auth: "AUTH_SECRET",
    });
  });

  it("ignores extra fields (expirationTime, etc.)", () => {
    expect(parsePushSubscription({ ...valid, expirationTime: null })).toEqual({
      endpoint: valid.endpoint,
      p256dh: "PUB_KEY",
      auth: "AUTH_SECRET",
    });
  });

  it("rejects a non-https endpoint", () => {
    expect(
      parsePushSubscription({ ...valid, endpoint: "http://push.example.com/x" })
    ).toBeNull();
  });

  it("rejects missing endpoint or keys", () => {
    expect(parsePushSubscription({ keys: valid.keys })).toBeNull();
    expect(
      parsePushSubscription({ endpoint: valid.endpoint, keys: null })
    ).toBeNull();
    expect(
      parsePushSubscription({
        endpoint: valid.endpoint,
        keys: { p256dh: "x" },
      })
    ).toBeNull();
    expect(
      parsePushSubscription({
        endpoint: valid.endpoint,
        keys: { auth: "y" },
      })
    ).toBeNull();
  });

  it("rejects non-object / empty-string inputs", () => {
    expect(parsePushSubscription(null)).toBeNull();
    expect(parsePushSubscription(undefined)).toBeNull();
    expect(parsePushSubscription("nope")).toBeNull();
    expect(parsePushSubscription(42)).toBeNull();
    expect(
      parsePushSubscription({ endpoint: "", keys: valid.keys })
    ).toBeNull();
  });
});

describe("push-core: buildPushPayload", () => {
  it("packs title, body and a default deep link", () => {
    const json = buildPushPayload({ title: "Morning supps", body: "Take 2" });
    expect(JSON.parse(json)).toEqual({
      title: "Morning supps",
      body: "Take 2",
      url: DEFAULT_PUSH_URL,
    });
  });

  it("uses an explicit url when given", () => {
    const json = buildPushPayload({ title: "T", body: "B" }, "/medicine");
    expect(JSON.parse(json).url).toBe("/medicine");
  });

  it("truncates an over-long body (with an ellipsis) to stay under the payload cap", () => {
    const body = "x".repeat(1000);
    const parsed = JSON.parse(buildPushPayload({ title: "T", body }));
    expect(parsed.body.length).toBeLessThan(body.length);
    expect(parsed.body.endsWith("…")).toBe(true);
  });

  it("drops action tokens — the payload is title/body/url only (PHI-conscious)", () => {
    const json = buildPushPayload({
      title: "T",
      body: "B",
      actions: [{ label: "Taken", data: "take:9:3:2026-07-09" }],
    });
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed).sort()).toEqual(["body", "title", "url"]);
    expect(json).not.toContain("take:9:3");
  });
});

describe("push-core: vapidConfigured", () => {
  it("requires BOTH halves of the keypair", () => {
    expect(vapidConfigured({ publicKey: "p", privateKey: "s" })).toBe(true);
    expect(vapidConfigured({ publicKey: "p", privateKey: null })).toBe(false);
    expect(vapidConfigured({ publicKey: null, privateKey: "s" })).toBe(false);
    expect(vapidConfigured({ publicKey: "", privateKey: "" })).toBe(false);
    expect(vapidConfigured({})).toBe(false);
  });
});
