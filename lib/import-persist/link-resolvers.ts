import { db } from "../db";

function makeScopedExternalIdResolver(
  profileId: number,
  docSource: string | null,
  table: "encounters" | "conditions"
): (raw: string | null | undefined) => number | null {
  const resolved = new Map<string, number | null>();

  return (raw) => {
    if (!raw || !docSource) return null;
    if (resolved.has(raw)) return resolved.get(raw)!;

    const row = db
      .prepare(
        `SELECT id FROM ${table} WHERE profile_id = ? AND external_id = ?`
      )
      .get(profileId, `${docSource}|${raw}`) as { id: number } | undefined;
    const id = row?.id ?? null;
    resolved.set(raw, id);
    return id;
  };
}

// Resolve a raw imported encounter reference to the source-scoped local row.
export function makeEncounterResolver(
  profileId: number,
  docSource: string | null
): (raw: string | null | undefined) => number | null {
  return makeScopedExternalIdResolver(profileId, docSource, "encounters");
}

// Resolve a raw imported condition reference to the source-scoped local row.
export function makeConditionResolver(
  profileId: number,
  docSource: string | null
): (raw: string | null | undefined) => number | null {
  return makeScopedExternalIdResolver(profileId, docSource, "conditions");
}
