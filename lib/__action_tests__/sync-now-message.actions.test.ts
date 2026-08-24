// SERVER-ACTION TIER — what "Sync now" actually toasts (#3618).
//
// THE PREFIX AND THE HTTP BRANCH ARE ONE CHANGE, which is why this file exists. The
// `"Sync failed: "` prefix at sync-actions.ts was load-bearing for as long as
// `res.error` was a fragment naming a path and a status — `Sync failed: Oura
// /v2/usercollection/sleep request failed (401)` is unreadable without it. Since
// #3592 the throw branch already returned a whole house sentence and the prefix had
// started doubling up; #3618 made every branch a sentence, so it doubles up on all
// of them and comes off.
//
// Nothing pinned the toast before this. `attention.test.ts` pins the ATTENTION item's
// copy and `source-state.ts` pins the card's "Sync failed" HEADLINE — neither is this
// string, so the prefix could have been removed alone (making the HTTP branch worse)
// or left behind (doubling up forever) with every tier green.
//
// Runs under vitest.db.config.ts's action project: a real login/profile in a
// throwaway DB, a stubbed provider host, and the real runner behind the real action.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { syncNow } from "@/app/(app)/integrations/sync-actions";
import { setOuraToken, getConnection } from "@/lib/integrations/connections";
import { setHomeLocation } from "@/lib/settings";
import { getLatestSyncEvent } from "@/lib/queries";
import { actAs, createLogin, createProfile } from "./harness";

let profileId: number;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const login = createLogin({ role: "admin" });
  const profile = createProfile(`SyncNow ${Date.now()}`, login.id);
  profileId = profile.id;
  actAs(login, profile, "write");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Sync now toast", () => {
  it("is the recorded line verbatim — no prefix in front of a house sentence", async () => {
    setOuraToken(profileId, "live-token");
    fetchMock.mockResolvedValue(
      new Response("upstream error", { status: 503 })
    );

    const res = await syncNow("oura");

    expect(res.status).toBe("error");
    // ONE LINE, THREE SURFACES. The toast, the card's red line and the digest all
    // render this string, so the toast must not decorate it.
    expect(res.message).toBe("Couldn't reach Oura. Try again.");
    expect(res.message).toBe(getLatestSyncEvent(profileId, "oura")?.error);
    expect(res.message).not.toContain("Sync failed");
    // The failure framing rides `status`, which SyncNowButton renders as
    // tone: "error" — it was never the prefix's job.
    expect(res.status).toBe("error");
  });

  it("toasts the reconnect ask when the token died, and nothing about a status", async () => {
    setOuraToken(profileId, "dead-token");
    fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    const res = await syncNow("oura");

    expect(getConnection(profileId, "oura")?.status).toBe("needs_reauth");
    expect(res.message).toBe(
      "Your Oura Ring connection expired. Reconnect to resume syncing."
    );
    expect(res.message).not.toMatch(/\d/);
    expect(res.message).not.toContain("Sync failed");
  });

  it("still says its own thing for a source that was never connected", async () => {
    // The one branch that is NOT the recorded line: `"not connected"` is a runner
    // sentinel, never user copy, and it is translated rather than passed through.
    const res = await syncNow("oura");
    expect(res.status).toBe("error");
    expect(res.message).toBe("Connect Oura Ring first, then sync.");
  });

  // THE ONE RUNNER FRAGMENT A PERSON COULD REACH, PINNED (#3618 review). The claim
  // at sync-actions.ts is that every `res.error` is now a whole house sentence, and
  // two runner returns are still raw fragments: weather-sync's `"no home location"`
  // and strava-sync's `"Strava read-request budget exhausted"`. Neither reaches this
  // toast today, but only one of them is guarded by something a person configured —
  // and it is the guard, not the fragment, that has to stay true.
  it("a profile with no home location is stopped before the runner speaks", async () => {
    // `blockedReason` answers first, so `runWeatherSync`'s "no home location" — a
    // fragment, and one that reads as a diagnosis rather than an instruction — never
    // becomes the toast. Remove the guard and this reads "no home location".
    const res = await syncNow("weather");
    expect(res.status).toBe("error");
    expect(res.message).toBe(
      "Set your home location first (Settings → Profile)."
    );
    expect(res.message).not.toBe("no home location");
  });

  it("…and with one set, the run proceeds to the real failure line", async () => {
    setHomeLocation(profileId, { lat: 40.7, lng: -74 });
    fetchMock.mockResolvedValue(new Response("upstream", { status: 503 }));

    const res = await syncNow("weather");

    expect(res.status).toBe("error");
    expect(res.message).toBe("Couldn't reach Open-Meteo. Try again.");
    expect(res.message).not.toMatch(/\d/);
  });
});
