import { describe, expect, it } from "vitest";
import {
  IMPORTED,
  LOGGED_VIA_FIELD,
  LOGGED_VIA_MEANING,
  LOGGED_VIA_VALUES,
  OFFLINE_REPLAY,
  isLoggedVia,
  parseWebOrigin,
  type LoggedVia,
  type WebLoggedVia,
} from "@/lib/logged-via";

// The closed vocabulary behind `logged_via` (#3087).
//
// THE POINT OF EVERY ASSERTION BELOW IS THAT IT TRACKS THE UNION, not that it lists
// today's members. A guard written as `const all: LoggedVia[] = ["telegram-nudge", …]`
// is accepted by TypeScript for any SUBSET, so adding a tenth value would leave it —
// and the suite — green while covering nothing new. Everything here is either derived
// from `Record<LoggedVia, …>` (exhaustive in both directions) or asserted against a
// derived set, so a new member is a COMPILE error until it is declared.

describe("the logged_via vocabulary", () => {
  it("derives its value list from the exhaustive meaning record", () => {
    expect(LOGGED_VIA_VALUES).toEqual(Object.keys(LOGGED_VIA_MEANING));
    expect(new Set(LOGGED_VIA_VALUES).size).toBe(LOGGED_VIA_VALUES.length);
  });

  it("gives every member a meaning a query reader can use", () => {
    // Driven from the record, so a member added without a sentence cannot reach here.
    for (const [value, meaning] of Object.entries(LOGGED_VIA_MEANING)) {
      expect(meaning.trim(), `${value} has no stated meaning`).not.toBe("");
    }
  });

  it("carries the nine members #3087 specified, and says so by NAME", () => {
    // The one place a literal list is right: it pins what shipped, and the moment the
    // union grows this fails and a human decides whether the newcomer belongs in the
    // web subset, in a migration, or nowhere. `satisfies` — not an annotation — so a
    // TYPO here is an error rather than a silently-absent member.
    const shipped = [
      "telegram-nudge",
      "telegram-command",
      "telegram-text",
      "dashboard-hero",
      "dashboard-widget",
      "quick-log",
      "page",
      "offline-replay",
      "import",
    ] as const satisfies readonly LoggedVia[];
    expect([...LOGGED_VIA_VALUES].sort()).toEqual([...shipped].sort());
  });

  it("accepts exactly its own members at the untyped boundary", () => {
    for (const value of LOGGED_VIA_VALUES)
      expect(isLoggedVia(value)).toBe(true);
    for (const hostile of [
      "telegram",
      "web",
      "TELEGRAM-NUDGE",
      "page ",
      "",
      "toString",
      "constructor",
      null,
      undefined,
      7,
      { page: true },
    ])
      expect(isLoggedVia(hostile), String(hostile)).toBe(false);
  });

  it("names the two non-surface stamps as members of the same vocabulary", () => {
    // `import` says nobody acted; `offline-replay` says the replay did. Both are
    // written from code rather than posted, and both must still be in the closed set.
    expect(isLoggedVia(IMPORTED)).toBe(true);
    expect(isLoggedVia(OFFLINE_REPLAY)).toBe(true);
    expect(IMPORTED).toBe("import");
    expect(OFFLINE_REPLAY).toBe("offline-replay");
  });
});

describe("parseWebOrigin — the browser's claim is never trusted", () => {
  // The web subset, driven off a Record so it is exhaustive over WebLoggedVia. Adding
  // a web surface without listing it here is a compile error, not a quiet gap.
  const WEB: Record<WebLoggedVia, true> = {
    "dashboard-hero": true,
    "dashboard-widget": true,
    "quick-log": true,
    page: true,
  };
  const webValues = Object.keys(WEB) as WebLoggedVia[];

  it("passes through every web surface", () => {
    for (const value of webValues)
      expect(parseWebOrigin(value, "page")).toBe(value);
  });

  it("REFUSES the values a browser must not be able to claim", () => {
    // Derived, not listed: every vocabulary member that is not in the web subset.
    // These three are exactly the values a later analysis draws conclusions from — a
    // forged post that could claim `telegram-nudge` would make "does the nudge get
    // used" answerable in the attacker's favour.
    const nonWeb = LOGGED_VIA_VALUES.filter((v) => !(v in WEB)) as Exclude<
      LoggedVia,
      WebLoggedVia
    >[];
    expect(nonWeb.length).toBeGreaterThan(0);
    for (const value of nonWeb) {
      expect(parseWebOrigin(value, "page"), value).toBe("page");
    }
  });

  it("falls back rather than storing an unknown string", () => {
    for (const hostile of ["", "  page", "webhook", null, undefined, 3, {}]) {
      expect(parseWebOrigin(hostile, "dashboard-widget")).toBe(
        "dashboard-widget"
      );
    }
  });

  it("posts under a stable field name", () => {
    // The client and the action agree through this constant; a rename that reached
    // only one side would silently send every surface to its fallback.
    expect(LOGGED_VIA_FIELD).toBe("logged_via");
  });
});
