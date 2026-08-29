// DB INTEGRATION TIER — the record's palette doors honour the substance line (#3958).
//
// The command palette is a DOOR, and every other substance door is life-stage gated:
// the specialty route redirects a known minor, the nav pane hides, the quick-log
// hides, every substance action refuses, and the record's own gather excludes the
// rows. #3958 added a "Substance history" page entry keyed on
// "alcohol nicotine cannabis drinks" and gated none of it — so the one surface still
// OFFERING it was the search box. The destination was harmless because the gather
// refuses; that is what makes it worth fixing rather than what excuses it. Quiet
// access is about what the app offers.
//
// THE PREDICATE IS `isMinor` AND NOT `!isAdult`: hide on a positive under-age match
// only, never on missing data — the same one the specialty route redirects on, so a
// profile whose age nobody has entered still sees every door.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { searchAll } from "@/lib/queries";
import { setStoredAge } from "@/lib/settings";

function profile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function pageTitles(profileId: number, query: string): string[] {
  return (
    searchAll(profileId, query)
      .find((group) => group.domain === "page")
      ?.hits.map((hit) => hit.title) ?? []
  );
}

describe("the palette's substance door is life-stage gated (#1174/#1279)", () => {
  // EVERY KEYWORD THE ENTRY SHIPS, not just its title: the defect was reachable by
  // typing "alcohol", which is the word a minor would actually type, and a test that
  // only asked for "Substance history" would have passed over it.
  it.each(["substance history", "alcohol", "nicotine", "cannabis", "drinks"])(
    "answers an adult but not a known minor for %j",
    (query) => {
      const adult = profile(`palette adult ${query}`);
      setStoredAge(adult, 34);
      const minor = profile(`palette minor ${query}`);
      setStoredAge(minor, 11);

      expect(pageTitles(adult, query)).toContain("Substance history");
      expect(pageTitles(minor, query)).not.toContain("Substance history");
    }
  );

  it("still answers a profile whose age nobody has entered", () => {
    const unknown = profile("palette unknown age");
    expect(pageTitles(unknown, "alcohol")).toContain("Substance history");
  });

  // THE GUARD MUST STAY QUIET ON ITS NEIGHBOURS. A gate that swallowed the record's
  // other doors would look identical in the assertion above and be a much worse bug —
  // a minor's own food and body history are their own data (#3067) and are never
  // filtered from them.
  it("hides nothing else from a minor", () => {
    const minor = profile("palette minor neighbours");
    setStoredAge(minor, 11);
    expect(pageTitles(minor, "food history")).toContain("Food history");
    expect(pageTitles(minor, "body history")).toContain("Body history");
    expect(pageTitles(minor, "history")).toContain("History");
  });
});
