// SERVER-ACTION TIER — the kind × channel matrix columns (#928, re-homed by #1072).
// Each column saves through a tier-correct action: Telegram + Web Push follow the
// LOGIN (requireSession, login-scoped as of #1072), Home Assistant follows the
// PROFILE (requireWriteAccess). Proves each persists to its own tier store, the HA
// column preserves the channel's enable/URL, the login-tier columns allow a
// read-only member, and the HA (profile) column refuses one.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { saveHomeAssistantNotifyKinds } from "@/app/(app)/settings/profile/actions";
import {
  savePushNotifyKinds,
  saveLoginTelegramNotifyKinds,
} from "@/app/(app)/settings/actions";
import {
  getLoginTelegramDisabledKinds,
  getLoginPushDisabledKinds,
  getProfileHomeAssistant,
  setProfileHomeAssistant,
} from "@/lib/settings";
import {
  NOTIFICATION_KIND_REGISTRY,
  SAFETY_NOTIFICATION_KINDS,
} from "@/lib/notifications/kinds";
import {
  applyColumnBulk,
  sweepableKinds,
} from "@/lib/notifications/matrix-bulk";
import { isPushDeliverableKind } from "@/lib/notifications/push-core";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

const disabled = (kinds: string[]) => ({
  disabled_kinds: JSON.stringify(kinds),
});

beforeEach(() => revalidate.mockClear());

describe("saveLoginTelegramNotifyKinds (login tier, #1072)", () => {
  it("persists the Telegram column to the acting login, not the profile", async () => {
    const login = createLogin();
    const profile = createProfile("tg-owner", login.id);
    const other = createLogin();
    actAs(login, profile);

    const res = await saveLoginTelegramNotifyKinds(
      fd(disabled(["refill", "digest"]))
    );
    expect(res).toEqual({ ok: true });
    expect(new Set(getLoginTelegramDisabledKinds(login.id))).toEqual(
      new Set(["refill", "digest"])
    );
    // Login-scoped: another login is untouched.
    expect(getLoginTelegramDisabledKinds(other.id)).toEqual([]);
    expect(revalidate).toHaveBeenCalledWith("/settings/notifications");
  });

  it("drops unknown kinds via the shared pure parser", async () => {
    const login = createLogin();
    const profile = createProfile("tg-parse", login.id);
    actAs(login, profile);
    await saveLoginTelegramNotifyKinds(fd(disabled(["refill", "not-a-kind"])));
    expect(getLoginTelegramDisabledKinds(login.id)).toEqual(["refill"]);
  });

  it("is allowed for a read-only member (login-scoped, not profile-owned)", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("tg-ro", login.id);
    actAs(login, profile, "read");
    // requireSession() only — a read-only member may still set their own Telegram
    // channel prefs (the chat is theirs), like the push column.
    const res = await saveLoginTelegramNotifyKinds(fd(disabled(["refill"])));
    expect(res).toEqual({ ok: true });
    expect(getLoginTelegramDisabledKinds(login.id)).toEqual(["refill"]);
  });
});

describe("saveHomeAssistantNotifyKinds (profile tier)", () => {
  it("rewrites only the disabled kinds, preserving enable/URL/secret", async () => {
    const login = createLogin();
    const profile = createProfile("ha-kinds", login.id);
    actAs(login, profile);
    setProfileHomeAssistant(profile.id, {
      enabled: true,
      webhookUrl: "http://homeassistant.local:8123/api/webhook/allos-x",
      secret: "keep",
      disabledKinds: ["digest"],
    });

    await saveHomeAssistantNotifyKinds(fd(disabled(["refill"])));
    const cfg = getProfileHomeAssistant(profile.id);
    expect(cfg.enabled).toBe(true);
    expect(cfg.webhookUrl).toBe(
      "http://homeassistant.local:8123/api/webhook/allos-x"
    );
    expect(cfg.secret).toBe("keep");
    expect(cfg.disabledKinds).toEqual(["refill"]);
  });
});

// A column select-all (#1868 §2) is not a new action — it is ONE write of the full
// disabled set through the SAME tier-correct action a single cell uses, composed by the
// pure `applyColumnBulk` over `sweepableKinds`. What must hold end-to-end is that the
// composition writes exactly the non-safety kinds and leaves the safety tier's stored
// state alone in BOTH directions.
describe("a column sweep composed onto the real actions (#1868 §2)", () => {
  const rowKinds = NOTIFICATION_KIND_REGISTRY.map((e) => e.kind);

  it("turning the Telegram column off disables every non-safety kind and no safety kind", async () => {
    const login = createLogin();
    const profile = createProfile("sweep-tg", login.id);
    actAs(login, profile);

    const sweep = sweepableKinds(rowKinds);
    const next = applyColumnBulk([], sweep, false);
    await saveLoginTelegramNotifyKinds(
      fd({ disabled_kinds: JSON.stringify(next) })
    );

    const stored = new Set(getLoginTelegramDisabledKinds(login.id));
    expect(stored).toEqual(new Set(sweep));
    // The point of the whole exercise: one tap cannot silence a safety signal.
    for (const k of SAFETY_NOTIFICATION_KINDS)
      expect(stored.has(k)).toBe(false);
  });

  it("a sweep carries a deliberately-disabled safety kind through untouched", async () => {
    const login = createLogin();
    const profile = createProfile("sweep-safety", login.id);
    actAs(login, profile);
    // The user turned `dose` off on this channel by hand, cell by cell.
    await savePushNotifyKinds(fd(disabled(["dose"])));

    const sweep = sweepableKinds(
      rowKinds.filter((k) => isPushDeliverableKind(k))
    );
    // Sweep OFF, then sweep back ON: `dose` survives both, because neither direction
    // may rewrite what the user declared individually.
    const off = applyColumnBulk(
      getLoginPushDisabledKinds(login.id),
      sweep,
      false
    );
    await savePushNotifyKinds(fd({ disabled_kinds: JSON.stringify(off) }));
    expect(getLoginPushDisabledKinds(login.id)).toContain("dose");

    const on = applyColumnBulk(
      getLoginPushDisabledKinds(login.id),
      sweep,
      true
    );
    await savePushNotifyKinds(fd({ disabled_kinds: JSON.stringify(on) }));
    expect(getLoginPushDisabledKinds(login.id)).toEqual(["dose"]);
  });

  it("the HA column sweep rewrites only the kinds, keeping the webhook config", async () => {
    const login = createLogin();
    const profile = createProfile("sweep-ha", login.id);
    actAs(login, profile);
    setProfileHomeAssistant(profile.id, {
      enabled: true,
      webhookUrl: "http://homeassistant.local:8123/api/webhook/allos-sweep",
      secret: "keep",
      disabledKinds: ["escalation"],
    });

    const sweep = sweepableKinds(rowKinds);
    const next = applyColumnBulk(
      getProfileHomeAssistant(profile.id).disabledKinds,
      sweep,
      false
    );
    await saveHomeAssistantNotifyKinds(
      fd({ disabled_kinds: JSON.stringify(next) })
    );

    const cfg = getProfileHomeAssistant(profile.id);
    expect(cfg.enabled).toBe(true);
    expect(cfg.webhookUrl).toBe(
      "http://homeassistant.local:8123/api/webhook/allos-sweep"
    );
    expect(cfg.secret).toBe("keep");
    expect(new Set(cfg.disabledKinds)).toEqual(
      new Set(["escalation", ...sweep])
    );
    expect(cfg.disabledKinds).not.toContain("dose");
  });
});

describe("savePushNotifyKinds (login tier)", () => {
  it("persists the push column to the acting login, not the profile", async () => {
    const login = createLogin();
    const profile = createProfile("push-owner", login.id);
    actAs(login, profile);

    const res = await savePushNotifyKinds(fd(disabled(["milestone"])));
    expect(res).toEqual({ ok: true });
    expect(getLoginPushDisabledKinds(login.id)).toEqual(["milestone"]);
    // Login-scoped: NOT written to the login's telegram column.
    expect(getLoginTelegramDisabledKinds(login.id)).toEqual([]);
    expect(revalidate).toHaveBeenCalledWith("/settings/notifications");
  });

  it("is allowed for a read-only member (login-scoped, not profile-owned)", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("push-ro", login.id);
    actAs(login, profile, "read");
    // requireSession() only — a read-only member may still set their own push prefs.
    const res = await savePushNotifyKinds(fd(disabled(["refill"])));
    expect(res).toEqual({ ok: true });
    expect(getLoginPushDisabledKinds(login.id)).toEqual(["refill"]);
  });
});
