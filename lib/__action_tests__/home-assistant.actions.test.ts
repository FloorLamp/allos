// SERVER-ACTION TIER — the Home Assistant notification prefs write path (#248).
//
// Proves the real saveHomeAssistantPrefs / sendTestHomeAssistant actions run through
// the (mocked) auth guard, persist to the acting PROFILE's settings tier, derive the
// disabled-kinds set from the unchecked boxes, reject a malformed URL, refuse a
// read-only member, and report "not configured" for a send-test with no webhook.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import {
  saveHomeAssistantPrefs,
  sendTestHomeAssistant,
} from "@/app/(app)/settings/profile/actions";
import { getProfileHomeAssistant } from "@/lib/settings";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

const URL = "http://homeassistant.local:8123/api/webhook/allos-test";

beforeEach(() => {
  revalidate.mockClear();
});

describe("saveHomeAssistantPrefs", () => {
  it("persists enable/url/secret and disables the unchecked kinds", async () => {
    const login = createLogin();
    const profile = createProfile("ha-owner", login.id);
    const bystander = createProfile("bystander", login.id);
    actAs(login, profile);

    // Only "dose" and "refill" boxes checked → the other kinds are disabled.
    const res = await saveHomeAssistantPrefs(
      fd({
        ha_enabled: "1",
        ha_webhook_url: URL,
        ha_secret: "s3cr3t",
        ha_kind_dose: "1",
        ha_kind_refill: "1",
      })
    );

    expect(res).toEqual({ ok: true });
    const cfg = getProfileHomeAssistant(profile.id);
    expect(cfg.enabled).toBe(true);
    expect(cfg.webhookUrl).toBe(URL);
    expect(cfg.secret).toBe("s3cr3t");
    // The disabled set is every toggleable kind NOT checked. Since #1108 there is no
    // separate `upcoming` row (the "what's due" list is the morning digest's Today
    // section — one `digest` kind), so it isn't among the derived disabled kinds.
    expect(new Set(cfg.disabledKinds)).toEqual(
      new Set([
        "escalation",
        "preventive",
        "workout",
        "workout-recap",
        "food",
        "mood",
        "digest",
        "weekly-recap",
        "milestone",
      ])
    );
    // Profile-scoped: a bystander profile is untouched.
    expect(getProfileHomeAssistant(bystander.id).enabled).toBe(false);
    expect(revalidate).toHaveBeenCalledWith("/settings/profile");
  });

  it("rejects a malformed URL when enabling and persists nothing", async () => {
    const login = createLogin();
    const profile = createProfile("bad-url", login.id);
    actAs(login, profile);

    const res = await saveHomeAssistantPrefs(
      fd({ ha_enabled: "1", ha_webhook_url: "not-a-url" })
    );
    expect(res.ok).toBe(false);
    expect(getProfileHomeAssistant(profile.id).enabled).toBe(false);
  });

  it("rejects non-Home Assistant webhook targets when enabling", async () => {
    const login = createLogin();
    const profile = createProfile("ssrf-url", login.id);
    actAs(login, profile);

    const res = await saveHomeAssistantPrefs(
      fd({ ha_enabled: "1", ha_webhook_url: "http://127.0.0.1:8080/admin" })
    );
    expect(res.ok).toBe(false);
    expect(getProfileHomeAssistant(profile.id).enabled).toBe(false);
  });

  it("refuses a read-only member (requireWriteAccess gate)", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("readonly", login.id);
    actAs(login, profile, "read");

    await expect(
      saveHomeAssistantPrefs(fd({ ha_enabled: "1", ha_webhook_url: URL }))
    ).rejects.toThrow(/read-only/);
    expect(getProfileHomeAssistant(profile.id).enabled).toBe(false);
  });
});

describe("sendTestHomeAssistant", () => {
  it("reports not-configured when no webhook is set", async () => {
    const login = createLogin();
    const profile = createProfile("no-webhook", login.id);
    actAs(login, profile);

    const res = await sendTestHomeAssistant();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/No Home Assistant webhook/);
  });
});
