import { beforeAll, describe, expect, it, vi } from "vitest";
import { db, today } from "@/lib/db";
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
  withPrimedSettings,
  withSettingReadCache,
} from "@/lib/settings/kv";
import {
  allProfileIds,
  installStatementTrace,
  loadPage,
  pageProps,
  profilesForIds,
  requestCache,
  resolveAsyncTree,
  session,
} from "@/lib/__db_tests__/dashboard-render-harness";

// The record's day view renders through the shared harness (#5774). Its three
// mocks are written out here rather than imported because the isolation scan reads
// THIS file's source to route it, and a mock registered from an imported module
// would not be hoisted — see vitest.isolation.ts.
vi.mock("@/lib/request-cache", async () =>
  (
    await import("@/lib/__db_tests__/dashboard-render-harness")
  ).requestCacheModule()
);
vi.mock("@/lib/auth", async (importActual) =>
  (await import("@/lib/__db_tests__/dashboard-render-harness")).authModule(
    await importActual()
  )
);
vi.mock("@/lib/scope", async (importActual) =>
  (await import("@/lib/__db_tests__/dashboard-render-harness")).scopeModule(
    await importActual(),
    await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth")
  )
);

/** One per-key read of each tier — what an unprimed render pays per setting. */
const PER_KEY = {
  profile:
    /SELECT value FROM profile_settings WHERE profile_id = \? AND key = \?/,
  login: /SELECT value FROM login_settings WHERE login_id = \? AND key = \?/,
  global: /SELECT value FROM settings WHERE key = \?/,
};
/** The primed reads that replace them: one statement per tier, per profile. */
const WHOLE_TIER = {
  profile: /SELECT key, value FROM profile_settings WHERE profile_id = \?/,
  login: /SELECT key, value FROM login_settings WHERE login_id = \?/,
  global: /SELECT key, value FROM settings$/,
};

// THE TRACE IS INSTALLED BEFORE THE FIRST SETTING READ IN THIS FILE, and that is a
// correctness requirement rather than tidiness: the six statements below are
// `hoistedStatement`s, prepared once per connection on first use and memoized. One
// prepared before the spy is in place is never proxied again, and the render would
// then report zero per-key reads whether or not it made any — the exact false pass
// the primed-read control below exists to catch, and it caught this.
let trace: ReturnType<typeof installStatementTrace>;
beforeAll(() => {
  trace = installStatementTrace({ timing: true });
});
function executions(shape: RegExp): number {
  return trace
    .stats()
    .filter((stat) => shape.test(stat.sql))
    .reduce((sum, stat) => sum + stat.count, 0);
}

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

// THE RECORD OPENS THE CACHE (#5774). Home opened it and `HistoryPage` did not, so
// every `getProfileSetting`/`getLoginSetting`/`getSetting` the day view made ran its
// own single-key SELECT — 77 of the 172 statements one seeded persona's day view
// spent, measured through this harness.
//
// THE ASSERTION IS "NO PER-KEY READ", not a statement budget: the route meters own
// totals (dashboard-placement-manifest.test.ts, app-shell-budget.test.ts), and a
// number here would be a second budget to re-record whenever the day view gathers
// anything new. What must not come back is the SHAPE.
//
// THE POSITIVE CONTROL IS THE PRIMED READ ITSELF. A render that threw, or a walk
// that reached nothing, would also report zero per-key reads — so each case pins
// one whole-tier read per primed profile, which only a render that really asked for
// settings can produce.
describe("the record's day view primes its settings (#5774)", () => {
  function loginId(): number {
    return (
      db
        .prepare(
          "SELECT id FROM logins WHERE role = 'admin' ORDER BY id LIMIT 1"
        )
        .get() as { id: number }
    ).id;
  }
  function newProfile(name: string): number {
    return Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
        .lastInsertRowid
    );
  }
  /** Render the day view twice and leave the second render's statements in `trace`. */
  async function renderDayView(profileIds: readonly number[], view?: string) {
    session.loginId = loginId();
    session.accessible = profilesForIds(
      allProfileIds().filter((id) => profileIds.includes(id))
    );
    session.profile = session.accessible.find(
      (profile) => profile.id === profileIds[0]
    )!;
    session.viewIds = [...profileIds];
    try {
      const Page = await loadPage("app/(app)/history/page");
      const params: Record<string, string> = {
        day: today(profileIds[0]),
        ...(view ? { view } : {}),
      };
      // Warm first: the module graph's own one-time reads are not this render's.
      await requestCache.during(async () =>
        resolveAsyncTree(await Page(pageProps({}, params)))
      );
      trace.clear();
      await requestCache.during(async () =>
        resolveAsyncTree(await Page(pageProps({}, params)))
      );
    } finally {
      session.viewIds = null;
    }
  }

  it("reads no setting one key at a time on a single subject", async () => {
    const profileId = newProfile("day view primed");
    await renderDayView([profileId]);

    expect(executions(PER_KEY.profile)).toBe(0);
    expect(executions(PER_KEY.login)).toBe(0);
    expect(executions(PER_KEY.global)).toBe(0);
    expect(executions(WHOLE_TIER.profile)).toBe(1);
    expect(executions(WHOLE_TIER.login)).toBe(1);
    expect(executions(WHOLE_TIER.global)).toBe(1);
  });

  it("primes one read per viewed member under the household fan-out", async () => {
    const members = [
      newProfile("day view household acting"),
      newProfile("day view household second"),
      newProfile("day view household third"),
    ];
    await renderDayView(members, "everyone");

    expect(executions(PER_KEY.profile)).toBe(0);
    expect(executions(PER_KEY.login)).toBe(0);
    expect(executions(PER_KEY.global)).toBe(0);
    // One per member, and no more: the fan-out primes each viewed profile once.
    expect(executions(WHOLE_TIER.profile)).toBe(members.length);
    expect(executions(WHOLE_TIER.login)).toBe(1);
  });

  it("answers each primed profile from its own rows", () => {
    // THE FAN-OUT MUST NOT ANSWER FOR THE WRONG SUBJECT. Two members, the same key,
    // different values, and a third whose row is absent — primed together in one
    // scope, as a household day view primes them.
    const [first, second, third] = [
      newProfile("primed scoping first"),
      newProfile("primed scoping second"),
      newProfile("primed scoping third"),
    ];
    setProfileSetting(first, "primed_scoping_test", "first");
    setProfileSetting(second, "primed_scoping_test", "second");

    withPrimedSettings(
      { loginId: loginId(), profileIds: [first, second, third] },
      () => {
        expect(getProfileSetting(first, "primed_scoping_test")).toBe("first");
        expect(getProfileSetting(second, "primed_scoping_test")).toBe("second");
        expect(getProfileSetting(third, "primed_scoping_test")).toBeUndefined();
      }
    );
  });
});
