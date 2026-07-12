// Disambiguate a list of profiles for display (issue #534). Profile names carry no
// uniqueness constraint, so a household can hold two "Alex" profiles that render
// identically in the profile switcher / dashboard household chips (and, with no
// photo, identical Avatar initials) — the switch itself is id-correct, but the
// label is a guess. When two or more SHOWN profiles share a name (case-insensitive,
// whitespace-collapsed), append a stable "(2)", "(3)" ordinal in id order so each is
// distinguishable; a unique name is left untouched.
//
// Ordinal — not birth-year or relationship — because it needs nothing beyond the
// id+name the chrome already has (no schema/query change) and can't leak another
// profile's DOB into shared layout. Pure + unit-tested; the surfaces (UserMenu,
// HouseholdStrip) are formatters over this one result so their labels can't drift.
export function disambiguateProfileNames<
  T extends { id: number; name: string },
>(profiles: readonly T[]): Map<number, string> {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const counts = new Map<string, number>();
  for (const p of profiles) {
    const key = norm(p.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const out = new Map<number, string>();
  for (const p of [...profiles].sort((a, b) => a.id - b.id)) {
    const key = norm(p.name);
    if ((counts.get(key) ?? 0) <= 1) {
      out.set(p.id, p.name);
    } else {
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      out.set(p.id, `${p.name} (${n})`);
    }
  }
  return out;
}
