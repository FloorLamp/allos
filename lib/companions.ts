import { decayedWeight, SUGGESTION_HALF_LIFE_DAYS } from "./decay";
import { baseLiftName } from "./lifts";

// One (activity, exercise) membership row for the co-occurrence scan: the
// distinct exercises logged in an activity, each carrying the activity's date so
// stale pairings can be decayed. The SQL that produces these is profile-scoped
// (issue #195).
export interface CompanionRow {
  activityId: number;
  date: string;
  exercise: string;
}

// exercise base-name (lowercased) -> its top co-logged lifts (base display
// names, strongest first). Capped per exercise to bound the payload.
export type CompanionMap = Record<string, string[]>;

// Build the per-lift co-occurrence map: exercises logged in the SAME activity
// are "companions", each pairing weighted by that activity's recency decay so a
// pairing you've drifted away from fades. Names are base-collapsed ("Dumbbell
// Curl" -> "Curl") and de-duplicated within an activity, so a pair is counted at
// most once per activity (not once per set). Capped at `topN` companions each.
// Pure — the pairing/decay/collapse is unit-tested; only `rows` comes from SQL.
export function buildCompanionMap(
  rows: CompanionRow[],
  today: string,
  topN = 5,
  halfLifeDays = SUGGESTION_HALF_LIFE_DAYS
): CompanionMap {
  // Distinct base names per activity (keyed lowercased → first display casing),
  // plus the activity date for its decay weight.
  const byActivity = new Map<
    number,
    { date: string; names: Map<string, string> }
  >();
  for (const r of rows) {
    const base = baseLiftName(r.exercise).trim();
    if (!base) continue;
    const key = base.toLowerCase();
    let g = byActivity.get(r.activityId);
    if (!g)
      byActivity.set(r.activityId, (g = { date: r.date, names: new Map() }));
    if (!g.names.has(key)) g.names.set(key, base);
  }

  const display = new Map<string, string>(); // key -> display name
  const pairWeight = new Map<string, Map<string, number>>();
  const bump = (a: string, b: string, w: number) => {
    let m = pairWeight.get(a);
    if (!m) pairWeight.set(a, (m = new Map()));
    m.set(b, (m.get(b) ?? 0) + w);
  };
  for (const g of byActivity.values()) {
    const entries = [...g.names.entries()]; // [key, display][]
    if (entries.length < 2) continue;
    const w = decayedWeight(g.date, today, halfLifeDays);
    for (const [k, d] of entries) if (!display.has(k)) display.set(k, d);
    for (let i = 0; i < entries.length; i++)
      for (let j = 0; j < entries.length; j++) {
        if (i === j) continue; // an exercise is never its own companion
        bump(entries[i][0], entries[j][0], w);
      }
  }

  const nameOf = (k: string) => display.get(k) ?? k;
  const out: CompanionMap = {};
  for (const [key, m] of pairWeight) {
    const top = [...m.entries()]
      // Strongest pairing first; ties break alphabetically on the display name
      // so the order is deterministic.
      .sort((a, b) => b[1] - a[1] || nameOf(a[0]).localeCompare(nameOf(b[0])))
      .slice(0, topN)
      .map(([k]) => nameOf(k));
    if (top.length) out[key] = top;
  }
  return out;
}

// Re-rank `options` so companions of the already-entered lifts float to the top,
// ordered by combined companion strength — an option that companions MORE of the
// entered lifts, or ranks higher in their companion lists, sorts first — with
// the input order kept as the stable tiebreak, so the decayed base-frequency
// order still governs everything the companion signal doesn't (issue #195).
//
// Pure and non-destructive: a companion at position `p` of an entered lift's
// list contributes `topN - p`, so earlier and shared companions win. With no
// entered lifts (or no companion hits) the input order is returned unchanged.
// The combobox runs its fuzzy filter over the returned order, so once the user
// types, fuzzy score dominates and this only breaks its ties.
export function biasByCompanions(
  options: string[],
  enteredNames: string[],
  companions: CompanionMap,
  topN = 5
): string[] {
  const entered = new Set(
    enteredNames.map((n) => n.trim().toLowerCase()).filter(Boolean)
  );
  if (entered.size === 0) return options;
  const score = new Map<string, number>();
  for (const e of entered) {
    const list = companions[e];
    if (!list) continue;
    list.forEach((name, p) => {
      const k = name.trim().toLowerCase();
      if (entered.has(k)) return; // already in the draft — don't re-suggest it
      score.set(k, (score.get(k) ?? 0) + (topN - p));
    });
  }
  if (score.size === 0) return options;
  return options
    .map((o, i) => ({ o, i, s: score.get(o.trim().toLowerCase()) ?? 0 }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.o);
}
