import { describe, expect, it } from "vitest";
import {
  HISTORY_FAMILIES,
  HISTORY_FAMILY_KINDS,
  HISTORY_KINDS,
  HISTORY_ROLLUP_KINDS,
  historyKindFamily,
  historyRollupNoun,
  layoutHistoryDay,
  parseHistoryExpand,
  type HistoryKind,
  type HistoryRow,
} from "@/lib/history-format";

// THE DENSITY ANSWER (#3958 phase 2), at the tier that can actually see it: the rollup
// is a pure decision over one day's already-merged rows, so every claim below is a
// claim about the function rather than about a fixture that happened to render.

function row(
  kind: HistoryKind,
  over: Partial<HistoryRow> & { profileId?: number } = {}
): HistoryRow {
  const profileId = over.profileId ?? 1;
  const { profileId: _drop, ...rest } = over;
  void _drop;
  return {
    id: `${kind}:${profileId}:${over.id ?? Math.random().toString(36).slice(2)}`,
    kind,
    tz: "UTC",
    date: "2026-08-28",
    sortTime: "08:00",
    clock: "8:00am",
    clockKind: "stated",
    title: kind,
    href: null,
    detail: "",
    media: 0,
    edit: null,
    profileId,
    ...rest,
  };
}

describe("the closed kind registry", () => {
  it("gives every kind exactly one family, and every family its own kinds", () => {
    // TOTALITY IN BOTH DIRECTIONS. A kind in two families would make the chip rows
    // disagree about where a row lives; a kind in none would render under no chip at
    // all and be reachable only by typing its `?kind=`.
    const seen = new Map<HistoryKind, string[]>();
    for (const family of HISTORY_FAMILIES)
      for (const kind of HISTORY_FAMILY_KINDS[family])
        seen.set(kind, [...(seen.get(kind) ?? []), family]);
    expect([...seen.keys()].sort()).toEqual([...HISTORY_KINDS].sort());
    for (const [kind, families] of seen) {
      expect(families).toHaveLength(1);
      expect(historyKindFamily(kind)).toBe(families[0]);
    }
  });

  it("rolls up every Logs kind and only Logs kinds — sleep excepted", () => {
    // The exception is the whole reason the set is stated: #3958 names sleep as the
    // one log kind that never collapses, and a set that also dropped, say, body would
    // make "sleep never rolls up" an unremarkable member of a hand-picked list.
    expect([...HISTORY_ROLLUP_KINDS].sort()).toEqual(
      HISTORY_FAMILY_KINDS.logs.filter((k) => k !== "sleep").sort()
    );
    expect(HISTORY_ROLLUP_KINDS).not.toContain("sleep");
  });
});

describe("layoutHistoryDay", () => {
  it("splits the rollup per MEMBER, never per day", () => {
    // TWO MEMBERS ON ONE DAY, which is the only fixture that can tell the two apart: a
    // single-member day produces one line either way, so it cannot fail on a
    // per-day grouping and cannot prove a per-member one.
    const rows = [
      row("dose", { profileId: 1 }),
      row("dose", { profileId: 1 }),
      row("food", { profileId: 1 }),
      row("dose", { profileId: 2 }),
      row("food", { profileId: 2 }),
    ];
    const { visible, rollups } = layoutHistoryDay(rows, { rollup: true });
    expect(visible).toHaveLength(0);
    expect(rollups.map((r) => [r.profileId, r.label, r.count])).toEqual([
      [1, "2 doses · 1 serving", 3],
      [2, "1 dose · 1 serving", 2],
    ]);
    // And each line stands for its own member's rows and nobody else's.
    for (const line of rollups)
      expect(line.rows.every((r) => r.profileId === line.profileId)).toBe(true);
  });

  it("never rolls sleep up, on a day dense enough that everything else did", () => {
    // THE FIXTURE HAS TO BE A DAY WHERE IT WOULD HAVE. A sparse day collapses nothing,
    // so a sleep row surviving there says nothing about the exception.
    const rows = [
      row("sleep", { id: "night", title: "Sleep" }),
      ...Array.from({ length: 6 }, () => row("dose")),
      ...Array.from({ length: 4 }, () => row("food")),
    ];
    const { visible, rollups } = layoutHistoryDay(rows, { rollup: true });
    expect(visible.map((r) => r.kind)).toEqual(["sleep"]);
    expect(rollups).toHaveLength(1);
    expect(rollups[0].label).toBe("6 doses · 4 servings");
    expect(rollups[0].rows.map((r) => r.kind)).not.toContain("sleep");
  });

  it("keeps the rare events visible and the rollup line last", () => {
    const rows = [
      row("lab", { id: "panel" }),
      row("dose"),
      row("milestone", { id: "pb" }),
      row("food"),
    ];
    const { visible, rollups } = layoutHistoryDay(rows, { rollup: true });
    expect(visible.map((r) => r.kind)).toEqual(["lab", "milestone"]);
    expect(rollups.map((r) => r.label)).toEqual(["1 dose · 1 serving"]);
  });

  it("is the plain record when the reader has narrowed to a family", () => {
    const rows = [row("dose"), row("dose"), row("food")];
    expect(layoutHistoryDay(rows, { rollup: false })).toEqual({
      visible: rows,
      rollups: [],
    });
  });

  it("labels kinds in registry order, whatever order the day produced them", () => {
    const a = layoutHistoryDay([row("food"), row("dose")], { rollup: true });
    const b = layoutHistoryDay([row("dose"), row("food")], { rollup: true });
    expect(a.rollups[0].label).toBe(b.rollups[0].label);
    expect(a.rollups[0].label).toBe("1 dose · 1 serving");
  });
});

describe("?expand", () => {
  it.each([
    ["2026-08-28:3", true],
    ["2026-08-28:12,2026-08-27:3", true],
    ["2026-08", false],
    ["2026-08-28", false],
    ["2026-08-28:", false],
    ["ahead", false],
  ])("%s parses to a rollup key set: %s", (raw, kept) => {
    expect(parseHistoryExpand(raw).size > 0).toBe(kept);
  });
});

describe("historyRollupNoun", () => {
  it.each([
    ["dose" as const, 1, "1 dose"],
    ["dose" as const, 6, "6 doses"],
    ["food" as const, 1, "1 serving"],
    ["food" as const, 4, "4 servings"],
    ["symptom" as const, 10, "10 symptoms"],
  ])("%s x%d reads %s", (kind, n, expected) => {
    expect(historyRollupNoun(kind, n)).toBe(expected);
  });
});
