import { describe, it, expect } from "vitest";
import {
  DISCLOSURES,
  DISCLOSURE_IDS,
  DISCLOSURE_MEMORY_KEY,
  STATELESS_FOLD_CLASSES,
  disclosureKey,
  disclosureOpen,
  parseDisclosureMemory,
  rememberDisclosure,
  serializeDisclosureMemory,
} from "@/lib/disclosure-memory";

// Fixtures here are ids from the registry itself and hand-written JSON — no health
// data, nothing high-entropy.

describe("the registry declares its scope (#2652 behavior 3)", () => {
  it("every disclosure states why it is a routine fold", () => {
    for (const id of DISCLOSURE_IDS) {
      expect(DISCLOSURES[id].reason.length, id).toBeGreaterThan(20);
    }
  });

  it("names the fold classes that stay STATELESS, with reasons", () => {
    expect(STATELESS_FOLD_CLASSES.map((c) => c.name)).toEqual([
      "findings",
      "suppression",
      "narrowing-filter",
    ]);
    for (const c of STATELESS_FOLD_CLASSES) {
      expect(c.reason.length, c.name).toBeGreaterThan(20);
    }
  });

  it("no disclosure id names a stateless class — the allowlist cannot swallow one", () => {
    for (const id of DISCLOSURE_IDS) {
      for (const c of STATELESS_FOLD_CLASSES) {
        expect(id.includes(c.name), `${id} vs ${c.name}`).toBe(false);
      }
    }
  });

  it("the store key is versioned, so a shape change is dropped not migrated", () => {
    expect(DISCLOSURE_MEMORY_KEY).toMatch(/:v\d+$/);
  });
});

describe("disclosureKey", () => {
  it("a non-instanced id ignores an instance — one fold, one memory", () => {
    expect(disclosureKey("dashboard-prn-more", "whatever")).toBe(
      "dashboard-prn-more"
    );
  });

  it("an instanced id carries a slugged instance", () => {
    expect(disclosureKey("settings-group", "Notification Prefs")).toBe(
      "settings-group/notification-prefs"
    );
  });

  it("an instanced id with no instance falls back to the bare id", () => {
    expect(disclosureKey("settings-group")).toBe("settings-group");
    expect(disclosureKey("settings-group", "   ")).toBe("settings-group");
  });
});

describe("disclosureOpen", () => {
  it("an unremembered fold takes its declared default", () => {
    expect(disclosureOpen({}, "dashboard-prn-more")).toBe(
      DISCLOSURES["dashboard-prn-more"].defaultOpen
    );
  });

  it("memory fills the default in both directions", () => {
    expect(
      disclosureOpen({ "dashboard-prn-more": 1 }, "dashboard-prn-more")
    ).toBe(true);
    expect(
      disclosureOpen({ "dashboard-prn-more": 0 }, "dashboard-prn-more")
    ).toBe(false);
  });

  it("an explicit override WINS over memory (the URL-beats-memory rule)", () => {
    expect(
      disclosureOpen({ "dashboard-prn-more": 1 }, "dashboard-prn-more", {
        override: false,
      })
    ).toBe(false);
  });

  it("instances are remembered apart", () => {
    const memory = { "settings-group/units": 1 } as const;
    expect(disclosureOpen(memory, "settings-group", { instance: "units" })).toBe(
      true
    );
    expect(
      disclosureOpen(memory, "settings-group", { instance: "privacy" })
    ).toBe(DISCLOSURES["settings-group"].defaultOpen);
  });
});

describe("rememberDisclosure", () => {
  it("never mutates its input", () => {
    const before = {};
    const after = rememberDisclosure(before, "dashboard-prn-more", true);
    expect(before).toEqual({});
    expect(after).toEqual({ "dashboard-prn-more": 1 });
  });

  it("DROPS a state that equals the default, so the store is only departures", () => {
    const opened = rememberDisclosure({}, "dashboard-prn-more", true);
    const closedAgain = rememberDisclosure(
      opened,
      "dashboard-prn-more",
      false
    );
    expect(closedAgain).toEqual({});
  });

  it("records per instance", () => {
    const m = rememberDisclosure({}, "settings-group", true, "Units");
    expect(m).toEqual({ "settings-group/units": 1 });
  });
});

describe("parseDisclosureMemory degrades, never throws", () => {
  it("handles absent, invalid and wrong-shaped values", () => {
    expect(parseDisclosureMemory(null)).toEqual({});
    expect(parseDisclosureMemory("")).toEqual({});
    expect(parseDisclosureMemory("{oops")).toEqual({});
    expect(parseDisclosureMemory("[1,2]")).toEqual({});
    expect(parseDisclosureMemory("null")).toEqual({});
    expect(parseDisclosureMemory('"a string"')).toEqual({});
  });

  it("drops unknown ids, so a removed disclosure leaves no residue", () => {
    expect(
      parseDisclosureMemory(
        '{"dashboard-prn-more":1,"a-fold-that-no-longer-exists":1}'
      )
    ).toEqual({ "dashboard-prn-more": 1 });
  });

  it("drops non-0/1 values", () => {
    expect(
      parseDisclosureMemory('{"dashboard-prn-more":true,"settings-group":2}')
    ).toEqual({});
  });

  it("round-trips", () => {
    const m = rememberDisclosure({}, "settings-group", true, "units");
    expect(parseDisclosureMemory(serializeDisclosureMemory(m))).toEqual(m);
  });
});
