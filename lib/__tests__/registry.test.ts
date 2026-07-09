import { describe, expect, it } from "vitest";
import { INTEGRATIONS, getIntegration } from "@/lib/integrations/registry";

describe("INTEGRATIONS", () => {
  it("has unique ids", () => {
    const ids = INTEGRATIONS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lists Health Connect as the available push integration", () => {
    const hc = INTEGRATIONS.find((i) => i.id === "health-connect");
    expect(hc?.status).toBe("available");
    expect(hc?.kind).toBe("push");
  });
});

describe("getIntegration", () => {
  it("looks up a definition by id", () => {
    expect(getIntegration("health-connect")?.name).toBe(
      "Google Health Connect"
    );
    expect(getIntegration("strava")?.status).toBe("available");
    expect(getIntegration("strava")?.kind).toBe("oauth");
  });

  it("returns undefined for an unknown id", () => {
    // Cast through unknown since the arg is typed to known ids.
    expect(getIntegration("nope" as unknown as never)).toBeUndefined();
  });
});
