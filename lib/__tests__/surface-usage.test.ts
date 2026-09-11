// PURE TIER — the surface-usage read model's declarations (issue #4249).
//
// The counting is covered in lib/__db_tests__/surface-usage.test.ts. What belongs
// here is everything the model decides WITHOUT a database: which channel each
// vocabulary member names, that the classification is exhaustive over the
// vocabulary, and that an unknown or absent stamp is read as no channel rather than
// as a web act — the claim the whole issue exists to stop the app making.

import { describe, expect, it } from "vitest";
import { LOGGED_VIA_VALUES, type LoggedVia } from "@/lib/logged-via";
import {
  SURFACE_CHANNEL,
  SURFACE_USAGE_WINDOW_DAYS,
  TELEGRAM_ACT_SURFACES,
  WEB_ACT_SURFACES,
  surfaceChannel,
} from "@/lib/surface-usage";

describe("SURFACE_CHANNEL", () => {
  it("classifies every member of the vocabulary, and only those", () => {
    expect(Object.keys(SURFACE_CHANNEL).sort()).toEqual(
      [...LOGGED_VIA_VALUES].sort()
    );
  });

  it("puts the three chat surfaces on the chat and the four web regions on the web", () => {
    expect([...TELEGRAM_ACT_SURFACES].sort()).toEqual([
      "telegram-command",
      "telegram-nudge",
      "telegram-text",
    ]);
    // `offline-replay` is on the web WITH the four regions: the offline queue exists
    // only in the browser, so a replayed write is a web act whose finer provenance
    // was discarded. Reading it as no channel would delete evidence the app holds.
    expect([...WEB_ACT_SURFACES].sort()).toEqual([
      "dashboard-hero",
      "dashboard-widget",
      "offline-replay",
      "page",
      "quick-log",
    ]);
  });

  it("claims no channel for the two values that name no surface", () => {
    // `import` says no person acted; `usual-backfill` REPLACES the surface (#4118),
    // so a backfill from the chat and one from the web are indistinguishable — and
    // crediting the web with a tap that may have happened in Telegram is exactly the
    // defect this model removed.
    expect(surfaceChannel("import")).toBe("none");
    expect(surfaceChannel("usual-backfill")).toBe("none");
  });
});

describe("surfaceChannel", () => {
  it("reads an absent stamp as no channel", () => {
    // The column arrived nullable with no backfill (#3087). "Unknown" is not
    // evidence that a person acts on the web.
    expect(surfaceChannel(null)).toBe("none");
    expect(surfaceChannel(undefined)).toBe("none");
    expect(surfaceChannel("")).toBe("none");
  });

  it("reads an unknown or forged value as no channel", () => {
    expect(surfaceChannel("web")).toBe("none");
    expect(surfaceChannel("telegram-typo")).toBe("none");
    // `Object.hasOwn`, never `in`: `in` walks the prototype chain, so a stored
    // "constructor" would read as a member of the closed set — the same trap
    // lib/logged-via.ts's own guards are written against.
    expect(surfaceChannel("constructor")).toBe("none");
    expect(surfaceChannel("toString")).toBe("none");
  });

  it("agrees with the record for every real value", () => {
    for (const via of LOGGED_VIA_VALUES) {
      expect(surfaceChannel(via)).toBe(SURFACE_CHANNEL[via as LoggedVia]);
    }
  });
});

describe("the declared window", () => {
  it("is a quarter, and is a whole number of days", () => {
    expect(SURFACE_USAGE_WINDOW_DAYS).toBe(90);
    expect(Number.isInteger(SURFACE_USAGE_WINDOW_DAYS)).toBe(true);
  });
});
