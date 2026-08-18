import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  deleteLoginSetting,
  deleteProfileSetting,
  deleteSetting,
  getLoginSetting,
  getProfileSetting,
  getSetting,
  preloadGlobalSettings,
  preloadLoginSettings,
  preloadProfileSettings,
  setLoginSetting,
  setProfileSetting,
  setSetting,
  withSettingReadCache,
} from "@/lib/settings/kv";

describe("request-scoped setting reads", () => {
  it("preloads complete tiers while preserving missing keys and later writes", () => {
    const profileId = Number(
      db
        .prepare(
          "INSERT INTO profiles (name) VALUES ('settings preload fixture')"
        )
        .run().lastInsertRowid
    );
    const loginId = (
      db.prepare("SELECT id FROM logins ORDER BY id LIMIT 1").get() as {
        id: number;
      }
    ).id;
    setSetting("settings_preload_test", "global");
    setProfileSetting(profileId, "settings_preload_test", "profile");
    setLoginSetting(loginId, "settings_preload_test", "login");

    try {
      withSettingReadCache(() => {
        preloadGlobalSettings();
        preloadProfileSettings([profileId, profileId]);
        preloadLoginSettings(loginId);

        expect(getSetting("settings_preload_test")).toBe("global");
        expect(getProfileSetting(profileId, "settings_preload_test")).toBe(
          "profile"
        );
        expect(getLoginSetting(loginId, "settings_preload_test")).toBe("login");
        expect(getSetting("settings_preload_missing")).toBeUndefined();
        expect(
          getProfileSetting(profileId, "settings_preload_missing")
        ).toBeUndefined();
        expect(
          getLoginSetting(loginId, "settings_preload_missing")
        ).toBeUndefined();

        setProfileSetting(profileId, "settings_preload_missing", "now set");
        expect(getProfileSetting(profileId, "settings_preload_missing")).toBe(
          "now set"
        );
      });
    } finally {
      deleteSetting("settings_preload_test");
      deleteProfileSetting(profileId, "settings_preload_test");
      deleteProfileSetting(profileId, "settings_preload_missing");
      deleteLoginSetting(loginId, "settings_preload_test");
    }
  });

  it("observes writes and deletes inside an async cache scope", async () => {
    const profileId = Number(
      db
        .prepare(
          "INSERT INTO profiles (name) VALUES ('settings cache fixture')"
        )
        .run().lastInsertRowid
    );
    const loginId = (
      db.prepare("SELECT id FROM logins ORDER BY id LIMIT 1").get() as {
        id: number;
      }
    ).id;

    await withSettingReadCache(async () => {
      setSetting("settings_cache_test", "one");
      setProfileSetting(profileId, "settings_cache_test", "one");
      setLoginSetting(loginId, "settings_cache_test", "one");
      await Promise.resolve();

      expect(getSetting("settings_cache_test")).toBe("one");
      expect(getProfileSetting(profileId, "settings_cache_test")).toBe("one");
      expect(getLoginSetting(loginId, "settings_cache_test")).toBe("one");

      setSetting("settings_cache_test", "two");
      setProfileSetting(profileId, "settings_cache_test", "two");
      setLoginSetting(loginId, "settings_cache_test", "two");
      expect(getSetting("settings_cache_test")).toBe("two");
      expect(getProfileSetting(profileId, "settings_cache_test")).toBe("two");
      expect(getLoginSetting(loginId, "settings_cache_test")).toBe("two");

      deleteSetting("settings_cache_test");
      deleteProfileSetting(profileId, "settings_cache_test");
      deleteLoginSetting(loginId, "settings_cache_test");
      expect(getSetting("settings_cache_test")).toBeUndefined();
      expect(
        getProfileSetting(profileId, "settings_cache_test")
      ).toBeUndefined();
      expect(getLoginSetting(loginId, "settings_cache_test")).toBeUndefined();
    });
  });
});
