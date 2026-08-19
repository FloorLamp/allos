// DB INTEGRATION TIER — a profile's own protocol records follow the profile at
// every age (#3133, restoring #3067's invariant: "a profile's own data is never
// filtered from that profile").
//
// #3091 wrapped several reads of ALREADY-RECORDED protocols in
// isLongevityRelevant (unknown age → false), which filtered a profile's own
// N-of-1 experiments out of its trends overlays, weekly-habit links, biomarker
// detail windows, and the record's own detail page. The adult-only content line
// stays on protocol CREATION; these tests pin each restored read surface by
// name — re-wrapping any one of them in the gate reds the test that names it.
// (Timeline and search have their twins in timeline.test.ts and
// search-entity-domains.test.ts; the seven actions in protocols.actions.test.ts.)

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { setStoredAge } from "@/lib/settings";
import { buildProtocolTrendWindows } from "@/lib/trends-series";
import WeeklyHabits from "@/app/(app)/nutrition/WeeklyHabits";
import ProtocolDetailPage from "@/app/(app)/protocols/[id]/page";
import ClinicalResultDetailPage from "@/app/(app)/results/clinical-results/view/page";
import { seedActor } from "../__action_tests__/harness";

// Flatten a rendered element tree to a string for containment checks. React
// element props can reference module objects with cycles, so plain
// JSON.stringify throws; a WeakSet replacer drops repeats instead.
function treeText(tree: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(tree, (_key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return undefined;
      seen.add(value);
    }
    return value;
  })!;
}

function newProfile(name: string, age: number | null): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  if (age != null) setStoredAge(id, age);
  return id;
}

function seedProtocol(
  profileId: number,
  fields: {
    name: string;
    start: string;
    end?: string | null;
    outcomeKeys?: string[];
    frequencyTargetId?: number;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO protocols
           (profile_id, name, start_date, end_date, outcome_keys, frequency_target_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        fields.name,
        fields.start,
        fields.end ?? null,
        JSON.stringify(fields.outcomeKeys ?? []),
        fields.frequencyTargetId ?? null
      ).lastInsertRowid
  );
}

describe("lib/trends-series.ts buildProtocolTrendWindows (#3133)", () => {
  it.each([
    ["unknown-age", null],
    ["minor", 15],
  ] as const)("shades a %s profile's own protocol window", (label, age) => {
    const profileId = newProfile(`trend-window-${label}`, age);
    seedProtocol(profileId, {
      name: "Own trend window fixture",
      start: "2026-03-01",
      end: "2026-04-01",
    });

    const windows = buildProtocolTrendWindows(profileId, {
      from: undefined,
      to: undefined,
    });
    expect(windows).toHaveLength(1);
    expect(windows[0].label).toBe("Own trend window fixture");
  });
});

describe("nutrition WeeklyHabits protocol links (#3133)", () => {
  it("labels an unknown-age profile's habit with its adopting protocol", () => {
    const profileId = newProfile("weekly-habits-unknown-age", null);
    const targetId = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
           VALUES (?, 'food_group', 'leafy_greens', 3)`
        )
        .run(profileId).lastInsertRowid
    );
    seedProtocol(profileId, {
      name: "Own habit protocol fixture",
      start: "2026-03-01",
      frequencyTargetId: targetId,
    });

    // The server component renders the habit row with the adopting protocol's
    // name (the untrack confirmation), age or no age.
    const tree = treeText(WeeklyHabits({ profileId }));
    expect(tree).toContain("Own habit protocol fixture");
  });
});

describe("protocol detail page (#3133)", () => {
  it.each([
    ["unknown-age", null],
    ["minor", 15],
  ] as const)(
    "renders a %s profile's own record instead of redirecting",
    async (label, age) => {
      const { profile } = seedActor();
      setStoredAge(profile.id, age);
      const id = seedProtocol(profile.id, {
        name: `Own detail fixture ${label}`,
        start: "2026-03-01",
      });

      // An age redirect here would throw NEXT_REDIRECT and red this await.
      const page = await ProtocolDetailPage({
        params: Promise.resolve({ id: String(id) }),
      });
      expect(treeText(page)).toContain(`Own detail fixture ${label}`);
    }
  );
});

describe("clinical result detail protocol windows (#3133)", () => {
  it("shades the targeting protocol's window for an unknown-age profile", async () => {
    const { profile } = seedActor();
    setStoredAge(profile.id, null);
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, canonical_name, value, value_num, unit)
       VALUES (?, '2026-03-15', 'lab', 'CHOLESTEROL, TOTAL', 'Total Cholesterol', '180', 180, 'mg/dL')`
    ).run(profile.id);
    seedProtocol(profile.id, {
      name: "Own biomarker protocol fixture",
      start: "2026-03-01",
      end: "2026-04-01",
      outcomeKeys: ["result:Total Cholesterol"],
    });

    const page = await ClinicalResultDetailPage({
      searchParams: Promise.resolve({ name: "Total Cholesterol" }),
    });
    expect(treeText(page)).toContain("Own biomarker protocol fixture");
  });
});
