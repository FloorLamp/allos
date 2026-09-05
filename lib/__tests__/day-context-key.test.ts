// PURE TIER — the day-context key's identity properties (#5211 clause 1, for #3416).
//
// The key exists so the provider and the offline layer cannot disagree about which
// (subject, day, reach) a response belongs to. That is one property — equal triples
// give equal keys, different triples give different keys — plus the two decisions the
// module made on purpose: the reach's PROSE is not part of the identity, and a
// component carrying the separator cannot forge another triple's key.

import { describe, expect, it } from "vitest";
import { dayContextKey } from "@/lib/day-context-key";
import type { DayContextParts, TapReach } from "@/lib/day-context-key";

const SEP = "\u0000";

const bounded = (
  back: number,
  forward: number,
  reason = "the sheet's offer",
  ref: `#${number}` = "#5211"
): TapReach => ({ kind: "bounded", back, forward, reason, ref });

const BASE: DayContextParts = {
  profileId: 7,
  day: "2026-09-05",
  reach: bounded(2, 0),
};

describe("the day-context key", () => {
  it("gives one key to one identity, through separately built values", () => {
    const twin: DayContextParts = {
      profileId: 7,
      day: "2026-09-05",
      reach: bounded(2, 0),
    };
    expect(dayContextKey(twin)).toBe(dayContextKey(BASE));

    // The property both consumers rest on: last-good data stored under one triple is
    // found by the other. A struct would fail this, which is why the key is a string.
    const cache = new Map<string, string>();
    cache.set(dayContextKey(BASE), "last good");
    expect(cache.get(dayContextKey(twin))).toBe("last good");
    expect(cache.size).toBe(1);
  });

  // One component moves per row; every row must land on a different key, or a response
  // issued for one context can be applied to another.
  it.each([
    ["the subject", { ...BASE, profileId: 8 }],
    ["the day", { ...BASE, day: "2026-09-04" }],
    [
      "the reach kind, to dated",
      { ...BASE, reach: { kind: "dated" } as TapReach },
    ],
    [
      "the reach kind, to today",
      { ...BASE, reach: { kind: "today" } as TapReach },
    ],
    ["the reach's back count", { ...BASE, reach: bounded(1, 0) }],
    ["the reach's forward count", { ...BASE, reach: bounded(2, 1) }],
  ])("moves when %s moves", (_what, parts: DayContextParts) => {
    expect(dayContextKey(parts)).not.toBe(dayContextKey(BASE));
  });

  it("does not move when only the declaration's argument moves", () => {
    // Deliberate, and the module says why: `reason` and `ref` justify the bound, they
    // are not the offer. Editing a comment must not discard in-flight responses.
    const reworded = { ...BASE, reach: bounded(2, 0, "reworded", "#3416") };
    expect(dayContextKey(reworded)).toBe(dayContextKey(BASE));
  });

  // The unambiguity the string shape owes: distinct triples, distinct keys, including
  // the two neighbours that a careless encoding runs together — a pair whose components
  // differ only in where one ends (a missing separator collides them), and a day
  // carrying the separator itself (the only free-form component, so the only forgery
  // route).
  it("gives distinct keys to distinct triples, separator included", () => {
    const targets: DayContextParts[] = [
      BASE,
      { profileId: 7, day: "2026-09-05", reach: { kind: "dated" } },
      { profileId: 7, day: "2026-09-05", reach: { kind: "today" } },
      { profileId: 8, day: "2026-09-04", reach: bounded(2, 2) },
      // Same characters as BASE with the boundary moved one place.
      { profileId: 72, day: "026-09-05", reach: bounded(2, 0) },
    ];
    const forged = targets.flatMap((target) => {
      // Pack a whole well-formed key's tail into the DAY and re-key it.
      const tail = dayContextKey(target).slice(
        `${target.profileId}${SEP}`.length
      );
      return [{ kind: "dated" } as TapReach, bounded(2, 0)].map((reach) => ({
        profileId: target.profileId,
        day: tail,
        reach,
      }));
    });

    const triples = [...targets, ...forged];
    expect(new Set(triples.map(dayContextKey)).size).toBe(triples.length);

    // The near-miss control: each forgery really does reach one separator short of the
    // key it imitates, so the count above is a result and not a fixture that never got
    // close to the state it forbids.
    for (const target of targets) {
      const targetKey = dayContextKey(target);
      const attempts = forged.filter((f) =>
        dayContextKey(f).startsWith(targetKey)
      );
      expect(attempts).toHaveLength(2);
    }
  });
});
