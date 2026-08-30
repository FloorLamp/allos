// SERVER-ACTION TIER — the Home Assistant notification prefs write path (#248).
//
// Proves the real saveHomeAssistantPrefs / sendTestHomeAssistant actions run through
// the (mocked) auth guard, persist to the acting PROFILE's settings tier, PRESERVE the
// per-kind routing the matrix owns, reject a malformed URL, refuse a read-only member,
// and report "not configured" for a send-test with no webhook.
//
// The card used to DERIVE `disabledKinds` from `ha_kind_*` checkboxes it rendered
// itself — the duplicate editor #1868 §1 removed. The matrix's HA column is now the one
// editor of that key, so this action must carry the stored set through: deriving it
// from a form that no longer has those fields would read as "every kind unchecked" and
// silence the whole channel whenever someone edited the webhook URL.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import {
  saveHomeAssistantPrefs,
  sendTestHomeAssistant,
} from "@/app/(app)/settings/profile/actions";
import {
  getProfileHomeAssistant,
  setProfileHomeAssistant,
} from "@/lib/settings";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

const URL = "http://homeassistant.local:8123/api/webhook/allos-test";

beforeEach(() => {
  revalidate.mockClear();
});

describe("saveHomeAssistantPrefs", () => {
  it("persists to the acting profile and preserves matrix-owned routing", async () => {
    const login = createLogin();
    const profile = createProfile("ha-owner", login.id);
    const bystander = createProfile("bystander", login.id);
    actAs(login, profile);

    const initialResult = await saveHomeAssistantPrefs(
      fd({ ha_enabled: "1", ha_webhook_url: URL, ha_secret: "s3cr3t" })
    );

    expect(initialResult).toEqual({ ok: true });
    const initial = getProfileHomeAssistant(profile.id);
    expect(initial.enabled).toBe(true);
    expect(initial.webhookUrl).toBe(URL);
    expect(initial.secret).toBe("s3cr3t");
    // Nothing was routed off: a channel card that carries no per-kind fields must not
    // invent a disabled set (#1868 §1).
    expect(initial.disabledKinds).toEqual([]);
    // Profile-scoped: a bystander profile is untouched.
    expect(getProfileHomeAssistant(bystander.id).enabled).toBe(false);
    expect(revalidate).toHaveBeenCalledWith("/settings/notifications");

    // What the matrix's HA column stored.
    setProfileHomeAssistant(profile.id, {
      enabled: true,
      webhookUrl: URL,
      secret: "",
      disabledKinds: ["digest", "milestone"],
    });

    // Editing the webhook target says nothing about routing, and must change nothing
    // about it — the failure mode being pinned is a silent whole-channel mute.
    const editedResult = await saveHomeAssistantPrefs(
      fd({
        ha_enabled: "1",
        ha_webhook_url: "http://homeassistant.local:8123/api/webhook/allos-new",
        ha_secret: "added",
      })
    );

    expect(editedResult).toEqual({ ok: true });
    const edited = getProfileHomeAssistant(profile.id);
    expect(edited.webhookUrl).toBe(
      "http://homeassistant.local:8123/api/webhook/allos-new"
    );
    expect(edited.secret).toBe("added");
    expect(edited.disabledKinds).toEqual(["digest", "milestone"]);
  });

  it("rejects malformed and non-Home Assistant targets without persisting", async () => {
    const login = createLogin();
    const profile = createProfile("invalid-url", login.id);
    actAs(login, profile);

    for (const ha_webhook_url of ["not-a-url", "http://127.0.0.1:8080/admin"]) {
      const res = await saveHomeAssistantPrefs(
        fd({ ha_enabled: "1", ha_webhook_url })
      );
      expect(res.ok).toBe(false);
      expect(getProfileHomeAssistant(profile.id).enabled).toBe(false);
    }
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
