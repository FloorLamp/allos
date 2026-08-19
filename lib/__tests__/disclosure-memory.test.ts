import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DISCLOSURE_BOOT_SCRIPT,
  DISCLOSURE_KEY_ATTR,
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
import type { DisclosureMemory } from "@/lib/disclosure-memory";

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
  // Registry-driven, so it keeps holding as ids are added: an instanced id must carry
  // its instance and a non-instanced one must ignore it (one fold, one memory — a
  // non-instanced id cannot be fragmented into per-page copies by a careless caller).
  it("respects each declaration's `instanced` flag", () => {
    for (const id of DISCLOSURE_IDS) {
      const keyed = disclosureKey(id, "Some Instance");
      if (DISCLOSURES[id].instanced) {
        expect(keyed, id).toBe(`${id}/some-instance`);
      } else {
        expect(keyed, id).toBe(id);
      }
    }
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
    expect(disclosureOpen({}, "settings-group")).toBe(
      DISCLOSURES["settings-group"].defaultOpen
    );
  });

  it("keeps the single dashboard remainder closed by default", () => {
    expect(DISCLOSURES["dashboard-all"]).toMatchObject({
      defaultOpen: false,
      instanced: false,
    });
    expect(disclosureKey("dashboard-all", "ignored")).toBe("dashboard-all");
  });

  it("memory fills the default in both directions", () => {
    expect(disclosureOpen({ "settings-group": 1 }, "settings-group")).toBe(
      true
    );
    expect(disclosureOpen({ "settings-group": 0 }, "settings-group")).toBe(
      false
    );
  });

  it("an explicit override WINS over memory (the URL-beats-memory rule)", () => {
    expect(
      disclosureOpen({ "settings-group": 1 }, "settings-group", {
        override: false,
      })
    ).toBe(false);
  });

  it("instances are remembered apart", () => {
    const memory = { "settings-group/units": 1 } as const;
    expect(
      disclosureOpen(memory, "settings-group", { instance: "units" })
    ).toBe(true);
    expect(
      disclosureOpen(memory, "settings-group", { instance: "privacy" })
    ).toBe(DISCLOSURES["settings-group"].defaultOpen);
  });
});

describe("rememberDisclosure", () => {
  it("never mutates its input", () => {
    const before = {};
    const after = rememberDisclosure(before, "settings-group", true);
    expect(before).toEqual({});
    expect(after).toEqual({ "settings-group": 1 });
  });

  it("DROPS a state that equals the default, so the store is only departures", () => {
    const opened = rememberDisclosure({}, "settings-group", true);
    const closedAgain = rememberDisclosure(opened, "settings-group", false);
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
        '{"settings-group":1,"a-fold-that-no-longer-exists":1}'
      )
    ).toEqual({ "settings-group": 1 });
  });

  it("drops non-0/1 values", () => {
    expect(
      parseDisclosureMemory('{"settings-group":true,"settings-group/units":2}')
    ).toEqual({});
  });

  it("round-trips", () => {
    const m = rememberDisclosure({}, "settings-group", true, "units");
    expect(parseDisclosureMemory(serializeDisclosureMemory(m))).toEqual(m);
  });
});

describe("DISCLOSURE_BOOT_SCRIPT ≡ disclosureOpen (the pre-paint restore)", () => {
  // The boot script is a STRING of source that must run before any bundle, so it cannot
  // import the rule. This is the one-computation pin: execute it against stubbed browser
  // globals and compare the `open` it applies with the imported decision, so the frame-one
  // restore and the post-hydration render can never answer differently. A drift here is
  // the exact bug this script exists to fix, reintroduced.

  type FakeEl = { open: boolean; key: string | null };

  function fakeDetails(key: string | null, open = false) {
    const el: FakeEl = { open, key };
    return {
      el,
      node: {
        nodeType: 1,
        open,
        getAttribute: (a: string) => (a === DISCLOSURE_KEY_ATTR ? key : null),
        matches: (sel: string) =>
          key !== null && sel === `details[${DISCLOSURE_KEY_ATTR}]`,
        querySelectorAll: () => [],
        set _open(v: boolean) {
          el.open = v;
        },
      },
    };
  }

  /** Run the script over one streamed-in fold and report the `open` it left behind. */
  function runBoot(
    stored: string | null,
    key: string | null,
    initialOpen = false
  ): boolean {
    let observerCb: ((records: unknown[]) => void) | null = null;
    const node = {
      nodeType: 1,
      open: initialOpen,
      getAttribute: (a: string) => (a === DISCLOSURE_KEY_ATTR ? key : null),
      matches: (sel: string) =>
        key !== null && sel === `details[${DISCLOSURE_KEY_ATTR}]`,
      querySelectorAll: () => [] as unknown[],
    };
    const run = new Function(
      "localStorage",
      "document",
      "MutationObserver",
      "JSON",
      DISCLOSURE_BOOT_SCRIPT
    );
    run(
      { getItem: (k: string) => (k === DISCLOSURE_MEMORY_KEY ? stored : null) },
      {
        documentElement: {},
        body: {},
        addEventListener: () => {},
      },
      class {
        constructor(cb: (records: unknown[]) => void) {
          observerCb = cb;
        }
        observe() {}
        disconnect() {}
      },
      JSON
    );
    // Nothing stored → the script returns before observing, and the fold keeps the state
    // the server rendered.
    if (!observerCb) return node.open;
    (observerCb as (records: unknown[]) => void)([{ addedNodes: [node] }]);
    return node.open;
  }

  it("is the key and attribute the module itself declares", () => {
    expect(DISCLOSURE_BOOT_SCRIPT).toContain(
      `localStorage.getItem('${DISCLOSURE_MEMORY_KEY}')`
    );
    expect(DISCLOSURE_BOOT_SCRIPT).toContain(`details[${DISCLOSURE_KEY_ATTR}]`);
  });

  it("is the script the root layout actually inlines", () => {
    const layout = readFileSync(join(process.cwd(), "app/layout.tsx"), "utf8");
    expect(layout).toContain("DISCLOSURE_BOOT_SCRIPT");
  });

  it("applies exactly what disclosureOpen would, for every stored state", () => {
    const key = disclosureKey("settings-group", "health-advanced");
    const cases: (DisclosureMemory | null)[] = [
      null,
      {},
      { [key]: 1 },
      { [key]: 0 },
      { "settings-group/other": 1 },
    ];
    for (const memory of cases) {
      const stored = memory === null ? null : serializeDisclosureMemory(memory);
      const applied = runBoot(stored, key);
      const expected = disclosureOpen(memory ?? {}, "settings-group", {
        instance: "health-advanced",
      });
      expect(applied, `stored=${stored}`).toBe(expected);
    }
  });

  it("leaves a fold with no stored key alone — a caller-controlled fold is invisible to it", () => {
    expect(runBoot('{"settings-group/x":1}', null, false)).toBe(false);
    expect(runBoot('{"settings-group/x":1}', null, true)).toBe(true);
  });

  it("swallows a storage failure rather than throwing before first paint", () => {
    const run = new Function(
      "localStorage",
      "document",
      "MutationObserver",
      "JSON",
      DISCLOSURE_BOOT_SCRIPT
    );
    expect(() =>
      run(
        {
          getItem: () => {
            throw new Error("storage disabled");
          },
        },
        { documentElement: {}, body: {}, addEventListener: () => {} },
        class {
          observe() {}
          disconnect() {}
        },
        JSON
      )
    ).not.toThrow();
  });

  it("ignores a corrupt or array-shaped store instead of throwing", () => {
    for (const bad of ["{oops", "[1,2]", "null", '"str"']) {
      expect(() => runBoot(bad, "settings-group/x"), bad).not.toThrow();
      expect(runBoot(bad, "settings-group/x"), bad).toBe(false);
    }
  });
});
