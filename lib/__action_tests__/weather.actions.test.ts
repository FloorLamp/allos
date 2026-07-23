// SERVER-ACTION TIER (issue #1172): the keyless weather/UV integration actions +
// the skin-type profile attribute. The DB is real; runWeatherSync is mocked so no
// network is touched (offline test rule) — the actual sync is covered in the DB tier.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";

// Mock the sync module BEFORE importing the actions, so enableWeatherAction's initial
// sync is a no-op (no Open-Meteo fetch in the test tier).
vi.mock("@/lib/integrations/weather-sync", () => ({
  runWeatherSync: vi.fn(async () => ({
    hours: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
  })),
}));

import {
  enableWeatherAction,
  disconnectWeatherAction,
} from "@/app/(app)/integrations/weather/actions";
import { saveProfileSettings } from "@/app/(app)/settings/profile/actions";
import { getConnection } from "@/lib/integrations/connections";
import { getSkinType, setHomeLocation } from "@/lib/settings";
import { runWeatherSync } from "@/lib/integrations/weather-sync";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => {
  revalidate.mockClear();
  vi.mocked(runWeatherSync).mockClear();
});

describe("weather integration actions (#1172)", () => {
  it("enables the connection when a home location is set, and kicks a sync", async () => {
    const login = createLogin();
    const profile = createProfile("weather-en", login.id);
    actAs(login, profile);
    setHomeLocation(profile.id, { lat: 40.7, lng: -74 });

    await enableWeatherAction();

    expect(getConnection(profile.id, "weather")?.status).toBe("connected");
    expect(vi.mocked(runWeatherSync)).toHaveBeenCalledWith(profile.id);
  });

  it("refuses to enable without a home location (redirects, connection stays off)", async () => {
    const login = createLogin();
    const profile = createProfile("weather-noloc", login.id);
    actAs(login, profile);

    // redirect() throws NEXT_REDIRECT in the test tier — the refusal path.
    await expect(enableWeatherAction()).rejects.toThrow();
    expect(getConnection(profile.id, "weather")?.status ?? "disconnected").toBe(
      "disconnected"
    );
    expect(vi.mocked(runWeatherSync)).not.toHaveBeenCalled();
  });

  it("disables the connection", async () => {
    const login = createLogin();
    const profile = createProfile("weather-dis", login.id);
    actAs(login, profile);
    setHomeLocation(profile.id, { lat: 40.7, lng: -74 });

    await enableWeatherAction();
    expect(getConnection(profile.id, "weather")?.status).toBe("connected");

    await disconnectWeatherAction();
    expect(getConnection(profile.id, "weather")?.status).toBe("disconnected");
  });
});

describe("skin type persists through saveProfileSettings (#1172)", () => {
  it("stores a chosen Fitzpatrick type and clears it on empty", async () => {
    const login = createLogin();
    const profile = createProfile("skin-1", login.id);
    actAs(login, profile);

    await saveProfileSettings(fd({ skin_type: "3" }));
    expect(getSkinType(profile.id)).toBe(3);

    await saveProfileSettings(fd({ skin_type: "" }));
    expect(getSkinType(profile.id)).toBeNull();
  });

  it("rejects an out-of-range value (clears rather than persisting garbage)", async () => {
    const login = createLogin();
    const profile = createProfile("skin-2", login.id);
    actAs(login, profile);

    await saveProfileSettings(fd({ skin_type: "9" }));
    expect(getSkinType(profile.id)).toBeNull();
  });
});
