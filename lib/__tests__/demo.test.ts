import { describe, expect, it } from "vitest";
import { isDemoModeEnv, isDemoRestricted } from "../demo";

// Pure demo-mode predicates (#181). The env-flag interpretation and the
// "who is locked down" decision are the only logic; both are pure and pinned here.

describe("isDemoModeEnv", () => {
  it("treats the documented truthy spellings as on", () => {
    for (const v of ["1", "true", "TRUE", "yes", "Yes", "on", "  on  "]) {
      expect(isDemoModeEnv(v), v).toBe(true);
    }
  });

  it("treats absent / empty / anything-else as off", () => {
    for (const v of [undefined, null, "", "0", "false", "no", "off", "maybe"]) {
      expect(isDemoModeEnv(v), String(v)).toBe(false);
    }
  });
});

describe("isDemoRestricted", () => {
  it("locks down a member only when demo mode is on", () => {
    expect(isDemoRestricted(true, "member")).toBe(true);
    expect(isDemoRestricted(false, "member")).toBe(false);
  });

  it("never locks down an admin (operator must stay functional)", () => {
    expect(isDemoRestricted(true, "admin")).toBe(false);
    expect(isDemoRestricted(false, "admin")).toBe(false);
  });
});
